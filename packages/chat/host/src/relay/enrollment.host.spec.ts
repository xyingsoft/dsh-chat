/**
 * 开户与 token 生命周期测试。
 *
 * 用注入的 fetch 记下**每一个出站请求的完整报文**，然后对着它断言。这比测
 * 「函数返回了什么」有用得多：这一层最要紧的性质是「什么东西没有被发出去」，
 * 而那只能从报文上看。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CredentialStore } from '../identity/credentials.js'

import { RelayClient } from './client.js'

let workDir: string
let store: CredentialStore
let sent: { url: string; headers: Record<string, string>; body: string }[]

interface Reply {
  status: number
  body: unknown
}

/** 按 URL 后缀排队的假 relay。取不到就 404 —— 沉默地成功会掩盖路径写错。 */
function fakeRelay(replies: Record<string, Reply | Reply[]>): typeof globalThis.fetch {
  const queues = new Map<string, Reply[]>(
    Object.entries(replies).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  )
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = init?.headers as Record<string, string>
    sent.push({ url, headers, body: String(init?.body ?? '') })
    const key = Object.keys(replies).find((suffix) => url.endsWith(suffix))
    const queue = key === undefined ? undefined : queues.get(key)
    const reply = queue?.length === 1 ? queue[0] : queue?.shift()
    if (reply === undefined) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND_OR_FORBIDDEN' } }), {
        status: 404,
      })
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as typeof globalThis.fetch
}

function session(suffix: string): Reply {
  return {
    status: 200,
    body: {
      data: {
        accountId: 'acct-9',
        deviceId: 'dev-9',
        accessToken: `access-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        accessExpiresAt: '2026-12-01T00:00:00.000Z',
        refreshExpiresAt: '2027-12-01T00:00:00.000Z',
      },
    },
  }
}

const NEGOTIATE: Reply = {
  status: 200,
  body: {
    data: {
      currentVersion: 1,
      minimumVersion: 1,
      eventFormatVersions: {
        message_accepted: 1,
        notification_created: 1,
        work_item_changed: 1,
      },
    },
  },
}

function client(fetchImpl: typeof globalThis.fetch): RelayClient {
  return new RelayClient({
    baseUrl: 'https://relay.test',
    sharedSecret: 'deployment-secret',
    credentials: store,
    fetch: fetchImpl,
  })
}

const PRINCIPAL = { accountId: 'acct-9', deviceId: 'dev-9', organizationId: 'org-1' }

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-enroll-'))
  store = new CredentialStore(join(workDir, 'creds.json'))
  sent = []
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('开户', () => {
  it('凭据落到本机，账号与设备来自 relay', async () => {
    const relay = client(fakeRelay({ '/api/identity/register': session('1') }))
    const result = await relay.enroll({
      inviteCode: 'code-1',
      displayName: '甲',
      deviceName: '甲的笔记本',
    })

    expect(result.ok).toBe(true)
    const saved = store.read()
    expect(saved?.accountId).toBe('acct-9')
    expect(saved?.accessToken).toBe('access-1')
    expect(relay.enrolled).toBe(true)
  })

  it('出站请求里只有公钥 —— 私钥一个字节都没走', async () => {
    // §7 的「私钥永不上传」在这一条上兑现。改坏了这个性质，其他所有
    // 安全性质都不再成立：私钥泄露之后设备身份就是可伪造的
    const relay = client(fakeRelay({ '/api/identity/register': session('1') }))
    await relay.enroll({ inviteCode: 'code-1', displayName: '甲', deviceName: '笔记本' })

    const saved = store.read()
    expect(saved?.signingPrivateKey.length).toBeGreaterThan(0)
    const outbound = sent.map((r) => r.body).join('\n')
    expect(outbound).toContain(saved?.signingPublicKey)
    expect(outbound).not.toContain(saved?.signingPrivateKey)
    for (const key of ['signingPrivateKey', 'privateKey', 'PRIVATE KEY']) {
      expect(outbound, `报文里出现了 ${key}`).not.toContain(key)
    }
  })

  it('relay 拒绝时不留下半份凭据', async () => {
    // 留下的话，本机以为开过户了，之后每个请求都 401 —— 而正确的处置
    // 是重新走一遍注册
    const relay = client(
      fakeRelay({
        '/api/identity/register': { status: 404, body: { error: { code: 'NOT_FOUND_OR_FORBIDDEN' } } },
      }),
    )
    const result = await relay.enroll({ inviteCode: 'bad', displayName: '甲', deviceName: '本' })

    expect(result.ok).toBe(false)
    expect(store.read()).toBeUndefined()
    expect(relay.enrolled).toBe(false)
  })

  it('应答缺字段时整个当失败', async () => {
    // 写一份缺 refreshToken 的凭据进去，本机会一直用到 access 过期，
    // 然后既刷不了也不知道为什么
    const relay = client(
      fakeRelay({
        '/api/identity/register': {
          status: 200,
          body: { data: { accountId: 'a', deviceId: 'd', accessToken: 't' } },
        },
      }),
    )
    expect((await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })).ok).toBe(
      false,
    )
    expect(store.read()).toBeUndefined()
  })

  it('协议不兼容时仍然可以开户', async () => {
    // 开户恰恰是版本升级之后要重做的事。挡住它等于让一个版本不匹配的部署
    // 连自救都做不到
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': {
          status: 200,
          body: { data: { currentVersion: 99, minimumVersion: 99, eventFormatVersions: {} } },
        },
        '/api/identity/register': session('1'),
      }),
    )
    await relay.connect()
    expect(relay.state.kind).toBe('incompatible')
    expect((await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })).ok).toBe(
      true,
    )
  })
})

describe('token 认证', () => {
  it('开过户之后用 access token，不再用共享密钥', async () => {
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': NEGOTIATE,
        '/api/identity/register': session('1'),
        '/api/chat/conversations': { status: 200, body: { data: { conversations: [] } } },
      }),
    )
    await relay.connect()
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    sent = []
    await relay.call('/api/chat/conversations', {}, PRINCIPAL)

    expect(sent[0]?.headers['authorization']).toBe('Bearer access-1')
    expect(sent[0]?.headers['authorization']).not.toContain('deployment-secret')
  })

  it('没开户时回落共享密钥', async () => {
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': NEGOTIATE,
        '/api/chat/conversations': { status: 200, body: { data: {} } },
      }),
    )
    await relay.connect()
    sent = []
    await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(sent[0]?.headers['authorization']).toBe('Bearer deployment-secret')
  })

  it('组织仍由请求头带 —— 一个账号可属多个组织（§9）', async () => {
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': NEGOTIATE,
        '/api/identity/register': session('1'),
        '/api/chat/conversations': { status: 200, body: { data: {} } },
      }),
    )
    await relay.connect()
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    sent = []
    await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(sent[0]?.headers['x-dsh-organization']).toBe('org-1')
  })
})

describe('401 自动刷新', () => {
  it('过期后刷新一次并重试，调用方看不到那次 401', async () => {
    // access token 是短期的，过期是**正常状态**。让它冒到界面上，
    // 用户看到的就是每小时被踢一次
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': NEGOTIATE,
        '/api/identity/register': session('1'),
        '/api/identity/session/refresh': session('2'),
        '/api/chat/conversations': [
          { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } },
          { status: 200, body: { data: { conversations: [] } } },
        ],
      }),
    )
    await relay.connect()
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    sent = []

    const response = await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(response.status).toBe(200)
    // 重试那次带的是新 token
    expect(sent.at(-1)?.headers['authorization']).toBe('Bearer access-2')
    expect(store.read()?.refreshToken).toBe('refresh-2')
  })

  it('刷新也失败时把 401 如实返回，不无限重试', async () => {
    // 刷完还是 401 说明会话真的没了（被撤销、设备换了密钥）。循环重试
    // 只会把一个「需要重新登录」的状态变成一个卡住的界面
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': NEGOTIATE,
        '/api/identity/register': session('1'),
        '/api/identity/session/refresh': { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } },
        '/api/chat/conversations': { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } },
      }),
    )
    await relay.connect()
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    sent = []

    const response = await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(response.status).toBe(401)
    // 刷新没成，就不该有第二次业务调用 —— 拿着同一个已知失效的 token 再打
    // 一遍只是多一次必然失败的往返
    const business = sent.filter((r) => r.url.endsWith('/api/chat/conversations'))
    expect(business).toHaveLength(1)
  })

  it('刷新失败不会清掉本机凭据', async () => {
    // relay 临时抽风就把用户注销掉，是把一个可恢复的故障变成不可恢复的
    const relay = client(
      fakeRelay({
        '/protocol/negotiate': NEGOTIATE,
        '/api/identity/register': session('1'),
        '/api/identity/session/refresh': { status: 503, body: {} },
        '/api/chat/conversations': { status: 401, body: {} },
      }),
    )
    await relay.connect()
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    await relay.call('/api/chat/conversations', {}, PRINCIPAL)
    expect(store.read()).toBeDefined()
  })
})

describe('注销', () => {
  it('远端撤销 + 本地清除', async () => {
    const relay = client(
      fakeRelay({
        '/api/identity/register': session('1'),
        '/api/identity/session/sign-out': { status: 200, body: { data: { revoked: 1 } } },
      }),
    )
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    expect(await relay.signOut()).toBe(true)
    expect(store.read()).toBeUndefined()
  })

  it('连不上 relay 时仍然退出本机，并如实报告没撤成', async () => {
    // 一个连不上服务器就退不掉的登出按钮是坏的。但也不能谎报成功 ——
    // 那对 token 在 relay 那边还活着，用户有权知道
    const relay = client(
      fakeRelay({
        '/api/identity/register': session('1'),
        '/api/identity/session/sign-out': { status: 503, body: {} },
      }),
    )
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })
    expect(await relay.signOut()).toBe(false)
    expect(store.read()).toBeUndefined()
  })
})
