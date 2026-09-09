import { describe, expect, it } from 'vitest'

import { ChatDatabase } from './database.js'
import {
  consumeConfirmationChallengeInTransaction,
  insertConfirmationChallengeInTransaction,
} from './confirmation-challenges.js'

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
    ).run(
      'device-1',
      'account-1',
      'public-key',
      'fingerprint',
      '2026-09-07T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z',
    )
  })
}

const challenge = {
  challengeId: 'ch-1',
  operationId: 'op-1',
  accountId: 'account-1',
  deviceId: 'device-1',
  operationDigest: 'sha256:operation',
  createdAt: '2026-09-07T00:00:00.000Z',
  expiresAt: '2026-09-07T00:05:00.000Z',
}

describe('ConfirmationChallenge transaction boundary', () => {
  it('inserts and atomically consumes a matching pending challenge once', () => {
    const db = openMemory()
    seedIdentity(db)
    db.transaction((handle) => insertConfirmationChallengeInTransaction(handle, challenge))
    expect(
      db.transaction((handle) =>
        consumeConfirmationChallengeInTransaction(handle, {
          ...challenge,
          confirmedAt: '2026-09-07T00:01:00.000Z',
        }),
      ),
    ).toBe(true)
    expect(
      db.transaction((handle) =>
        consumeConfirmationChallengeInTransaction(handle, {
          ...challenge,
          confirmedAt: '2026-09-07T00:02:00.000Z',
        }),
      ),
    ).toBe(false)
    db.close()
  })

  it('rejects mismatched or expired challenges without consuming them', () => {
    const db = openMemory()
    seedIdentity(db)
    db.transaction((handle) => insertConfirmationChallengeInTransaction(handle, challenge))
    expect(
      db.transaction((handle) =>
        consumeConfirmationChallengeInTransaction(handle, {
          ...challenge,
          operationDigest: 'sha256:other',
          confirmedAt: '2026-09-07T00:01:00.000Z',
        }),
      ),
    ).toBe(false)
    expect(
      db.transaction((handle) =>
        consumeConfirmationChallengeInTransaction(handle, {
          ...challenge,
          confirmedAt: '2026-09-07T00:06:00.000Z',
        }),
      ),
    ).toBe(false)
    const state = db.readonlyHandle
      .prepare('SELECT state FROM confirmation_challenges WHERE challenge_id = ?')
      .get('ch-1') as { state: string }
    expect(state.state).toBe('pending')
    db.close()
  })
})
