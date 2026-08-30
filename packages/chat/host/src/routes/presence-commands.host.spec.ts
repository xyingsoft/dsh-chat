/**
 * 在线状态端点测试。
 *
 * 领域层的折叠规则在 `@dsh-chat/identity` 的 `presence.host.spec.ts` 里测过了。
 * 这里测的是**边界**：可见性过滤有没有在服务端做（让界面自觉是不行的 ——
 * 界面拿到什么就能显示什么），以及查询接口会不会变成一个组织通讯录。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PresenceState } from '@dsh-chat/contract'
import type { PresenceVisibility } from '@dsh-chat/identity'

import { ChatDatabase } from '../storage/database.js'

import type { Principal } from './message-commands.js'
import {
  heartbeatHandler,
  presenceQueryHandler,
  type PresenceCommandDeps,
} from './presence-commands.js'

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
let principal: Principal | undefined
let now = new Date('2026-08-30T12:00:00.000Z')
let visibility: PresenceVisibility = 'everyone'
let sharesScope = true

beforeEach(async () => {
  now = new Date('2026-08-30T12:00:00.000Z')
  visibility = 'everyone'
  sharesScope = true
  chat = ChatDatabase.open({ location: ':memory:' })
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    for (const id of ['jia', 'yi']) insert.run(id, id, now.toISOString())
  })

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: 'org-1' }

  const deps: PresenceCommandDeps = {
    database: {
      transaction: chat.transaction.bind(chat),
      readonlyHandle: chat.readonlyHandle,
    } as PresenceCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    now: () => now,
    visibilityOf: () => visibility,
    sharesScope: () => sharesScope,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      for (const [path, handler] of [
        ['/api/chat/presence', presenceQueryHandler(deps)],
        ['/api/chat/presence/heartbeat', heartbeatHandler(deps)],
      ] as const) {
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

async function presenceOfAccounts(accountIds: string[]): Promise<Record<string, PresenceState>> {
  const body = (await (await post('/api/chat/presence', { accountIds })).json()) as {
    data: { presence: Record<string, PresenceState> }
  }
  return body.data.presence
}

/** 让乙发一次心跳。 */
async function yiHeartbeat(lastInteractionAt?: string): Promise<Response> {
  const saved = principal
  principal = { accountId: 'yi', deviceId: 'yi-laptop', organizationId: 'org-1' }
  const response = await post(
    '/api/chat/presence/heartbeat',
    lastInteractionAt === undefined ? {} : { lastInteractionAt },
  )
  principal = saved
  return response
}

describe('心跳', () => {
  it('上报后对方查得到在线', async () => {
    await yiHeartbeat()
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('online')
  })

  it('没上报过的人是 unknown，不是 offline', async () => {
    // offline 是一个「这个人不在」的断言，而我们没有依据
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('unknown')
  })

  it('心跳新鲜但久未交互 → idle', async () => {
    const longAgo = new Date(now.getTime() - 30 * 60_000).toISOString()
    await yiHeartbeat(longAgo)
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('idle')
  })

  it('未来的交互时间被丢弃，回落到「现在」', async () => {
    // 信它的话，一个时钟设错的客户端会让自己永远显示 online —— 而 idle
    // 就再也不会出现
    await yiHeartbeat(new Date(now.getTime() + 3_600_000).toISOString())
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('online')

    // 往后拨 30 分钟，如果刚才存的是未来时间，这里会仍然是 online
    now = new Date(now.getTime() + 30 * 60_000)
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('offline')
  })

  it('未认证时拒绝', async () => {
    principal = undefined
    expect((await post('/api/chat/presence/heartbeat', {})).status).toBe(401)
  })
})

describe('可见性在服务端过滤', () => {
  it('hidden 时别人看到 unknown', async () => {
    // 让界面自觉是不行的：界面拿到什么就能显示什么，一个改过的客户端会把
    // 隐藏的人也画出来
    await yiHeartbeat()
    visibility = 'hidden'
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('unknown')
  })

  it('shared_scopes 且不共享作用域时看到 unknown', async () => {
    await yiHeartbeat()
    visibility = 'shared_scopes'
    sharesScope = false
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('unknown')
  })

  it('查自己时不受可见性影响', async () => {
    // 看不到的话，用户没法确认自己的隐藏设置生效了没有，也没法发现自己的
    // host 其实已经掉线
    await post('/api/chat/presence/heartbeat', {})
    visibility = 'hidden'
    expect((await presenceOfAccounts(['jia']))['jia']).toBe('online')
  })
})

describe('查询接口不是通讯录', () => {
  it('只按显式列表查，不提供「列出全组织在线的人」', async () => {
    // 提供了就等于一个免鉴权的组织通讯录，而列名单是要 organization.manage 的
    await yiHeartbeat()
    const result = await presenceOfAccounts(['jia'])
    expect(Object.keys(result)).toEqual(['jia'])
  })

  it('不给 accountIds 时拒绝，不默认返回全部', async () => {
    const response = await post('/api/chat/presence', {})
    expect(response.status).toBe(404)
  })

  it('查别的组织的人得到 unknown', async () => {
    await yiHeartbeat()
    principal = { accountId: 'jia', deviceId: 'jia-laptop', organizationId: 'org-别人的' }
    expect((await presenceOfAccounts(['yi']))['yi']).toBe('unknown')
  })

  it('一次问几千个人会被截断', async () => {
    // 不截断的话这个端点就是一次全组织扫描
    const many = Array.from({ length: 500 }, (_, i) => `acct-${i}`)
    const result = await presenceOfAccounts(many)
    expect(Object.keys(result).length).toBeLessThanOrEqual(200)
  })

  it('重复的账号只查一次', async () => {
    const result = await presenceOfAccounts(['yi', 'yi', 'yi'])
    expect(Object.keys(result)).toEqual(['yi'])
  })
})
