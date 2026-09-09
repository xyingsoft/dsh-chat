/**
 * P0 TOTP interoperability profile.
 *
 * This file defines only wire-neutral, shared parameters. Secret storage,
 * enrollment challenges, replay transactions, and rate limiting belong to the
 * identity/relay boundary and are intentionally not modeled here yet.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'
export type TotpDigits = 6 | 8

export interface TotpConfig {
  readonly algorithm: TotpAlgorithm
  readonly digits: TotpDigits
  readonly periodSeconds: number
  readonly toleranceSteps: number
}

/** P0 default: RFC 6238, six digits, 30 seconds, ±1 step. */
export const DEFAULT_TOTP_CONFIG: TotpConfig = Object.freeze({
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
  toleranceSteps: 1,
})
