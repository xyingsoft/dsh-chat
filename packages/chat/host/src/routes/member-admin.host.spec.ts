/**
 * 成员管理端点测试：列名单、改角色、移除。
 *
 * 这三个此前只有「查自己」，管理界面无从下手。
 *
 * 盯得最紧的是**最后一个所有者不能被降级或移除**。没有所有者的组织谁也
 * 管不了：改不了成员、建不了工作区、连把所有权交出去都做不到。那是一次
 * 误操作就能造成的不可逆自锁，而它不会在任何单元测试里自己冒出来。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditEventsOf } from '@dsh-chat/audit'

import { ChatDatabase } from '../storage/database.js'

import type { Principal } from './message-commands.js'
import {
  acceptMembershipHandler,
  changeMemberRoleHandler,
  createOrganizationHandler,
  createProjectHandler,
  createWorkspaceHandler,
  inviteMemberHandler,
  listMembersHandler,
  myMembershipsHandler,
  removeMemberHandler,
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
        ['/api/organization/members', listMembersHandler(deps)],
        ['/api/organization/members/role', changeMemberRoleHandler(deps)],
        ['/api/organization/members/remove', removeMemberHandler(deps)],
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

interface MembershipRow {
  membershipId: string
  version: number
  role: string
  state: string
  accountId: string
}

/** 建组织 + 工作区 + 项目，并把 principal 切到新组织。 */
async function setUpOrganization(): Promise<{ org: string; proj: string }> {
  const created = await dataOf<{ organization: { organizationId: string } }>(
    await post('/api/organization', { name: 'Acme', operationId: 'op-org' }),
  )
  const org = created.organization.organizationId
  principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: org }

  const ws = await dataOf<{ workspaceId: string }>(
    await post('/api/organization/workspaces', { name: '主工作区', operationId: 'op-ws' }),
  )
  const proj = await dataOf<{ projectId: string }>(
    await post('/api/organization/projects', {
      name: '主项目',
      workspaceId: ws.workspaceId,
      operationId: 'op-proj',
    }),
  )
  return { org, proj: proj.projectId }
}

/** 甲自己那条组织所有者成员关系。 */
async function ownerMembership(): Promise<MembershipRow> {
  const mine = await dataOf<{ memberships: MembershipRow[] }>(
    await post('/api/organization/members/me', {}),
  )
  const owner = mine.memberships.find((m) => m.role === 'organization_owner')
  if (owner === undefined) throw new Error('没有找到所有者成员关系')
  return owner
}

async function inviteYi(proj: string): Promise<MembershipRow> {
  return dataOf<MembershipRow>(
    await post('/api/organization/members/invite', {
      accountId: 'yi',
      scopeKind: 'project',
      scopeId: proj,
      role: 'developer',
      operationId: 'op-invite-yi',
    }),
  )
}

describe('列出全组织成员', () => {
  it('管理员能看到全部，包括还没接受邀请的', async () => {
    // 看不到 invited 的话，管理员会以为邀请没发出去，然后重复邀请
    const { proj } = await setUpOrganization()
    await inviteYi(proj)

    const listed = await dataOf<{ memberships: MembershipRow[] }>(
      await post('/api/organization/members', {}),
    )
    expect([...new Set(listed.memberships.map((m) => m.accountId))].sort()).toEqual(['jia', 'yi'])
    expect(listed.memberships.find((m) => m.accountId === 'yi')?.state).toBe('invited')
  })

  it('没有 organization.manage 的人拿不到名单', async () => {
    // 返回空列表更糟：调用方会以为组织里真的没人
    const { org, proj } = await setUpOrganization()
    await inviteYi(proj)

    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    const response = await post('/api/organization/members', {})
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('NOT_FOUND_OR_FORBIDDEN')
  })
})

describe('改角色', () => {
  it('管理员能改，版本号跟着涨', async () => {
    const { proj } = await setUpOrganization()
    const member = await inviteYi(proj)

    const updated = await dataOf<MembershipRow>(
      await post('/api/organization/members/role', {
        membershipId: member.membershipId,
        role: 'project_manager',
        expectedVersion: member.version,
        operationId: 'op-role',
      }),
    )
    expect(updated.role).toBe('project_manager')
    expect(updated.version).toBe(member.version + 1)
  })

  it('版本号过期返回 VERSION_CONFLICT，不静默覆盖', async () => {
    // 静默覆盖的后果是有人以为自己把某人降级了，实际被另一次并发写盖回去
    const { proj } = await setUpOrganization()
    const member = await inviteYi(proj)

    await post('/api/organization/members/role', {
      membershipId: member.membershipId,
      role: 'project_manager',
      expectedVersion: member.version,
      operationId: 'op-role-1',
    })
    const stale = await post('/api/organization/members/role', {
      membershipId: member.membershipId,
      role: 'member',
      expectedVersion: member.version,
      operationId: 'op-role-2',
    })
    expect(await errorOf(stale)).toBe('VERSION_CONFLICT')
  })

  it('拼错的角色名不会进库', async () => {
    // 放行任意字符串的话，之后 ROLE_CAPABILITIES 查表拿到 undefined
    const { proj } = await setUpOrganization()
    const member = await inviteYi(proj)

    const response = await post('/api/organization/members/role', {
      membershipId: member.membershipId,
      role: 'super_admin',
      expectedVersion: member.version,
      operationId: 'op-bad-role',
    })
    expect(response.status).toBe(404)
  })

  it('不能把最后一个所有者降级', async () => {
    await setUpOrganization()
    const owner = await ownerMembership()

    const response = await post('/api/organization/members/role', {
      membershipId: owner.membershipId,
      role: 'member',
      expectedVersion: owner.version,
      operationId: 'op-self-demote',
    })
    expect(response.status).toBe(404)

    // 确认真的没改动 —— 只看返回码的话，一个「拒绝了但也改了」的实现也能过
    expect((await ownerMembership()).role).toBe('organization_owner')
  })

  it('有第二个所有者时就能降级第一个', async () => {
    // 上一条挡的是「最后一个」，不是「所有者」。挡错了的话，所有权转让
    // 完成后的清理步骤就永远做不了
    const { org } = await setUpOrganization()
    const second = await dataOf<MembershipRow>(
      await post('/api/organization/members/invite', {
        accountId: 'yi',
        scopeKind: 'organization',
        scopeId: org,
        role: 'organization_owner',
        operationId: 'op-second-owner',
      }),
    )
    // invited 还不算 active 所有者，要乙先接受
    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    await post('/api/organization/members/accept', {
      membershipId: second.membershipId,
      expectedVersion: second.version,
      operationId: 'op-accept-second',
    })

    principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: org }
    const owner = await ownerMembership()
    const response = await post('/api/organization/members/role', {
      membershipId: owner.membershipId,
      role: 'member',
      expectedVersion: owner.version,
      operationId: 'op-demote-first',
    })
    expect(response.status).toBe(200)
  })

  it('只是被邀请的所有者不算数，挡不住降级最后一个 active 所有者', async () => {
    // 数 invited 的话，一个从没接受过邀请的「所有者」会让真所有者被降掉，
    // 而组织从此没人管
    const { org } = await setUpOrganization()
    await post('/api/organization/members/invite', {
      accountId: 'yi',
      scopeKind: 'organization',
      scopeId: org,
      role: 'organization_owner',
      operationId: 'op-invite-owner',
    })

    const owner = await ownerMembership()
    const response = await post('/api/organization/members/role', {
      membershipId: owner.membershipId,
      role: 'member',
      expectedVersion: owner.version,
      operationId: 'op-demote-with-pending',
    })
    expect(response.status).toBe(404)
  })

  it('改不了别的组织里的成员', async () => {
    // 跨组织与「不存在」返回同一个码，不泄露别的组织里有没有这个人（§46）
    const { proj } = await setUpOrganization()
    const member = await inviteYi(proj)
    principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: 'org-别人的' }

    const response = await post('/api/organization/members/role', {
      membershipId: member.membershipId,
      role: 'member',
      expectedVersion: member.version,
      operationId: 'op-cross-org',
    })
    expect(response.status).toBe(404)
  })
})

describe('移除成员', () => {
  it('移除是状态变更而不是删行 —— 记录留着供审计', async () => {
    // 删掉行就永远回答不了「这个人当时是什么角色、什么时候被谁移除的」
    const { proj } = await setUpOrganization()
    const member = await inviteYi(proj)

    const removed = await dataOf<MembershipRow>(
      await post('/api/organization/members/remove', {
        membershipId: member.membershipId,
        expectedVersion: member.version,
        operationId: 'op-remove',
      }),
    )
    expect(removed.state).toBe('removed')
    expect(removed.role).toBe('developer')

    const listed = await dataOf<{ memberships: MembershipRow[] }>(
      await post('/api/organization/members', {}),
    )
    expect(listed.memberships.find((m) => m.accountId === 'yi')?.state).toBe('removed')
  })

  it('不能移除最后一个所有者', async () => {
    await setUpOrganization()
    const owner = await ownerMembership()

    const response = await post('/api/organization/members/remove', {
      membershipId: owner.membershipId,
      expectedVersion: owner.version,
      operationId: 'op-remove-owner',
    })
    expect(response.status).toBe(404)
    expect((await ownerMembership()).state).toBe('active')
  })

  it('重复移除返回 VERSION_CONFLICT 而不是静默成功', async () => {
    // 调用方拿着过期版本号来，说明它看到的不是当前状态 —— 让它重新读一次
    const { proj } = await setUpOrganization()
    const member = await inviteYi(proj)

    await post('/api/organization/members/remove', {
      membershipId: member.membershipId,
      expectedVersion: member.version,
      operationId: 'op-remove-1',
    })
    const again = await post('/api/organization/members/remove', {
      membershipId: member.membershipId,
      expectedVersion: member.version,
      operationId: 'op-remove-2',
    })
    expect(await errorOf(again)).toBe('VERSION_CONFLICT')
  })

  it('被拒绝的移除同样写审计（§43 第 14 步）', async () => {
    const { org, proj } = await setUpOrganization()
    const member = await inviteYi(proj)

    // 乙没有 organization.manage
    principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: org }
    await post('/api/organization/members/remove', {
      membershipId: member.membershipId,
      expectedVersion: member.version,
      operationId: 'op-remove-denied',
    })

    const events = chat.transaction((db) => auditEventsOf(db, org))
    const rejected = events.filter((e) => e.operationId === 'op-remove-denied')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.outcome).toBe('rejected')
  })
})
