/**
 * 组织、工作区、项目与成员端点的端到端测试。
 *
 * 骨架第 3 步「甲创建组织、工作区和项目，并把乙以开发者角色邀请进项目」此前只在
 * 领域函数层面走通，本文件让它经**真实 HTTP** 走通一遍。
 *
 * 重点不在「成功路径能跑」，而在三类边界：
 * 1. 跨组织 —— 猜到别人的 ID 能不能操作
 * 2. 身份等同 —— 能不能替别人接受邀请
 * 3. 枚举校验 —— 拼错的角色名会不会进库
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditEventsOf } from '@dsh-chat/audit'
import { createOrganization, createWorkspace, inviteMember } from '@dsh-chat/organization'

import { ChatDatabase } from '../storage/database.js'

import type { Principal } from './message-commands.js'
import {
  acceptMembershipHandler,
  createOrganizationHandler,
  createProjectHandler,
  createWorkspaceHandler,
  inviteMemberHandler,
  myMembershipsHandler,
  type OrganizationCommandDeps,
} from './organization-commands.js'

const NOW = new Date('2026-08-30T00:00:00Z')

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
let principal: Principal | undefined
let idCounter = 0

beforeEach(async () => {
  idCounter = 0
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    for (const [id, name] of [
      ['jia', '甲'],
      ['yi', '乙'],
      ['bing', '丙'],
    ]) {
      insert.run(id, name, NOW.toISOString())
    }
  })

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: 'org-pending' }

  const deps: OrganizationCommandDeps = {
    database: {
      transaction: chat.transaction.bind(chat),
      readonlyHandle: chat.readonlyHandle,
    } as OrganizationCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    now: () => NOW,
    newId: (prefix) => `${prefix}-${++idCounter}`,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      const routes = [
        ['/api/organization', createOrganizationHandler(deps)],
        ['/api/organization/workspaces', createWorkspaceHandler(deps)],
        ['/api/organization/projects', createProjectHandler(deps)],
        ['/api/organization/members/invite', inviteMemberHandler(deps)],
        ['/api/organization/members/accept', acceptMembershipHandler(deps)],
        ['/api/organization/members/me', myMembershipsHandler(deps)],
      ] as const
      for (const [path, handler] of routes) {
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

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function dataOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T }
  return body.data
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

/** 走完「建组织 → 建工作区 → 建项目」，返回三个 ID。 */
async function buildOrganization(): Promise<{ org: string; ws: string; proj: string }> {
  const created = await dataOf<{ organization: { organizationId: string } }>(
    await post('/api/organization', { name: 'Acme', operationId: 'op-org' }),
  )
  const org = created.organization.organizationId
  principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: org }

  const ws = await dataOf<{ workspaceId: string }>(
    await post('/api/organization/workspaces', { name: '研发', operationId: 'op-ws' }),
  )
  const proj = await dataOf<{ projectId: string }>(
    await post('/api/organization/projects', {
      workspaceId: ws.workspaceId,
      name: 'chat',
      operationId: 'op-proj',
    }),
  )
  return { org, ws: ws.workspaceId, proj: proj.projectId }
}

describe('骨架第 3 步经 HTTP 走通', () => {
  it('创建组织、工作区、项目，并把乙以开发者角色邀请进项目', async () => {
    const { org, proj } = await buildOrganization()

    const invited = await post('/api/organization/members/invite', {
      accountId: 'yi',
      scopeKind: 'project',
      scopeId: proj,
      role: 'developer',
      operationId: 'op-invite',
    })
    expect(invited.status).toBe(200)
    const membership = await dataOf<{ membershipId: string; state: string; version: number }>(
      invited,
    )
    // §11.2：邀请后是 invited 而不是 active —— 被邀请人还没同意，
    // 不该已经承担该角色的能力
    expect(membership.state).toBe('invited')

    // 乙接受
    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    const accepted = await post('/api/organization/members/accept', {
      membershipId: membership.membershipId,
      expectedVersion: membership.version,
      operationId: 'op-accept',
    })
    expect(accepted.status).toBe(200)
    expect((await dataOf<{ state: string }>(accepted)).state).toBe('active')
  })

  it('创建者自动成为 active 的 organization_owner', async () => {
    // 若沿用邀请流程的 invited，创建者就要接受自己发出的邀请
    // 才能操作自己的组织
    await buildOrganization()
    const mine = await dataOf<{ memberships: Array<{ role: string; state: string }> }>(
      await post('/api/organization/members/me', {}),
    )
    expect(mine.memberships).toHaveLength(1)
    expect(mine.memberships[0]?.role).toBe('organization_owner')
    expect(mine.memberships[0]?.state).toBe('active')
  })
})

describe('跨组织隔离', () => {
  it('不能在别人组织的工作区下建项目，即使猜到 workspaceId', async () => {
    // 乙的组织与工作区，甲完全不知情
    chat.transaction((db) => {
      createOrganization(db, {
        organizationId: 'org-yi',
        name: '乙的组织',
        createdBy: 'yi',
        now: NOW,
      })
      createWorkspace(db, {
        workspaceId: 'ws-yi',
        organizationId: 'org-yi',
        name: '乙的工作区',
        createdBy: 'yi',
        now: NOW,
      })
    })

    await buildOrganization()
    const response = await post('/api/organization/projects', {
      workspaceId: 'ws-yi',
      name: '偷来的项目',
      operationId: 'op-steal',
    })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('NOT_FOUND_OR_FORBIDDEN')

    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS c FROM projects WHERE workspace_id = ?')
      .get('ws-yi') as { c: number }
    expect(count.c).toBe(0)
  })

  it('工作区不存在与无权限返回同一错误码', async () => {
    // 区分开就是一个跨组织的工作区存在性探测接口（§46）
    await buildOrganization()
    const nonexistent = await post('/api/organization/projects', {
      workspaceId: 'ws-does-not-exist',
      name: 'x',
      operationId: 'op-a',
    })
    chat.transaction((db) => {
      createOrganization(db, { organizationId: 'org-yi', name: '乙', createdBy: 'yi', now: NOW })
      createWorkspace(db, {
        workspaceId: 'ws-real-but-theirs',
        organizationId: 'org-yi',
        name: '真实但属他人',
        createdBy: 'yi',
        now: NOW,
      })
    })
    const forbidden = await post('/api/organization/projects', {
      workspaceId: 'ws-real-but-theirs',
      name: 'x',
      operationId: 'op-b',
    })
    expect(nonexistent.status).toBe(forbidden.status)
    expect(await errorOf(nonexistent)).toBe(await errorOf(forbidden))
  })
})

describe('接受邀请的身份等同', () => {
  it('不能替别人接受邀请', async () => {
    const { org, proj } = await buildOrganization()
    const membership = await dataOf<{ membershipId: string; version: number }>(
      await post('/api/organization/members/invite', {
        accountId: 'yi',
        scopeKind: 'project',
        scopeId: proj,
        role: 'developer',
        operationId: 'op-invite',
      }),
    )

    // 丙拿着乙的 membershipId 来接受
    principal = { accountId: 'bing', deviceId: 'bing-pc', organizationId: org }
    const response = await post('/api/organization/members/accept', {
      membershipId: membership.membershipId,
      expectedVersion: membership.version,
      operationId: 'op-hijack',
    })
    expect(response.status).toBe(404)

    const state = chat.readonlyHandle
      .prepare('SELECT state FROM memberships WHERE membership_id = ?')
      .get(membership.membershipId) as { state: string }
    expect(state.state).toBe('invited')
  })

  it('版本不匹配返回 VERSION_CONFLICT 而非静默覆盖', async () => {
    const { org, proj } = await buildOrganization()
    const membership = await dataOf<{ membershipId: string }>(
      await post('/api/organization/members/invite', {
        accountId: 'yi',
        scopeKind: 'project',
        scopeId: proj,
        role: 'developer',
        operationId: 'op-invite',
      }),
    )
    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    const response = await post('/api/organization/members/accept', {
      membershipId: membership.membershipId,
      expectedVersion: 99,
      operationId: 'op-stale',
    })
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('VERSION_CONFLICT')
  })
})

describe('输入校验', () => {
  it('拼错的角色名被拒绝，不会进库', async () => {
    // 放行任意字符串的话，ROLE_CAPABILITIES 查表会拿到 undefined，
    // 授权判定在运行时崩溃或静默放行
    const { proj } = await buildOrganization()
    const response = await post('/api/organization/members/invite', {
      accountId: 'yi',
      scopeKind: 'project',
      scopeId: proj,
      role: 'developerr',
      operationId: 'op-typo',
    })
    expect(response.status).toBe(404)
    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS c FROM memberships WHERE account_id = ?')
      .get('yi') as { c: number }
    expect(count.c).toBe(0)
  })

  it('不存在的 scopeKind 被拒绝', async () => {
    const { proj } = await buildOrganization()
    const response = await post('/api/organization/members/invite', {
      accountId: 'yi',
      scopeKind: 'universe',
      scopeId: proj,
      role: 'developer',
      operationId: 'op-bad-scope',
    })
    expect(response.status).toBe(404)
  })

  it('空名称被拒绝', async () => {
    // 名称为空的组织在界面上不可指认，而它能被创建
    expect((await post('/api/organization', { name: '', operationId: 'op' })).status).toBe(404)
  })

  it('未认证的请求一律拒绝', async () => {
    principal = undefined
    for (const path of [
      '/api/organization',
      '/api/organization/workspaces',
      '/api/organization/projects',
      '/api/organization/members/invite',
      '/api/organization/members/accept',
      '/api/organization/members/me',
    ]) {
      const response = await post(path, { name: 'x', operationId: 'op' })
      expect(response.status, `${path} 未拒绝未认证请求`).toBe(401)
    }
  })
})

describe('授权判定', () => {
  it('开发者不能创建工作区', async () => {
    const { org, proj } = await buildOrganization()
    chat.transaction((db) => {
      inviteMember(db, {
        membershipId: 'm-yi',
        organizationId: org,
        accountId: 'yi',
        scopeKind: 'project',
        scopeId: proj,
        role: 'developer',
        now: NOW,
      })
      db.prepare("UPDATE memberships SET state = 'active' WHERE membership_id = 'm-yi'").run()
    })
    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    const response = await post('/api/organization/workspaces', {
      name: '乙想建的',
      operationId: 'op-nope',
    })
    expect(response.status).toBe(404)
  })

  it('越权尝试同样写入审计（§43 第 14 步）', async () => {
    const { org } = await buildOrganization()
    principal = { accountId: 'bing', deviceId: 'bing-pc', organizationId: org }
    await post('/api/organization/workspaces', { name: '丙想建的', operationId: 'op-rejected' })

    const events = chat.transaction((db) => auditEventsOf(db, org))
    const rejected = events.filter((e) => e.outcome === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.errorCode).toBe('NOT_FOUND_OR_FORBIDDEN')
    expect(rejected[0]?.actorAccountId).toBe('bing')
  })

  it('组织被挂起后写入停止', async () => {
    // 授权判定读库中的组织状态，不是写死的 'active'
    const { org } = await buildOrganization()
    chat.transaction((db) => {
      db.prepare('UPDATE organizations SET state = ? WHERE organization_id = ?').run(
        'suspended',
        org,
      )
    })
    const response = await post('/api/organization/workspaces', {
      name: '挂起后的工作区',
      operationId: 'op-suspended',
    })
    expect(response.status).toBe(404)
  })
})

describe('成员名单不外泄', () => {
  it('/members/me 只返回调用者自己的成员关系', async () => {
    // 默认返回全组织名单会让任何 guest 拿到完整通讯录
    const { org, proj } = await buildOrganization()
    await post('/api/organization/members/invite', {
      accountId: 'yi',
      scopeKind: 'project',
      scopeId: proj,
      role: 'developer',
      operationId: 'op-invite',
    })

    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    const mine = await dataOf<{ memberships: Array<{ accountId: string }> }>(
      await post('/api/organization/members/me', {}),
    )
    expect(mine.memberships.every((m) => m.accountId === 'yi')).toBe(true)
  })
})
