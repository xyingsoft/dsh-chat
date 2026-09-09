import type { DatabaseSync } from 'node:sqlite'

export interface PendingTotpFactorInsert {
  readonly factorId: string
  readonly accountId: string
  readonly algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  readonly digits: 6 | 8
  readonly periodSeconds: number
  readonly toleranceSteps: number
  readonly keyId: string
  readonly nonce: string
  readonly aad: string
  readonly ciphertext: string
  readonly authTag: string
  readonly createdAt: string
}

export interface TotpFactorRecord {
  readonly factorId: string
  readonly accountId: string
  readonly state: 'pending_verification' | 'active' | 'suspended' | 'revoked'
  readonly algorithm: PendingTotpFactorInsert['algorithm']
  readonly digits: 6 | 8
  readonly periodSeconds: number
  readonly toleranceSteps: number
  readonly keyId: string
  readonly nonce: string
  readonly aad: string
  readonly ciphertext: string
  readonly authTag: string
  readonly lastAcceptedStep: bigint | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Must be called inside ChatDatabase.transaction(). */
export function insertPendingTotpFactorInTransaction(
  db: DatabaseSync,
  input: PendingTotpFactorInsert,
): void {
  db.prepare(
    `INSERT INTO totp_factors
     (factor_id, account_id, state, algorithm, digits, period_seconds, tolerance_steps,
      key_id, nonce, aad, ciphertext, auth_tag, last_accepted_step, created_at, updated_at)
     VALUES (?, ?, 'pending_verification', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.factorId,
    input.accountId,
    input.algorithm,
    input.digits,
    input.periodSeconds,
    input.toleranceSteps,
    input.keyId,
    input.nonce,
    input.aad,
    input.ciphertext,
    input.authTag,
    input.createdAt,
    input.createdAt,
  )
}

/** Must be called inside ChatDatabase.transaction(). */
export function confirmTotpFactorInTransaction(
  db: DatabaseSync,
  factorId: string,
  confirmedAt: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE totp_factors
       SET state = 'active', updated_at = ?
       WHERE factor_id = ? AND state = 'pending_verification'`,
    )
    .run(confirmedAt, factorId)
  return result.changes === 1
}

export function readTotpFactor(
  db: DatabaseSync,
  accountId: string,
  factorId: string,
): TotpFactorRecord | undefined {
  const row = db
    .prepare(
      `SELECT factor_id, account_id, state, algorithm, digits, period_seconds, tolerance_steps,
              key_id, nonce, aad, ciphertext, auth_tag, last_accepted_step, created_at, updated_at
       FROM totp_factors WHERE account_id = ? AND factor_id = ?`,
    )
    .get(accountId, factorId) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return {
    factorId: row['factor_id'] as string,
    accountId: row['account_id'] as string,
    state: row['state'] as TotpFactorRecord['state'],
    algorithm: row['algorithm'] as TotpFactorRecord['algorithm'],
    digits: row['digits'] as 6 | 8,
    periodSeconds: row['period_seconds'] as number,
    toleranceSteps: row['tolerance_steps'] as number,
    keyId: row['key_id'] as string,
    nonce: row['nonce'] as string,
    aad: row['aad'] as string,
    ciphertext: row['ciphertext'] as string,
    authTag: row['auth_tag'] as string,
    lastAcceptedStep: (row['last_accepted_step'] as bigint | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  }
}

export type TotpRevokeResult =
  | { readonly ok: true; readonly state: 'revoked' }
  | { readonly ok: false; readonly reason: 'last_active_factor_forbidden' }

/** Must be called inside ChatDatabase.transaction(). */
export function revokeTotpFactorInTransaction(
  db: DatabaseSync,
  accountId: string,
  factorId: string,
  mandatoryPolicy: boolean,
): TotpRevokeResult {
  if (mandatoryPolicy) {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM totp_factors WHERE account_id = ? AND state = 'active'`)
      .get(accountId) as { count: number }
    const target = db
      .prepare(`SELECT state FROM totp_factors WHERE account_id = ? AND factor_id = ?`)
      .get(accountId, factorId) as { state: string } | undefined
    if (target?.state === 'active' && row.count <= 1) {
      return { ok: false, reason: 'last_active_factor_forbidden' }
    }
  }
  const result = db
    .prepare(
      `UPDATE totp_factors SET state = 'revoked', updated_at = ?
       WHERE account_id = ? AND factor_id = ? AND state = 'active'`,
    )
    .run(new Date().toISOString(), accountId, factorId)
  return result.changes === 1 ? { ok: true, state: 'revoked' } : { ok: false, reason: 'last_active_factor_forbidden' }
}
