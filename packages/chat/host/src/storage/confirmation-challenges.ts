import type { DatabaseSync } from 'node:sqlite'

export interface ConfirmationChallengeInsert {
  readonly challengeId: string
  readonly operationId: string
  readonly accountId: string
  readonly deviceId: string
  readonly operationDigest: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface ConfirmationChallengeProof {
  readonly challengeId: string
  readonly operationId: string
  readonly accountId: string
  readonly deviceId: string
  readonly operationDigest: string
  readonly confirmedAt: string
}

/** Must be called inside ChatDatabase.transaction(). */
export function insertConfirmationChallengeInTransaction(
  db: DatabaseSync,
  input: ConfirmationChallengeInsert,
): void {
  db.prepare(
    `INSERT INTO confirmation_challenges
     (challenge_id, operation_id, account_id, device_id, operation_digest, state, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    input.challengeId,
    input.operationId,
    input.accountId,
    input.deviceId,
    input.operationDigest,
    input.createdAt,
    input.expiresAt,
  )
}

/**
 * Atomically consumes a pending challenge only when every binding matches and
 * the confirmation instant is inside the challenge lifetime.
 */
export function consumeConfirmationChallengeInTransaction(
  db: DatabaseSync,
  proof: ConfirmationChallengeProof,
): boolean {
  const result = db
    .prepare(
      `UPDATE confirmation_challenges
       SET state = 'consumed', consumed_at = ?
       WHERE challenge_id = ?
         AND operation_id = ?
         AND account_id = ?
         AND device_id = ?
         AND operation_digest = ?
         AND state = 'pending'
         AND created_at <= ?
         AND ? < expires_at`,
    )
    .run(
      proof.confirmedAt,
      proof.challengeId,
      proof.operationId,
      proof.accountId,
      proof.deviceId,
      proof.operationDigest,
      proof.confirmedAt,
      proof.confirmedAt,
    )
  return result.changes === 1
}
