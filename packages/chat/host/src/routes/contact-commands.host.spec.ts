/**
 * 联系人端点测试。
 *
 * 第一条是**整个产品能不能用**：加为联系人之后，消息真的发得出去。这条
 * 之前是断的 —— 领域层的准入判定要求已接受的联系人关系，而没有任何入口能
 * 建立它。测试里也一直是直接调 `acceptContactRequest` 写库绕过去的，于是
 * 那个死锁在测试里从来没暴露过。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatDatabase } from '../storage/database.js'

import {
  acceptContactHandler,
  directoryHandler,
  listContactsHandler,
  rejectContactHandler,
  removeContactHandler,
  requestContactHandler,
  type ContactCommandDeps,
  type ContactsView,
  type DirectoryEntry,
} from './contact-commands.js'
import {
  conversationsHandler,
  sendMessageHandler,
  type MessageCommandDeps,
  type Principal,
} from './message-commands.js'

const NOW = new Date('2026-08-30T00:00:00Z')
const ORG = 'org-1'

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
let principal: Principal | undefined
let idCounter = 0

beforeEach(async () => {
  idCounter = 0
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const stamp = NOW.toISOString()
    const account = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    for (const [id, name] of [
      ['jia', '甲'],
      ['yi', '乙'],
      ['bing', '丙'],
      ['wai', '组织外的人'],
    ]) {
      account.run(id, name, stamp)
    }
    db.prepare(
      `INSERT INTO organizations
         (organization_id, name, state, created_by, created_at, updated_at, version, policy_revision)
       VALUES (?,?,'active',?,?,?,1,1)`,
    ).run(ORG, 'Acme', 'jia', stamp, stamp)

    const membership = db.prepare(
      `INSERT INTO memberships
         (membership_id, organization_id, account_id, scope_kind, scope_id, role, state,
          created_at, updated_at, version, policy_revision)
       VALUES (?,?,?,'organization',?,?,?,?,?,1,1)`,
    )
    for (const id of ['jia', 'yi', 'bing']) {
      membership.run(`mem-${id}`, ORG, id, ORG, 'member', 'active', stamp, stamp)
    }
    // 「组织外的人」故意不给成员关系
  })

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: ORG }

  const database = {
    transaction: chat.transaction.bind(chat),
    readonlyHandle: chat.readonlyHandle,
  } as ContactCommandDeps['database']

  const deps: ContactCommandDeps = {
    database,
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    now: () => NOW,
    newId: (prefix) => `${prefix}-${++idCounter}`,
  }
  const messageDeps: MessageCommandDeps = {
    database: database as unknown as MessageCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    queueCapacity: 1000,
    leaseMs: 60_000,
    now: () => NOW,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      for (const [path, handler] of [
        ['/api/organization/directory', directoryHandler(deps)],
        ['/api/chat/contacts', listContactsHandler(deps)],
        ['/api/chat/contacts/request', requestContactHandler(deps)],
        ['/api/chat/contacts/accept', acceptContactHandler(deps)],
        ['/api/chat/contacts/reject', rejectContactHandler(deps)],
        ['/api/chat/contacts/remove', removeContactHandler(deps)],
        ['/api/chat/messages', sendMessageHandler(messageDeps)],
        ['/api/chat/conversations', conversationsHandler(messageDeps)],
      ] as const) {
        inner.effect(
          () => inner.webServer.register({ kind: 'exact', path, handler }),
          `route ${path}`,
        )
      }
    },
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  chat.close()
})

async function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function dataOf<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data
}

function as(accountId: string): void {
  principal = { accountId, deviceId: `${accountId}-laptop`, organizationId: ORG }
}

/** 走完「甲请求 → 乙接受」。 */
async function becomeContacts(a = 'jia', b = 'yi'): Promise<void> {
  as(a)
  const created = await dataOf<{ requestId: string }>(
    await post('/api/chat/contacts/request', { targetId: b }),
  )
  as(b)
  const accepted = await post('/api/chat/contacts/accept', { requestId: created.requestId })
  expect(accepted.status).toBe(200)
  as(a)
}

describe('死锁解开了：加为联系人之后消息发得出去', () => {
  it('不是联系人时发消息被拒', async () => {
    // 这是原来的状态 —— 而且没有任何办法离开它
    const response = await post('/api/chat/messages', {
      messageId: '0192-a',
      recipientId: 'yi',
      body: '你好',
      operationId: 'op-1',
    })
    expect(response.status).toBe(404)
  })

  it('成为联系人之后同一条消息发得出去', async () => {
    await becomeContacts()
    const response = await post('/api/chat/messages', {
      messageId: '0192-b',
      recipientId: 'yi',
      body: '你好',
      operationId: 'op-2',
    })
    expect(response.status).toBe(200)
  })

  it('发完之后会话出现在双方的列表里', async () => {
    // 只测发送成功是不够的：会话列表是用户唯一的入口，不出现等于没发
    await becomeContacts()
    await post('/api/chat/messages', {
      messageId: '0192-c',
      recipientId: 'yi',
      body: '你好',
      operationId: 'op-3',
    })

    const mine = await dataOf<{ conversations: Array<{ peerId: string }> }>(
      await post('/api/chat/conversations'),
    )
    expect(mine.conversations.map((c) => c.peerId)).toContain('yi')

    as('yi')
    const theirs = await dataOf<{ conversations: Array<{ peerId: string }> }>(
      await post('/api/chat/conversations'),
    )
    expect(theirs.conversations.map((c) => c.peerId)).toContain('jia')
  })
})

describe('通讯录', () => {
  it('列出本组织的 active 成员，带上与我的关系', async () => {
    const data = await dataOf<{ members: DirectoryEntry[] }>(
      await post('/api/organization/directory'),
    )
    expect(data.members.map((m) => m.accountId).sort()).toEqual(['bing', 'jia', 'yi'])
    expect(data.members.find((m) => m.accountId === 'jia')?.relation).toBe('self')
    expect(data.members.find((m) => m.accountId === 'yi')?.relation).toBe('none')
  })

  it('不列组织外的人', async () => {
    const data = await dataOf<{ members: DirectoryEntry[] }>(
      await post('/api/organization/directory'),
    )
    expect(data.members.map((m) => m.accountId)).not.toContain('wai')
  })

  it('不是本组织成员时拿不到花名册', async () => {
    // 否则任何人带一个组织 ID 过来就能拿到那个组织的通讯录
    principal = { accountId: 'wai', deviceId: 'wai-laptop', organizationId: ORG }
    expect((await post('/api/organization/directory')).status).toBe(404)
  })

  it('关系随状态变化 —— 界面据此决定显示哪个按钮', async () => {
    as('jia')
    await post('/api/chat/contacts/request', { targetId: 'yi' })

    const mine = await dataOf<{ members: DirectoryEntry[] }>(
      await post('/api/organization/directory'),
    )
    expect(mine.members.find((m) => m.accountId === 'yi')?.relation).toBe('pending_outgoing')

    as('yi')
    const theirs = await dataOf<{ members: DirectoryEntry[] }>(
      await post('/api/organization/directory'),
    )
    expect(theirs.members.find((m) => m.accountId === 'jia')?.relation).toBe('pending_incoming')
  })

  it('接受之后双方都是 contact', async () => {
    await becomeContacts()
    for (const [me, other] of [
      ['jia', 'yi'],
      ['yi', 'jia'],
    ]) {
      as(me as string)
      const data = await dataOf<{ members: DirectoryEntry[] }>(
        await post('/api/organization/directory'),
      )
      expect(data.members.find((m) => m.accountId === other)?.relation, `${me} 看 ${other}`).toBe(
        'contact',
      )
    }
  })
})

describe('发起请求', () => {
  it('不能加自己', async () => {
    expect((await post('/api/chat/contacts/request', { targetId: 'jia' })).status).toBe(404)
  })

  it('不能加组织外的人', async () => {
    // 不查的话，猜一个账号 ID 就能向组织外的人发请求
    expect((await post('/api/chat/contacts/request', { targetId: 'wai' })).status).toBe(404)
  })

  it('重复点不产生第二条请求', async () => {
    const first = await dataOf<{ requestId: string }>(
      await post('/api/chat/contacts/request', { targetId: 'yi' }),
    )
    const second = await dataOf<{ requestId: string }>(
      await post('/api/chat/contacts/request', { targetId: 'yi' }),
    )
    expect(second.requestId).toBe(first.requestId)

    as('yi')
    const view = await dataOf<ContactsView>(await post('/api/chat/contacts'))
    expect(view.incoming).toHaveLength(1)
  })

  it('对方已经请求过我时，我这一下等于接受', async () => {
    // 两人同时点「加联系人」很常见。各挂一条待处理请求会让双方都看到一个
    // 要处理的东西，而实际上事情已经成了
    as('yi')
    await post('/api/chat/contacts/request', { targetId: 'jia' })

    as('jia')
    const result = await dataOf<{ state: string }>(
      await post('/api/chat/contacts/request', { targetId: 'yi' }),
    )
    expect(result.state).toBe('accepted')

    const view = await dataOf<ContactsView>(await post('/api/chat/contacts'))
    expect(view.contacts.map((c) => c.accountId)).toContain('yi')
    expect(view.incoming).toHaveLength(0)
  })
})

describe('处理请求', () => {
  it('只有被请求的那一方能接受', async () => {
    // 不查的话，任何人猜到 requestId 就能替别人接受 —— 而接受的后果是
    // 对方可以给自己发消息
    as('jia')
    const created = await dataOf<{ requestId: string }>(
      await post('/api/chat/contacts/request', { targetId: 'yi' }),
    )

    as('bing')
    expect((await post('/api/chat/contacts/accept', { requestId: created.requestId })).status).toBe(
      404,
    )
    // 请求方自己也不能接受自己的请求
    as('jia')
    expect((await post('/api/chat/contacts/accept', { requestId: created.requestId })).status).toBe(
      404,
    )
  })

  it('拒绝之后对方可以再发（§13：拒绝不创建拉黑）', async () => {
    as('jia')
    const created = await dataOf<{ requestId: string }>(
      await post('/api/chat/contacts/request', { targetId: 'yi' }),
    )
    as('yi')
    await post('/api/chat/contacts/reject', { requestId: created.requestId })

    as('jia')
    const again = await post('/api/chat/contacts/request', { targetId: 'yi' })
    expect(again.status).toBe(200)
  })

  it('删除联系人之后消息发不出去了', async () => {
    await becomeContacts()
    await post('/api/chat/contacts/remove', { peerId: 'yi' })

    const response = await post('/api/chat/messages', {
      messageId: '0192-d',
      recipientId: 'yi',
      body: '还在吗',
      operationId: 'op-4',
    })
    expect(response.status).toBe(404)
  })
})

describe('我的联系人列表', () => {
  it('分成已接受、待我处理、我发出的三组', async () => {
    as('bing')
    await post('/api/chat/contacts/request', { targetId: 'jia' })
    await becomeContacts('jia', 'yi')

    as('jia')
    await post('/api/chat/contacts/request', { targetId: 'wai' }) // 会被拒，不该出现

    const view = await dataOf<ContactsView>(await post('/api/chat/contacts'))
    expect(view.contacts.map((c) => c.accountId)).toEqual(['yi'])
    expect(view.incoming.map((r) => r.accountId)).toEqual(['bing'])
    expect(view.outgoing).toHaveLength(0)
  })

  it('带上显示名 —— 界面不该只能显示一串账号 ID', async () => {
    await becomeContacts()
    const view = await dataOf<ContactsView>(await post('/api/chat/contacts'))
    expect(view.contacts[0]?.displayName).toBe('乙')
  })
})
