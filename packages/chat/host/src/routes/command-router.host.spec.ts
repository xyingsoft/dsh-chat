/**
 * 命令路由测试。
 *
 * 用真实的 `WebServer` 与真实的 HTTP 请求，而不是 mock —— 跨源判定、请求体上限、
 * 状态码映射这几条都依赖真实的请求对象，mock 出来的很容易和实际行为不一致。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ERROR_CATALOGUE, type ErrorCode } from '@dsh-chat/contract'

import { commandHandler, errorBody, httpStatusOf, isSameOriginWrite } from './command-router.js'

let ctx: Context
let baseUrl: string

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** 注册一个测试用命令端点。 */
async function mount(
  execute: Parameters<typeof commandHandler>[0]['execute'],
  path = '/api/chat/test',
): Promise<void> {
  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      inner.effect(
        () =>
          inner.webServer.register({
            kind: 'exact',
            path,
            handler: commandHandler({ expectedOrigin: baseUrl, execute }),
          }),
        'test route',
      )
    },
  })
}

describe('状态码映射取自错误码目录', () => {
  it('每个错误码的 HTTP 映射与目录一致', () => {
    for (const code of Object.keys(ERROR_CATALOGUE) as ErrorCode[]) {
      expect(httpStatusOf(code)).toBe(ERROR_CATALOGUE[code].http)
    }
  })

  it('两条领域状态码映射为 200 而非错误状态', () => {
    // §46：它们是被正常返回的领域状态而非请求失败，调用方按状态机处理
    expect(httpStatusOf('SANDBOX_QUOTA_EXCEEDED')).toBe(200)
    expect(httpStatusOf('ATTACHMENT_UNAVAILABLE')).toBe(200)
  })

  it('响应体携带可重试性，供客户端决定是否显示重试入口', () => {
    // §5：错误按可重试性分级呈现；§46：可重试性是错误码的固有属性
    expect(errorBody('RATE_LIMITED', 3000)).toEqual({
      error: { code: 'RATE_LIMITED', retryability: 'retryable', retryAfterMs: 3000 },
    })
    expect(errorBody('FORBIDDEN')).toEqual({
      error: { code: 'FORBIDDEN', retryability: 'terminal' },
    })
  })
})

describe('跨源写请求防护（§44.1.2）', () => {
  it('同源写请求放行', async () => {
    await mount(async () => ({ ok: true, value: { ok: 1 } }))
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
  })

  it('跨源写请求被拒绝，返回 FORBIDDEN', async () => {
    await mount(async () => ({ ok: true, value: { ok: 1 } }))
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(httpStatusOf('FORBIDDEN'))
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('跨源请求不会到达业务处理器', async () => {
    let executed = false
    await mount(async () => {
      executed = true
      return { ok: true, value: null }
    })
    await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: '{}',
    })
    expect(executed, '跨源请求应在进入业务逻辑前被拦下').toBe(false)
  })

  it('GET 不受跨源检查限制', () => {
    // 读请求不改变状态；对它做跨源拒绝会误伤合法的嵌入场景
    const request = { method: 'GET', headers: { origin: 'https://other.example' } }
    expect(isSameOriginWrite(request as never, 'http://127.0.0.1:1')).toBe(true)
  })

  it('无 Origin 头的写请求放行', () => {
    // 来自非浏览器客户端；浏览器发起的跨源请求一定带 Origin
    const request = { method: 'POST', headers: {} }
    expect(isSameOriginWrite(request as never, 'http://127.0.0.1:1')).toBe(true)
  })

  it('用 Origin 而非 Referer 判定', () => {
    // Referer 可被隐私设置剥离；当作判定依据会在用户开启隐私保护时误拒
    const request = {
      method: 'POST',
      headers: { referer: 'https://evil.example/page', origin: 'http://127.0.0.1:1' },
    }
    expect(isSameOriginWrite(request as never, 'http://127.0.0.1:1')).toBe(true)
  })
})

describe('请求体处理', () => {
  it('合法 JSON 被解析并传给处理器', async () => {
    let received: unknown
    await mount(async (body) => {
      received = body
      return { ok: true, value: { echoed: true } }
    })
    await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ 消息: '你好' }),
    })
    expect(received).toEqual({ 消息: '你好' })
  })

  it('非法 JSON 被拒绝且不进入业务处理器', async () => {
    let executed = false
    await mount(async () => {
      executed = true
      return { ok: true, value: null }
    })
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: '{ 这不是合法 JSON',
    })
    expect(response.status).toBe(httpStatusOf('NOT_FOUND_OR_FORBIDDEN'))
    expect(executed).toBe(false)
  })
})

describe('错误响应不泄露内部细节（§26）', () => {
  it('业务错误只返回错误码与可重试性', async () => {
    await mount(async () => ({ ok: false, errorCode: 'RECIPIENT_QUEUE_FULL' }))
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl },
      body: '{}',
    })
    expect(response.status).toBe(507)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['error'])
    expect(body['error']).toEqual({
      code: 'RECIPIENT_QUEUE_FULL',
      retryability: 'conditional',
    })
  })

  it('未预期异常不把堆栈或消息返回给客户端', async () => {
    await mount(async () => {
      throw new Error('数据库连接字符串 postgres://user:secret@host/db')
    })
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl },
      body: '{}',
    })
    expect(response.status).toBe(500)
    const text = await response.text()
    // 内部细节绝不能出现在响应中
    expect(text).not.toContain('postgres://')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('Error')
  })
})

describe('响应头', () => {
  it('命令响应不缓存', async () => {
    // 版本号与幂等结果都依赖实时状态，缓存会让客户端拿到过期版本号并触发
    // 本可避免的 VERSION_CONFLICT
    await mount(async () => ({ ok: true, value: { version: 1 } }))
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl },
      body: '{}',
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('响应为 UTF-8 JSON，中文正确往返', async () => {
    await mount(async () => ({ ok: true, value: { 内容: '你好，世界' } }))
    const response = await fetch(`${baseUrl}/api/chat/test`, {
      method: 'POST',
      headers: { origin: baseUrl },
      body: '{}',
    })
    expect(response.headers.get('content-type')).toContain('charset=utf-8')
    const body = (await response.json()) as { data: { 内容: string } }
    expect(body.data.内容).toBe('你好，世界')
  })
})
