/**
 * 私聊命令的 HTTP 端点。
 *
 * 这是把领域模块接到浏览器的最后一层。每个端点严格按 §26 的顺序执行：
 *
 * > 认证 → 授权 → 版本检查 → **同一数据库事务写入领域对象和 outbox** → 提交后异步投递
 *
 * 其中「同一事务」是本文件最要紧的一条：领域写入、审计与 outbox **必须**在同一个
 * `transaction()` 回调内完成。§44.1.2 明确要求「审计写入失败导致整个命令失败」，
 * 分开写就做不到这一点。
 */

import type { IncomingMessage } from 'node:http'

import type { ErrorCode } from '@dsh-chat/contract'
import { recordAuditEvent } from '@dsh-chat/audit'
import { checkDirectMessageGate, acceptDirectMessage, acknowledge, leaseBatch } from '@dsh-chat/messaging'

import type { ChatDatabaseService } from '../storage/service.js'

import { commandHandler, type CommandOutcome } from './command-router.js'

/** 认证结果。本文件不做认证 —— 由上游的设备签名校验注入。 */
export interface Principal {
  readonly accountId: string
  readonly deviceId: string
  readonly organizationId: string
}

export interface MessageCommandDeps {
  readonly database: ChatDatabaseService
  readonly expectedOrigin: string
  /** 从请求中解析出调用者。返回 undefined 表示未认证。 */
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  /** 队列容量。属版本化 `PlanLimits`，从配置读取而非硬编码（§30.1）。 */
  readonly queueCapacity: number
  readonly leaseMs: number
  readonly now: () => Date
}

interface SendBody {
  readonly messageId: string
  readonly recipientId: string
  readonly body: string
  readonly operationId: string
}

function parseSendBody(value: unknown): SendBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const { messageId, recipientId, body, operationId } = raw
  if (
    typeof messageId !== 'string' ||
    typeof recipientId !== 'string' ||
    typeof body !== 'string' ||
    typeof operationId !== 'string'
  ) {
    return undefined
  }
  // §30.1：消息正文 8000 字素簇。用 Intl.Segmenter 按字素簇计数而非 length ——
  // 后者数的是 UTF-16 码元，一个 emoji 会被算成 2，中文与之无异但表情符号会误判
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(body)].length
  if (graphemes === 0 || graphemes > 8000) return undefined
  return { messageId, recipientId, body, operationId }
}

/**
 * 发送私聊。
 *
 * 顺序：认证 → 准入判定（§13 的联系人与拉黑）→ 同一事务写入消息、队列项与审计。
 *
 * 被拒绝时**同样写审计**（§43 第 14 步），且写在同一事务里 —— 否则拒绝路径的
 * 审计可能因为后续失败而丢失。
 */
export function sendMessageHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request): Promise<CommandOutcome<{ deliverySeq: number }>> => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false, errorCode: 'UNAUTHENTICATED' }

      const body = parseSendBody(raw)
      if (!body) return { ok: false, errorCode: 'NOT_FOUND_OR_FORBIDDEN' }

      const now = deps.now()
      const audit = (outcome: 'succeeded' | 'rejected', errorCode?: ErrorCode) => ({
        auditEventId: `ae-${body.operationId}-${outcome}`,
        organizationId: principal.organizationId,
        eventType: 'message_accepted',
        occurredAt: now,
        actorAccountId: principal.accountId,
        deviceId: principal.deviceId,
        // 只放引用，不放正文（§43 第 14 步）
        targetRef: `message:${principal.accountId}/${body.messageId}`,
        outcome,
        policyRevision: 1,
        operationId: body.operationId,
        ...(errorCode === undefined ? {} : { errorCode }),
      })

      return deps.database.transaction((db) => {
        const gate = checkDirectMessageGate(db, {
          organizationId: principal.organizationId,
          senderId: principal.accountId,
          recipientId: body.recipientId,
        })
        if (!gate.allowed) {
          recordAuditEvent(db, audit('rejected', gate.errorCode))
          return { ok: false as const, errorCode: gate.errorCode }
        }

        const accepted = acceptDirectMessage(db, {
          messageId: body.messageId,
          organizationId: principal.organizationId,
          senderId: principal.accountId,
          recipientId: body.recipientId,
          body: body.body,
          operationId: body.operationId,
          now,
          queueCapacity: deps.queueCapacity,
        })

        if (!accepted.ok) {
          recordAuditEvent(db, audit('rejected', accepted.errorCode))
          return { ok: false as const, errorCode: accepted.errorCode }
        }

        // 幂等重放**不写第二条审计**。
        //
        // §26：「事务提交后网络连接断开时，调用方用同一幂等键查询最终结果」——
        // 重放是**查询首次执行的结果**，不是再次执行。为它补一条审计会让审计
        // 记录的操作次数多于实际发生的次数，而审计的用途正是回答「发生了什么」。
        //
        // 首次执行的那条审计已经存在，重放只是把它的结果再返回一次。
        if (!accepted.idempotentReplay) {
          recordAuditEvent(db, audit('succeeded'))
        }
        return { ok: true as const, value: { deliverySeq: accepted.deliverySeq } }
      })
    },
  })
}

/**
 * 拉取一个带租约的批次。
 *
 * 这是读+写混合：分配租约本身是写操作，所以整体在事务内完成。
 * 租约按**设备**分配（§28），因此 `deviceId` 来自认证结果而非请求体 ——
 * 让调用方自己声明设备等于允许它冒用别人的租约。
 */
export function pullMessagesHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const batchSize =
        typeof raw === 'object' && raw !== null && typeof (raw as { batchSize?: unknown }).batchSize === 'number'
          ? Math.min(Math.max(1, (raw as { batchSize: number }).batchSize), 100)
          : 50

      const items = deps.database.transaction((db) =>
        leaseBatch(db, {
          organizationId: principal.organizationId,
          recipientId: principal.accountId,
          deviceId: principal.deviceId,
          batchSize,
          leaseMs: deps.leaseMs,
          now: deps.now(),
        }),
      )
      return { ok: true as const, value: { items } }
    },
  })
}

/**
 * 确认一批 `DeliverySeq`。
 *
 * 只有持有租约的设备能 ACK；`deviceId` 同样来自认证结果。
 * 返回实际确认的条数 —— 与请求条数不符时，调用方据此知道有一部分租约已过期。
 */
export function ackMessagesHandler(deps: MessageCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const seqs =
        typeof raw === 'object' && raw !== null && Array.isArray((raw as { deliverySeqs?: unknown }).deliverySeqs)
          ? ((raw as { deliverySeqs: unknown[] }).deliverySeqs.filter(
              (v): v is number => typeof v === 'number',
            ) as number[])
          : []

      const acked = deps.database.transaction((db) =>
        acknowledge(db, {
          organizationId: principal.organizationId,
          recipientId: principal.accountId,
          deviceId: principal.deviceId,
          deliverySeqs: seqs,
          now: deps.now(),
        }),
      )
      return { ok: true as const, value: { acked, requested: seqs.length } }
    },
  })
}
