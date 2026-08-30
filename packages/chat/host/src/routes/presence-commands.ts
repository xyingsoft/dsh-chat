/**
 * 在线状态端点（§9.1）。
 *
 * 两个：上报心跳、查一批人的状态。
 *
 * ## 心跳由 host 自己发，不是浏览器
 *
 * §9.1 说的是「每个活跃 host 用已认证设备定期发送心跳」——「host 是否仍在
 * 运行」。让浏览器发的话，关掉标签页就等于下线，而 host 还在跑、消息还在
 * 收 —— 那报的就不是文档要的那个东西了。
 *
 * 所以这里的心跳端点只是给 host 内部的定时器用；浏览器要做的是**报告用户
 * 交互时间**，那才是它知道而 host 不知道的信息。两者合在一个端点里，
 * 由请求体区分。
 *
 * ## 查询要过可见性
 *
 * 直接返回真实状态会让 `hidden` 形同虚设。过滤在服务端做而不是让界面自觉，
 * 理由是界面拿到什么就能显示什么 —— 一个改过的客户端会把隐藏的人也画出来。
 */

import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import {
  applyVisibility,
  presenceOf,
  recordHeartbeat,
  type PresenceVisibility,
} from '@dsh-chat/identity'
import type { PresenceState } from '@dsh-chat/contract'

import type { ChatDatabaseService } from '../storage/service.js'

import { commandHandler } from './command-router.js'
import type { Principal } from './message-commands.js'

export interface PresenceCommandDeps {
  readonly database: ChatDatabaseService
  readonly expectedOrigin: string
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  readonly now: () => Date
  /**
   * 读某人的可见性设置。
   *
   * 不提供时一律按 `everyone` —— P0 还没有设置界面，而默认隐藏会让在线状态
   * 整个看起来是坏的。这是一个**会随设置界面上线而改变的默认值**，不是
   * 「隐私默认关闭」的立场。
   */
  readonly visibilityOf?: (db: DatabaseSync, accountId: string) => PresenceVisibility
  /**
   * 两人是否共享至少一个项目或群。`shared_scopes` 下用它判定。
   *
   * 不提供时视为**不共享** —— 默认收紧而不是默认放开。判不出来的时候
   * 少给一点信息，而不是多给。
   */
  readonly sharesScope?: (db: DatabaseSync, a: string, b: string) => boolean
}

/**
 * 上报心跳。
 *
 * 请求体里的 `lastInteractionAt` 由浏览器给 —— 它知道用户有没有在动键盘，
 * host 不知道。不给就等同于「就是现在」。
 */
export function heartbeatHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const at = deps.now()
      const reported = (raw as { lastInteractionAt?: unknown }).lastInteractionAt
      const parsed = typeof reported === 'string' ? new Date(reported) : undefined
      // 未来的交互时间一律丢弃并回落到「现在」。信它的话，一个时钟设错的
      // 客户端会让自己永远显示 online
      const lastInteractionAt =
        parsed !== undefined && !Number.isNaN(parsed.getTime()) && parsed.getTime() <= at.getTime()
          ? parsed
          : at

      deps.database.transaction((db) => {
        recordHeartbeat(db, {
          deviceId: principal.deviceId,
          accountId: principal.accountId,
          organizationId: principal.organizationId,
          at,
          lastInteractionAt,
        })
      })
      return { ok: true as const, value: { at: at.toISOString() } }
    },
  })
}

/** 查询上限。一次问几千个人会把这个端点变成一个全组织扫描。 */
const MAX_QUERY = 200

/**
 * 查一批人的在线状态。
 *
 * 只接受显式的账号列表，**不提供「列出全组织在线的人」** —— 那等于一个
 * 组织通讯录接口，而列名单是要 `organization.manage` 的（§46 也要求不泄露
 * 其他成员的存在性）。
 *
 * 查一个不存在或不同组织的账号返回 `unknown`，与「隐藏」同一个值：这里
 * 不区分「没这个人」与「这个人不想说」。
 */
export function presenceQueryHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const requested = (raw as { accountIds?: unknown }).accountIds
      if (!Array.isArray(requested)) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const accountIds = [
        ...new Set(requested.filter((id): id is string => typeof id === 'string' && id.length > 0)),
      ].slice(0, MAX_QUERY)

      const now = deps.now()
      const presence = deps.database.transaction<Record<string, PresenceState>>((db) => {
        const out: Record<string, PresenceState> = {}
        for (const accountId of accountIds) {
          const actual = presenceOf(db, {
            organizationId: principal.organizationId,
            accountId,
            now,
          })
          out[accountId] = applyVisibility(actual, {
            visibility: deps.visibilityOf?.(db, accountId) ?? 'everyone',
            isSelf: accountId === principal.accountId,
            sharesScope: deps.sharesScope?.(db, principal.accountId, accountId) ?? false,
          })
        }
        return out
      })

      return { ok: true as const, value: { presence } }
    },
  })
}
