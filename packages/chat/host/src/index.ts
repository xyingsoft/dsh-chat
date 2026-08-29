/**
 * dsh-chat host 插件。
 *
 * 职责（见 docs/02-architecture/01-overall-architecture.md §4）：host 是浏览器访问组织
 * 与 relay 的唯一入口，负责本地持久化缓存、保存设备凭证、运行 relay 客户端、发送在线
 * 心跳，并向浏览器提供同源 API。浏览器不直接与 relay 通信。
 *
 * 本文件目前只建立插件骨架与一个健康检查路由，用于验证插件能被 DSH 正确装载与卸载。
 * 业务路由随对应实现阶段加入。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

// `ctx.webServer` 由 dsh-host-webserver 通过 `declare module '@deepseek-ai/cordis'`
// 增强到 Context 上。这里必须引入该包才能让增强生效 —— 只 import cordis 是拿不到的。
import type {} from '@deepseek-ai/dsh-host-webserver'

/** host 路由的同源前缀。§4 规定浏览器只与 `/api/chat` 和 `/api/organization` 通信。 */
export const CHAT_API_PREFIX = '/api/chat'

export const name = 'dsh-chat-host'

/**
 * 声明所需服务。缺少必需提供者时 profile 加载失败，不允许静默降级
 * （见 docs/02-architecture/02-plugin-model.md §6）。
 */
export const inject = ['webServer'] as const

export interface Config {
  /**
   * L1 只服务一个由部署明确指定的组织。
   * 见 docs/04-roadmap/03-iteration-plan.md §44.1。
   */
  readonly organizationId?: string
}

export function apply(ctx: Context, _config: Config = {}): void {
  // 所有 Cordis 注册通过 ctx.effect() 完成并返回 disposer；插件卸载后不得残留
  // 路由、后台任务或事件监听（§48 编码规范）。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${CHAT_API_PREFIX}/health`,
        handler: (_request: IncomingMessage, response: ServerResponse) => {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ status: 'ok', plugin: name }))
        },
      }),
    `${name}: health route`,
  )
}
