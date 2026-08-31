/**
 * 在线状态端点（§9.1）。
 *
 * 四个：上报心跳、查一批人的状态、读/改自己的可见性。
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
  PRESENCE_VISIBILITY,
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
   * 读某人的可见性设置。缺省走本地表（见 `visibilityOf`）。
   *
   * 留这个钩子是为了测试能直接摆出一个档位，不用先写库。
   */
  readonly visibilityOf?: (db: DatabaseSync, organizationId: string, accountId: string) => PresenceVisibility
  /** 两人是否共享至少一个工作区或项目。缺省走本地表（见 `sharesScope`）。 */
  readonly sharesScope?: (
    db: DatabaseSync,
    organizationId: string,
    a: string,
    b: string,
  ) => boolean
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
            visibility: (deps.visibilityOf ?? visibilityOf)(
              db,
              principal.organizationId,
              accountId,
            ),
            isSelf: accountId === principal.accountId,
            sharesScope: (deps.sharesScope ?? sharesScope)(
              db,
              principal.organizationId,
              principal.accountId,
              accountId,
            ),
          })
        }
        return out
      })

      return { ok: true as const, value: { presence } }
    },
  })
}

/**
 * 改自己的可见性。
 *
 * 只能改自己的 —— 这不是一项可以被授予的权限，是一条身份等同判断。允许
 * 管理员代改的话，「隐身」就成了一个可以被别人关掉的开关，那它保护不了
 * 任何东西。所以请求体里根本不收账号。
 */
export function setVisibilityHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const value = (raw as { visibility?: unknown }).visibility
      if (typeof value !== 'string' || !(PRESENCE_VISIBILITY as readonly string[]).includes(value)) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      deps.database.transaction((db) => {
        db.prepare(
          `INSERT INTO presence_visibility (account_id, organization_id, visibility, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, organization_id) DO UPDATE SET
             visibility = excluded.visibility,
             updated_at = excluded.updated_at`,
        ).run(principal.accountId, principal.organizationId, value, now.toISOString())
      })
      return { ok: true as const, value: { visibility: value as PresenceVisibility } }
    },
  })
}

/** 读自己的可见性。界面要能显示当前选的是哪一档。 */
export function getVisibilityHandler(deps: PresenceCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (_raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const visibility = deps.database.transaction<PresenceVisibility>((db) =>
        (deps.visibilityOf ?? visibilityOf)(db, principal.organizationId, principal.accountId),
      )
      return { ok: true as const, value: { visibility } }
    },
  })
}

/**
 * 某人在某组织的可见性。没设过按 `everyone`。
 *
 * 存了一个不认识的值时同样按 `everyone` 而不是抛：那多半是降级部署写进去的
 * 新档位，而一个查不出在线状态的界面比一个多显示了状态的界面更像坏了。
 */
function visibilityOf(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
): PresenceVisibility {
  const row = db
    .prepare(
      'SELECT visibility FROM presence_visibility WHERE account_id = ? AND organization_id = ?',
    )
    .get(accountId, organizationId) as { visibility: string } | undefined
  const value = row?.visibility
  return value !== undefined && (PRESENCE_VISIBILITY as readonly string[]).includes(value)
    ? (value as PresenceVisibility)
    : 'everyone'
}

/**
 * 两人是否共享至少一个工作区或项目。
 *
 * **只看非组织级的作用域。** 同属一个组织不算「共享作用域」—— 若算，
 * `shared_scopes` 就等同于 `everyone`，那一档就白设了。
 *
 * 两边都要求 `active`：被移除的成员关系还留在表里（那是审计线索），
 * 拿它当共享依据的话，一个已经被踢出项目的人还能继续看到别人的在线状态。
 */
function sharesScope(
  db: DatabaseSync,
  organizationId: string,
  a: string,
  b: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit
         FROM memberships ma
         JOIN memberships mb
           ON ma.organization_id = mb.organization_id
          AND ma.scope_kind = mb.scope_kind
          AND ma.scope_id = mb.scope_id
        WHERE ma.organization_id = ?
          AND ma.account_id = ?
          AND mb.account_id = ?
          AND ma.scope_kind <> 'organization'
          AND ma.state = 'active'
          AND mb.state = 'active'
        LIMIT 1`,
    )
    .get(organizationId, a, b) as { hit: number } | undefined
  return row !== undefined
}
