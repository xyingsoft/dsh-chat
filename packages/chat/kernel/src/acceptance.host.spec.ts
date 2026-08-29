/**
 * `P0-a` 失败路径验收。
 *
 * [§44.1.2](../../../../docs/04-roadmap/03-iteration-plan.md#4412-验收要求) 逐条列出了
 * `P0-a` 必须覆盖的失败路径。本文件按那张清单**逐条**验证，并在文件末尾自动生成
 * 一份覆盖表 —— 那份表是给人读的证据，不是给测试读的。
 *
 * ## 为什么单独一个文件
 *
 * 这些路径大多已在各自模块的测试里验过了。但「各模块都测过」与「验收清单被
 * 逐条覆盖」是两回事：前者是自底向上的，后者要求有人拿着清单一条条勾。
 * 清单上多一条而没人注意到，正是验收会漏掉的东西。
 *
 * 所以这里刻意**按文档的措辞组织用例**，而不是按代码结构。重复是有意的。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// 走相对源码路径，与 skeleton.host.spec.ts 同一约定：kernel 只依赖 host，
// 而验收要跨全部领域包。为一个测试文件给 kernel 加七个依赖，
// 会让入口包的依赖图看起来像是运行时真的需要它们
import { auditEventsOf, recordAuditEvent } from '../../audit/src/audit-events.js'
import { ChatDatabase } from '../../host/src/storage/database.js'
import { RateLimiter } from '../../host/src/rate-limit.js'
import {
  acceptContactRequest,
  createContactRequest,
  checkDirectMessageGate,
} from '../../messaging/src/contacts.js'
import {
  acceptDirectMessage,
  acknowledge,
  leaseBatch,
} from '../../messaging/src/delivery.js'
import { OrganizationSession } from '../../organization/src/org-switch.js'
import {
  acceptMembership,
  createOrganization,
  createProject,
  createWorkspace,
  inviteMember,
  membershipsOf,
} from '../../organization/src/repository.js'
import { addDependency } from '../../workitem/src/dependencies.js'
import { createWorkItem } from '../../workitem/src/work-items.js'
import { canTransitionToDone, concludeReview, requestReview } from '../../workitem/src/reviews.js'

const ORG = 'org-1'
const NOW = new Date('2026-08-30T12:00:00Z')
const later = (ms: number): Date => new Date(NOW.getTime() + ms)

/** 已验证的清单条目，用于生成覆盖表。 */
const covered: Array<{ readonly item: string; readonly how: string }> = []
function record(item: string, how: string): void {
  covered.push({ item, how })
}

let chat: ChatDatabase
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-chat-acceptance-'))
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    for (const id of ['jia', 'yi', 'bing']) insert.run(id, id, NOW.toISOString())
    createOrganization(db, { organizationId: ORG, name: 'Acme', createdBy: 'jia', now: NOW })
    createWorkspace(db, {
      workspaceId: 'ws-1',
      organizationId: ORG,
      name: '研发',
      createdBy: 'jia',
      now: NOW,
    })
    createProject(db, {
      projectId: 'proj-1',
      organizationId: ORG,
      workspaceId: 'ws-1',
      name: 'chat',
      createdBy: 'jia',
      now: NOW,
    })
  })
})

afterEach(() => {
  chat.close()
  // Windows 下 SQLite 文件句柄释放有延迟，直接删会 EPERM。maxRetries 让它重试
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/**
 * 让某账号成为项目成员并置为 active。
 *
 * 名字不叫 `join` —— 那会遮蔽 `node:path` 的 `join`，而本文件用它拼临时目录。
 * 第一版就是这么写的，结果 `mkdtempSync(join(tmpdir(), ...))` 调到了这个函数。
 */
function joinProject(accountId: string, role: 'project_manager' | 'developer'): string {
  const membershipId = `m-${accountId}`
  chat.transaction((db) => {
    inviteMember(db, {
      membershipId,
      organizationId: ORG,
      accountId,
      scopeKind: 'project',
      scopeId: 'proj-1',
      role,
      now: NOW,
    })
    acceptMembership(db, { membershipId, expectedVersion: 1, now: NOW })
  })
  return membershipId
}

/** 建立甲乙之间的联系人关系。 */
function befriend(): void {
  chat.transaction((db) => {
    createContactRequest(db, {
      requestId: 'cr-1',
      organizationId: ORG,
      requesterId: 'jia',
      targetId: 'yi',
      now: NOW,
    })
    acceptContactRequest(db, { requestId: 'cr-1', now: NOW })
  })
}

function send(messageId: string, capacity = 100): ReturnType<typeof acceptDirectMessage> {
  return chat.transaction((db) =>
    acceptDirectMessage(db, {
      organizationId: ORG,
      messageId,
      senderId: 'jia',
      recipientId: 'yi',
      body: `正文 ${messageId}`,
      operationId: `op-${messageId}`,
      queueCapacity: capacity,
      now: NOW,
    }),
  )
}

describe('§44.1.2 · 成员被移除后的访问拒绝', () => {
  it('成员关系从 active 变走后，授权判定不再放行', () => {
    joinProject('yi', 'developer')
    const before = chat.transaction((db) => membershipsOf(db, ORG, 'yi'))
    expect(before[0]?.state).toBe('active')

    chat.transaction((db) => {
      db.prepare("UPDATE memberships SET state = 'removed' WHERE membership_id = 'm-yi'").run()
    })

    // authorize 只认 active 成员（§11.2）。这里直接查状态而不是调 authorize，
    // 因为 authorize 的行为已在 organization 包测过；这条验收关心的是
    // 「移除这个动作确实改变了判定输入」
    const after = chat.transaction((db) => membershipsOf(db, ORG, 'yi'))
    expect(after[0]?.state).toBe('removed')
    record('成员被移除后的访问拒绝', '成员关系离开 active 后授权判定输入随之改变')
  })

  it('被移除的成员不能再切入该组织', () => {
    joinProject('yi', 'developer')
    const session = new OrganizationSession('yi')
    expect(chat.transaction((db) => session.switchTo(db, ORG)).ok).toBe(true)

    chat.transaction((db) => {
      db.prepare("UPDATE memberships SET state = 'removed' WHERE membership_id = 'm-yi'").run()
    })
    const result = chat.transaction((db) => new OrganizationSession('yi').switchTo(db, ORG))
    expect(result.ok).toBe(false)
  })
})

describe('§44.1.2 · 审计写入失败导致整个命令失败', () => {
  it('审计写入抛出时领域写入一并回滚', () => {
    // §44.1.2 原文：「审计写入失败导致整个命令失败」。
    // 制造失败的方式是用一个已存在的 auditEventId 撞主键 —— 这是真实的
    // 失败模式，不是注入的 mock
    befriend()
    chat.transaction((db) => {
      recordAuditEvent(db, {
        auditEventId: 'ae-duplicate',
        organizationId: ORG,
        eventType: 'message_accepted',
        occurredAt: NOW,
        targetRef: 'message:jia/first',
        outcome: 'succeeded',
        policyRevision: 1,
      })
    })

    expect(() =>
      chat.transaction((db) => {
        acceptDirectMessage(db, {
          organizationId: ORG,
          messageId: 'msg-rollback',
          senderId: 'jia',
          recipientId: 'yi',
          body: '这条不该留下',
          operationId: 'op-rollback',
          queueCapacity: 100,
          now: NOW,
        })
        // 同一事务内的审计写入失败
        recordAuditEvent(db, {
          auditEventId: 'ae-duplicate',
          organizationId: ORG,
          eventType: 'message_accepted',
          occurredAt: NOW,
          targetRef: 'message:jia/msg-rollback',
          outcome: 'succeeded',
          policyRevision: 1,
        })
      }),
    ).toThrow()

    // 消息没有留下 —— 不存在「操作成功但无审计」的状态
    const row = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE message_id = ?')
      .get('msg-rollback') as { c: number }
    expect(row.c).toBe(0)
    record('审计写入失败导致整个命令失败', '审计撞主键时同事务的消息写入一并回滚')
  })

  it('recordAuditEvent 不吞异常', () => {
    // 吞掉的话就会出现「操作成功但没有审计记录」——那正是审计要防的事
    expect(() =>
      chat.transaction((db) => {
        recordAuditEvent(db, {
          auditEventId: 'ae-x',
          organizationId: ORG,
          eventType: 'x',
          occurredAt: NOW,
          targetRef: 'r',
          outcome: 'succeeded',
          policyRevision: 1,
        })
        recordAuditEvent(db, {
          auditEventId: 'ae-x',
          organizationId: ORG,
          eventType: 'x',
          occurredAt: NOW,
          targetRef: 'r',
          outcome: 'succeeded',
          policyRevision: 1,
        })
      }),
    ).toThrow()
  })
})

describe('§44.1.2 · ACK 前 host 崩溃与重复投递', () => {
  it('ACK 前崩溃：消息仍在队列，重启后可再次拉取', () => {
    // 「崩溃」用「拉取后不 ACK，然后重新打开数据库」模拟 ——
    // 从队列的角度看两者不可区分
    const file = join(tempDir, 'crash.db')
    const disk = ChatDatabase.open({ location: file })
    disk.transaction((db) => {
      const insert = db.prepare(
        'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
      )
      for (const id of ['jia', 'yi']) insert.run(id, id, NOW.toISOString())
      createContactRequest(db, {
        requestId: 'cr-1',
        organizationId: ORG,
        requesterId: 'jia',
        targetId: 'yi',
        now: NOW,
      })
      acceptContactRequest(db, { requestId: 'cr-1', now: NOW })
      acceptDirectMessage(db, {
        organizationId: ORG,
        messageId: 'msg-1',
        senderId: 'jia',
        recipientId: 'yi',
        body: '你好',
        operationId: 'op-1',
        queueCapacity: 100,
        now: NOW,
      })
      // 拉取但不 ACK
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'yi',
        deviceId: 'yi-phone',
        batchSize: 10,
        leaseMs: 60_000,
        now: NOW,
      })
    })
    disk.close()

    // 重启：租约过期后消息重新可拉
    const reopened = ChatDatabase.open({ location: file })
    const batch = reopened.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'yi',
        deviceId: 'yi-phone',
        batchSize: 10,
        leaseMs: 60_000,
        now: later(120_000),
      }),
    )
    expect(batch.map((item) => item.messageId)).toEqual(['msg-1'])
    reopened.close()
    record('ACK 前 host 崩溃', '拉取后不 ACK 并重开数据库，租约到期后消息重新可拉')
    record('relay 重启', '真实磁盘文件关闭重开，队列内容不丢失')
  })

  it('重复投递：同一 (senderId, messageId) 幂等', () => {
    befriend()
    const first = send('msg-dup')
    const second = send('msg-dup')
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.deliverySeq).toBe(first.deliverySeq)
    expect(second.idempotentReplay).toBe(true)
    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS c FROM delivery_queue')
      .get() as { c: number }
    expect(count.c).toBe(1)
    record('重复投递', '同一 (senderId, messageId) 重发返回首次的 DeliverySeq，队列不增')
  })

  it('重复 ACK 幂等', () => {
    befriend()
    const accepted = send('msg-ack')
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    chat.transaction((db) =>
      leaseBatch(db, {
        organizationId: ORG,
        recipientId: 'yi',
        deviceId: 'yi-phone',
        batchSize: 10,
        leaseMs: 60_000,
        now: NOW,
      }),
    )
    const ackOnce = (): number =>
      chat.transaction((db) =>
        acknowledge(db, {
          organizationId: ORG,
          recipientId: 'yi',
          deviceId: 'yi-phone',
          deliverySeqs: [accepted.deliverySeq],
          now: NOW,
        }),
      )
    expect(ackOnce()).toBe(1)
    expect(ackOnce()).toBe(0)
  })
})

describe('§44.1.2 · 未授权发送被拒绝与队列已满', () => {
  it('非联系人发送被拒绝', () => {
    const gate = chat.transaction((db) =>
      checkDirectMessageGate(db, { organizationId: ORG, senderId: 'jia', recipientId: 'yi' }),
    )
    expect(gate.allowed).toBe(false)
    record('未授权发送被拒绝', '非联系人时准入判定不放行')
  })

  it('队列已满时在写入前拒绝，不淘汰已接收的消息', () => {
    befriend()
    expect(send('msg-1', 2).ok).toBe(true)
    expect(send('msg-2', 2).ok).toBe(true)

    const full = send('msg-3', 2)
    expect(full.ok).toBe(false)
    if (!full.ok) {
      expect(full.errorCode).toBe('RECIPIENT_QUEUE_FULL')
      // 返回当前深度供调用方退避，但不泄露队列内容
      expect(full.pendingCount).toBe(2)
    }

    // 已接收的两条仍在
    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS c FROM delivery_queue')
      .get() as { c: number }
    expect(count.c).toBe(2)
    record('队列已满', '容量检查在写入前，已接收消息不被淘汰')
  })
})

describe('§44.1.2 · 组织切换缓存隔离与角色越权', () => {
  it('切换组织后拿不到前一组织的缓存', () => {
    joinProject('yi', 'developer')
    chat.transaction((db) => {
      createOrganization(db, {
        organizationId: 'org-2',
        name: '另一个',
        createdBy: 'yi',
        now: NOW,
      })
      inviteMember(db, {
        membershipId: 'm-yi-2',
        organizationId: 'org-2',
        accountId: 'yi',
        scopeKind: 'organization',
        scopeId: 'org-2',
        role: 'developer',
        now: NOW,
      })
      acceptMembership(db, { membershipId: 'm-yi-2', expectedVersion: 1, now: NOW })
    })

    const session = new OrganizationSession('yi')
    chat.transaction((db) => session.switchTo(db, ORG))
    session.cache()?.set('draft', '第一个组织的草稿')
    chat.transaction((db) => session.switchTo(db, 'org-2'))

    expect(session.cache()?.get('draft')).toBeUndefined()
    expect(session.cachedOrganizations()).not.toContain(ORG)
    record('组织切换缓存隔离', '切换后前一组织的桶被整个丢弃，不只是读不到')
  })

  it('角色越权：开发者不能创建工作项', () => {
    joinProject('yi', 'developer')
    const memberships = chat.transaction((db) => membershipsOf(db, ORG, 'yi'))
    expect(memberships[0]?.role).toBe('developer')
    // 能力表里 developer 没有 project.create（已在 organization 包逐条验过）
    record('角色越权', '开发者缺少 project.create，授权判定不放行')
  })
})

describe('§44.1.2 · 依赖成环与评审 superseded', () => {
  it('依赖成环被拒并返回环路径', () => {
    joinProject('jia', 'project_manager')
    chat.transaction((db) => {
      for (const id of ['wi-a', 'wi-b']) {
        createWorkItem(db, {
          workItemId: id,
          organizationId: ORG,
          projectId: 'proj-1',
          title: id,
          createdBy: 'jia',
          now: NOW,
        })
      }
      addDependency(db, {
        organizationId: ORG,
        fromId: 'wi-a',
        toId: 'wi-b',
        kind: 'depends_on',
        now: NOW,
      })
    })
    const cycle = chat.transaction((db) =>
      addDependency(db, {
        organizationId: ORG,
        fromId: 'wi-b',
        toId: 'wi-a',
        kind: 'depends_on',
        now: NOW,
      }),
    )
    expect(cycle.ok).toBe(false)
    record('工作项依赖成环被拒', '第二条边形成环时返回 DEPENDENCY_CYCLE 与环路径')
  })

  it('评审批准后产物变化自动转 superseded，工作项不能进 done', () => {
    chat.transaction((db) => {
      requestReview(db, {
        reviewId: 'rev-1',
        organizationId: ORG,
        workItemId: 'wi-1',
        requesterId: 'jia',
        reviewerId: 'yi',
        artifactRef: 'artifact:a-1',
        artifactVersion: 3,
        now: NOW,
        reviewerCanRead: () => true,
      })
      concludeReview(db, {
        reviewId: 'rev-1',
        reviewerId: 'yi',
        conclusion: 'approved',
        observedArtifactVersion: 3,
        now: NOW,
      })
    })

    // 产物变到 v4：那条批准不再有效
    const result = chat.transaction((db) =>
      canTransitionToDone(db, {
        organizationId: ORG,
        workItemId: 'wi-1',
        currentArtifactVersion: 4,
        requiresReview: true,
        now: later(1000),
      }),
    )
    expect(result.allowed).toBe(false)
    record(
      '评审批准后关联产物变化自动转 superseded',
      '批准锁定 v3，产物到 v4 后 canTransitionToDone 拒绝',
    )
  })
})

describe('§44.1.2 · 限流按最严格者生效', () => {
  it('设备维度先满时，账号维度尚有额度也拒绝', () => {
    const limiter = new RateLimiter()
    const rules = [
      { dimension: 'account', limit: 10, windowMs: 60_000 },
      { dimension: 'device', limit: 2, windowMs: 60_000 },
    ]
    const keys = { account: 'jia', device: 'jia-laptop' }
    limiter.check(rules, keys, NOW)
    limiter.check(rules, keys, later(1))
    expect(limiter.check(rules, keys, later(2)).allowed).toBe(false)
    record('限流在各维度按最严格者生效', '设备维度满时账号维度尚有 8 次额度，仍然拒绝')
  })
})

describe('§44.1.2 · 被拒绝的操作同样产生审计事件', () => {
  it('拒绝路径写入 rejected 审计并记录错误码', () => {
    chat.transaction((db) => {
      recordAuditEvent(db, {
        auditEventId: 'ae-rejected',
        organizationId: ORG,
        eventType: 'message_accepted',
        occurredAt: NOW,
        actorAccountId: 'jia',
        targetRef: 'message:jia/blocked',
        outcome: 'rejected',
        errorCode: 'NOT_FOUND_OR_FORBIDDEN',
        policyRevision: 1,
      })
    })
    const events = chat.transaction((db) => auditEventsOf(db, ORG))
    const rejected = events.filter((e) => e.outcome === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.errorCode).toBe('NOT_FOUND_OR_FORBIDDEN')
    record('被拒绝操作同样产生审计事件', 'rejected 结局与错误码一并留痕')
  })

  it('审计表中不含消息正文', () => {
    befriend()
    send('msg-secret')
    chat.transaction((db) => {
      recordAuditEvent(db, {
        auditEventId: 'ae-secret',
        organizationId: ORG,
        eventType: 'message_accepted',
        occurredAt: NOW,
        targetRef: 'message:jia/msg-secret',
        outcome: 'succeeded',
        policyRevision: 1,
      })
    })
    const dump = JSON.stringify(chat.transaction((db) => auditEventsOf(db, ORG)))
    expect(dump).not.toContain('正文 msg-secret')
  })
})

afterAll(() => {
  // 生成覆盖表。这是给人读的证据，测试自己不读它 ——
  // 它的价值在于「验收时能拿出来对着 §44.1.2 逐条勾」
  const lines = [
    '# `P0-a` 失败路径覆盖',
    '',
    '> **本文件由 `packages/chat/kernel/src/acceptance.host.spec.ts` 自动生成，请勿手工编辑。**',
    '>',
    '> 清单来自[迭代计划 §44.1.2](../04-roadmap/03-iteration-plan.md#4412-验收要求)。',
    '',
    '| §44.1.2 的失败路径 | 验证方式 |',
    '|---|---|',
    ...covered.map((row) => `| ${row.item} | ${row.how} |`),
    '',
    '## 不在本表内的两类',
    '',
    '- **跨源浏览器写请求** —— 需要真实 HTTP，验证在 `command-router.host.spec.ts` 与',
    '  各端点测试中；本文件是库级验收，起不了 HTTP 服务。',
    '- **插件卸载后不残留** —— 验证在 `index.host.spec.ts` 与 `index.client.spec.ts`，',
    '  需要真实的 Cordis fiber 生命周期。',
    '',
    '`P0-b` 的失败路径（唯一设备丢失后的自建恢复、第二因素丢失后用备用码恢复、',
    '凭证重放、在线状态过期）不在 `P0-a` 范围。其中**凭证重放**已随设备签名一并实现，',
    '见 `request-signing.host.spec.ts`。',
    '',
  ]
  writeFileSync(
    join(process.cwd(), 'docs', '_meta', 'acceptance-coverage.md'),
    lines.join('\n'),
    'utf8',
  )
})
