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

import {
  generateDeviceKeyPair,
  type CredentialStore,
  type DeviceCredentials,
} from '../identity/credentials.js'
import { ClockOffset, signRequest } from '../identity/request-proof.js'
import type { Principal } from '../routes/message-commands.js'

export interface RelayClientOptions {
  /** relay 的基地址，例如 `https://relay.example.com`。 */
  readonly baseUrl: string
  /**
   * 部署期共享密钥。**回落用，不是设备身份。**
   *
   * 它只证明「这是一台被授权接入的 host」，不证明请求来自哪个账号 —— 账号由
   * `x-dsh-account` 声明。本机开过户之后就不再用它：`credentials` 里的
   * access token 优先，账号与设备由 relay 从会话查出来，这一侧说了不算。
   *
   * relay 那边默认**不接受**用共享密钥声称身份（要显式开
   * `allowSharedSecretIdentity`），所以这条路只在尚未开户的部署上通。
   */
  readonly sharedSecret: string
  /**
   * 本机凭据。给了就用 token 认证，并在 401 时自动刷新一次。
   *
   * 不给也能跑 —— 那是「还没开户」的状态，走共享密钥回落。
   */
  readonly credentials?: CredentialStore
  /**
   * 期望的 relay TLS 公钥指纹（带外配置）。
   *
   * relay 在协商应答里会报自己的指纹，但**那个值本身不提供防中间人能力** ——
   * 中间人当然会报自己的。配了这一项才有意义：两者不一致就拒绝连接，等价于
   * SSH 的 `known_hosts` 钉法。
   *
   * 不配时用 relay 报的值签名（签名仍然防篡改、防重放），但**换不来通道
   * 绑定**。这一点在 README 里写明，不靠读代码才能发现。
   */
  readonly expectedRelayFingerprint?: string
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
  /** 协商时从 relay 学到的指纹。签名要用它，所以必须在 connect 之后才有。 */
  #relayFingerprint: string | undefined
  /** relay 是否要求签名。它说不要求时也不要白签 —— 那只是多送一次密码学运算。 */
  #requiresSignature = false
  readonly #clock = new ClockOffset()
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

    const declared = (capability as { relayFingerprint?: unknown }).relayFingerprint
    const expected = this.#options.expectedRelayFingerprint
    if (expected !== undefined && expected.length > 0) {
      // 钉住的指纹对不上就**不连**。这是唯一真正防中间人的一步 ——
      // 换成「警告一下继续连」的话，攻击成功与否就取决于有没有人在看日志
      if (declared !== expected) {
        this.#state = {
          kind: 'unreachable',
          diagnostic:
            'relay 指纹与配置的期望值不一致，已拒绝连接。' +
            '若确实更换了证书，请更新 relayFingerprint 配置。',
        }
        return this.#state
      }
    }
    this.#relayFingerprint = typeof declared === 'string' ? declared : undefined
    this.#requiresSignature =
      (capability as { requiresRequestSignature?: unknown }).requiresRequestSignature === true

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
      const first = await this.#request(path, body, principal)

      // 时钟偏移：§7.1 让 relay 返回服务器时间与允许窗口，正是为了让这一侧
      // 能自己校准。不处理的话，一台时钟偏了几分钟的机器什么都干不了，
      // 而错误信息看起来像认证失败 —— 用户会去查密码
      if (isTimeSkew(first.body) && this.#clock.learnFrom(first.body)) {
        return await this.#request(path, body, principal)
      }

      // access token 是短期的（relay 那边 1 小时），过期是**正常状态**而不是
      // 错误。让它冒到界面上，用户看到的就是每小时被踢一次
      if (first.status !== 401 || this.#options.credentials === undefined) return first
      if (!(await this.refreshTokens())) return first
      // 只重试一次。刷完还是 401 说明会话真的没了（被撤销、设备换了密钥），
      // 循环重试只会把一个需要重新登录的状态变成一个卡住的界面
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

  /**
   * 用邀请码在 relay 开户，并把凭据落到本机。
   *
   * 密钥对**在这里生成**，私钥进本地文件，出站请求里只有公钥 —— §7 的
   * 「私钥永不上传」在这一行代码上兑现，不是在文档里。
   *
   * 不做协商检查：注册要能在协议不兼容时进行，否则一个版本不匹配的部署
   * 连开户都做不了，而开户恰恰是升级之后要重做的事。
   */
  async enroll(input: {
    inviteCode: string
    displayName: string
    deviceName: string
  }): Promise<{ ok: true; credentials: DeviceCredentials } | { ok: false; status: number; body: unknown }> {
    const store = this.#options.credentials
    if (store === undefined) {
      return { ok: false, status: 500, body: { error: { code: 'INTERNAL' } } }
    }

    const keys = generateDeviceKeyPair()
    const response = await this.#request('/api/identity/register', {
      inviteCode: input.inviteCode,
      displayName: input.displayName,
      deviceName: input.deviceName,
      // 只有公钥。私钥在 keys 里，留在这个进程
      signingPublicKey: keys.signingPublicKey,
    })
    if (response.status !== 200) return { ok: false, status: response.status, body: response.body }

    const data = (response.body as { data?: unknown }).data
    if (!isSessionPayload(data)) {
      return { ok: false, status: 502, body: { error: { code: 'INTERNAL' } } }
    }

    const credentials: DeviceCredentials = {
      accountId: data.accountId,
      deviceId: data.deviceId,
      signingPrivateKey: keys.signingPrivateKey,
      signingPublicKey: keys.signingPublicKey,
      keyFingerprint: keys.keyFingerprint,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessExpiresAt: data.accessExpiresAt,
      refreshExpiresAt: data.refreshExpiresAt,
    }
    store.write(credentials)
    return { ok: true, credentials }
  }

  /**
   * 用 refresh token 换一对新的。
   *
   * relay 那边是**轮换**：旧的用过即撤销。所以这里一旦拿到新的就必须写进
   * 文件，中途失败会让本机持有一对已经作废的 token —— 那种情况下唯一的
   * 出路是重新注册，所以写文件放在最后一步且是整份替换。
   */
  async refreshTokens(): Promise<boolean> {
    const store = this.#options.credentials
    const current = store?.read()
    if (store === undefined || current === undefined) return false

    const response = await this.#request('/api/identity/session/refresh', {
      refreshToken: current.refreshToken,
    })
    if (response.status !== 200) return false
    const data = (response.body as { data?: unknown }).data
    if (!isSessionPayload(data)) return false

    store.updateTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessExpiresAt: data.accessExpiresAt,
      refreshExpiresAt: data.refreshExpiresAt,
    })
    return true
  }

  /** 本机是否已开户。给界面判断该显示注册引导还是聊天。 */
  get enrolled(): boolean {
    return this.#options.credentials?.read() !== undefined
  }

  /**
   * 可以安全交给浏览器的那部分凭据。
   *
   * 只有账号与设备 ID。**没有 getter 能拿到 token 或私钥** —— 不是靠调用方
   * 自觉不去读，而是这个类根本不往外给。
   */
  credentialsSummary(): { accountId: string; deviceId: string } | undefined {
    const current = this.#options.credentials?.read()
    if (current === undefined) return undefined
    return { accountId: current.accountId, deviceId: current.deviceId }
  }

  /**
   * 注销：撤销 relay 上的会话，并清除本机凭据。
   *
   * 返回的是「远端撤销成功了没有」。本地清除**无论如何都做** —— 一个连不上
   * 服务器就退不掉的登出按钮是坏的。远端没撤成时那对 token 会一直活到过期，
   * 所以这个返回值要如实报给用户，不能吞掉。
   */
  async signOut(): Promise<boolean> {
    const store = this.#options.credentials
    if (store === undefined) return false
    let revoked = false
    try {
      const response = await this.#request('/api/identity/session/sign-out', {})
      revoked = response.status === 200
    } catch {
      revoked = false
    }
    store.clear()
    return revoked
  }

  /**
   * §7.1 的请求证明请求头。不该签时返回空对象。
   *
   * 四个都齐了才签：relay 要求签名、知道它的指纹、本机有私钥、这次请求带了
   * 组织（签名覆盖目标组织，没有组织就签不出对侧认得的东西）。
   *
   * 缺任何一个都**静默不签**而不是抛异常：relay 那边不启用校验时不带签名是
   * 完全正常的；而启用了却没签会被它明确拒掉 —— 由拒绝方报错，比在这里猜
   * 一个错误更准。
   */
  #proofHeaders(
    path: string,
    payload: string,
    principal: Principal | undefined,
    credentials: DeviceCredentials | undefined,
  ): Record<string, string> {
    if (!this.#requiresSignature) return {}
    if (this.#relayFingerprint === undefined) return {}
    if (credentials === undefined || principal === undefined) return {}
    return signRequest({
      method: 'POST',
      path,
      body: payload,
      deviceId: credentials.deviceId,
      organizationId: principal.organizationId,
      relayFingerprint: this.#relayFingerprint,
      signingPrivateKey: credentials.signingPrivateKey,
      clock: this.#clock,
    })
  }

  async #request(path: string, body: unknown, principal?: Principal): Promise<RelayResponse> {
    const controller = new AbortController()
    // 不设超时的话，一个不回包的 relay 会让 host 的请求永远挂着，
    // 浏览器那边表现为界面卡住而不是报错
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000)
    const credentials = this.#options.credentials?.read()
    // 序列化一次并复用。签名覆盖请求体摘要，重新 stringify 一遍可能得到
    // 不同的字节（键序、数字表示），摘要就对不上了
    const payload = JSON.stringify(body)
    try {
      const response = await this.#fetch(`${this.#options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // token 优先。开过户之后账号与设备由 relay 从会话查出来，
          // 下面那两个请求头就只是冗余信息了 —— 但组织仍然必须带，
          // 一个账号可属多个组织（§9），当前在哪个组织下是这一侧的选择
          authorization: `Bearer ${credentials?.accessToken ?? this.#options.sharedSecret}`,
          ...(principal === undefined
            ? {}
            : {
                'x-dsh-account': principal.accountId,
                'x-dsh-organization': principal.organizationId,
                'x-dsh-device': principal.deviceId,
              }),
          ...this.#proofHeaders(path, payload, principal, credentials),
        },
        body: payload,
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
/** relay 说时钟偏了。与认证失败区分开是 §7.1 的明文要求。 */
function isTimeSkew(body: unknown): boolean {
  return (body as { error?: { code?: unknown } }).error?.code === 'TIME_SKEW'
}

interface SessionPayload {
  accountId: string
  deviceId: string
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  refreshExpiresAt: string
}

/**
 * relay 的会话应答是不是完整的一份。
 *
 * 缺字段时宁可整个当失败：写一份缺 refreshToken 的凭据进去，本机会一直用到
 * access 过期，然后既刷不了也不知道为什么。
 */
function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    ['accountId', 'deviceId', 'accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt'] as const
  ).every((key) => typeof record[key] === 'string' && record[key] !== '')
}

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
