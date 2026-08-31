/**
 * 请求证明测试。
 *
 * 最要紧的一条是**拼接格式**。它是与 relay 的一份跨仓库约定，两边各有一份
 * 实现；差一个换行就永远对不上，而失败长得像「认证失败」。所以下面把期望的
 * 字节串**逐行写死**，而不是调用同一个函数去比 —— 用同一个函数比，两边一起
 * 改错时测试照样绿。
 */

import { createPublicKey, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { generateDeviceKeyPair } from './credentials.js'

import {
  ClockOffset,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  proofPayload,
  signRequest,
} from './request-proof.js'

const SAMPLE = {
  method: 'post',
  path: '/api/chat/messages',
  body: '{"a":1}',
  timestamp: 1_700_000_000_000,
  nonce: 'nonce-1',
  deviceId: 'dev-1',
  organizationId: 'org-1',
  relayFingerprint: 'f'.repeat(64),
}

describe('拼接格式（与 relay 的跨仓库约定）', () => {
  it('九行，顺序固定，换行分隔', () => {
    // 期望值逐行写死。调用对侧的函数去比的话，两边一起改错时测试照样绿
    const expected = [
      'dsh-chat/1',
      'POST',
      '/api/chat/messages',
      // sha256('{"a":1}') 的 base64
      'AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=',
      '1700000000000',
      'nonce-1',
      'dev-1',
      'org-1',
      'f'.repeat(64),
    ].join('\n')
    expect(proofPayload(SAMPLE).toString('utf8')).toBe(expected)
  })

  it('方法名大写 —— 两边必须用同一种写法', () => {
    expect(proofPayload({ ...SAMPLE, method: 'post' }).toString('utf8')).toBe(
      proofPayload({ ...SAMPLE, method: 'POST' }).toString('utf8'),
    )
  })

  it('签的是请求体的摘要而不是请求体本身', () => {
    // 正文可能几百 KB，逐字节签名会让每个请求多一次全量拷贝
    expect(proofPayload(SAMPLE).toString('utf8')).not.toContain('{"a":1}')
  })

  it('空请求体也有确定的摘要，不是特例', () => {
    expect(() => proofPayload({ ...SAMPLE, body: '' })).not.toThrow()
    expect(proofPayload({ ...SAMPLE, body: '' }).toString('utf8').split('\n')).toHaveLength(9)
  })

  it('要素含换行时抛异常，不签出一个有歧义的证明', () => {
    // 直接拼的话 path=/a/b + nonce=c 与 path=/a + nonce=/bc 会撞成同一个
    // 字符串，两个不同的请求共享一个签名 —— 经典的分隔符注入
    expect(() => proofPayload({ ...SAMPLE, nonce: 'a\nb' })).toThrow()
  })

  it('换任何一个要素都得到不同的字节串', () => {
    const base = proofPayload(SAMPLE).toString('utf8')
    const variants = {
      method: 'GET',
      path: '/api/chat/other',
      body: '{"a":2}',
      timestamp: 1_700_000_000_001,
      nonce: 'nonce-2',
      deviceId: 'dev-2',
      organizationId: 'org-2',
      relayFingerprint: 'e'.repeat(64),
    }
    for (const [key, value] of Object.entries(variants)) {
      expect(
        proofPayload({ ...SAMPLE, [key]: value }).toString('utf8'),
        `改了 ${key} 却得到同一个待签名字节串`,
      ).not.toBe(base)
    }
  })
})

describe('签名', () => {
  it('用设备公钥验得过', () => {
    const keys = generateDeviceKeyPair()
    const clock = new ClockOffset()
    const headers = signRequest({
      method: 'POST',
      path: '/api/chat/conversations',
      body: '{}',
      deviceId: 'dev-1',
      organizationId: 'org-1',
      relayFingerprint: SAMPLE.relayFingerprint,
      signingPrivateKey: keys.signingPrivateKey,
      clock,
    })

    const payload = proofPayload({
      method: 'POST',
      path: '/api/chat/conversations',
      body: '{}',
      timestamp: Number(headers[TIMESTAMP_HEADER]),
      nonce: headers[NONCE_HEADER] as string,
      deviceId: 'dev-1',
      organizationId: 'org-1',
      relayFingerprint: SAMPLE.relayFingerprint,
    })
    const publicKey = createPublicKey({
      key: Buffer.from(keys.signingPublicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    expect(
      verify(null, payload, publicKey, Buffer.from(headers[SIGNATURE_HEADER] as string, 'base64')),
    ).toBe(true)
  })

  it('每次的 nonce 都不同', () => {
    // 复用会被 relay 判为重放 —— 那正是防重放的全部意义
    const keys = generateDeviceKeyPair()
    const clock = new ClockOffset()
    const once = () =>
      signRequest({
        method: 'POST',
        path: '/p',
        body: '{}',
        deviceId: 'd',
        organizationId: 'o',
        relayFingerprint: SAMPLE.relayFingerprint,
        signingPrivateKey: keys.signingPrivateKey,
        clock,
      })[NONCE_HEADER]
    expect(once()).not.toBe(once())
  })
})

describe('时钟偏移', () => {
  it('初始没有偏移', () => {
    expect(new ClockOffset().offsetMs).toBe(0)
  })

  it('从 TIME_SKEW 应答里学到差值', () => {
    // 记差值而不是绝对时间：绝对时间在下一个请求就过期了
    const clock = new ClockOffset()
    const serverTime = new Date(Date.now() + 600_000).toISOString()
    expect(clock.learnFrom({ error: { code: 'TIME_SKEW', serverTime } })).toBe(true)
    expect(clock.offsetMs).toBeGreaterThan(500_000)
    expect(clock.now()).toBeGreaterThan(Date.now() + 500_000)
  })

  it('应答形状不对时不假装校准成功', () => {
    // 假装成功会让调用方无限重试一个永远修不好的问题
    const clock = new ClockOffset()
    for (const body of [{}, { error: {} }, { error: { serverTime: 42 } }, { error: { serverTime: '不是时间' } }]) {
      expect(clock.learnFrom(body), `${JSON.stringify(body)} 不该被当作可用的服务器时间`).toBe(
        false,
      )
    }
    expect(clock.offsetMs).toBe(0)
  })

  it('学到偏移后签名用的是校准过的时间', () => {
    const keys = generateDeviceKeyPair()
    const clock = new ClockOffset()
    clock.learnFrom({ error: { serverTime: new Date(Date.now() + 600_000).toISOString() } })
    const headers = signRequest({
      method: 'POST',
      path: '/p',
      body: '{}',
      deviceId: 'd',
      organizationId: 'o',
      relayFingerprint: SAMPLE.relayFingerprint,
      signingPrivateKey: keys.signingPrivateKey,
      clock,
    })
    expect(Number(headers[TIMESTAMP_HEADER])).toBeGreaterThan(Date.now() + 500_000)
  })
})
