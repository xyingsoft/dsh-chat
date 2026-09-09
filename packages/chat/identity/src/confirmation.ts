import type { ConfirmationChallenge, ConfirmationProof } from '@dsh-chat/contract'

export type ConfirmationFailure =
  | 'challenge_not_found'
  | 'challenge_expired'
  | 'challenge_already_used'
  | 'challenge_binding_mismatch'

export type ConfirmationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConfirmationFailure }

/** Validate challenge binding and lifetime without consuming it. */
export function validateConfirmationProof(
  challenge: ConfirmationChallenge | undefined,
  proof: ConfirmationProof,
  now: Date,
): ConfirmationValidation {
  if (challenge === undefined) return { ok: false, reason: 'challenge_not_found' }
  if (challenge.state !== 'pending') return { ok: false, reason: 'challenge_already_used' }
  if (now.getTime() >= Date.parse(challenge.expiresAt)) {
    return { ok: false, reason: 'challenge_expired' }
  }
  if (
    challenge.challengeId !== proof.challengeId ||
    challenge.operationId !== proof.operationId ||
    challenge.operationDigest !== proof.operationDigest ||
    Date.parse(proof.confirmedAt) < Date.parse(challenge.createdAt)
  ) {
    return { ok: false, reason: 'challenge_binding_mismatch' }
  }
  return { ok: true }
}

/**
 * Pure state transition for one-time consumption. Persist the returned state
 * atomically with the protected operation; this function does not touch storage.
 */
export function consumeConfirmationChallenge(
  challenge: ConfirmationChallenge,
  proof: ConfirmationProof,
  now: Date,
): ConfirmationValidation {
  const result = validateConfirmationProof(challenge, proof, now)
  return result
}
