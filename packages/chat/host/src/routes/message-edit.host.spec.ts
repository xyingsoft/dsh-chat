/**
 * 编辑与撤回端点的端到端测试。
 *
 * 领域语义已在 `message-events.host.spec.ts` 中验证。这里只测**经过 HTTP 之后
 * 才可能出错的那些**：身份从哪里来、错误码怎么映射、审计里有没有正文。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditEventsOf } from '@dsh-chat/audit'
import { acceptContactRequest, createContactRequest, messageView } from '@dsh-chat/messaging'

import { ChatDatabase } from '../storage/database.js'

import {
  editMessageHandler,
  revokeMessageHandler,
  sendMessageHandler,
  type MessageCommandDeps,
  type Principal,
} from './message-commands.js'

const ORG = 'org-1'
const NOW = new Date('2026-08-30T00:00:00Z')

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
let principal: Principal | undefined
let complianceGranted = false

beforeEach(async () => {
  complianceGranted = false
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('alice', '甲', NOW.toISOString())
    insert.run('bob', '乙', NOW.toISOString())
    insert.run('admin', '合规管理员', NOW.toISOString())
    createContactRequest(db, {
      requestId: 'cr-1',
      organizationId: ORG,
      requesterId: 'alice',
      targetId: 'bob',
      now: NOW,
    })
    acceptContactRequest(db, { requestId: 'cr-1', now: NOW })
  })

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  principal = { accountId: 'alice', deviceId: 'alice-laptop', organizationId: ORG }

  const deps: MessageCommandDeps = {
    database: { transaction: chat.transaction.bind(chat) } as MessageCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    queueCapacity: 10,
    leaseMs: 60_000,
    now: () => NOW,
    authorizeCompliance: () => complianceGranted,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      const routes = [
        ['/api/chat/messages', sendMessageHandler(deps)],
        ['/api/chat/messages/edit', editMessageHandler(deps)],
        ['/api/chat/messages/revoke', revokeMessageHandler(deps)],
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

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

/** 甲发一条消息给乙。 */
async function send(messageId = 'msg-1', body = '原始正文'): Promise<void> {
  const response = await post('/api/chat/messages', {
    messageId,
    recipientId: 'bob',
    body,
    operationId: `op-send-${messageId}`,
  })
  expect(response.status).toBe(200)
}

function viewOf(messageId = 'msg-1', senderId = 'alice') {
  return chat.transaction((db) =>
    messageView(db, { organizationId: ORG, senderId, messageId }),
  )
}

describe('编辑', () => {
  it('原发送者可以编辑，正文变更但 messages 表未被覆盖', async () => {
    await send()
    const response = await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      targetRevision: 2,
      body: '改过的正文',
      operationId: 'op-edit',
    })
    expect(response.status).toBe(200)
    expect(viewOf()?.body).toBe('改过的正文')

    const row = chat.readonlyHandle
      .prepare('SELECT body FROM messages WHERE sender_id = ? AND message_id = ?')
      .get('alice', 'msg-1') as { body: string }
    expect(row.body).toBe('原始正文')
  })

  it('senderId 取自认证结果，不能编辑他人消息', async () => {
    // 若从请求体取 senderId，任何人填上别人的 accountId 就能编辑别人的消息 ——
    // 领域层那道「只有原发送者」的检查会因为拿到伪造的 senderId 而通过
    await send()
    principal = { accountId: 'bob', deviceId: 'bob-phone', organizationId: ORG }
    const response = await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      senderId: 'alice',
      targetRevision: 2,
      body: '乙冒充甲改的',
      operationId: 'op-forge',
    })
    expect(response.status).toBe(404)
    expect(viewOf()?.body).toBe('原始正文')
  })

  it('revision 不递增时返回 VERSION_CONFLICT（409）', async () => {
    await send()
    await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      targetRevision: 5,
      body: '新',
      operationId: 'op-a',
    })
    const stale = await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      targetRevision: 3,
      body: '旧',
      operationId: 'op-b',
    })
    expect(stale.status).toBe(409)
    expect(await errorOf(stale)).toBe('VERSION_CONFLICT')
  })

  it('targetRevision 必须是 ≥2 的整数', async () => {
    // 1 是初始正文的 revision，编辑不可能落在它上面；小数与负数同理
    await send()
    for (const bad of [1, 0, -1, 1.5, '2', null]) {
      const response = await post('/api/chat/messages/edit', {
        messageId: 'msg-1',
        targetRevision: bad,
        body: 'x',
        operationId: 'op',
      })
      expect(response.status, `targetRevision=${JSON.stringify(bad)} 未被拒绝`).toBe(404)
    }
  })

  it('空正文与超长正文被拒绝，与发送同一口径', async () => {
    await send()
    expect(
      (
        await post('/api/chat/messages/edit', {
          messageId: 'msg-1',
          targetRevision: 2,
          body: '',
          operationId: 'op',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await post('/api/chat/messages/edit', {
          messageId: 'msg-1',
          targetRevision: 2,
          body: '啊'.repeat(8001),
          operationId: 'op',
        })
      ).status,
    ).toBe(404)
  })

  it('审计记录编辑，但不含新正文', async () => {
    // 否则审计表就成了消息正文的第二份副本，§43 第 14 步的约束形同虚设
    await send()
    await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      targetRevision: 2,
      body: '这段文字不该出现在审计里',
      operationId: 'op-edit',
    })
    const events = chat.transaction((db) => auditEventsOf(db, ORG))
    const dump = JSON.stringify(events)
    expect(dump).not.toContain('这段文字不该出现在审计里')
    expect(events.some((e) => e.eventType === 'message_edited')).toBe(true)
  })

  it('被拒绝的编辑同样留审计', async () => {
    await send()
    principal = { accountId: 'bob', deviceId: 'bob-phone', organizationId: ORG }
    await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      targetRevision: 2,
      body: 'x',
      operationId: 'op-rejected',
    })
    const events = chat.transaction((db) => auditEventsOf(db, ORG))
    expect(events.some((e) => e.outcome === 'rejected' && e.eventType === 'message_edited')).toBe(
      true,
    )
  })
})

describe('撤回', () => {
  it('原发送者可以撤回，正文不再可得', async () => {
    await send()
    const response = await post('/api/chat/messages/revoke', {
      messageId: 'msg-1',
      senderId: 'alice',
      operationId: 'op-revoke',
    })
    expect(response.status).toBe(200)
    const view = viewOf()
    expect(view?.revoked).toBe(true)
    expect(view?.body).toBeUndefined()
  })

  it('没有合规权限时撤不了别人的消息', async () => {
    await send()
    principal = { accountId: 'admin', deviceId: 'admin-pc', organizationId: ORG }
    complianceGranted = false
    const response = await post('/api/chat/messages/revoke', {
      messageId: 'msg-1',
      senderId: 'alice',
      operationId: 'op-nope',
    })
    expect(response.status).toBe(404)
    expect(viewOf()?.revoked).toBe(false)
  })

  it('有合规权限时可以撤回他人消息', async () => {
    await send()
    principal = { accountId: 'admin', deviceId: 'admin-pc', organizationId: ORG }
    complianceGranted = true
    const response = await post('/api/chat/messages/revoke', {
      messageId: 'msg-1',
      senderId: 'alice',
      operationId: 'op-compliance',
    })
    expect(response.status).toBe(200)
    expect(viewOf()?.revoked).toBe(true)
  })

  it('撤回后再编辑返回 RESOURCE_GONE（410）', async () => {
    await send()
    await post('/api/chat/messages/revoke', {
      messageId: 'msg-1',
      senderId: 'alice',
      operationId: 'op-revoke',
    })
    const response = await post('/api/chat/messages/edit', {
      messageId: 'msg-1',
      targetRevision: 9,
      body: 'x',
      operationId: 'op-late',
    })
    expect(response.status).toBe(410)
    expect(await errorOf(response)).toBe('RESOURCE_GONE')
  })

  it('重复撤回是幂等的', async () => {
    await send()
    const body = { messageId: 'msg-1', senderId: 'alice', operationId: 'op-revoke' }
    const first = await post('/api/chat/messages/revoke', body)
    const second = await post('/api/chat/messages/revoke', body)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual(await second.json())
  })
})

describe('通用边界', () => {
  it('未认证请求返回 401', async () => {
    principal = undefined
    for (const path of ['/api/chat/messages/edit', '/api/chat/messages/revoke']) {
      expect((await post(path, { messageId: 'x', operationId: 'op' })).status).toBe(401)
    }
  })

  it('跨源写请求被拒绝', async () => {
    await send()
    const response = await fetch(`${baseUrl}/api/chat/messages/revoke`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'msg-1', senderId: 'alice', operationId: 'op' }),
    })
    expect(response.status).toBe(403)
    expect(viewOf()?.revoked).toBe(false)
  })

  it('不存在的消息返回 404，与无权限不可区分', async () => {
    const missing = await post('/api/chat/messages/revoke', {
      messageId: 'msg-nonexistent',
      senderId: 'alice',
      operationId: 'op-a',
    })
    await send()
    principal = { accountId: 'bob', deviceId: 'bob-phone', organizationId: ORG }
    const forbidden = await post('/api/chat/messages/revoke', {
      messageId: 'msg-1',
      senderId: 'alice',
      operationId: 'op-b',
    })
    expect(missing.status).toBe(forbidden.status)
    expect(await errorOf(missing)).toBe(await errorOf(forbidden))
  })
})
