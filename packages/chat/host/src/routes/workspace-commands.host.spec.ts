/**
 * 组织、工作项与通知端点的端到端测试。
 *
 * 与私聊端点的区别在于这些命令**需要授权判定**。因此测试的重点是：
 * 越权调用被拒绝、拒绝路径同样留审计、判定与写入在同一事务内。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditEventsOf } from '@dsh-chat/audit'
import {
  acceptMembership,
  createOrganization,
  createProject,
  createWorkspace,
  inviteMember,
  type Role,
} from '@dsh-chat/organization'

import { ChatDatabase } from '../storage/database.js'

import type { Principal } from './message-commands.js'
import {
  addDependencyHandler,
  assignWorkItemHandler,
  createWorkItemHandler,
  inboxHandler,
  type WorkspaceCommandDeps,
} from './workspace-commands.js'

const ORG = 'org-1'
const NOW = new Date('2026-08-30T00:00:00Z')

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
let principal: Principal | undefined
let idCounter = 0

/** 加入一名成员并直接置为 active。 */
function addMember(accountId: string, role: Role, scopeId = 'proj-1'): void {
  chat.transaction((db) => {
    const membershipId = `m-${accountId}`
    inviteMember(db, {
      membershipId,
      organizationId: ORG,
      accountId,
      scopeKind: 'project',
      scopeId,
      role,
      now: NOW,
    })
    acceptMembership(db, { membershipId, expectedVersion: 1, now: NOW })
  })
}

beforeEach(async () => {
  idCounter = 0
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    for (const [id, name] of [
      ['pm', '项目经理'],
      ['dev', '开发者'],
      ['outsider', '局外人'],
    ]) {
      insert.run(id, name, NOW.toISOString())
    }
    createOrganization(db, { organizationId: ORG, name: 'Acme', createdBy: 'pm', now: NOW })
    createWorkspace(db, {
      workspaceId: 'ws-1',
      organizationId: ORG,
      name: '研发',
      createdBy: 'pm',
      now: NOW,
    })
    createProject(db, {
      projectId: 'proj-1',
      organizationId: ORG,
      workspaceId: 'ws-1',
      name: 'chat',
      createdBy: 'pm',
      now: NOW,
    })
  })
  addMember('pm', 'project_manager')
  addMember('dev', 'developer')

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  principal = { accountId: 'pm', deviceId: 'pm-laptop', organizationId: ORG }

  const deps: WorkspaceCommandDeps = {
    database: {
      transaction: chat.transaction.bind(chat),
      readonlyHandle: chat.readonlyHandle,
    } as WorkspaceCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    now: () => NOW,
    // 可预测的 ID，使断言与复现都稳定（§45：测试数据不含真实凭证）
    newId: (prefix) => `${prefix}-${++idCounter}`,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      const routes = [
        ['/api/chat/work-items', createWorkItemHandler(deps)],
        ['/api/chat/work-items/assign', assignWorkItemHandler(deps)],
        ['/api/chat/work-items/dependencies', addDependencyHandler(deps)],
        ['/api/chat/notifications', inboxHandler(deps)],
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

async function createItem(title = '实现投递'): Promise<{ workItemId: string; version: number }> {
  const response = await post('/api/chat/work-items', {
    projectId: 'proj-1',
    title,
    operationId: `op-${title}`,
  })
  const body = (await response.json()) as { data: { workItemId: string; version: number } }
  return body.data
}

describe('授权判定', () => {
  it('项目经理可以创建工作项', async () => {
    const response = await post('/api/chat/work-items', {
      projectId: 'proj-1',
      title: '实现投递',
      operationId: 'op-1',
    })
    expect(response.status).toBe(200)
  })

  it('开发者不能创建工作项', async () => {
    // §11.1：创建项目群、工作项是项目经理的能力
    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    const response = await post('/api/chat/work-items', {
      projectId: 'proj-1',
      title: '越权创建',
      operationId: 'op-1',
    })
    expect(response.status).toBe(404)
  })

  it('非成员不能创建工作项', async () => {
    principal = { accountId: 'outsider', deviceId: 'x', organizationId: ORG }
    const response = await post('/api/chat/work-items', {
      projectId: 'proj-1',
      title: '越权创建',
      operationId: 'op-1',
    })
    expect(response.status).toBe(404)
  })

  it('开发者不能分派工作项', async () => {
    // §17：只有项目经理、项目管理员或被授予分派权限的成员可变更负责人
    const item = await createItem()
    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    const response = await post('/api/chat/work-items/assign', {
      workItemId: item.workItemId,
      assigneeId: 'dev',
      expectedVersion: item.version,
      operationId: 'op-assign',
    })
    expect(response.status).toBe(404)
  })

  it('越权尝试同样写入审计（§43 第 14 步）', async () => {
    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    await post('/api/chat/work-items', {
      projectId: 'proj-1',
      title: '越权创建',
      operationId: 'op-1',
    })
    const events = auditEventsOf(chat.readonlyHandle, ORG)
    const rejected = events.filter((e) => e.outcome === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      actorAccountId: 'dev',
      errorCode: 'NOT_FOUND_OR_FORBIDDEN',
    })
  })

  it('越权被拒时不产生任何领域写入', async () => {
    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    await post('/api/chat/work-items', {
      projectId: 'proj-1',
      title: '越权创建',
      operationId: 'op-1',
    })
    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS n FROM work_items')
      .get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('分派与通知', () => {
  it('分派成功后被分派人收到通知', async () => {
    const item = await createItem()
    const response = await post('/api/chat/work-items/assign', {
      workItemId: item.workItemId,
      assigneeId: 'dev',
      expectedVersion: item.version,
      operationId: 'op-assign',
    })
    expect(response.status).toBe(200)

    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    const inbox = await post('/api/chat/notifications', { limit: 10 })
    const body = (await inbox.json()) as {
      data: { items: Array<{ eventType: string; priority: string }>; unread: number }
    }
    expect(body.data.unread).toBe(1)
    expect(body.data.items[0]).toMatchObject({
      eventType: 'work_item_acknowledgement_request',
      // §17.1：签收请求不参与聚合，始终逐条呈现
      priority: 'high',
    })
  })

  it('版本不匹配时分派失败且不发通知', async () => {
    const item = await createItem()
    const response = await post('/api/chat/work-items/assign', {
      workItemId: item.workItemId,
      assigneeId: 'dev',
      expectedVersion: 99,
      operationId: 'op-assign',
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VERSION_CONFLICT')

    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    const inbox = await post('/api/chat/notifications', {})
    const inboxBody = (await inbox.json()) as { data: { unread: number } }
    expect(inboxBody.data.unread, '失败的分派不应产生通知').toBe(0)
  })
})

describe('依赖成环', () => {
  it('成环返回 DEPENDENCY_CYCLE（409）', async () => {
    const a = await createItem('A')
    const b = await createItem('B')
    await post('/api/chat/work-items/dependencies', {
      fromId: a.workItemId,
      toId: b.workItemId,
      kind: 'depends_on',
    })
    const response = await post('/api/chat/work-items/dependencies', {
      fromId: b.workItemId,
      toId: a.workItemId,
      kind: 'depends_on',
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; retryability: string } }
    expect(body.error.code).toBe('DEPENDENCY_CYCLE')
    // §46：DEPENDENCY_CYCLE 是 terminal，重试无意义
    expect(body.error.retryability).toBe('terminal')
  })
})

describe('收件箱游标', () => {
  it('按游标补拉而非页码', async () => {
    // §17.1：host 重连后从收件箱游标补拉。页码在有新通知插入时会错位
    const first = await createItem('第一项')
    await post('/api/chat/work-items/assign', {
      workItemId: first.workItemId,
      assigneeId: 'dev',
      expectedVersion: first.version,
      operationId: 'op-1',
    })

    principal = { accountId: 'dev', deviceId: 'dev-laptop', organizationId: ORG }
    const page = await post('/api/chat/notifications', { limit: 10 })
    const body = (await page.json()) as { data: { items: Array<{ createdAt: string }> } }
    expect(body.data.items).toHaveLength(1)

    const after = body.data.items[0]!.createdAt
    const next = await post('/api/chat/notifications', { after, limit: 10 })
    const nextBody = (await next.json()) as { data: { items: unknown[] } }
    expect(nextBody.data.items).toHaveLength(0)
  })
})
