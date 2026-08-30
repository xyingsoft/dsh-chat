/**
 * 开户端点测试。
 *
 * 最要紧的一条是**浏览器永远拿不到 token** —— 下面直接对整个应答体做子串
 * 断言，而不是逐字段检查。逐字段检查挡不住以后有人加一个 `debug` 字段把
 * 整份凭据塞进去。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CredentialStore } from '../identity/credentials.js'
import { RelayClient } from '../relay/client.js'

import { enrollHandler, enrollmentStatusHandler, signOutHandler } from './identity-commands.js'

let workDir: string
let store: CredentialStore

const ORIGIN = 'http://127.0.0.1:5173'
const SESSION = {
  status: 200,
  body: {
    data: {
      accountId: 'acct-7',
      deviceId: 'dev-7',
      accessToken: 'super-secret-access-token',
      refreshToken: 'super-secret-refresh-token',
      accessExpiresAt: '2026-12-01T00:00:00.000Z',
      refreshExpiresAt: '2027-12-01T00:00:00.000Z',
    },
  },
}

function relayFetch(replies: Record<string, { status: number; body: unknown }>) {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const key = Object.keys(replies).find((suffix) => url.endsWith(suffix))
    const reply = key === undefined ? undefined : replies[key]
    if (reply === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as typeof globalThis.fetch
}

function relayClient(replies: Record<string, { status: number; body: unknown }>): RelayClient {
  return new RelayClient({
    baseUrl: 'https://relay.test',
    sharedSecret: 'deployment-secret',
    credentials: store,
    fetch: relayFetch(replies),
  })
}

/** 造一个最小的请求/应答对，跑一次处理器并把写出去的东西收集起来。 */
async function invoke(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const chunks: string[] = []
  let status = 0
  const request = {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body))
    },
  } as unknown as IncomingMessage

  const done = new Promise<void>((resolve) => {
    const response = {
      writeHead(code: number) {
        status = code
        return response
      },
      end(chunk?: string) {
        if (chunk !== undefined) chunks.push(chunk)
        resolve()
        return response
      },
    } as unknown as ServerResponse
    handler(request, response)
  })
  await done
  return { status, text: chunks.join('') }
}

const deps = (relay?: RelayClient) => ({
  expectedOrigin: ORIGIN,
  authenticate: () => ({ accountId: 'acct-7' }),
  ...(relay === undefined ? {} : { relay }),
})

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-idroute-'))
  store = new CredentialStore(join(workDir, 'creds.json'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('状态', () => {
  it('没配 relay 时是本机模式，不是错误', async () => {
    // 报错会让人以为哪里配坏了，实际上单机跑本来就不需要账号
    const { status, text } = await invoke(enrollmentStatusHandler(deps()), {})
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ data: { mode: 'local' } })
  })

  it('配了 relay 但没开户时是 unenrolled', async () => {
    const { text } = await invoke(enrollmentStatusHandler(deps(relayClient({}))), {})
    expect(JSON.parse(text)).toEqual({ data: { mode: 'unenrolled' } })
  })

  it('开过户之后报账号与设备', async () => {
    const relay = relayClient({ '/api/identity/register': SESSION })
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })

    const { text } = await invoke(enrollmentStatusHandler(deps(relay)), {})
    expect(JSON.parse(text)).toEqual({
      data: { mode: 'enrolled', accountId: 'acct-7', deviceId: 'dev-7' },
    })
  })
})

describe('开户', () => {
  it('成功后回账号与设备', async () => {
    const relay = relayClient({ '/api/identity/register': SESSION })
    const { status, text } = await invoke(enrollHandler(deps(relay)), {
      inviteCode: 'code-1',
      displayName: '甲',
      deviceName: '甲的笔记本',
    })
    expect(status).toBe(200)
    expect(JSON.parse(text).data.accountId).toBe('acct-7')
  })

  it('应答里没有 token，也没有私钥', async () => {
    // token 回到浏览器就进了渲染进程的 JS 上下文，一个 XSS 或一个多嘴的
    // 扩展就能带走它，而它可以直接对 relay 用
    const relay = relayClient({ '/api/identity/register': SESSION })
    const { text } = await invoke(enrollHandler(deps(relay)), {
      inviteCode: 'code-1',
      displayName: '甲',
      deviceName: '本',
    })

    const saved = store.read()
    expect(saved).toBeDefined()
    for (const secret of [
      saved?.accessToken,
      saved?.refreshToken,
      saved?.signingPrivateKey,
    ] as string[]) {
      expect(text, '应答里出现了不该回传的凭据').not.toContain(secret)
    }
    expect(text).not.toContain('Token')
    expect(text).not.toContain('token')
  })

  it('缺字段时拒绝', async () => {
    const relay = relayClient({ '/api/identity/register': SESSION })
    for (const omit of ['inviteCode', 'displayName', 'deviceName']) {
      const body: Record<string, string> = {
        inviteCode: 'c',
        displayName: '甲',
        deviceName: '本',
      }
      delete body[omit]
      const { status } = await invoke(enrollHandler(deps(relay)), body)
      expect(status, `缺 ${omit} 未被拒绝`).toBe(404)
    }
  })

  it('relay 拒绝时不区分原因', async () => {
    // relay 那边邀请码的三种失败已经抹平为一个错误码，这里再拆开就白抹了
    const relay = relayClient({
      '/api/identity/register': { status: 404, body: { error: { code: 'NOT_FOUND_OR_FORBIDDEN' } } },
    })
    const { status, text } = await invoke(enrollHandler(deps(relay)), {
      inviteCode: 'bad',
      displayName: '甲',
      deviceName: '本',
    })
    expect(status).toBe(404)
    expect(text).not.toContain('过期')
    expect(text).not.toContain('已消费')
  })

  it('本机模式下开户被拒 —— 那是一个没有意义的操作', async () => {
    const { status } = await invoke(enrollHandler(deps()), {
      inviteCode: 'c',
      displayName: '甲',
      deviceName: '本',
    })
    expect(status).toBe(404)
  })
})

describe('注销', () => {
  it('清掉本地凭据并报告远端撤销结果', async () => {
    const relay = relayClient({
      '/api/identity/register': SESSION,
      '/api/identity/session/sign-out': { status: 200, body: { data: { revoked: 1 } } },
    })
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })

    const { status, text } = await invoke(signOutHandler(deps(relay)), {})
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ data: { mode: 'unenrolled', revokedRemotely: true } })
    expect(store.read()).toBeUndefined()
  })

  it('远端撤销失败时如实报告，但本机照样退出', async () => {
    const relay = relayClient({
      '/api/identity/register': SESSION,
      '/api/identity/session/sign-out': { status: 503, body: {} },
    })
    await relay.enroll({ inviteCode: 'c', displayName: '甲', deviceName: '本' })

    const { text } = await invoke(signOutHandler(deps(relay)), {})
    expect(JSON.parse(text).data.revokedRemotely).toBe(false)
    expect(store.read()).toBeUndefined()
  })
})
