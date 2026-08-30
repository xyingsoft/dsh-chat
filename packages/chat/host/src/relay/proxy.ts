/**
 * 把浏览器的调用转发到 relay。
 *
 * §4：浏览器只与 host 的同源 API 通信。所以转发发生在 host 进程内 ——
 * 浏览器打的还是同一个 `/api/chat/...`，只是背后从「查本地库」换成了
 * 「问 relay」。这一层对浏览器完全透明，正是它该有的样子。
 *
 * ## 认证在这一侧完成，不是往下透传
 *
 * 浏览器请求经 host 自己的 `authenticate` 判定出 `Principal`，再由
 * `RelayClient` 以请求头带给 relay。**不把浏览器的请求头原样转发** ——
 * 那样浏览器就能自己声称 `x-dsh-account`，host 这一层的认证形同虚设。
 *
 * ## 跨源防护也在这一侧
 *
 * 复用 `commandHandler`，与本地路由同一套：会话列表含对端显示名与消息摘要，
 * 被第三方站点读走就是一次通讯录泄露，走不走 relay 都一样。
 */

import { ERROR_CATALOGUE, type ErrorCode } from '@dsh-chat/contract'

import type { ChatDatabaseService } from '../storage/service.js'
import { commandHandler } from '../routes/command-router.js'
import type { Principal } from '../routes/message-commands.js'

import type { RelayClient } from './client.js'

export interface RelayProxyDeps {
  readonly relay: RelayClient
  readonly expectedOrigin: string
  readonly authenticate: (request: import('node:http').IncomingMessage) => Principal | undefined
  /** 仅用于满足 `commandHandler` 的形状；转发路径不碰本地库。 */
  readonly database?: ChatDatabaseService
}

/**
 * 生成一个把请求转发到 relay 指定路径的处理器。
 *
 * relay 的错误信封与 host 自己的同形状，所以**原样透传** —— 在中间翻译一道
 * 只会引入两套措辞不一致的风险，而错误码目录本来就是共享的。
 */
export function relayProxyHandler(deps: RelayProxyDeps, path: string) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw, request) => {
      const principal = deps.authenticate(request)
      if (!principal) return { ok: false as const, errorCode: 'UNAUTHENTICATED' as const }

      const response = await deps.relay.call(path, raw ?? {}, principal)

      // relay 已经给了完整信封。commandHandler 期望的是 { ok, value } 或
      // { ok, errorCode }，所以这里把它拆回去 —— 成功取 data，失败取 code
      const body = response.body as
        | { data?: unknown; error?: { code?: string } }
        | undefined
      if (response.status >= 200 && response.status < 300 && body?.data !== undefined) {
        return { ok: true as const, value: body.data }
      }

      const code = body?.error?.code
      // 认得的码原样透传 —— 错误码目录是两侧共享的，翻译一道只会引入
      // 两套措辞不一致的风险
      if (typeof code === 'string' && code in ERROR_CATALOGUE) {
        return { ok: false as const, errorCode: code as ErrorCode }
      }

      // 认不出来的码**不硬塞成某个具体错误**。relay 返回了一个本侧目录里
      // 没有的码，本身就是两侧不一致 —— 抛出去让 router 的兜底给 500 INTERNAL，
      // 并把原始码打进服务端日志。编一个看起来更具体的码会掩盖这个不一致
      throw new Error(
        `relay 返回了未知错误码：${String(code)}（HTTP ${response.status}）`,
      )
    },
  })
}
