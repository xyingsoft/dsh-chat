import { describe, expect, it } from 'vitest'

import type { ConfirmationChallenge, ConfirmationProof } from '@dsh-chat/contract'

import { consumeConfirmationChallenge, validateConfirmationProof } from './confirmation.js'

const challenge: ConfirmationChallenge = {
  challengeId: 'ch-1' as ConfirmationChallenge['challengeId'],
  operationId: 'op-1' as ConfirmationChallenge['operationId'],
  accountId: 'account-1' as ConfirmationChallenge['accountId'],
  deviceId: 'device-1' as ConfirmationChallenge['deviceId'],
  operationDigest: 'sha256:operation',
  state: 'pending',
  createdAt: '2026-09-07T00:00:00.000Z',
  expiresAt: '2026-09-07T00:05:00.000Z',
}
const proof: ConfirmationProof = {
  challengeId: challenge.challengeId,
  operationId: challenge.operationId,
  operationDigest: challenge.operationDigest,
  confirmedAt: '2026-09-07T00:01:00.000Z',
}
const now = new Date('2026-09-07T00:02:00.000Z')

describe('ConfirmationChallenge validation', () => {
  it('accepts a matching unexpired pending proof', () => {
    expect(validateConfirmationProof(challenge, proof, now)).toEqual({ ok: true })
  })

  it('rejects missing, consumed and expired challenges', () => {
    expect(validateConfirmationProof(undefined, proof, now)).toEqual({
      ok: false,
      reason: 'challenge_not_found',
    })
    expect(validateConfirmationProof({ ...challenge, state: 'consumed' }, proof, now)).toEqual({
      ok: false,
      reason: 'challenge_already_used',
    })
    expect(
      validateConfirmationProof(
        { ...challenge, expiresAt: '2026-09-07T00:01:00.000Z' },
        proof,
        now,
      ),
    ).toEqual({ ok: false, reason: 'challenge_expired' })
  })

  it('rejects a proof bound to another operation', () => {
    expect(
      validateConfirmationProof(challenge, { ...proof, operationDigest: 'sha256:other' }, now),
    ).toEqual({ ok: false, reason: 'challenge_binding_mismatch' })
  })

  it('consumption validation remains pure and requires persistence by caller', () => {
    expect(consumeConfirmationChallenge(challenge, proof, now)).toEqual({ ok: true })
    expect(challenge.state).toBe('pending')
  })
})
