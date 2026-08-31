/**
 * 联系人端点（§13）。
 *
 * 领域层（`@dsh-chat/messaging` 的 `contacts.ts`）早就实现了请求、接受、拒绝、
 * 删除、拉黑，但**一个 HTTP 入口都没有**。而发消息前会查
 * `checkDirectMessageGate`，没有已接受的联系人关系就拒绝 —— 也就是说在这个
 * 文件存在之前，通过界面一条消息都发不出去。
 *
 * 这和「没账号签不出邀请码、没邀请码开不了户」是同一类死锁，只是发生在
 * 另一条路上。
 *
 * ## 通讯录与成员管理是两个东西
 *
 * `/api/organization/members` 是**管理视图**：包含 invited 与 removed、
 * 覆盖全部作用域、要 `organization.manage`。
 *
 * 这里的 `/directory` 是**通讯录**：只有本组织 `active` 的人，只有显示名，
 * 任何 active 成员都能看。把两者合成一个的话，要么普通成员找不到同事
 * （产品不可用），要么谁都能看到已移除成员和邀请中的人（管理信息外泄）。
 */

import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import {
  acceptContactRequest,
  createContactRequest,
  findContactRequest,
  rejectContactRequest,
  removeContact,
} from '@dsh-chat/messaging'

import type { ChatDatabaseService } from '../storage/service.js'

import { commandHandler } from './command-router.js'
import type { Principal } from './message-commands.js'

export interface ContactCommandDeps {
  readonly database: ChatDatabaseService
  readonly expectedOrigin: string
  readonly authenticate: (request: IncomingMessage) => Principal | undefined
  readonly now: () => Date
  readonly newId: (prefix: string) => string
}

/** 通讯录里的一个人。**只有显示名** —— 邮箱、设备、角色都不在这里。 */
export interface DirectoryEntry {
  readonly accountId: string
  readonly displayName: string
  /** 与调用者的关系，界面据此决定显示「发消息」还是「加联系人」。 */
  readonly relation: 'self' | 'contact' | 'pending_outgoing' | 'pending_incoming' | 'none'
}

/**
 * 组织通讯录。
 *
 * 要求调用者自己是本组织的 `active` 成员 —— 否则任何人带一个组织 ID 过来
 * 就能拿到那个组织的花名册。
 *
 * 一并返回「与我的关系」：不返回的话，界面要为每个人再查一次，或者自己
 * 拼接两份列表 —— 而拼错的表现是「已经是联系人的人还显示加好友按钮」。
 */
export function directoryHandler(deps: ContactCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (_raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      return deps.database.transaction<
        | { ok: true; value: { members: DirectoryEntry[] } }
        | { ok: false; errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
      >((db) => {
        if (!isActiveMember(db, principal.organizationId, principal.accountId)) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const rows = db
          .prepare(
            `SELECT DISTINCT a.account_id AS accountId, a.display_name AS displayName
               FROM memberships m
               JOIN accounts a ON a.account_id = m.account_id
              WHERE m.organization_id = ? AND m.state = 'active'
              ORDER BY a.display_name`,
          )
          .all(principal.organizationId) as Array<{ accountId: string; displayName: string }>

        const members = rows.map((row) => ({
          accountId: row.accountId,
          displayName: row.displayName,
          relation: relationOf(db, principal, row.accountId),
        }))
        return { ok: true as const, value: { members } }
      })
    },
  })
}

/** 我的联系人与待处理请求。 */
export interface ContactsView {
  readonly contacts: ReadonlyArray<{ accountId: string; displayName: string }>
  readonly incoming: ReadonlyArray<{
    requestId: string
    accountId: string
    displayName: string
    createdAt: string
  }>
  readonly outgoing: ReadonlyArray<{ requestId: string; accountId: string; displayName: string }>
}

export function listContactsHandler(deps: ContactCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (_raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const now = deps.now().toISOString()
      return deps.database.transaction<{ ok: true; value: ContactsView }>((db) => {
        const accepted = db
          .prepare(
            `SELECT CASE WHEN requester_id = ?1 THEN target_id ELSE requester_id END AS accountId,
                    a.display_name AS displayName
               FROM contact_requests c
               JOIN accounts a
                 ON a.account_id = CASE WHEN c.requester_id = ?1 THEN c.target_id ELSE c.requester_id END
              WHERE c.organization_id = ?2 AND c.state = 'accepted'
                AND (c.requester_id = ?1 OR c.target_id = ?1)
              ORDER BY a.display_name`,
          )
          .all(principal.accountId, principal.organizationId) as Array<{
          accountId: string
          displayName: string
        }>

        // 过期的待处理请求不显示。显示的话，用户点「接受」会失败而看不出
        // 为什么 —— 领域层的 acceptContactRequest 会因为 expires_at 拒绝
        const incoming = db
          .prepare(
            `SELECT c.request_id AS requestId, c.requester_id AS accountId,
                    a.display_name AS displayName, c.created_at AS createdAt
               FROM contact_requests c
               JOIN accounts a ON a.account_id = c.requester_id
              WHERE c.organization_id = ? AND c.target_id = ? AND c.state = 'pending'
                AND c.expires_at > ?
              ORDER BY c.created_at DESC`,
          )
          .all(principal.organizationId, principal.accountId, now) as unknown as ContactsView['incoming']

        const outgoing = db
          .prepare(
            `SELECT c.request_id AS requestId, c.target_id AS accountId,
                    a.display_name AS displayName
               FROM contact_requests c
               JOIN accounts a ON a.account_id = c.target_id
              WHERE c.organization_id = ? AND c.requester_id = ? AND c.state = 'pending'
                AND c.expires_at > ?
              ORDER BY c.created_at DESC`,
          )
          .all(principal.organizationId, principal.accountId, now) as unknown as ContactsView['outgoing']

        return { ok: true as const, value: { contacts: accepted, incoming, outgoing } }
      })
    },
  })
}

/**
 * 发起联系人请求。
 *
 * 对方**已经给我发过请求**时直接互相接受，而不是再挂一条反向请求。两人同时
 * 点「加联系人」是很常见的，各挂一条待处理请求会让双方都看到一个要处理的
 * 东西，而实际上事情已经成了。
 */
export function requestContactHandler(deps: ContactCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const targetId = str((raw as Record<string, unknown>)['targetId'])
      if (targetId === undefined || targetId === principal.accountId) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction<
        | { ok: true; value: { state: 'pending' | 'accepted'; requestId: string } }
        | { ok: false; errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
      >((db) => {
        // 两人都得是本组织的 active 成员。不查的话，猜一个账号 ID 就能
        // 向组织外的人发请求
        if (
          !isActiveMember(db, principal.organizationId, principal.accountId) ||
          !isActiveMember(db, principal.organizationId, targetId)
        ) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const existing = pendingBetween(db, principal.organizationId, principal.accountId, targetId, now)
        if (existing !== undefined) {
          if (existing.requesterId === targetId) {
            // 对方先发的，这一下等于接受
            acceptContactRequest(db, { requestId: existing.requestId, now })
            return {
              ok: true as const,
              value: { state: 'accepted' as const, requestId: existing.requestId },
            }
          }
          // 自己重复点。返回原来那条而不是新建 —— §13 说同一目标重发受速率
          // 限制，最省事又最诚实的做法是根本不产生第二条
          return {
            ok: true as const,
            value: { state: 'pending' as const, requestId: existing.requestId },
          }
        }

        if (acceptedBetween(db, principal.organizationId, principal.accountId, targetId)) {
          return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
        }

        const created = createContactRequest(db, {
          requestId: deps.newId('cr'),
          organizationId: principal.organizationId,
          requesterId: principal.accountId,
          targetId,
          now,
        })
        return {
          ok: true as const,
          value: { state: 'pending' as const, requestId: created.requestId },
        }
      })
    },
  })
}

/** 接受一条请求。只有**被请求的那一方**能接受。 */
export function acceptContactHandler(deps: ContactCommandDeps) {
  return respondHandler(deps, 'accept')
}

/** 拒绝一条请求。§13：拒绝不创建拉黑，对方可以再发。 */
export function rejectContactHandler(deps: ContactCommandDeps) {
  return respondHandler(deps, 'reject')
}

function respondHandler(deps: ContactCommandDeps, action: 'accept' | 'reject') {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const requestId = str((raw as Record<string, unknown>)['requestId'])
      if (requestId === undefined) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      return deps.database.transaction<
        { ok: true; value: { done: boolean } } | { ok: false; errorCode: 'NOT_FOUND_OR_FORBIDDEN' }
      >((db) => {
        const found = findContactRequest(db, requestId)
        // 只有被请求的那一方能处理。不查的话，任何人猜到 requestId 就能
        // 替别人接受一条请求 —— 而接受的后果是对方可以给自己发消息
        const mine =
          found !== undefined &&
          found.organizationId === principal.organizationId &&
          found.targetId === principal.accountId
        if (!mine) return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }

        const done =
          action === 'accept'
            ? acceptContactRequest(db, { requestId, now })
            : rejectContactRequest(db, { requestId, now })
        return { ok: true as const, value: { done } }
      })
    },
  })
}

/** 删除联系人。§13：置 `removed`，**不创建拉黑**，对方可再次发起请求。 */
export function removeContactHandler(deps: ContactCommandDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const peerId = str((raw as Record<string, unknown>)['peerId'])
      if (peerId === undefined) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const now = deps.now()
      deps.database.transaction((db) => {
        removeContact(db, {
          organizationId: principal.organizationId,
          accountA: principal.accountId,
          accountB: peerId,
          now,
        })
      })
      return { ok: true as const, value: { removed: true } }
    },
  })
}

function relationOf(
  db: DatabaseSync,
  principal: Principal,
  otherId: string,
): DirectoryEntry['relation'] {
  if (otherId === principal.accountId) return 'self'
  if (acceptedBetween(db, principal.organizationId, principal.accountId, otherId)) return 'contact'
  const row = db
    .prepare(
      `SELECT requester_id AS requesterId FROM contact_requests
        WHERE organization_id = ? AND state = 'pending'
          AND ((requester_id = ?2 AND target_id = ?3) OR (requester_id = ?3 AND target_id = ?2))
        LIMIT 1`,
    )
    .get(principal.organizationId, principal.accountId, otherId) as
    | { requesterId: string }
    | undefined
  if (row === undefined) return 'none'
  return row.requesterId === principal.accountId ? 'pending_outgoing' : 'pending_incoming'
}

function pendingBetween(
  db: DatabaseSync,
  organizationId: string,
  a: string,
  b: string,
  now: Date,
): { requestId: string; requesterId: string } | undefined {
  return db
    .prepare(
      `SELECT request_id AS requestId, requester_id AS requesterId FROM contact_requests
        WHERE organization_id = ?1 AND state = 'pending' AND expires_at > ?4
          AND ((requester_id = ?2 AND target_id = ?3) OR (requester_id = ?3 AND target_id = ?2))
        LIMIT 1`,
    )
    .get(organizationId, a, b, now.toISOString()) as
    | { requestId: string; requesterId: string }
    | undefined
}

function acceptedBetween(
  db: DatabaseSync,
  organizationId: string,
  a: string,
  b: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM contact_requests
        WHERE organization_id = ?1 AND state = 'accepted'
          AND ((requester_id = ?2 AND target_id = ?3) OR (requester_id = ?3 AND target_id = ?2))`,
    )
    .get(organizationId, a, b)
  return row !== undefined
}

function isActiveMember(db: DatabaseSync, organizationId: string, accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM memberships
        WHERE organization_id = ? AND account_id = ? AND state = 'active' LIMIT 1`,
    )
    .get(organizationId, accountId)
  return row !== undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
