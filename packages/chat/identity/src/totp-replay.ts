/**
 * Pure replay gate for a successfully verified TOTP counter.
 *
 * The returned next value must be written with an atomic compare-and-swap (or
 * equivalent transaction) together with the authentication result. This
 * helper intentionally does not claim that an in-memory comparison is enough.
 */

export interface TotpReplayAccepted {
  readonly accepted: true
  readonly nextLastAcceptedStep: bigint
}

export interface TotpReplayRejected {
  readonly accepted: false
}

export type TotpReplayResult = TotpReplayAccepted | TotpReplayRejected

export function acceptTotpStep(
  lastAcceptedStep: bigint | null,
  matchedStep: bigint,
): TotpReplayResult {
  if (matchedStep < 0n || (lastAcceptedStep !== null && lastAcceptedStep < 0n)) {
    return { accepted: false }
  }
  if (lastAcceptedStep !== null && matchedStep <= lastAcceptedStep) {
    return { accepted: false }
  }
  return { accepted: true, nextLastAcceptedStep: matchedStep }
}
