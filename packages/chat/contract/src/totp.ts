/**
 * P0 TOTP interoperability and operation contracts.
 *
 * Secret bytes never appear in API response types. The envelope is metadata
 * for an encrypted-at-rest value and must be handled only by the relay boundary.
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

import type { ConfirmationChallengeId } from './confirmation.js'
import type { OperationId } from './persistence.js'

export type TotpFactorId = string & { readonly __totpFactorId: unique symbol }
export type { ConfirmationChallengeId } from './confirmation.js'
export type { OperationId } from './persistence.js'

export type TotpFactorState = 'pending_verification' | 'active' | 'suspended' | 'revoked'

/** Versioned AEAD ciphertext metadata; plaintext secret is never part of this type. */
export interface TotpSecretEnvelope {
  readonly version: 1
  readonly algorithm: 'AES-256-GCM'
  readonly keyId: string
  readonly nonce: string
  readonly aad: string
  readonly ciphertext: string
  readonly authTag: string
}

export interface TotpEnrollmentStarted {
  readonly factorId: TotpFactorId
  readonly state: 'pending_verification'
  readonly config: TotpConfig
  readonly issuer: string
  readonly accountLabel: string
  readonly secretBase32: string
  readonly confirmationChallengeId: ConfirmationChallengeId
}

export interface TotpEnrollmentConfirmation {
  readonly operationId: OperationId
  readonly factorId: TotpFactorId
  readonly confirmationChallengeId: ConfirmationChallengeId
  readonly code: string
}

export interface TotpVerificationRequest {
  readonly operationId: OperationId
  readonly factorId: TotpFactorId
  readonly code: string
}

export interface TotpVerificationAccepted {
  readonly accepted: true
  readonly factorId: TotpFactorId
  readonly acceptedStep: bigint
}

export interface TotpVerificationRejected {
  readonly accepted: false
  /** Deliberately generic; does not reveal factor existence or code validity. */
  readonly reason: 'authentication_failed'
}

export type TotpVerificationResult = TotpVerificationAccepted | TotpVerificationRejected

export interface TotpRevocationRequest {
  readonly operationId: OperationId
  readonly factorId: TotpFactorId
  readonly confirmationChallengeId: ConfirmationChallengeId
}

export interface TotpRevocationResult {
  readonly factorId: TotpFactorId
  readonly state: 'revoked'
}
