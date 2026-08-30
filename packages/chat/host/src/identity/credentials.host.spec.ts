/**
 * 本机凭据存储测试。
 *
 * 两条不变量值得单独测：**半份凭据一律当作未开户**（否则用户会卡在一个每个
 * 请求都失败、又看不出为什么的状态），以及**写入是原子的**（写到一半掉电
 * 不该表现为莫名其妙被注销）。
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CredentialStore, generateDeviceKeyPair, type DeviceCredentials } from './credentials.js'

let workDir: string
let store: CredentialStore

const SAMPLE: DeviceCredentials = {
  accountId: 'acct-1',
  deviceId: 'dev-1',
  signingPrivateKey: 'priv',
  signingPublicKey: 'pub',
  keyFingerprint: 'f'.repeat(64),
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  accessExpiresAt: '2026-01-01T00:00:00.000Z',
  refreshExpiresAt: '2026-02-01T00:00:00.000Z',
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-cred-'))
  store = new CredentialStore(join(workDir, 'creds.json'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('读写', () => {
  it('没有文件时是「未开户」而不是报错', () => {
    expect(store.read()).toBeUndefined()
  })

  it('写进去能原样读回来', () => {
    store.write(SAMPLE)
    expect(store.read()).toEqual(SAMPLE)
  })

  it('刷新只换 token，密钥不动', () => {
    // 刷新把密钥也换掉的话，relay 那边绑定的指纹就对不上了，
    // 会话立即失效 —— 一次刷新等于一次注销
    store.write(SAMPLE)
    const next = store.updateTokens({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accessExpiresAt: '2026-03-01T00:00:00.000Z',
      refreshExpiresAt: '2026-04-01T00:00:00.000Z',
    })
    expect(next?.signingPrivateKey).toBe(SAMPLE.signingPrivateKey)
    expect(next?.keyFingerprint).toBe(SAMPLE.keyFingerprint)
    expect(next?.accessToken).toBe('new-access')
    expect(store.read()?.refreshToken).toBe('new-refresh')
  })

  it('还没开户时刷新是空操作，不会凭空造出一份凭据', () => {
    expect(store.updateTokens({
      accessToken: 'a',
      refreshToken: 'b',
      accessExpiresAt: 'c',
      refreshExpiresAt: 'd',
    })).toBeUndefined()
    expect(store.read()).toBeUndefined()
  })

  it('注销后读不到', () => {
    store.write(SAMPLE)
    store.clear()
    expect(store.read()).toBeUndefined()
  })
})

describe('坏文件一律当作未开户', () => {
  it('不是 JSON', () => {
    writeFileSync(store.path, '{ 截断了', 'utf8')
    expect(store.read()).toBeUndefined()
  })

  it('缺字段', () => {
    // 半份凭据比没有凭据更糟：调用方会以为已经开过户，然后在每个请求上失败
    for (const missing of ['refreshToken', 'signingPrivateKey', 'deviceId'] as const) {
      const partial: Record<string, unknown> = { ...SAMPLE }
      delete partial[missing]
      writeFileSync(store.path, JSON.stringify(partial), 'utf8')
      expect(store.read(), `缺 ${missing} 时应视为未开户`).toBeUndefined()
    }
  })

  it('字段是空串', () => {
    writeFileSync(store.path, JSON.stringify({ ...SAMPLE, accessToken: '' }), 'utf8')
    expect(store.read()).toBeUndefined()
  })
})

describe('写入是原子的', () => {
  it('落盘后不留临时文件', () => {
    // 临时文件留着的话，下次崩溃恢复分不清哪个是好的
    store.write(SAMPLE)
    expect(readdirSync(workDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('密钥对', () => {
  it('每次都不一样', () => {
    const a = generateDeviceKeyPair()
    const b = generateDeviceKeyPair()
    expect(a.signingPublicKey).not.toBe(b.signingPublicKey)
    expect(a.keyFingerprint).not.toBe(b.keyFingerprint)
  })

  it('指纹是公钥的 SHA-256，不是私钥的', () => {
    // 指纹要能被 relay 独立算出来。掺进私钥就算不出了 —— 而 relay 只有公钥
    const { signingPublicKey, keyFingerprint } = generateDeviceKeyPair()
    const expected = createHash('sha256')
      .update(Buffer.from(signingPublicKey, 'base64'))
      .digest('hex')
    expect(keyFingerprint).toBe(expected)
  })

  it('私钥和公钥不是同一个东西', () => {
    const keys = generateDeviceKeyPair()
    expect(keys.signingPrivateKey).not.toBe(keys.signingPublicKey)
    expect(keys.signingPrivateKey.length).toBeGreaterThan(0)
  })
})
