import { describe, expect, it } from 'vitest'

import { ChatDatabase } from './database.js'
import {
  confirmTotpFactorInTransaction,
  insertPendingTotpFactorInTransaction,
  readTotpFactor,
  revokeTotpFactorInTransaction,
} from './totp-factors.js'

function openMemory(): ChatDatabase {
  return ChatDatabase.open({ location: ':memory:' })
}

function seedIdentity(db: ChatDatabase): void {
  db.transaction((handle) => {
    handle.prepare('INSERT INTO accounts (account_id, display_name, created_at) VALUES (?, ?, ?)').run(
      'account-1',
      '测试账号',
      '2026-09-07T00:00:00.000Z',
    )
    handle.prepare(
      `INSERT INTO devices
       (device_id, account_id, signing_public_key, key_fingerprint, state, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run('device-1', 'account-1', 'public-key', 'fingerprint', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')
  })
}

const factor = {
  factorId: 'factor-1',
  accountId: 'account-1',
  algorithm: 'SHA1' as const,
  digits: 6 as const,
  periodSeconds: 30,
  toleranceSteps: 1,
  keyId: 'key-1',
  nonce: 'nonce',
  aad: 'account:account-1/factor:factor-1',
  ciphertext: 'ciphertext',
  authTag: 'auth-tag',
  createdAt: '2026-09-07T00:00:00.000Z',
}

describe('TOTP factor transaction storage', () => {
  it('inserts pending, confirms once, and reads the factor without plaintext secret', () => {
    const db = openMemory()
    seedIdentity(db)
    db.transaction((handle) => insertPendingTotpFactorInTransaction(handle, factor))
    expect(
      db.transaction((handle) =>
        confirmTotpFactorInTransaction(handle, 'factor-1', '2026-09-07T00:01:00.000Z'),
      ),
    ).toBe(true)
    expect(
      db.transaction((handle) =>
        confirmTotpFactorInTransaction(handle, 'factor-1', '2026-09-07T00:02:00.000Z'),
      ),
    ).toBe(false)
    const result = readTotpFactor(db.readonlyHandle, 'account-1', 'factor-1')
    expect(result).toMatchObject({ factorId: 'factor-1', state: 'active', lastAcceptedStep: null })
    expect(result).not.toHaveProperty('secret')
    db.close()
  })

  it('revokes an active factor, but protects the last active factor under mandatory policy', () => {
    const db = openMemory()
    seedIdentity(db)
    db.transaction((handle) => insertPendingTotpFactorInTransaction(handle, factor))
    db.transaction((handle) => confirmTotpFactorInTransaction(handle, 'factor-1', '2026-09-07T00:01:00.000Z'))
    expect(
      db.transaction((handle) => revokeTotpFactorInTransaction(handle, 'account-1', 'factor-1', true)),
    ).toEqual({ ok: false, reason: 'last_active_factor_forbidden' })
    expect(
      db.transaction((handle) => revokeTotpFactorInTransaction(handle, 'account-1', 'factor-1', false)),
    ).toEqual({ ok: true, state: 'revoked' })
    db.close()
  })
})
