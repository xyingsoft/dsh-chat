import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { decryptTotpSecret, encryptTotpSecret } from './totp-envelope.js'

describe('TOTP secret envelope', () => {
  it('encrypts and decrypts without putting plaintext in the envelope', () => {
    const secret = new TextEncoder().encode('base32-secret')
    const key = randomBytes(32)
    const envelope = encryptTotpSecret(secret, key, 'key-1', 'account:a/factor:f')

    expect(JSON.stringify(envelope)).not.toContain('base32-secret')
    expect(decryptTotpSecret(envelope, key, 'account:a/factor:f')).toEqual(secret)
  })

  it('rejects a wrong key or changed associated data', () => {
    const key = randomBytes(32)
    const envelope = encryptTotpSecret(
      new TextEncoder().encode('secret'),
      key,
      'key-1',
      'account:a/factor:f',
    )
    expect(() => decryptTotpSecret(envelope, randomBytes(32), 'account:a/factor:f')).toThrow(
      '密钥封装验证失败',
    )
    expect(() => decryptTotpSecret(envelope, key, 'account:b/factor:f')).toThrow(
      '密钥封装验证失败',
    )

    const tampered = {
      ...envelope,
      authTag: `${envelope.authTag.slice(0, -1)}${envelope.authTag.endsWith('0') ? '1' : '0'}`,
    }
    expect(() => decryptTotpSecret(tampered, key, envelope.aad)).toThrow('密钥封装验证失败')
  })

  it('rejects malformed envelope and invalid key length', () => {
    expect(() =>
      encryptTotpSecret(new Uint8Array([1]), new Uint8Array(31), 'key-1', 'aad'),
    ).toThrow('AES-256-GCM 密钥必须为 32 字节')
    expect(() =>
      decryptTotpSecret(
        {
          version: 2,
          algorithm: 'AES-256-GCM',
          keyId: 'key-1',
          nonce: '',
          aad: 'aad',
          ciphertext: '',
          authTag: '',
        } as never,
        new Uint8Array(32),
        'aad',
      ),
    ).toThrow('密钥封装格式无效')
  })
})
