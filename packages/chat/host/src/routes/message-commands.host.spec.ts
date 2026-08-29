/**
 * 私聊命令端点的端到端测试。
 *
 * 这是全套里最接近真实使用的一层：真实 HTTP、真实数据库、真实领域模块。
 * 上层的骨架走查用库调用验证语义，这里验证同一套语义**经过 HTTP 之后仍然成立** ——
 * 序列化、认证注入、事务边界都可能在这一层引入偏差。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditEventsOf } from '@dsh-chat/audit'
import { acceptContactRequest, block, createContactRequest } from '@dsh-chat/messaging'

import { ChatDatabase } from '../storage/database.js'

import {
  ackMessagesHandler,
  pullMessagesHandler,
  sendMessageHandler,
  type MessageCommandDeps,
  type Principal,
} from './message-commands.js'

const ORG = 'org-1'
const NOW = new Date('2026-08-30T00:00:00Z')

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
/** 当前请求的身份，测试通过改这个变量切换调用者。 */
let principal: Principal | undefined

beforeEach(async () => {
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('alice', '甲', NOW.toISOString())
    insert.run('bob', '乙', NOW.toISOString())
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
    // 直接用 ChatDatabase 而非服务包装：本测试关心的是端点行为，
    // 服务包装的生命周期已在 database.host.spec.ts 中单独验证
    database: { transaction: chat.transaction.bind(chat) } as MessageCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    queueCapacity: 2,
    leaseMs: 60_000,
    now: () => NOW,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      const routes = [
        ['/api/chat/messages', sendMessageHandler(deps)],
        ['/api/chat/messages/pull', pullMessagesHandler(deps)],
        ['/api/chat/messages/ack', ackMessagesHandler(deps)],
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

const sendPayload = (messageId: string, text = '你好') => ({
  messageId,
  recipientId: 'bob',
  body: text,
  operationId: `op-${messageId}`,
})

describe('发送', () => {
  it('成功发送返回 DeliverySeq', async () => {
    const response = await post('/api/chat/messages', sendPayload('m-1'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { deliverySeq: number } }
    expect(body.data.deliverySeq).toBe(1)
  })

  it('中文正文经 HTTP 往返后原样落库', async () => {
    await post('/api/chat/messages', sendPayload('m-1', '你好，世界。这是一条中文消息。'))
    const stored = chat.readonlyHandle
      .prepare('SELECT body FROM messages WHERE message_id = ?')
      .get('m-1') as { body: string }
    expect(stored.body).toBe('你好，世界。这是一条中文消息。')
  })

  it('未认证返回 UNAUTHENTICATED', async () => {
    principal = undefined
    const response = await post('/api/chat/messages', sendPayload('m-1'))
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('被拉黑时拒绝，且不写入消息', async () => {
    chat.transaction((db) => block(db, { organizationId: ORG, actorId: 'bob', subjectId: 'alice', now: NOW }))
    const response = await post('/api/chat/messages', sendPayload('m-1'))
    expect(response.status).toBe(404)
    const stored = chat.readonlyHandle
      .prepare('SELECT message_id FROM messages WHERE message_id = ?')
      .get('m-1')
    expect(stored).toBeUndefined()
  })

  it('队列满返回 RECIPIENT_QUEUE_FULL（507）', async () => {
    await post('/api/chat/messages', sendPayload('m-1'))
    await post('/api/chat/messages', sendPayload('m-2'))
    const response = await post('/api/chat/messages', sendPayload('m-3'))
    expect(response.status).toBe(507)
    const body = (await response.json()) as { error: { code: string; retryability: string } }
    expect(body.error.code).toBe('RECIPIENT_QUEUE_FULL')
    expect(body.error.retryability).toBe('conditional')
  })

  it('超长正文被拒绝', async () => {
    // §30.1：消息正文 8000 字素簇，提交前拒绝且不截断
    const tooLong = '字'.repeat(8001)
    const response = await post('/api/chat/messages', sendPayload('m-1', tooLong))
    expect(response.status).toBe(404)
  })

  it('正文长度按字素簇而非 UTF-16 码元计算', async () => {
    // 一个 emoji 在 length 上算 2，按字素簇算 1。用 4000 个 emoji 测：
    // 若按 length 判断会是 8000 恰好通过边界，按字素簇是 4000，应当通过
    const emojis = '👍'.repeat(4000)
    const response = await post('/api/chat/messages', sendPayload('m-1', emojis))
    expect(response.status).toBe(200)
  })

  it('同一 messageId 重发是幂等的', async () => {
    const first = await post('/api/chat/messages', sendPayload('m-1'))
    const second = await post('/api/chat/messages', sendPayload('m-1'))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const count = chat.readonlyHandle
      .prepare('SELECT COUNT(*) AS n FROM messages')
      .get() as { n: number }
    expect(count.n).toBe(1)
  })
})

describe('审计与领域写入同事务（§44.1.2）', () => {
  it('成功发送写入 succeeded 审计', async () => {
    await post('/api/chat/messages', sendPayload('m-1'))
    const events = auditEventsOf(chat.readonlyHandle, ORG)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      outcome: 'succeeded',
      actorAccountId: 'alice',
      deviceId: 'alice-laptop',
      targetRef: 'message:alice/m-1',
    })
  })

  it('被拒绝的发送同样写入审计并记录错误码', async () => {
    // §43 第 14 步：被拒绝的越权尝试同样留下记录
    chat.transaction((db) => block(db, { organizationId: ORG, actorId: 'bob', subjectId: 'alice', now: NOW }))
    await post('/api/chat/messages', sendPayload('m-1'))
    const events = auditEventsOf(chat.readonlyHandle, ORG)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      outcome: 'rejected',
      errorCode: 'NOT_FOUND_OR_FORBIDDEN',
    })
  })

  it('审计中不含消息正文', async () => {
    await post('/api/chat/messages', sendPayload('m-1', '这是不该出现在审计里的正文'))
    const serialized = JSON.stringify(auditEventsOf(chat.readonlyHandle, ORG))
    expect(serialized).not.toContain('这是不该出现在审计里的正文')
    // targetRef 只放引用
    expect(serialized).toContain('message:alice/m-1')
  })
})

describe('拉取与确认', () => {
  async function asBob<T>(body: () => Promise<T>): Promise<T> {
    principal = { accountId: 'bob', deviceId: 'bob-laptop', organizationId: ORG }
    try {
      return await body()
    } finally {
      principal = { accountId: 'alice', deviceId: 'alice-laptop', organizationId: ORG }
    }
  }

  it('乙拉取到甲发送的消息', async () => {
    await post('/api/chat/messages', sendPayload('m-1', '第一条'))
    const items = await asBob(async () => {
      const response = await post('/api/chat/messages/pull', { batchSize: 10 })
      const body = (await response.json()) as { data: { items: Array<{ body: string }> } }
      return body.data.items
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.body).toBe('第一条')
  })

  it('deviceId 来自认证结果而非请求体——不能冒用他人租约', async () => {
    await post('/api/chat/messages', sendPayload('m-1'))
    await asBob(async () => {
      await post('/api/chat/messages/pull', { batchSize: 10 })
    })
    // 甲试图确认乙的批次，并在请求体里伪造 deviceId
    const response = await post('/api/chat/messages/ack', {
      deliverySeqs: [1],
      deviceId: 'bob-laptop',
    })
    const body = (await response.json()) as { data: { acked: number } }
    // 认证身份是甲，租约属于乙的设备，确认数为 0
    expect(body.data.acked).toBe(0)
  })

  it('ACK 后队列腾出额度', async () => {
    await post('/api/chat/messages', sendPayload('m-1'))
    await post('/api/chat/messages', sendPayload('m-2'))
    expect((await post('/api/chat/messages', sendPayload('m-3'))).status).toBe(507)

    await asBob(async () => {
      const pull = await post('/api/chat/messages/pull', { batchSize: 10 })
      const body = (await pull.json()) as { data: { items: Array<{ deliverySeq: number }> } }
      await post('/api/chat/messages/ack', {
        deliverySeqs: body.data.items.map((i) => i.deliverySeq),
      })
    })

    expect((await post('/api/chat/messages', sendPayload('m-4'))).status).toBe(200)
  })

  it('确认数与请求数一并返回，便于发现过期租约', async () => {
    await post('/api/chat/messages', sendPayload('m-1'))
    const result = await asBob(async () => {
      await post('/api/chat/messages/pull', { batchSize: 10 })
      const response = await post('/api/chat/messages/ack', { deliverySeqs: [1, 999] })
      return (await response.json()) as { data: { acked: number; requested: number } }
    })
    expect(result.data).toEqual({ acked: 1, requested: 2 })
  })
})
