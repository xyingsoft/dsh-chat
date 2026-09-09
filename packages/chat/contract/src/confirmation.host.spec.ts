import { describe, expect, it } from 'vitest'

import type { ConfirmationChallenge, ConfirmationProof } from './confirmation.js'

describe('ConfirmationChallenge contract', () => {
  it('binds a high-risk operation to account, device, digest and expiry', () => {
    const challenge: ConfirmationChallenge = {
      challengeId: 'challenge-1' as ConfirmationChallenge['challengeId'],
      operationId: 'operation-1' as ConfirmationChallenge['operationId'],
      accountId: 'account-1' as ConfirmationChallenge['accountId'],
      deviceId: 'device-1' as ConfirmationChallenge['deviceId'],
      operationDigest: 'sha256:digest',
      state: 'pending',
      createdAt: '2026-09-07T00:00:00.000Z',
      expiresAt: '2026-09-07T00:05:00.000Z',
    }
    expect(challenge).not.toHaveProperty('secret')
    expect(challenge).not.toHaveProperty('code')
  })

  it('requires the proof to carry the same operation binding', () => {
    const proof: ConfirmationProof = {
      challengeId: 'challenge-1' as ConfirmationProof['challengeId'],
      operationId: 'operation-1' as ConfirmationProof['operationId'],
      operationDigest: 'sha256:digest',
      confirmedAt: '2026-09-07T00:01:00.000Z',
    }
    expect(proof.operationId).toBe('operation-1')
    expect(proof.operationDigest).toBe('sha256:digest')
  })
})
