/**
 * 给出站请求签名（§7.1 的 host 侧）。
 *
 * relay 那边的校验实现在 `dsh-chat-relay` 的 `domain/identity/request-signing.ts`。
 * **拼接方式必须逐字节一致**，差一个换行两边就永远对不上，而失败长得像
 * 「认证失败」，极难定位。所以这里把拼接单独抽出来，注释里写明它是一份
 * 需要与对侧同步演进的约定。
 *
 * ## 时钟偏移
 *
 * 本机时钟可能不准。relay 超窗时按 §7.1 返回 `TIME_SKEW` 加服务器时间与允许
 * 窗口，`ClockOffset` 把那个差值记下来，之后的签名都补上 —— 不是去改系统
 * 时钟（那要管理员权限，而且会影响整台机器），只是在签名时加一个偏移量。
 */

import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto'

/** 三个携带证明的请求头。名字要与 relay 的 `signature-guard.ts` 完全一致。 */
export const SIGNATURE_HEADER = 'x-dsh-signature'
export const NONCE_HEADER = 'x-dsh-nonce'
export const TIMESTAMP_HEADER = 'x-dsh-timestamp'

export interface ProofInput {
  readonly method: string
  readonly path: string
  readonly body: string
  readonly timestamp: number
  readonly nonce: string
  readonly deviceId: string
  readonly organizationId: string
  readonly relayFingerprint: string
}

/**
 * 拼接待签名的字节串。
 *
 * **这份拼接与 relay 的 `signingPayload` 是同一个约定的两个实现。** 换行分隔
 * 是为了防分隔符注入（直接拼的话 `path=/a/b`+`nonce=c` 与 `path=/a`+`nonce=/bc`
 * 会撞成同一个字符串）；前缀 `dsh-chat/1` 是域分隔。改这里必须同时改对侧。
 */
export function proofPayload(input: ProofInput): Buffer {
  const lines = [
    'dsh-chat/1',
    input.method.toUpperCase(),
    input.path,
    createHash('sha256').update(input.body).digest('base64'),
    String(input.timestamp),
    input.nonce,
    input.deviceId,
    input.organizationId,
    input.relayFingerprint,
  ]
  for (const line of lines) {
    // 含换行的要素会让拼接产生歧义。宁可在这里炸掉也不要签出一个
    // 对侧解读不同的证明
    if (line.includes('\n')) throw new Error(`签名要素不得含换行：${JSON.stringify(line)}`)
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

/**
 * 本机时钟相对 relay 的偏移量。
 *
 * 可变状态，因为它要跨请求累积 —— 一次 `TIME_SKEW` 学到的偏移，之后每个请求
 * 都用得上。重启后归零并重新学一次，那是对的：机器可能已经校过时了。
 */
export class ClockOffset {
  #offsetMs = 0

  get offsetMs(): number {
    return this.#offsetMs
  }

  /** 当前应当写进签名的时间戳。 */
  now(): number {
    return Date.now() + this.#offsetMs
  }

  /**
   * 从 relay 的 `TIME_SKEW` 应答里学。
   *
   * 记的是差值而不是绝对时间：绝对时间在下一个请求就过期了，差值可以一直用。
   * 返回是否真的学到了 —— 应答形状不对时不该假装校准成功，那会让调用方
   * 无限重试一个永远修不好的问题。
   */
  learnFrom(body: unknown): boolean {
    const serverTime = (body as { error?: { serverTime?: unknown } }).error?.serverTime
    if (typeof serverTime !== 'string') return false
    const parsed = Date.parse(serverTime)
    if (Number.isNaN(parsed)) return false
    this.#offsetMs = parsed - Date.now()
    return true
  }
}

/**
 * 三个请求头。
 *
 * 用 `Record<string, string>` 而不是把三个头名写成字面量键：后者在
 * `exactOptionalPropertyTypes` 下不能直接摊进 fetch 的 headers，而为此加一次
 * 类型断言只会把「这里到底有哪几个键」藏起来。键名在 `signRequest` 里就是
 * 上面那三个常量，读得到。
 */
export type ProofHeaders = Record<string, string>

/**
 * 用设备私钥签一个请求，返回三个请求头。
 *
 * nonce 每次新生成。复用会被 relay 判为重放 —— 那是对的，正是防重放的
 * 全部意义。
 */
export function signRequest(input: {
  method: string
  path: string
  body: string
  deviceId: string
  organizationId: string
  relayFingerprint: string
  signingPrivateKey: string
  clock: ClockOffset
}): ProofHeaders {
  const timestamp = input.clock.now()
  const nonce = randomUUID()
  const payload = proofPayload({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp,
    nonce,
    deviceId: input.deviceId,
    organizationId: input.organizationId,
    relayFingerprint: input.relayFingerprint,
  })
  const key = createPrivateKey({
    key: Buffer.from(input.signingPrivateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  return {
    [SIGNATURE_HEADER]: sign(null, payload, key).toString('base64'),
    [NONCE_HEADER]: nonce,
    [TIMESTAMP_HEADER]: String(timestamp),
  }
}
