/**
 * host 插件的装载测试。
 *
 * 这不是单元测试 —— 它把插件放进真实的 Cordis 容器与真实的 `WebServer` 服务里跑，
 * 目的是证明三件在写业务逻辑之前必须成立的事：
 *
 *   1. 插件形态正确，能被 Cordis 装载（导出、`inject`、`Config` 都对）；
 *   2. 路由确实注册到了 host 的同源 API 前缀下并可访问；
 *   3. **卸载后路由不残留** —— 这是 §48 编码规范的硬约束，也是最容易写错的一条。
 *
 * 第 3 点尤其重要：`webServer.register` 对重复的 `(kind, path)` 会抛错，所以一旦
 * disposer 失效，插件重载就会直接崩溃。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { HealthResponse } from '@dsh-chat/contract'

import * as hostPlugin from './index.js'

let ctx: Context
let baseUrl: string

beforeEach(async () => {
  ctx = new Context()
  // port: 0 让操作系统分配空闲端口，避免测试之间抢占固定端口
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
})

afterEach(async () => {
  // 销毁根 fiber 会级联释放其下所有插件与服务，HTTP 端口随之关闭
  await ctx.fiber.dispose()
})

it('装载后在 /api/chat/health 提供健康检查', async () => {
  await ctx.plugin(hostPlugin)

  const response = await fetch(`${baseUrl}${hostPlugin.CHAT_API_PREFIX}/health`)

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')

  const body = (await response.json()) as HealthResponse
  expect(body).toEqual({ status: 'ok', plugin: 'dsh-chat-host' })
})

it('卸载后路由不残留', async () => {
  const fiber = await ctx.plugin(hostPlugin)
  expect((await fetch(`${baseUrl}${hostPlugin.CHAT_API_PREFIX}/health`)).status).toBe(200)

  await fiber.dispose()

  // 未被任何路由认领的请求由 WebServer 的兜底返回 404
  const afterDispose = await fetch(`${baseUrl}${hostPlugin.CHAT_API_PREFIX}/health`)
  expect(afterDispose.status).toBe(404)
})

it('可重复装卸而不因路由冲突抛错', async () => {
  // webServer.register 对重复的 (kind, path) 会抛错；只有 disposer 真的生效，
  // 这个循环才能跑完。这是对上一个用例最直接的交叉验证。
  for (let round = 0; round < 3; round += 1) {
    const fiber = await ctx.plugin(hostPlugin)
    expect((await fetch(`${baseUrl}${hostPlugin.CHAT_API_PREFIX}/health`)).status).toBe(200)
    await fiber.dispose()
  }
})

it('未注册的路径返回 404 而不是被前缀匹配吞掉', async () => {
  await ctx.plugin(hostPlugin)

  // 路由注册为 kind: 'exact'，不应吞掉同前缀下的其他路径
  const response = await fetch(`${baseUrl}${hostPlugin.CHAT_API_PREFIX}/health/extra`)

  expect(response.status).toBe(404)
})

it('ROUTE_PATHS 里的每一条都真的注册了', async () => {
  // 这条是补上一次白屏事故的：处理器全都写好、端点测试全都通过，但插件的
  // apply() 里只注册了 /health，浏览器一调 /api/chat/conversations 就落空。
  //
  // 「处理器行为对」与「插件把它挂上去了」是两件事，各自要有断言。
  await ctx.plugin(hostPlugin, {
    organizationId: 'org-1',
    localAccountId: 'jia',
    databasePath: ':memory:',
  })

  for (const path of hostPlugin.ROUTE_PATHS) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: '{}',
    })
    // 判据不能是状态码：空请求体会让多数端点合法地返回
    // NOT_FOUND_OR_FORBIDDEN，那也是 404，与「路由不存在」的 404 撞了。
    //
    // 真正区分两者的是响应本身 —— 已注册的路由由我们的 commandHandler 应答，
    // 一定带 JSON content-type；未注册的路径由 web server 兜底，body 是空的
    expect(response.headers.get('content-type'), `${path} 未注册`).toContain('application/json')
    await response.body?.cancel()
  }
})

it('未配置本地身份时一律未认证，不是默认放行', async () => {
  await ctx.plugin(hostPlugin, { databasePath: ':memory:' })

  const response = await fetch(`${baseUrl}${hostPlugin.CHAT_API_PREFIX}/conversations`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(response.status).toBe(401)
})

it('卸载后全部路由一并撤销', async () => {
  const fiber = await ctx.plugin(hostPlugin, {
    organizationId: 'org-1',
    localAccountId: 'jia',
    databasePath: ':memory:',
  })
  await fiber.dispose()

  for (const path of hostPlugin.ROUTE_PATHS) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', body: '{}' })
    expect(response.status, `${path} 卸载后仍在`).toBe(404)
    // 同上：卸载后应当落到 web server 的兜底，而不是我们的处理器
    expect(response.headers.get('content-type'), `${path} 卸载后仍有处理器`).toBeNull()
    await response.body?.cancel()
  }
})
