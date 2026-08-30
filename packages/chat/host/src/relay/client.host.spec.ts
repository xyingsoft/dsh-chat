/**
 * relay 客户端测试。
 *
 * §41 那条「不兼容时**停止组织写入，不进入静默降级或部分可用状态**」是这里的
 * 主线。多数用例在确认：各种失败方式都落到一个**明确的、可区分的**状态，
 * 没有一种会让调用方以为写成功了。
 *
 * 用注入的 `fetch` 而不是起真实服务：这一层要测的是状态机与错误映射，
 * 真实网络的部分由三进程验收覆盖。
 */

import { describe, expect, it } from 'vitest'

import { RelayClient } from './client.js'

const PRINCIPAL = { accountId: 'jia', deviceId: 'jia-desktop', organizationId: 'org-1' }

/** 造一个按路径返回预设应答的 fetch。 */
function stubFetch(
  routes: Record<string, { status?: number; body?: unknown; throws?: boolean }>,
): { fn: typeof globalThis.fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const path = new URL(url).pathname
    const route = routes[path]
    if (route === undefined || route.throws === true) throw new Error('网络不可达')
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { fn, calls }
}

function client(routes: Parameters<typeof stubFetch>[0]): {
  relay: RelayClient
  calls: Array<{ url: string; headers: Record<string, string> }>
} {
  const { fn, calls } = stubFetch(routes)
  return {
    relay: new RelayClient({
      baseUrl: 'http://relay.test',
      sharedSecret: 'shared-secret-value',
      fetch: fn,
    }),
    calls,
  }
}

const COMPATIBLE = {
  data: { currentVersion: 1, minimumVersion: 1, eventFormatVersions: { message_accepted: 1 } },
}

describe('协商', () => {
  it('版本兼容时进入 ready 且可写', async () => {
    const { relay } = client({ '/protocol/negotiate': { body: COMPATIBLE } })
    const state = await relay.connect()
    expect(state.kind).toBe('ready')
    expect(relay.writable).toBe(true)
  })

  it('host 版本低于 relay 最低支持版本时不可写', async () => {
    // §41：不兼容时停止组织写入
    const { relay } = client({
      '/protocol/negotiate': {
        body: {
          data: { currentVersion: 9, minimumVersion: 5, eventFormatVersions: {} },
        },
      },
    })
    const state = await relay.connect()
    expect(state.kind).toBe('incompatible')
    expect(relay.writable).toBe(false)
  })

  it('不兼容时带出明确的升级提示', async () => {
    // §41 要求「显示明确的升级提示」——「协议版本不兼容」这种话用户读了
    // 不知道要做什么
    const { relay } = client({
      '/protocol/negotiate': {
        body: { data: { currentVersion: 9, minimumVersion: 5, eventFormatVersions: {} } },
      },
    })
    const state = await relay.connect()
    if (state.kind !== 'incompatible') throw new Error('应为 incompatible')
    expect(state.hint).toContain('升级')
    expect(state.hint).toContain('组织写入已停止')
  })

  it('连不上与协议不兼容是两种状态', async () => {
    // 前者可重试，后者要升级。混为一谈会让客户端做错重试决策
    const { relay } = client({ '/protocol/negotiate': { throws: true } })
    const state = await relay.connect()
    expect(state.kind).toBe('unreachable')
  })

  it('应答形状不对算连不上，不算不兼容', async () => {
    // 「不兼容」意味着对面是个能说话但版本不同的 relay；
    // 形状不对是对面根本没按约定应答
    const { relay } = client({ '/protocol/negotiate': { body: { data: { nonsense: true } } } })
    expect((await relay.connect()).kind).toBe('unreachable')
  })

  it('协商失败不抛异常', async () => {
    // relay 暂时连不上不该让整个插件装载失败，那会让用户连设置面板都打不开
    const { relay } = client({ '/protocol/negotiate': { throws: true } })
    await expect(relay.connect()).resolves.toBeDefined()
  })
})

describe('调用前必须先协商', () => {
  it('未协商时调用返回可重试的 503，而不是假装成功', async () => {
    const { relay } = client({ '/api/chat/conversations': { body: { data: {} } } })
    const response = await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: { code: 'SERVICE_READ_ONLY' } })
  })

  it('未协商时不会真的发出业务请求', async () => {
    // 发出去了就意味着一个协议不明的 host 在往 relay 写东西
    const { relay, calls } = client({ '/api/chat/messages': { body: { data: {} } } })
    await relay.call('/api/chat/messages', { body: 'x' }, PRINCIPAL)
    expect(calls.filter((c) => c.url.includes('/api/chat/messages'))).toHaveLength(0)
  })

  it('不兼容时调用返回 PROTOCOL_VERSION_UNSUPPORTED 且不发请求', async () => {
    const { relay, calls } = client({
      '/protocol/negotiate': {
        body: { data: { currentVersion: 9, minimumVersion: 5, eventFormatVersions: {} } },
      },
      '/api/chat/messages': { body: { data: {} } },
    })
    await relay.connect()
    const response = await relay.call('/api/chat/messages', {}, PRINCIPAL)
    expect(response.status).toBe(426)
    expect(response.body).toMatchObject({
      error: { code: 'PROTOCOL_VERSION_UNSUPPORTED', retryability: 'terminal' },
    })
    expect(calls.filter((c) => c.url.includes('/api/chat/messages'))).toHaveLength(0)
  })
})

describe('身份走请求头', () => {
  it('账号、组织、设备都以请求头带出', async () => {
    const { relay, calls } = client({
      '/protocol/negotiate': { body: COMPATIBLE },
      '/api/chat/conversations': { body: { data: { conversations: [] } } },
    })
    await relay.connect()
    await relay.call('/api/chat/conversations', {}, PRINCIPAL)

    const call = calls.find((c) => c.url.includes('/api/chat/conversations'))
    expect(call?.headers['x-dsh-account']).toBe('jia')
    expect(call?.headers['x-dsh-organization']).toBe('org-1')
    expect(call?.headers['x-dsh-device']).toBe('jia-desktop')
  })

  it('共享密钥以 Bearer 带出', async () => {
    const { relay, calls } = client({
      '/protocol/negotiate': { body: COMPATIBLE },
      '/api/chat/conversations': { body: { data: {} } },
    })
    await relay.connect()
    await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    const call = calls.find((c) => c.url.includes('/api/chat/conversations'))
    expect(call?.headers['authorization']).toBe('Bearer shared-secret-value')
  })

  it('协商请求不带身份 —— 那时还没有会话', async () => {
    const { relay, calls } = client({ '/protocol/negotiate': { body: COMPATIBLE } })
    await relay.connect()
    const call = calls[0]
    expect(call?.headers['x-dsh-account']).toBeUndefined()
  })
})

describe('应答透传', () => {
  it('成功应答原样返回', async () => {
    const { relay } = client({
      '/protocol/negotiate': { body: COMPATIBLE },
      '/api/chat/conversations': { body: { data: { conversations: [{ peerId: 'yi' }] } } },
    })
    await relay.connect()
    const response = await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: { conversations: [{ peerId: 'yi' }] } })
  })

  it('错误应答连同状态码一起透传', async () => {
    // relay 的错误信封与 host 自己的同形状，翻译一道只会引入
    // 两套措辞不一致的风险
    const { relay } = client({
      '/protocol/negotiate': { body: COMPATIBLE },
      '/api/chat/messages': { status: 404, body: { error: { code: 'NOT_FOUND_OR_FORBIDDEN' } } },
    })
    await relay.connect()
    const response = await relay.call('/api/chat/messages', {}, PRINCIPAL)
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND_OR_FORBIDDEN' } })
  })

  it('调用中途网络失败返回可重试的 503 而不是抛出去', async () => {
    const { relay } = client({
      '/protocol/negotiate': { body: COMPATIBLE },
      '/api/chat/messages': { throws: true },
    })
    await relay.connect()
    const response = await relay.call('/api/chat/messages', {}, PRINCIPAL)
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: { retryability: 'retryable' } })
  })
})
