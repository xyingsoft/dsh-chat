/**
 * 本机设备凭据。
 *
 * §7：host 本地生成 Ed25519 密钥对，**私钥永不上传**，只把公钥、设备名称与
 * 指纹提交给 relay。relay 回签一对 token。所以本机要长期持有三样东西：
 * 私钥、公钥、以及当前会话的一对 token。
 *
 * ## 为什么不放进 SQLite
 *
 * host 那个库是**缓存**（§4：「本地持久化缓存」），清掉它是一个受支持的恢复
 * 手段。凭据混在里面的话，清缓存会顺带把设备身份清掉 —— 用户以为自己在清
 * 缓存，实际是在注销。分开存，两件事就各归各。
 *
 * ## 文件权限只在 POSIX 上是真的
 *
 * 写文件时给 `0o600`。Windows 上这个 mode 基本没有效果 —— NTFS 走 ACL，
 * chmod 那套语义映射不过去。这不是可以忽略的细节：桌面端主力平台就是
 * Windows，所以**不要把「文件权限已限制」当成一层防护来依赖**。真正的
 * 防护是私钥离不开本机、以及 token 可撤销。
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 一台设备的身份材料。私钥字段只在本机出现，任何出站请求都不带它。 */
export interface DeviceCredentials {
  readonly accountId: string
  readonly deviceId: string
  /** PKCS#8 DER，base64。**只写本地文件，不进任何请求。** */
  readonly signingPrivateKey: string
  /** SPKI DER，base64。注册时提交给 relay 的就是这个。 */
  readonly signingPublicKey: string
  readonly keyFingerprint: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: string
  readonly refreshExpiresAt: string
}

/** 新生成的一对密钥。私钥留本地，公钥上传。 */
export interface GeneratedKeyPair {
  readonly signingPrivateKey: string
  readonly signingPublicKey: string
  readonly keyFingerprint: string
}

/**
 * 本机生成 Ed25519 密钥对。
 *
 * 在 host 而不是 relay 生成，是 §7 的要求也是唯一说得通的做法：relay 生成
 * 就意味着私钥在网上走过一趟，那之后再说「私钥永不上传」已经没有意义了。
 */
export function generateDeviceKeyPair(): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return {
    signingPrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    signingPublicKey: spki.toString('base64'),
    keyFingerprint: createHash('sha256').update(spki).digest('hex'),
  }
}

/**
 * 凭据文件。
 *
 * 读写都走整份替换 —— 凭据是一个整体，token 换了而私钥没换、或者反过来，
 * 都是不可用的状态。没有「部分更新」这回事。
 */
export class CredentialStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  /** 默认放在库文件旁边，但**是另一个文件** —— 见文件头关于清缓存的说明。 */
  static beside(databasePath: string): CredentialStore {
    return new CredentialStore(join(dirname(databasePath), 'dsh-chat.credentials.json'))
  }

  get path(): string {
    return this.#path
  }

  /**
   * 读取当前凭据。
   *
   * 文件不存在、读不动、或内容不是一份完整凭据，一律返回 `undefined` ——
   * 也就是「本机尚未开户」。半份凭据比没有凭据更糟：它会让调用方以为已经
   * 开过户，然后在每个请求上失败，而正确的处置是重新走一遍注册。
   */
  read(): DeviceCredentials | undefined {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    return isCredentials(parsed) ? parsed : undefined
  }

  /**
   * 整份写入。
   *
   * 先写临时文件再改名。直接覆写的话，写到一半掉电会留下一个被截断的 JSON，
   * 下次读出来是「未开户」—— 用户看到的是自己莫名其妙被注销了。
   */
  write(credentials: DeviceCredentials): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.#path)
  }

  /** 换一对新 token，其余字段原样保留。密钥不该因为刷新而变。 */
  updateTokens(tokens: {
    accessToken: string
    refreshToken: string
    accessExpiresAt: string
    refreshExpiresAt: string
  }): DeviceCredentials | undefined {
    const current = this.read()
    if (current === undefined) return undefined
    const next: DeviceCredentials = { ...current, ...tokens }
    this.write(next)
    return next
  }

  /** 清除本机凭据（注销）。私钥一并删除 —— 留着它没有任何用途。 */
  clear(): void {
    try {
      writeFileSync(this.#path, '', { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 文件本来就不在时删不掉不是错误
    }
  }
}

const REQUIRED = [
  'accountId',
  'deviceId',
  'signingPrivateKey',
  'signingPublicKey',
  'keyFingerprint',
  'accessToken',
  'refreshToken',
  'accessExpiresAt',
  'refreshExpiresAt',
] as const

function isCredentials(value: unknown): value is DeviceCredentials {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return REQUIRED.every((key) => typeof record[key] === 'string' && record[key] !== '')
}
