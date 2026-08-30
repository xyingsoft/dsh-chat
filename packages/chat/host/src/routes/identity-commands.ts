/**
 * 开户与注销的同源端点。
 *
 * §4：浏览器**不直接与 relay 通信**。所以「填邀请码开户」这件事也要经 host
 * 转一道 —— 界面把邀请码交给 host，host 本地生成密钥对、向 relay 注册、把
 * 凭据落到本机文件，只把「成了没有」告诉浏览器。
 *
 * ## 浏览器永远拿不到 token
 *
 * 应答里只有 `accountId`、`deviceId` 和一句状态。access token 与私钥都不回传。
 * 回传的话，token 就进了渲染进程的 JS 上下文 —— 任何一个 XSS 或一个多嘴的
 * 扩展就能把它带走，而它是可以直接对 relay 用的。凭据留在 host 进程，浏览器
 * 只能通过同源 API 借用它，这是 §4 那条「host 是唯一入口」的实际收益。
 *
 * ## 没配 relay 时这几个端点也在
 *
 * 但会明说「本机模式，不需要开户」而不是报错。报错会让人以为哪里配坏了，
 * 实际上单机跑本来就不需要账号。
 */

import type { IncomingMessage } from 'node:http'

import type { RelayClient } from '../relay/client.js'

import { commandHandler } from './command-router.js'

export interface IdentityRouteDeps {
  readonly expectedOrigin: string
  /** 没配 relay 时为 undefined —— 那是本机模式。 */
  readonly relay?: RelayClient
  readonly authenticate: (request: IncomingMessage) => { accountId: string } | undefined
}

/** 开户状态。界面据此决定显示注册引导还是聊天。 */
export interface EnrollmentStatus {
  /** `local` = 没配 relay，单机跑；`enrolled` / `unenrolled` = relay 模式。 */
  readonly mode: 'local' | 'enrolled' | 'unenrolled'
  readonly accountId?: string
  readonly deviceId?: string
}

export function enrollmentStatusHandler(deps: IdentityRouteDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async () => {
      const status: EnrollmentStatus = statusOf(deps.relay)
      return { ok: true as const, value: status }
    },
  })
}

/**
 * 用邀请码开户。
 *
 * 失败**不区分原因** —— relay 那边邀请码的三种失败已经抹平为一个错误码，
 * 这里再拆开就把它白抹了。
 */
export function enrollHandler(deps: IdentityRouteDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async (raw) => {
      if (deps.relay === undefined) {
        // 本机模式下开户是一个没有意义的操作，而不是一个失败的操作
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const body = raw as Record<string, unknown>
      const inviteCode = str(body['inviteCode'])
      const displayName = str(body['displayName'])
      const deviceName = str(body['deviceName'])
      if (inviteCode === undefined || displayName === undefined || deviceName === undefined) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }

      const result = await deps.relay.enroll({ inviteCode, displayName, deviceName })
      if (!result.ok) return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }

      // 只回账号与设备。token 和私钥留在 host —— 见文件头
      const status: EnrollmentStatus = {
        mode: 'enrolled',
        accountId: result.credentials.accountId,
        deviceId: result.credentials.deviceId,
      }
      return { ok: true as const, value: status }
    },
  })
}

/**
 * 注销本机。
 *
 * 两件事都要做：告诉 relay 撤销会话，以及删掉本地凭据。**只做后者是不够的**
 * —— 本机看起来退出了，但那对 token 在 relay 那边还活着，谁抄走了文件谁就
 * 还能用。反过来只做前者则会让本机留着一份永远认证失败的凭据。
 *
 * relay 那一步失败时仍然删本地：用户点了退出就该退出，一个连不上服务器就
 * 退不掉的登出按钮是坏的。撤销会在 token 过期时自然生效，代价是一段窗口期。
 */
export function signOutHandler(deps: IdentityRouteDeps) {
  return commandHandler({
    expectedOrigin: deps.expectedOrigin,
    execute: async () => {
      if (deps.relay === undefined) {
        return { ok: false as const, errorCode: 'NOT_FOUND_OR_FORBIDDEN' as const }
      }
      const revokedRemotely = await deps.relay.signOut()
      return { ok: true as const, value: { mode: 'unenrolled', revokedRemotely } }
    },
  })
}

function statusOf(relay: RelayClient | undefined): EnrollmentStatus {
  if (relay === undefined) return { mode: 'local' }
  const credentials = relay.credentialsSummary()
  return credentials === undefined ? { mode: 'unenrolled' } : { mode: 'enrolled', ...credentials }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
