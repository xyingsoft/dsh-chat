/**
 * 组织、工作区、项目与成员关系的读写。
 *
 * §11.2 规定这四类对象共享同一组公共字段：**不可变 ID、版本号、创建者、创建时间、
 * 修改时间、状态**；且所有角色、ACL、组织状态、成员状态的改变都由**显式命令**完成，
 * **携带版本号和幂等键**，并发变更返回 `VERSION_CONFLICT`，**不能静默覆盖**。
 *
 * 本文件只做数据访问，不做授权判定 —— 判定在 `authorization.ts` 中作为纯函数实现，
 * 调用方先判定后写入。两者分开是为了让判定可以被单独测试与复算（§48）。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { MembershipState, OrganizationState } from '@dsh-chat/contract'

import type { Role, ScopeKind } from './authorization.js'

/** §11.2 的公共字段。 */
export interface CommonFields {
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

export interface Organization extends CommonFields {
  readonly organizationId: string
  readonly name: string
  readonly state: OrganizationState
  readonly policyRevision: number
}

export interface Workspace extends CommonFields {
  readonly workspaceId: string
  readonly organizationId: string
  readonly name: string
  readonly state: string
}

export interface Project extends CommonFields {
  readonly projectId: string
  readonly organizationId: string
  readonly workspaceId: string
  readonly name: string
  readonly state: string
}

export interface Membership extends CommonFields {
  readonly membershipId: string
  readonly organizationId: string
  readonly accountId: string
  readonly scopeKind: ScopeKind
  readonly scopeId: string
  readonly role: Role
  readonly state: MembershipState
  readonly policyRevision: number
}

/** 版本冲突。§11.2 要求并发变更返回 `VERSION_CONFLICT` 而不是静默覆盖。 */
export class VersionConflictError extends Error {
  readonly errorCode = 'VERSION_CONFLICT' as const
  constructor(
    readonly expected: number,
    readonly actual: number | undefined,
  ) {
    super(`版本冲突：期望 ${expected}，实际 ${actual ?? '记录不存在'}`)
    this.name = 'VersionConflictError'
  }
}

// ── 组织 ──────────────────────────────────────────────────────────

export function createOrganization(
  db: DatabaseSync,
  input: {
    organizationId: string
    name: string
    createdBy: string
    now: Date
  },
): Organization {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO organizations
       (organization_id, name, state, created_by, created_at, updated_at, version, policy_revision)
     VALUES (?, ?, 'active', ?, ?, ?, 1, 1)`,
  ).run(input.organizationId, input.name, input.createdBy, iso, iso)

  return {
    organizationId: input.organizationId,
    name: input.name,
    state: 'active',
    createdBy: input.createdBy,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    policyRevision: 1,
  }
}

export function findOrganization(db: DatabaseSync, id: string): Organization | undefined {
  const row = db.prepare('SELECT * FROM organizations WHERE organization_id = ?').get(id) as
    | Record<string, string | number>
    | undefined
  if (!row) return undefined
  return {
    organizationId: row['organization_id'] as string,
    name: row['name'] as string,
    state: row['state'] as OrganizationState,
    createdBy: row['created_by'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    version: row['version'] as number,
    policyRevision: row['policy_revision'] as number,
  }
}

/**
 * 变更组织状态。
 *
 * 携带期望版本号；不匹配即抛 `VersionConflictError`。用 `WHERE version = ?` 让
 * 数据库做比较，避免「读出版本 → 比较 → 写入」之间的竞争窗口。
 */
export function updateOrganizationState(
  db: DatabaseSync,
  input: {
    organizationId: string
    expectedVersion: number
    state: OrganizationState
    now: Date
  },
): Organization {
  const result = db
    .prepare(
      `UPDATE organizations
          SET state = ?, updated_at = ?, version = version + 1
        WHERE organization_id = ? AND version = ?`,
    )
    .run(input.state, input.now.toISOString(), input.organizationId, input.expectedVersion)

  if (result.changes !== 1) {
    const current = findOrganization(db, input.organizationId)
    throw new VersionConflictError(input.expectedVersion, current?.version)
  }
  return findOrganization(db, input.organizationId)!
}

// ── 工作区与项目 ──────────────────────────────────────────────────

export function createWorkspace(
  db: DatabaseSync,
  input: { workspaceId: string; organizationId: string; name: string; createdBy: string; now: Date },
): Workspace {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO workspaces
       (workspace_id, organization_id, name, state, created_by, created_at, updated_at, version)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 1)`,
  ).run(input.workspaceId, input.organizationId, input.name, input.createdBy, iso, iso)
  return {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    name: input.name,
    state: 'active',
    createdBy: input.createdBy,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
  }
}

export function createProject(
  db: DatabaseSync,
  input: {
    projectId: string
    organizationId: string
    workspaceId: string
    name: string
    createdBy: string
    now: Date
  },
): Project {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO projects
       (project_id, organization_id, workspace_id, name, state, created_by, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1)`,
  ).run(
    input.projectId,
    input.organizationId,
    input.workspaceId,
    input.name,
    input.createdBy,
    iso,
    iso,
  )
  return {
    projectId: input.projectId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    name: input.name,
    state: 'active',
    createdBy: input.createdBy,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
  }
}

/** 项目所属的作用域链，供授权判定的祖先合并使用。 */
export function scopeChainOfProject(
  db: DatabaseSync,
  projectId: string,
): readonly { scopeKind: ScopeKind; scopeId: string }[] {
  const row = db
    .prepare('SELECT organization_id, workspace_id FROM projects WHERE project_id = ?')
    .get(projectId) as { organization_id: string; workspace_id: string } | undefined
  if (!row) return []
  return [
    { scopeKind: 'workspace', scopeId: row.workspace_id },
    { scopeKind: 'organization', scopeId: row.organization_id },
  ]
}

// ── 成员关系 ──────────────────────────────────────────────────────

function toMembership(row: Record<string, string | number>): Membership {
  return {
    membershipId: row['membership_id'] as string,
    organizationId: row['organization_id'] as string,
    accountId: row['account_id'] as string,
    scopeKind: row['scope_kind'] as ScopeKind,
    scopeId: row['scope_id'] as string,
    role: row['role'] as Role,
    state: row['state'] as MembershipState,
    createdBy: row['created_at'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    version: row['version'] as number,
    policyRevision: row['policy_revision'] as number,
  }
}

/**
 * 邀请成员。新成员状态为 `invited`，接受后才转 `active` ——
 * §11.2：只有 `active` 成员能接收新授权、发送项目消息。
 */
export function inviteMember(
  db: DatabaseSync,
  input: {
    membershipId: string
    organizationId: string
    accountId: string
    scopeKind: ScopeKind
    scopeId: string
    role: Role
    now: Date
  },
): Membership {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO memberships
       (membership_id, organization_id, account_id, scope_kind, scope_id, role, state,
        created_at, updated_at, version, policy_revision)
     VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?, 1, 1)`,
  ).run(
    input.membershipId,
    input.organizationId,
    input.accountId,
    input.scopeKind,
    input.scopeId,
    input.role,
    iso,
    iso,
  )
  return findMembership(db, input.membershipId)!
}

/** 接受邀请：`invited → active`。 */
export function acceptMembership(
  db: DatabaseSync,
  input: { membershipId: string; expectedVersion: number; now: Date },
): Membership {
  const result = db
    .prepare(
      `UPDATE memberships
          SET state = 'active', updated_at = ?, version = version + 1
        WHERE membership_id = ? AND version = ? AND state = 'invited'`,
    )
    .run(input.now.toISOString(), input.membershipId, input.expectedVersion)

  if (result.changes !== 1) {
    const current = findMembership(db, input.membershipId)
    throw new VersionConflictError(input.expectedVersion, current?.version)
  }
  return findMembership(db, input.membershipId)!
}

export function findMembership(db: DatabaseSync, membershipId: string): Membership | undefined {
  const row = db.prepare('SELECT * FROM memberships WHERE membership_id = ?').get(membershipId) as
    | Record<string, string | number>
    | undefined
  return row ? toMembership(row) : undefined
}

/** 读出某账号在某组织内的全部成员关系，供授权判定使用。 */
export function membershipsOf(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
): readonly Membership[] {
  const rows = db
    .prepare('SELECT * FROM memberships WHERE organization_id = ? AND account_id = ?')
    .all(organizationId, accountId) as Array<Record<string, string | number>>
  return rows.map(toMembership)
}

/**
 * 列出一个组织的全部成员关系。
 *
 * 包含 `invited` 与 `removed` —— 管理界面要能看到「邀了还没接受」的人
 * （否则会重复邀请）和「已移除」的记录（那是审计线索，§11.2 的移除是状态
 * 变更而不是删行）。调用方按 `state` 自行过滤。
 *
 * 按 `(account_id, scope_kind)` 排序而不是插入序：管理界面按人分组显示，
 * 排序不稳的话每次刷新条目都在跳。
 */
export function organizationMemberships(
  db: DatabaseSync,
  organizationId: string,
): readonly Membership[] {
  const rows = db
    .prepare(
      `SELECT * FROM memberships
        WHERE organization_id = ?
        ORDER BY account_id, scope_kind, scope_id`,
    )
    .all(organizationId) as Array<Record<string, string | number>>
  return rows.map(toMembership)
}

/**
 * 改角色。
 *
 * 带 `expectedVersion` 的乐观并发（§11.2）：两个管理员同时改同一个人时，
 * 后一个拿到 `VERSION_CONFLICT` 而不是静默覆盖 —— 静默覆盖的后果是有人
 * 以为自己把某人降级了，实际被另一次并发写盖回去。
 *
 * 只改 `active` 或 `invited` 的成员。已移除的改角色没有意义，而允许它会
 * 造成一种「改完了但那人其实不在」的错觉。
 */
export function changeMembershipRole(
  db: DatabaseSync,
  input: { membershipId: string; role: Role; expectedVersion: number; now: Date },
): Membership {
  const result = db
    .prepare(
      `UPDATE memberships
          SET role = ?, updated_at = ?, version = version + 1
        WHERE membership_id = ? AND version = ? AND state IN ('active', 'invited')`,
    )
    .run(input.role, input.now.toISOString(), input.membershipId, input.expectedVersion)

  if (result.changes !== 1) {
    const current = findMembership(db, input.membershipId)
    throw new VersionConflictError(input.expectedVersion, current?.version)
  }
  return findMembership(db, input.membershipId)!
}

/**
 * 移除成员：状态转 `removed`。
 *
 * **不删行。** §11.2 的成员关系带版本与策略修订，审计要能回答「这个人当时
 * 是什么角色、什么时候被谁移除的」—— 删掉行就永远答不了。已移除的成员关系
 * 在授权判定里不算数（那一侧只认 `active`），所以留着不会放行任何东西。
 *
 * 重复移除返回 `VERSION_CONFLICT` 而不是静默成功：调用方拿着一个过期的
 * 版本号来，说明它看到的不是当前状态，那种情况下让它重新读一次才对。
 */
export function removeMembership(
  db: DatabaseSync,
  input: { membershipId: string; expectedVersion: number; now: Date },
): Membership {
  const result = db
    .prepare(
      `UPDATE memberships
          SET state = 'removed', updated_at = ?, version = version + 1
        WHERE membership_id = ? AND version = ? AND state <> 'removed'`,
    )
    .run(input.now.toISOString(), input.membershipId, input.expectedVersion)

  if (result.changes !== 1) {
    const current = findMembership(db, input.membershipId)
    throw new VersionConflictError(input.expectedVersion, current?.version)
  }
  return findMembership(db, input.membershipId)!
}

/**
 * 一个组织里状态为 `active` 的所有者数量。
 *
 * 用来挡住「把最后一个所有者移除或降级」。没有所有者的组织谁也管不了 ——
 * 改不了成员、建不了工作区、连把所有权交出去都做不到。那是一个不可逆的
 * 自锁，而它只需要一次误操作。
 */
export function activeOwnerCount(db: DatabaseSync, organizationId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM memberships
        WHERE organization_id = ?
          AND scope_kind = 'organization'
          AND role = 'organization_owner'
          AND state = 'active'`,
    )
    .get(organizationId) as { c: number }
  return row.c
}
