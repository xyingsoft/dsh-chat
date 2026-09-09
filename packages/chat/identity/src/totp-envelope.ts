import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { TotpSecretEnvelope } from '@dsh-chat/contract'

const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

function requireKey(key: Uint8Array): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM 密钥必须为 32 字节')
  return Buffer.from(key)
}

function requireEnvelope(envelope: TotpSecretEnvelope): void {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    envelope.nonce.length !== NONCE_BYTES * 2 ||
    envelope.authTag.length !== TAG_BYTES * 2 ||
    envelope.keyId.length === 0 ||
    envelope.aad.length === 0 ||
    envelope.ciphertext.length === 0
  ) {
    throw new Error('密钥封装格式无效')
  }
}

export function encryptTotpSecret(
  secret: Uint8Array,
  key: Uint8Array,
  keyId: string,
  aad: string,
): TotpSecretEnvelope {
  const keyBuffer = requireKey(key)
  if (secret.length === 0 || keyId.length === 0 || aad.length === 0) {
    throw new Error('密钥封装输入无效')
  }
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyBuffer, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId,
    nonce: nonce.toString('hex'),
    aad,
    ciphertext: ciphertext.toString('base64url'),
    authTag: authTag.toString('hex'),
  }
}

export function decryptTotpSecret(
  envelope: TotpSecretEnvelope,
  key: Uint8Array,
  expectedAad: string,
): Uint8Array {
  requireEnvelope(envelope)
  const keyBuffer = requireKey(key)
  if (envelope.aad !== expectedAad) throw new Error('密钥封装验证失败')
  try {
    const decipher = createDecipheriv(ALGORITHM, keyBuffer, Buffer.from(envelope.nonce, 'hex'))
    decipher.setAAD(Buffer.from(envelope.aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'))
    return new Uint8Array(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]),
    )
  } catch {
    throw new Error('密钥封装验证失败')
  }
}
