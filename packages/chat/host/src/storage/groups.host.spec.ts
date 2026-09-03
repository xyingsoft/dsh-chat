/**
 * 群聊本地镜像（S4b）：迁移、store 与聚合。
 *
 * 用真实的 `ChatDatabase`（跑全套迁移）而不是内联建表 —— 这里要验证的正是
 * 「v8 迁移落地后，store 助手与聚合在这个 schema 上成立」，内联子集会把这个
 * 前提绕过去。
 */

import { describe, expect, it } from 'vitest'

import { acceptDirectMessage } from '@dsh-chat/messaging'

import { ChatDatabase } from './database.js'
import {
  addGroupMember,
  groupConversationsOf,
  ingestGroupMessage,
  upsertGroupRoster,
  type GroupConversationSummary,
} from './groups.js'

const ORG = 'org-1'
const ORG_OTHER = 'org-2'
const T0 = new Date('2026-08-30T00:00:00Z')
const at = (ms: number): Date => new Date(T0.getTime() + ms)

function openMemory(): ChatDatabase {
  return ChatDatabase.open({ location: ':memory:' })
}

function columnsOf(db: ChatDatabase, table: string): string[] {
  return (db.readonlyHandle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
}

describe('迁移 v8：群聊镜像', () => {
  it('打开空库后 schema 为最新版本，且镜像表齐备', () => {
    const db = openMemory()
    expect(db.schemaVersion).toBe(8)
    for (const table of ['groups', 'group_members', 'group_messages']) {
      const columns = columnsOf(db, table)
      expect(columns, `${table} 缺 organization_id`).toContain('organization_id')
    }
    db.close()
  })

  it('messages.recipient_type 存在，私聊行默认落为 account', () => {
    const db = openMemory()
    expect(columnsOf(db, 'messages')).toContain('recipient_type')
    db.transaction((handle) => {
      const insert = handle.prepare(
        'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
      )
      insert.run('alice', '甲', T0.toISOString())
      insert.run('bob', '乙', T0.toISOString())
      acceptDirectMessage(handle, {
        messageId: 'm-1',
        organizationId: ORG,
        senderId: 'alice',
        recipientId: 'bob',
        body: '你好',
        operationId: 'op-1',
        now: T0,
        queueCapacity: 10,
      })
    })
    const row = db.readonlyHandle
      .prepare('SELECT recipient_type FROM messages WHERE message_id = ?')
      .get('m-1') as { recipient_type: string }
    expect(row.recipient_type).toBe('account')
    db.close()
  })
})

describe('store：落群消息与名单', () => {
  it('落一条群消息：消息行 + 名册镜像一次完成', () => {
    const db = openMemory()
    const result = db.transaction((handle) =>
      ingestGroupMessage(handle, {
        messageId: 'gm-1',
        organizationId: ORG,
        senderId: 'alice',
        groupId: 'grp-1',
        groupName: '产品组',
        memberCount: 3,
        body: '大家好',
        operationId: 'op-gm-1',
        now: at(0),
      }),
    )
    expect(result).toEqual({ idempotentReplay: false })

    const message = db.readonlyHandle
      .prepare('SELECT body, group_id, created_at FROM group_messages WHERE message_id = ?')
      .get('gm-1') as { body: string; group_id: string; created_at: string }
    expect(message.body).toBe('大家好')
    expect(message.group_id).toBe('grp-1')

    const roster = db.readonlyHandle
      .prepare('SELECT name, member_count FROM groups WHERE group_id = ?')
      .get('grp-1') as { name: string; member_count: number | null }
    expect(roster).toEqual({ name: '产品组', member_count: 3 })
    db.close()
  })

  it('同一 (senderId, messageId) 重放幂等，不重复写入', () => {
    const db = openMemory()
    const input = {
      messageId: 'gm-1',
      organizationId: ORG,
      senderId: 'alice',
      groupId: 'grp-1',
      groupName: '产品组',
      body: '大家好',
      operationId: 'op-gm-1',
      now: at(0),
    }
    db.transaction((handle) => ingestGroupMessage(handle, input))
    const second = db.transaction((handle) => ingestGroupMessage(handle, input))
    expect(second).toEqual({ idempotentReplay: true })
    const count = db.readonlyHandle
      .prepare('SELECT COUNT(*) AS n FROM group_messages')
      .get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it('不同 sender 的同一条消息 id 不算重放（幂等键含 senderId，§14）', () => {
    const db = openMemory()
    const base = {
      messageId: 'gm-1',
      organizationId: ORG,
      groupId: 'grp-1',
      groupName: '产品组',
      body: 'x',
      operationId: 'op-gm-1',
      now: at(0),
    }
    db.transaction((handle) =>
      ingestGroupMessage(handle, { ...base, senderId: 'alice' }),
    )
    const other = db.transaction((handle) =>
      ingestGroupMessage(handle, { ...base, senderId: 'bob' }),
    )
    expect(other).toEqual({ idempotentReplay: false })
    db.close()
  })

  it('名册活动时间只前进不回退：迟到的旧消息不把群顶回顶部', () => {
    const db = openMemory()
    db.transaction((handle) =>
      ingestGroupMessage(handle, {
        messageId: 'gm-2',
        organizationId: ORG,
        senderId: 'alice',
        groupId: 'grp-1',
        groupName: '产品组',
        body: '新消息',
        operationId: 'op-gm-2',
        now: at(2000),
      }),
    )
    // 一条 created_at 更早、但重放路径之外的新消息（不同 messageId）
    db.transaction((handle) =>
      ingestGroupMessage(handle, {
        messageId: 'gm-1',
        organizationId: ORG,
        senderId: 'bob',
        groupId: 'grp-1',
        groupName: '产品组',
        body: '旧消息',
        operationId: 'op-gm-1',
        now: at(0),
      }),
    )
    const roster = db.readonlyHandle
      .prepare('SELECT last_activity_at FROM groups WHERE group_id = ?')
      .get('grp-1') as { last_activity_at: string }
    expect(roster.last_activity_at).toBe(at(2000).toISOString())
    db.close()
  })

  it('名单刷新：成员数只在确实知道时覆盖', () => {
    const db = openMemory()
    upsertGroupRoster(db.readonlyHandle, {
      organizationId: ORG,
      groupId: 'grp-1',
      name: '产品组',
      memberCount: 5,
      now: at(0),
    })
    // 不知道成员数的刷新不把已知数冲成 NULL
    upsertGroupRoster(db.readonlyHandle, {
      organizationId: ORG,
      groupId: 'grp-1',
      name: '产品组（改名）',
      now: at(1000),
    })
    const row = db.readonlyHandle
      .prepare('SELECT name, member_count FROM groups WHERE group_id = ?')
      .get('grp-1') as { name: string; member_count: number | null }
    expect(row).toEqual({ name: '产品组（改名）', member_count: 5 })
    db.close()
  })

  it('成员关系写入幂等', () => {
    const db = openMemory()
    addGroupMember(db.readonlyHandle, {
      organizationId: ORG,
      groupId: 'grp-1',
      accountId: 'alice',
      now: at(0),
    })
    addGroupMember(db.readonlyHandle, {
      organizationId: ORG,
      groupId: 'grp-1',
      accountId: 'alice',
      now: at(1000),
    })
    const count = db.readonlyHandle
      .prepare('SELECT COUNT(*) AS n FROM group_members')
      .get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })
})

/** 在库里种一个含消息的群 + 一个成员。返回群摘要的便捷读取。 */
function seedGroup(
  db: ChatDatabase,
  options: { member?: string; sender?: string } = {},
): void {
  db.transaction((handle) => {
    ingestGroupMessage(handle, {
      messageId: `gm-${options.sender ?? 'alice'}`,
      organizationId: ORG,
      senderId: options.sender ?? 'alice',
      groupId: 'grp-1',
      groupName: '产品组',
      memberCount: 3,
      body: '大家好',
      operationId: `op-${options.sender ?? 'alice'}`,
      now: at(0),
    })
    if (options.member !== undefined) {
      addGroupMember(handle, {
        organizationId: ORG,
        groupId: 'grp-1',
        accountId: options.member,
        now: at(0),
      })
    }
  })
}

describe('聚合：groupConversationsOf', () => {
  it('成员看到自己的群：名字、成员数、预览与最后活动', () => {
    const db = openMemory()
    seedGroup(db, { member: 'alice' })
    db.transaction((handle) =>
      ingestGroupMessage(handle, {
        messageId: 'gm-2',
        organizationId: ORG,
        senderId: 'bob',
        groupId: 'grp-1',
        groupName: '产品组',
        body: '第二条',
        operationId: 'op-2',
        now: at(1000),
      }),
    )
    const rows = groupConversationsOf(db.readonlyHandle, ORG, 'alice')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      peerId: 'grp-1',
      peerDisplayName: '产品组',
      kind: 'group',
      memberCount: 3,
      preview: '第二条',
      lastActivityAt: at(1000).toISOString(),
      unreadCount: 0,
      lastMessageOutgoing: false,
    } satisfies Partial<GroupConversationSummary>)
    db.close()
  })

  it('非成员看不到别人的群', () => {
    const db = openMemory()
    seedGroup(db, { member: 'alice' })
    expect(groupConversationsOf(db.readonlyHandle, ORG, 'carol')).toHaveLength(0)
    db.close()
  })

  it('成员在镜像里发过消息但没有成员行时也能看到（取件先于名单同步的兜底）', () => {
    const db = openMemory()
    seedGroup(db, { sender: 'alice' })
    expect(groupConversationsOf(db.readonlyHandle, ORG, 'alice')).toHaveLength(1)
    db.close()
  })

  it('多个群按最后活动倒序', () => {
    const db = openMemory()
    db.transaction((handle) => {
      ingestGroupMessage(handle, {
        messageId: 'g1-m1',
        organizationId: ORG,
        senderId: 'alice',
        groupId: 'grp-1',
        groupName: '早的群',
        body: 'x',
        operationId: 'o1',
        now: at(0),
      })
      ingestGroupMessage(handle, {
        messageId: 'g2-m1',
        organizationId: ORG,
        senderId: 'alice',
        groupId: 'grp-2',
        groupName: '晚的群',
        body: 'y',
        operationId: 'o2',
        now: at(2000),
      })
      addGroupMember(handle, { organizationId: ORG, groupId: 'grp-1', accountId: 'alice', now: at(0) })
      addGroupMember(handle, { organizationId: ORG, groupId: 'grp-2', accountId: 'alice', now: at(0) })
    })
    const rows = groupConversationsOf(db.readonlyHandle, ORG, 'alice')
    expect(rows.map((r) => r.peerId)).toEqual(['grp-2', 'grp-1'])
    db.close()
  })

  it('名单同步过但还没有消息的群也出现在列表（空预览）', () => {
    const db = openMemory()
    db.transaction((handle) => {
      upsertGroupRoster(handle, {
        organizationId: ORG,
        groupId: 'grp-roster',
        name: '刚建的群',
        now: at(5000),
      })
      addGroupMember(handle, { organizationId: ORG, groupId: 'grp-roster', accountId: 'alice', now: at(5000) })
    })
    const rows = groupConversationsOf(db.readonlyHandle, ORG, 'alice')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      peerId: 'grp-roster',
      peerDisplayName: '刚建的群',
      preview: '',
      lastActivityAt: at(5000).toISOString(),
    })
    // 名单还没同步成员数 → 不携带 memberCount
    expect('memberCount' in (rows[0] as object)).toBe(false)
    db.close()
  })

  it('组织隔离（§9）：不返回其他组织的群', () => {
    const db = openMemory()
    seedGroup(db, { member: 'alice' })
    expect(groupConversationsOf(db.readonlyHandle, ORG_OTHER, 'alice')).toHaveLength(0)
    db.close()
  })

  it('超长预览按字素簇截断并加省略号', () => {
    const db = openMemory()
    db.transaction((handle) => {
      ingestGroupMessage(handle, {
        messageId: 'gm-long',
        organizationId: ORG,
        senderId: 'alice',
        groupId: 'grp-1',
        groupName: '产品组',
        body: '啊'.repeat(200),
        operationId: 'op-long',
        now: at(0),
      })
      addGroupMember(handle, { organizationId: ORG, groupId: 'grp-1', accountId: 'alice', now: at(0) })
    })
    const rows = groupConversationsOf(db.readonlyHandle, ORG, 'alice')
    const preview = rows[0]!.preview
    expect(preview.endsWith('…')).toBe(true)
    expect([...preview].length).toBeLessThan(50)
    db.close()
  })

  it('limit 限制返回条数且保留最近的', () => {
    const db = openMemory()
    db.transaction((handle) => {
      for (let i = 0; i < 3; i += 1) {
        ingestGroupMessage(handle, {
          messageId: `gm-${i}`,
          organizationId: ORG,
          senderId: 'alice',
          groupId: `grp-${i}`,
          groupName: `群 ${i}`,
          body: 'x',
          operationId: `op-${i}`,
          now: at(i * 1000),
        })
        addGroupMember(handle, { organizationId: ORG, groupId: `grp-${i}`, accountId: 'alice', now: at(i * 1000) })
      }
    })
    const rows = groupConversationsOf(db.readonlyHandle, ORG, 'alice', { limit: 2 })
    expect(rows.map((r) => r.peerId)).toEqual(['grp-2', 'grp-1'])
    db.close()
  })
})
