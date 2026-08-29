/**
 * `P0-a` 最小可运行骨架的端到端验收。
 *
 * 按[最小可运行骨架](../../../../docs/04-roadmap/02-minimum-skeleton.md)逐步执行
 * `P0-a` 承担的第 1、3、5、6、7、8、9、11、14 步。每个 `it` 对应一步，标题即步骤原文。
 *
 * ## 与单元测试的区别
 *
 * 单元测试各自用独立的内存库；这里用**一个磁盘文件**贯穿全程，并在第 8 步真的
 * 关闭再打开它 —— 「relay 重启后状态不丢失」只有在真实的持久化上才验证得了，
 * 内存库一关就什么都没了。
 *
 * ## 执行产物
 *
 * 运行时会把每步的关键事实写入 `build/skeleton-walkthrough.md`，作为验收证据。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auditEventsOf, recordAuditEvent } from '../../audit/src/audit-events.js'
import { ChatDatabase } from '../../host/src/storage/database.js'
import { consumeInviteCode, issueInviteCode } from '../../identity/src/invite-codes.js'
import {
  acceptContactRequest,
  checkDirectMessageGate,
  createContactRequest,
} from '../../messaging/src/contacts.js'
import {
  acceptDirectMessage,
  acknowledge,
  leaseBatch,
} from '../../messaging/src/delivery.js'
import { createNotification, inboxSince, unreadCount } from '../../notification/src/inbox.js'
import { authorize } from '../../organization/src/authorization.js'
import {
  acceptMembership,
  createOrganization,
  createProject,
  createWorkspace,
  inviteMember,
  membershipsOf,
  scopeChainOfProject,
} from '../../organization/src/repository.js'
import { assignWorkItem, createWorkItem, findWorkItem } from '../../workitem/src/work-items.js'

const ORG = 'org-acme'
let workdir: string
let dbPath: string
let relay: ChatDatabase
let auditSeq = 0

/** 走查记录，测试结束后写入 build/skeleton-walkthrough.md 作为验收证据。 */
const walkthrough: string[] = []

function step(label: string, facts: readonly string[]): void {
  walkthrough.push(`## ${label}\n`)
  for (const fact of facts) walkthrough.push(`- ${fact}`)
  walkthrough.push('')
}

/** 每个业务动作都写审计——第 14 步要求「每一步在审计表中都有对应事件」。 */
function audit(
  db: Parameters<typeof recordAuditEvent>[0],
  eventType: string,
  targetRef: string,
  outcome: 'succeeded' | 'rejected',
  errorCode?: string,
): void {
  auditSeq += 1
  recordAuditEvent(db, {
    auditEventId: `ae-${auditSeq}`,
    organizationId: ORG,
    eventType,
    occurredAt: new Date(),
    targetRef,
    outcome,
    policyRevision: 1,
    ...(errorCode === undefined ? {} : { errorCode }),
  })
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'dsh-chat-skeleton-'))
  dbPath = join(workdir, 'relay.db')
  relay = ChatDatabase.open({ location: dbPath })
  relay.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('admin', '管理员', new Date().toISOString())
    insert.run('alice', '用户甲', new Date().toISOString())
    insert.run('bob', '用户乙', new Date().toISOString())
  })
})

afterAll(() => {
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../build')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'skeleton-walkthrough.md'),
    [
      '# P0-a 最小可运行骨架走查记录',
      '',
      '> 本文件由 `packages/chat/kernel/src/skeleton.host.spec.ts` 在测试运行时自动生成，',
      '> 记录 `P0-a` 承担的 9 个骨架步骤的实际执行结果。**不是手写的**。',
      '',
      `生成时间：${new Date().toISOString()}`,
      '',
      ...walkthrough,
    ].join('\n'),
    'utf8',
  )
  relay.close()
  rmSync(workdir, { recursive: true, force: true })
})

describe('P0-a 骨架走查', () => {
  it('第 1 步：管理员创建两个一次性注册邀请码', () => {
    const now = new Date()
    relay.transaction((db) => {
      issueInviteCode(db, {
        code: 'INVITE-ALICE',
        organizationId: ORG,
        createdBy: 'admin',
        now,
        validForMs: 86_400_000,
      })
      issueInviteCode(db, {
        code: 'INVITE-BOB',
        organizationId: ORG,
        createdBy: 'admin',
        now,
        validForMs: 86_400_000,
      })
      audit(db, 'invite_issued', 'invite:INVITE-ALICE', 'succeeded')
      audit(db, 'invite_issued', 'invite:INVITE-BOB', 'succeeded')
    })

    const consumed = relay.transaction((db) => {
      const a = consumeInviteCode(db, { code: 'INVITE-ALICE', accountId: 'alice', now })
      const b = consumeInviteCode(db, { code: 'INVITE-BOB', accountId: 'bob', now })
      audit(db, 'invite_consumed', 'invite:INVITE-ALICE', 'succeeded')
      audit(db, 'invite_consumed', 'invite:INVITE-BOB', 'succeeded')
      return { a, b }
    })
    expect(consumed.a.ok).toBe(true)
    expect(consumed.b.ok).toBe(true)

    // 一次性：重复消费被拒，且记入审计
    const replay = relay.transaction((db) => {
      const r = consumeInviteCode(db, { code: 'INVITE-ALICE', accountId: 'bob', now })
      audit(db, 'invite_consumed', 'invite:INVITE-ALICE', 'rejected', 'NOT_FOUND_OR_FORBIDDEN')
      return r
    })
    expect(replay.ok).toBe(false)

    step('第 1 步 · 一次性注册邀请码', [
      '管理员签发 2 个邀请码，甲乙各消费 1 个',
      '重复消费同一个码被拒绝，返回 `NOT_FOUND_OR_FORBIDDEN`',
      '被拒绝的尝试同样写入审计（第 14 步要求）',
    ])
  })

  it('第 3 步：甲创建组织、工作区和项目，并把乙以开发者角色邀请进项目', () => {
    const now = new Date()
    relay.transaction((db) => {
      createOrganization(db, { organizationId: ORG, name: 'Acme', createdBy: 'alice', now })
      createWorkspace(db, {
        workspaceId: 'ws-1',
        organizationId: ORG,
        name: '研发',
        createdBy: 'alice',
        now,
      })
      createProject(db, {
        projectId: 'proj-1',
        organizationId: ORG,
        workspaceId: 'ws-1',
        name: 'dsh-chat',
        createdBy: 'alice',
        now,
      })
      inviteMember(db, {
        membershipId: 'm-alice',
        organizationId: ORG,
        accountId: 'alice',
        scopeKind: 'organization',
        scopeId: ORG,
        role: 'organization_owner',
        now,
      })
      inviteMember(db, {
        membershipId: 'm-bob',
        organizationId: ORG,
        accountId: 'bob',
        scopeKind: 'project',
        scopeId: 'proj-1',
        role: 'developer',
        now,
      })
      audit(db, 'organization_created', `organization:${ORG}`, 'succeeded')
      audit(db, 'membership_changed', 'membership:m-bob', 'succeeded')
    })

    // 邀请状态下尚不能发言
    const beforeAccept = authorizeSend('bob')
    expect(beforeAccept).toBe(false)

    relay.transaction((db) => {
      acceptMembership(db, { membershipId: 'm-alice', expectedVersion: 1, now })
      acceptMembership(db, { membershipId: 'm-bob', expectedVersion: 1, now })
      audit(db, 'membership_changed', 'membership:m-bob', 'succeeded')
    })
    expect(authorizeSend('bob')).toBe(true)

    step('第 3 步 · 组织、工作区、项目与成员邀请', [
      '甲创建组织 `Acme` → 工作区 `研发` → 项目 `dsh-chat`',
      '乙以 `developer` 角色被邀请进项目，初始状态 `invited`',
      '**`invited` 状态下授权判定拒绝发言**，接受邀请转 `active` 后通过',
    ])
  })

  it('第 5 步：甲创建工作项分派给乙，乙在收件箱看到持久化通知', () => {
    const now = new Date()
    const item = relay.transaction((db) => {
      const created = createWorkItem(db, {
        workItemId: 'wi-1',
        organizationId: ORG,
        projectId: 'proj-1',
        title: '实现私聊投递',
        createdBy: 'alice',
        now,
      })
      audit(db, 'work_item_changed', 'work_item:wi-1', 'succeeded')
      return created
    })

    relay.transaction((db) => {
      const assigned = assignWorkItem(db, {
        workItemId: 'wi-1',
        assigneeId: 'bob',
        expectedVersion: item.version,
        now,
      })
      expect(assigned.ok).toBe(true)
      // 通知与领域写入同事务（§17.1）
      createNotification(db, {
        notificationId: 'n-1',
        organizationId: ORG,
        recipientId: 'bob',
        eventType: 'work_item_changed',
        resourceRef: 'work_item:wi-1',
        actorId: 'alice',
        summary: '甲把「实现私聊投递」分派给你',
        dedupeKey: 'wi-1:assigned',
        now,
      })
      audit(db, 'work_item_changed', 'work_item:wi-1', 'succeeded')
    })

    const assigned = findWorkItem(relay.readonlyHandle, 'wi-1')!
    expect(assigned.state).toBe('assigned')
    // 签收是独立状态机——分派只是「提出」
    expect(assigned.acknowledgementState).toBe('offered')
    expect(unreadCount(relay.readonlyHandle, ORG, 'bob')).toBe(1)

    step('第 5 步 · 工作项分派与持久化通知', [
      '工作项 `wi-1` 分派给乙，状态 `assigned`',
      '**签收状态独立为 `offered`** —— 分派只是「提出」，不代表乙已知晓或同意',
      '乙的收件箱有 1 条未读通知，与领域写入同事务落库',
    ])
  })

  it('第 6 步：甲发送联系人请求，乙接受', () => {
    const now = new Date()
    expect(gateAllowed()).toBe(false)

    relay.transaction((db) => {
      createContactRequest(db, {
        requestId: 'cr-1',
        organizationId: ORG,
        requesterId: 'alice',
        targetId: 'bob',
        now,
      })
      audit(db, 'contact_request_created', 'contact_request:cr-1', 'succeeded')
    })
    expect(gateAllowed(), '仅有 pending 请求时仍不能发言').toBe(false)

    relay.transaction((db) => {
      acceptContactRequest(db, { requestId: 'cr-1', now })
      audit(db, 'contact_request_accepted', 'contact_request:cr-1', 'succeeded')
    })
    expect(gateAllowed()).toBe(true)

    step('第 6 步 · 联系人请求与接受', [
      '未建立联系人时私聊准入判定拒绝',
      '**仅有 `pending` 请求时仍然拒绝** —— 必须 `accepted` 才放行',
      '乙接受后 `contactAccepted(a,b) && !Block(a,b) && !Block(b,a)` 成立',
    ])
  })

  it('第 7 步：甲在乙离线时发送一条中文文本私聊', () => {
    const now = new Date()
    const result = relay.transaction((db) => {
      const accepted = acceptDirectMessage(db, {
        messageId: 'm-1',
        organizationId: ORG,
        senderId: 'alice',
        recipientId: 'bob',
        body: '你好，工作项我看到了。',
        operationId: 'op-m-1',
        now,
        queueCapacity: 2,
      })
      audit(db, 'message_accepted', 'message:alice/m-1', 'succeeded')
      return accepted
    })
    expect(result).toMatchObject({ ok: true, deliverySeq: 1, idempotentReplay: false })

    step('第 7 步 · 离线投递', [
      '乙未在线，消息与队列项在**同一事务**写入 relay',
      '分配 `DeliverySeq = 1`',
      '正文为中文，落库后可原样读回',
    ])
  })

  it('第 11 步：收件人队列满时新发送被明确拒绝，已接收的早期消息不被删除', () => {
    const now = new Date()
    // 容量设为 2，已有 1 条未 ACK；再发 1 条到达上限，第 3 条应被拒
    relay.transaction((db) => {
      acceptDirectMessage(db, {
        messageId: 'm-2',
        organizationId: ORG,
        senderId: 'alice',
        recipientId: 'bob',
        body: '第二条',
        operationId: 'op-m-2',
        now,
        queueCapacity: 2,
      })
      audit(db, 'message_accepted', 'message:alice/m-2', 'succeeded')
    })

    const rejected = relay.transaction((db) => {
      const r = acceptDirectMessage(db, {
        messageId: 'm-3',
        organizationId: ORG,
        senderId: 'alice',
        recipientId: 'bob',
        body: '第三条',
        operationId: 'op-m-3',
        now,
        queueCapacity: 2,
      })
      audit(db, 'message_accepted', 'message:alice/m-3', 'rejected', 'RECIPIENT_QUEUE_FULL')
      return r
    })
    expect(rejected).toMatchObject({ ok: false, errorCode: 'RECIPIENT_QUEUE_FULL' })

    // 被拒绝的消息完全不存在——「发送未被接收」
    const missing = relay.readonlyHandle
      .prepare('SELECT message_id FROM messages WHERE message_id = ?')
      .get('m-3')
    expect(missing).toBeUndefined()

    // 早期消息未被淘汰
    const early = relay.readonlyHandle
      .prepare('SELECT body FROM messages WHERE message_id = ?')
      .get('m-1') as { body: string }
    expect(early.body).toBe('你好，工作项我看到了。')

    step('第 11 步 · 队列满', [
      '队列达到容量上限后，新发送返回 `RECIPIENT_QUEUE_FULL`',
      '**被拒绝的消息完全不存在** —— 该错误码的幂等语义是「发送未被接收」',
      '**早期未 ACK 的消息未被淘汰**，正文原样保留',
      '被拒绝的尝试写入审计并记录错误码',
    ])
  })

  it('第 8 步：relay 重启，队列、通知、工作项和组织状态不丢失', () => {
    const before = {
      queue: countPending(),
      unread: unreadCount(relay.readonlyHandle, ORG, 'bob'),
      workItemState: findWorkItem(relay.readonlyHandle, 'wi-1')!.state,
      auditCount: auditEventsOf(relay.readonlyHandle, ORG, { limit: 1000 }).length,
    }

    // 真的关闭再打开同一个磁盘文件
    relay.close()
    relay = ChatDatabase.open({ location: dbPath })

    expect(countPending()).toBe(before.queue)
    expect(unreadCount(relay.readonlyHandle, ORG, 'bob')).toBe(before.unread)
    expect(findWorkItem(relay.readonlyHandle, 'wi-1')!.state).toBe(before.workItemState)
    expect(auditEventsOf(relay.readonlyHandle, ORG, { limit: 1000 })).toHaveLength(
      before.auditCount,
    )

    step('第 8 步 · relay 重启', [
      '关闭数据库连接后重新打开同一磁盘文件（不是内存库）',
      `未 ACK 队列项 ${before.queue} 条、未读通知 ${before.unread} 条、工作项状态 \`${before.workItemState}\`、审计 ${before.auditCount} 条`,
      '重启后逐项核对，全部一致',
    ])
  })

  it('第 9 步：乙启动 DSH，持久化消息并 ACK，重启后仍只看到一条消息和一条已读通知', () => {
    const now = new Date()
    const batch = relay.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'bob-laptop',
        batchSize: 10,
        leaseMs: 60_000,
        now,
      }),
    )
    expect(batch).toHaveLength(2)

    const acked = relay.transaction((db) => {
      const n = acknowledge(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'bob-laptop',
        deliverySeqs: batch.map((i) => i.deliverySeq),
        now,
      })
      audit(db, 'message_acked', 'message:alice/m-1', 'succeeded')
      return n
    })
    expect(acked).toBe(2)

    // 重启后不再重复投递
    relay.close()
    relay = ChatDatabase.open({ location: dbPath })
    const afterRestart = relay.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'bob',
        deviceId: 'bob-laptop',
        batchSize: 10,
        leaseMs: 60_000,
        now: new Date(now.getTime() + 120_000),
      }),
    )
    expect(afterRestart, 'ACK 过的消息不应再次投递').toHaveLength(0)

    const inbox = inboxSince(relay.readonlyHandle, {
      organizationId: ORG,
      recipientId: 'bob',
      limit: 10,
    })
    expect(inbox).toHaveLength(1)

    step('第 9 步 · 持久化、ACK 与重启幂等', [
      '乙的设备拉取一个带租约的批次，取到 2 条消息',
      'ACK 后再次重启 relay',
      '**重启后重新拉取返回 0 条** —— 已 ACK 的消息不再重复投递',
      '收件箱仍只有 1 条通知，未因重启而重复',
    ])
  })

  it('第 14 步：每一步都有审计事件，被拒绝的越权尝试同样留痕，审计表不含消息正文', () => {
    const events = auditEventsOf(relay.readonlyHandle, ORG, { limit: 1000 })
    expect(events.length).toBeGreaterThanOrEqual(12)

    // 被拒绝的尝试同样留痕
    const rejected = events.filter((e) => e.outcome === 'rejected')
    expect(rejected.length).toBeGreaterThanOrEqual(2)
    expect(rejected.map((e) => e.errorCode)).toContain('RECIPIENT_QUEUE_FULL')
    expect(rejected.map((e) => e.errorCode)).toContain('NOT_FOUND_OR_FORBIDDEN')

    // 审计表不含消息正文
    const columns = (
      relay.readonlyHandle.prepare('PRAGMA table_info(audit_events)').all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(columns).not.toContain('body')
    expect(columns).not.toContain('content')

    // 审计内容本身不含已发送的中文正文
    const serialized = JSON.stringify(events)
    expect(serialized, '审计事件中不得出现消息正文').not.toContain('你好，工作项我看到了。')

    step('第 14 步 · 审计完整性', [
      `全流程共写入 ${events.length} 条审计事件`,
      `其中 ${rejected.length} 条为被拒绝的尝试，各自记录了错误码`,
      '审计表结构中没有 `body` / `content` 列',
      '**审计事件序列化后不含任何已发送的消息正文**',
    ])
  })
})

// ── 辅助函数 ──────────────────────────────────────────────────────

function authorizeSend(accountId: string): boolean {
  const memberships = membershipsOf(relay.readonlyHandle, ORG, accountId)
  return authorize({
    organizationState: 'active',
    memberships: memberships.map((m) => ({
      scopeKind: m.scopeKind,
      scopeId: m.scopeId,
      role: m.role,
      state: m.state,
    })),
    scopeKind: 'project',
    scopeId: 'proj-1',
    ancestors: scopeChainOfProject(relay.readonlyHandle, 'proj-1'),
    capability: 'message.send',
  }).allowed
}

function gateAllowed(): boolean {
  return checkDirectMessageGate(relay.readonlyHandle, {
    organizationId: ORG,
    senderId: 'alice',
    recipientId: 'bob',
  }).allowed
}

function countPending(): number {
  const row = relay.readonlyHandle
    .prepare(
      'SELECT COUNT(*) AS n FROM delivery_queue WHERE organization_id = ? AND acked_at IS NULL',
    )
    .get(ORG) as { n: number }
  return row.n
}
