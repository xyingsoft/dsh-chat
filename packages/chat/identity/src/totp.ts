/**
 * RFC 6238 verification primitives.
 *
 * This module deliberately has no database, HTTP, or secret-storage policy. The
 * caller supplies the secret and must persist `matchedStep` atomically before
 * accepting it, so replay prevention remains an account/device transaction rule.
 */

import type { TotpAlgorithm, TotpConfig } from '@dsh-chat/contract'

export type { TotpAlgorithm, TotpConfig } from '@dsh-chat/contract'
import { DEFAULT_TOTP_CONFIG } from '@dsh-chat/contract'

export { DEFAULT_TOTP_CONFIG }

export interface TotpMatch {
  readonly ok: true
  readonly matchedStep: bigint
}

export interface TotpFailure {
  readonly ok: false
}

export type TotpVerification = TotpMatch | TotpFailure

export type TotpHmac = (
  algorithm: TotpAlgorithm,
  secret: Uint8Array,
  counter: bigint,
) => Uint8Array

function validConfig(config: TotpConfig): boolean {
  return (
    (config.algorithm === 'SHA1' || config.algorithm === 'SHA256' || config.algorithm === 'SHA512') &&
    (config.digits === 6 || config.digits === 8) &&
    Number.isSafeInteger(config.periodSeconds) &&
    config.periodSeconds > 0 &&
    Number.isSafeInteger(config.toleranceSteps) &&
    config.toleranceSteps >= 0
  )
}

function decimalCode(bytes: Uint8Array, digits: number): string | undefined {
  const offsetByte = bytes.at(-1)
  if (offsetByte === undefined) return undefined
  const offset = offsetByte & 0x0f
  if (offset + 3 >= bytes.length) return undefined
  const binary =
    ((bytes[offset] ?? 0) & 0x7f) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

function sameCode(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/** Verify a decimal TOTP code and return the accepted counter for replay checks. */
export function verifyTotp(
  code: string,
  unixTimeSeconds: number,
  secret: Uint8Array,
  config: TotpConfig,
  hmac: TotpHmac,
): TotpVerification {
  if (
    !validConfig(config) ||
    secret.length === 0 ||
    !Number.isSafeInteger(unixTimeSeconds) ||
    unixTimeSeconds < 0 ||
    !new RegExp(`^\\d{${config.digits}}$`).test(code)
  ) {
    return { ok: false }
  }

  const currentStep = BigInt(Math.floor(unixTimeSeconds / config.periodSeconds))
  for (let delta = 0 - config.toleranceSteps; delta <= config.toleranceSteps; delta += 1) {
    const step = currentStep + BigInt(delta)
    if (step < 0n) continue
    const expected = decimalCode(hmac(config.algorithm, secret, step), config.digits)
    if (expected !== undefined && sameCode(code, expected)) {
      return { ok: true, matchedStep: step }
    }
  }
  return { ok: false }
}
