/**
 * relay 客户端。
 *
 * §4：host 运行 relay 客户端；浏览器只与 host 的同源 API 通信，**不直接与 relay
 * 通信**。所以这一层只在 host 进程里存在，浏览器看不到它，也拿不到 relay 的凭证。
 *
 * §41：host 与 relay **独立升级**，连接建立时协商协议版本；不兼容返回
 * `PROTOCOL_VERSION_UNSUPPORTED` 并**停止组织写入，不进入静默降级或部分可用
 * 状态**。协商的判定逻辑在 `@dsh-chat/contract` 的 `negotiate()`，这里只负责
 * 把两侧的声明凑齐、把结论落成「能不能写」。
 *
 * ## 为什么读也要挡
 *
 * §41 的原话只说停止**写入**。但协议不兼容时，读回来的负载同样可能是这一侧
 * 解析不了的形状 —— 把它渲染出来是「部分可用状态」的另一种形式。所以这里
 * 读写一起挡，并在诊断里写明这是比文档更严的处置。
 */

import {
  PROTOCOL_VERSION,
  negotiate,
  upgradeHint,
  type NegotiationResult,
  type ProtocolCapability,
  type ProtocolOffer,
} from '@dsh-chat/contract'

import type { Principal } from '../routes/message-commands.js'

export interface RelayClientOptions {
  /** relay 的基地址，例如 `https://relay.example.com`。 */
  readonly baseUrl: string
  /**
   * 部署期共享密钥。
   *
   * **这不是设备身份。** 它只证明「这是一台被授权接入的 host」，不证明请求
   * 来自哪个账号 —— 账号由 `x-dsh-account` 声明。真正的绑定要靠 §7.1 的设备
   * 签名，校验侧已在 `@dsh-chat/identity` 实现，缺会话建立与 token 下发。
   */
  readonly sharedSecret: string
  /** 单次请求超时。默认 15 秒。 */
  readonly timeoutMs?: number
  /** 注入 fetch，便于测试不起真实网络。 */
  readonly fetch?: typeof globalThis.fetch
}

/** relay 返回的信封。与 host 自己的路由同一形状，便于原样透传给浏览器。 */
export interface RelayResponse {
  readonly status: number
  readonly body: unknown
}

export type RelayState =
  /** 尚未协商。此时不允许任何调用 —— 不知道对面说不说得通。 */
  | { readonly kind: 'unnegotiated' }
  | { readonly kind: 'ready'; readonly negotiation: NegotiationResult }
  /** 协商失败。§41：停止组织写入并显示明确的升级提示。 */
  | { readonly kind: 'incompatible'; readonly negotiation: NegotiationResult; readonly hint: string }
  /** 连不上。与协议不兼容区分开 —— 前者可重试，后者要升级。 */
  | { readonly kind: 'unreachable'; readonly diagnostic: string }

export class RelayClient {
  #state: RelayState = { kind: 'unnegotiated' }
  readonly #options: RelayClientOptions
  readonly #fetch: typeof globalThis.fetch

  constructor(options: RelayClientOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  get state(): RelayState {
    return this.#state
  }

  /** 组织写入是否被允许。§41 不兼容时必须为 false。 */
  get writable(): boolean {
    return this.#state.kind === 'ready'
  }

  /**
   * 与 relay 协商协议版本。
   *
   * 在插件装载时调用一次。失败**不抛异常** —— relay 暂时连不上不该让整个插件
   * 装载失败，那会让用户连设置面板都打不开。改为把状态记下来，调用时再报。
   */
  async connect(): Promise<RelayState> {
    const offer: ProtocolOffer = {
      protocolVersion: PROTOCOL_VERSION,
      // P0 的事件格式版本统一为 1；后续按事件分别演进（§41）
      eventFormatVersions: { message_accepted: 1, notification_created: 1, work_item_changed: 1 },
    }

    let payload: unknown
    try {
      const response = await this.#request('/protocol/negotiate', offer)
      if (response.status !== 200) {
        this.#state = {
          kind: 'unreachable',
          diagnostic: `relay 协商端点返回 ${response.status}`,
        }
        return this.#state
      }
      payload = response.body
    } catch (error) {
      this.#state = { kind: 'unreachable', diagnostic: String(error) }
      return this.#state
    }

    const capability = (payload as { data?: unknown }).data
    if (!isCapability(capability)) {
      // 形状不对也算连不上，而不是「协议不兼容」—— 后者意味着对面是一个
      // 能说话但版本不同的 relay，这里是对面根本没按约定应答
      this.#state = { kind: 'unreachable', diagnostic: 'relay 的协商应答形状不符合契约' }
      return this.#state
    }

    // `exactOptionalPropertyTypes` 下「可选」与「可为 undefined」是两回事：
    // 从网络上解析出来的对象里 deprecationDeadline 可能不存在，直接传会被
    // 判为不兼容。按存在与否分别构造，而不是塞一个 undefined 进去
    const negotiation = negotiate(
      offer,
      capability.deprecationDeadline === undefined
        ? {
            currentVersion: capability.currentVersion as ProtocolCapability['currentVersion'],
            minimumVersion: capability.minimumVersion as ProtocolCapability['minimumVersion'],
            eventFormatVersions: capability.eventFormatVersions,
          }
        : {
            currentVersion: capability.currentVersion as ProtocolCapability['currentVersion'],
            minimumVersion: capability.minimumVersion as ProtocolCapability['minimumVersion'],
            eventFormatVersions: capability.eventFormatVersions,
            deprecationDeadline: capability.deprecationDeadline,
          },
    )
    this.#state = negotiation.accepted
      ? { kind: 'ready', negotiation }
      : {
          kind: 'incompatible',
          negotiation,
          // §41 要求「明确的升级提示」，措辞由 contract 统一给出
          hint: upgradeHint(negotiation) ?? '协议版本不兼容',
        }
    return this.#state
  }

  /**
   * 转发一次业务调用。
   *
   * 调用者身份经请求头带过去，**不放进请求体** —— 放进 body 的话，任何能构造
   * body 的人都能声称自己是别人，而 body 是从浏览器来的。
   */
  async call(path: string, body: unknown, principal: Principal): Promise<RelayResponse> {
    if (this.#state.kind === 'incompatible') {
      return {
        status: 426,
        body: {
          error: {
            code: 'PROTOCOL_VERSION_UNSUPPORTED',
            retryability: 'terminal',
            hint: this.#state.hint,
          },
        },
      }
    }
    if (this.#state.kind !== 'ready') {
      // 未协商或连不上：返回可重试的服务不可用，而不是假装成功
      return {
        status: 503,
        body: {
          error: {
            code: 'SERVICE_READ_ONLY',
            retryability: 'retryable',
            diagnostic:
              this.#state.kind === 'unreachable' ? this.#state.diagnostic : 'relay 尚未协商',
          },
        },
      }
    }

    try {
      return await this.#request(path, body, principal)
    } catch (error) {
      return {
        status: 503,
        body: {
          error: { code: 'SERVICE_READ_ONLY', retryability: 'retryable', diagnostic: String(error) },
        },
      }
    }
  }

  async #request(path: string, body: unknown, principal?: Principal): Promise<RelayResponse> {
    const controller = new AbortController()
    // 不设超时的话，一个不回包的 relay 会让 host 的请求永远挂着，
    // 浏览器那边表现为界面卡住而不是报错
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000)
    try {
      const response = await this.#fetch(`${this.#options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#options.sharedSecret}`,
          ...(principal === undefined
            ? {}
            : {
                'x-dsh-account': principal.accountId,
                'x-dsh-organization': principal.organizationId,
                'x-dsh-device': principal.deviceId,
              }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      // relay 的错误信封与 host 自己的同形状，原样透传即可；
      // 解析失败时也不要吞掉状态码
      const text = await response.text()
      let parsed: unknown = {}
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text)
      } catch {
        parsed = { error: { code: 'INTERNAL', diagnostic: 'relay 应答不是 JSON' } }
      }
      return { status: response.status, body: parsed }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** relay 协商应答的形状校验。契约只在边界解析（§48）。 */
function isCapability(value: unknown): value is {
  currentVersion: number
  minimumVersion: number
  eventFormatVersions: Record<string, number>
  deprecationDeadline?: string
} {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['currentVersion'] === 'number' &&
    typeof v['minimumVersion'] === 'number' &&
    typeof v['eventFormatVersions'] === 'object' &&
    v['eventFormatVersions'] !== null
  )
}
