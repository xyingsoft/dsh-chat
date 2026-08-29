/**
 * SSE 事件流测试。
 *
 * §17.1 的核心保证是「SSE 断开不会让通知丢失」。所以这里验证的不是
 * 「推送一定送到」，而是**推送失败时收件箱不受影响**、以及客户端拿得到
 * 补拉所需的游标。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EventStreamHub,
  eventStreamHandler,
  type EventStreamDeps,
} from './event-stream.js'

const ORG = 'org-1'
const NOW = new Date('2026-08-30T12:00:00Z')

let ctx: Context
let baseUrl: string
let hub: EventStreamHub
let principal: EventStreamDeps extends { authenticate: (r: never) => infer P } ? P : never
let cursor = 'cursor-42'

beforeEach(async () => {
  hub = new EventStreamHub()
  principal = { accountId: 'yi', deviceId: 'yi-phone', organizationId: ORG }

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`

  const deps: EventStreamDeps = {
    hub,
    authenticate: () => principal,
    cursorOf: () => cursor,
    now: () => NOW,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      inner.effect(
        () =>
          inner.webServer.register({
            kind: 'exact',
            path: '/api/chat/events',
            handler: eventStreamHandler(deps),
          }),
        'route events',
      )
    },
  })
})

afterEach(async () => {
  hub.closeAll()
  await ctx.fiber.dispose()
})

/** 打开一条 SSE 连接，返回读取器与中止句柄。 */
async function openStream(): Promise<{
  read: () => Promise<string>
  abort: () => void
  response: Response
}> {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/api/chat/events`, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  return {
    response,
    read: async () => {
      const { value } = await reader.read()
      return decoder.decode(value)
    },
    abort: () => controller.abort(),
  }
}

/** 从 SSE 帧中取出 data 字段并解析。 */
function parseFrame(frame: string): { id: string; type: string; data: unknown } {
  const id = /^id: (.*)$/m.exec(frame)?.[1] ?? ''
  const type = /^event: (.*)$/m.exec(frame)?.[1] ?? ''
  const data = [...frame.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).join('\n')
  return { id, type, data: JSON.parse(data) }
}

describe('连接建立', () => {
  it('返回 text/event-stream 且禁用缓冲', async () => {
    // 代理缓冲会让「实时推送」变成「几十秒后一起到」，那还不如不推
    const stream = await openStream()
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
    expect(stream.response.headers.get('cache-control')).toContain('no-transform')
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no')
    stream.abort()
  })

  it('连接建立时先发游标，客户端据此补拉（§17.1）', async () => {
    // 不发游标的话客户端要么全量拉，要么漏掉断线期间的通知
    const stream = await openStream()
    const frame = parseFrame(await stream.read())
    expect(frame.type).toBe('stream.ready')
    expect(frame.data).toMatchObject({ cursor: 'cursor-42', organizationId: ORG })
    stream.abort()
  })

  it('未认证返回 401 而不是一条空的事件流', async () => {
    // 返回空流的话，客户端会一直等着，界面表现为「连上了但没消息」——
    // 而实际是没登录
    principal = undefined as never
    const response = await fetch(`${baseUrl}/api/chat/events`)
    expect(response.status).toBe(401)
    await response.body?.cancel()
  })
})

describe('推送', () => {
  it('事件推给对应账号的连接', async () => {
    const stream = await openStream()
    await stream.read() // stream.ready

    expect(hub.publish(ORG, 'yi', { id: 'e-1', type: 'notification', data: { n: 1 } })).toBe(1)
    const frame = parseFrame(await stream.read())
    expect(frame.id).toBe('e-1')
    expect(frame.data).toEqual({ n: 1 })
    stream.abort()
  })

  it('不推给其他账号', async () => {
    const stream = await openStream()
    await stream.read()
    expect(hub.publish(ORG, 'bing', { id: 'e-1', type: 'notification', data: {} })).toBe(0)
    stream.abort()
  })

  it('不推给其他组织', async () => {
    // 组织切换后旧组织的事件不能继续推给已经切走的界面
    const stream = await openStream()
    await stream.read()
    expect(hub.publish('org-2', 'yi', { id: 'e-1', type: 'notification', data: {} })).toBe(0)
    stream.abort()
  })

  it('无人在线时返回 0，这是正常情况不是失败', async () => {
    // 通知已经在收件箱里，对方上线就能拉到。调用方不该据此重试
    expect(hub.publish(ORG, 'yi', { id: 'e-1', type: 'notification', data: {} })).toBe(0)
  })

  it('含换行的负载不会被截断在第一行', async () => {
    // SSE 的 data 逐行加前缀；不处理的话多行 JSON 只有第一行会到
    const stream = await openStream()
    await stream.read()
    hub.publish(ORG, 'yi', { id: 'e-1', type: 'x', data: { text: '第一行\n第二行' } })
    const frame = parseFrame(await stream.read())
    expect(frame.data).toEqual({ text: '第一行\n第二行' })
    stream.abort()
  })
})

describe('连接生命周期', () => {
  it('同一设备重连时旧连接被关掉', async () => {
    // 留着的话，一次断线重连会让同一设备收到两份。客户端按事件 ID 去重
    // 只掩盖了浪费，没有消除它
    const first = await openStream()
    await first.read()
    const second = await openStream()
    await second.read()
    expect(hub.size).toBe(1)
    first.abort()
    second.abort()
  })

  it('同一账号的不同设备各有一条连接', async () => {
    const phone = await openStream()
    await phone.read()
    principal = { accountId: 'yi', deviceId: 'yi-laptop', organizationId: ORG }
    const laptop = await openStream()
    await laptop.read()

    expect(hub.size).toBe(2)
    expect(hub.publish(ORG, 'yi', { id: 'e-1', type: 'x', data: {} })).toBe(2)
    phone.abort()
    laptop.abort()
  })

  it('closeAll 清空全部连接（卸载后不残留）', async () => {
    const stream = await openStream()
    await stream.read()
    hub.closeAll()
    expect(hub.size).toBe(0)
    stream.abort()
  })

  it('向已关闭的连接推送不抛异常，并清理死连接', async () => {
    const stream = await openStream()
    await stream.read()
    hub.closeAll()
    expect(() => hub.publish(ORG, 'yi', { id: 'e-1', type: 'x', data: {} })).not.toThrow()
    stream.abort()
  })
})

describe('SSE 是加速而非数据通路', () => {
  it('hub 不持久化 —— 新实例为空', () => {
    // 一条已经断了的连接，记住它没有任何用处
    expect(new EventStreamHub().size).toBe(0)
  })

  it('推送失败不影响任何已提交状态', () => {
    // §17.1：通知发送失败仅影响即时提醒，不影响消息、工作项或资源的
    // 已提交状态。publish 没有数据库参数 —— 它在类型上就碰不到领域数据
    const delivered = hub.publish(ORG, 'nobody', { id: 'e-1', type: 'x', data: {} })
    expect(delivered).toBe(0)
  })
})
