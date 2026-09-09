import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { DEFAULT_TOTP_CONFIG, verifyTotp, type TotpConfig } from './totp.js'

const config: TotpConfig = {
  algorithm: 'SHA1',
  digits: 8,
  periodSeconds: 30,
  toleranceSteps: 1,
}

function hmac(algorithm: 'SHA1' | 'SHA256' | 'SHA512', key: Uint8Array, counter: bigint): Uint8Array {
  const input = Buffer.alloc(8)
  input.writeBigUInt64BE(counter)
  return new Uint8Array(createHmac(algorithm.toLowerCase(), key).update(input).digest())
}

it('exposes the agreed P0 profile', () => {
  expect(DEFAULT_TOTP_CONFIG).toEqual({
    algorithm: 'SHA1',
    digits: 6,
    periodSeconds: 30,
    toleranceSteps: 1,
  })
})

describe('TOTP verifier · RFC 6238', () => {
  it('accepts the RFC 6238 SHA-1 vector at the exact time step', () => {
    const secret = new TextEncoder().encode('12345678901234567890')
    expect(verifyTotp('94287082', 59, secret, config, hmac)).toEqual({
      ok: true,
      matchedStep: 1n,
    })
  })

  it('accepts the RFC 6238 SHA-256 and SHA-512 vectors', () => {
    const sha256 = new TextEncoder().encode('12345678901234567890123456789012')
    const sha512 = new TextEncoder().encode('1234567890123456789012345678901234567890123456789012345678901234')
    expect(verifyTotp('46119246', 59, sha256, { ...config, algorithm: 'SHA256' }, hmac)).toEqual({
      ok: true,
      matchedStep: 1n,
    })
    expect(verifyTotp('90693936', 59, sha512, { ...config, algorithm: 'SHA512' }, hmac)).toEqual({
      ok: true,
      matchedStep: 1n,
    })
  })

  it('accepts one step of configured clock tolerance and reports that step', () => {
    const secret = new TextEncoder().encode('12345678901234567890')
    expect(verifyTotp('94287082', 60, secret, config, hmac)).toEqual({
      ok: true,
      matchedStep: 1n,
    })
  })

  it('rejects a wrong code without revealing whether the secret exists', () => {
    const secret = new TextEncoder().encode('12345678901234567890')
    expect(verifyTotp('00000000', 59, secret, config, hmac)).toEqual({ ok: false })
  })

  it('rejects malformed input and invalid configuration', () => {
    const secret = new Uint8Array([1, 2, 3])
    expect(verifyTotp('1234', 0, secret, config, hmac)).toEqual({ ok: false })
    expect(verifyTotp('123456', 0, secret, { ...config, digits: 5 }, hmac)).toEqual({ ok: false })
    expect(verifyTotp('123456', 0, secret, { ...config, toleranceSteps: -1 }, hmac)).toEqual({ ok: false })
  })

  it('does not accept a step outside the configured tolerance', () => {
    const secret = new TextEncoder().encode('12345678901234567890')
    expect(verifyTotp('94287082', 120, secret, config, hmac)).toEqual({ ok: false })
  })
})
