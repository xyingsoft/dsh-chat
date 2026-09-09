/** High-risk operation confirmation contract. */

import type { AccountId, DeviceId } from './index.js'
import type { OperationId } from './persistence.js'

export type ConfirmationChallengeId = string & { readonly __confirmationChallengeId: unique symbol }
export type ConfirmationChallengeState = 'pending' | 'consumed' | 'expired' | 'rejected'

export interface ConfirmationChallenge {
  readonly challengeId: ConfirmationChallengeId
  readonly operationId: OperationId
  readonly accountId: AccountId
  readonly deviceId: DeviceId
  /** Stable digest/reference of the exact operation parameters; never raw secrets. */
  readonly operationDigest: string
  readonly state: ConfirmationChallengeState
  readonly createdAt: string
  readonly expiresAt: string
  readonly consumedAt?: string
}

export interface ConfirmationChallengeRequest {
  readonly operationId: OperationId
  readonly operationDigest: string
}

export interface ConfirmationProof {
  readonly challengeId: ConfirmationChallengeId
  readonly operationId: OperationId
  readonly operationDigest: string
  readonly confirmedAt: string
}
