import { describe, expect, it } from 'vitest'

import { acceptTotpStep } from './totp-replay.js'

describe('TOTP replay gate', () => {
  it('accepts the first successful step', () => {
    expect(acceptTotpStep(null, 10n)).toEqual({ accepted: true, nextLastAcceptedStep: 10n })
  })

  it('rejects the same step and older steps', () => {
    expect(acceptTotpStep(10n, 10n)).toEqual({ accepted: false })
    expect(acceptTotpStep(10n, 9n)).toEqual({ accepted: false })
  })

  it('accepts only a strictly newer step', () => {
    expect(acceptTotpStep(10n, 11n)).toEqual({ accepted: true, nextLastAcceptedStep: 11n })
  })

  it('rejects invalid counters instead of allowing a bypass', () => {
    expect(acceptTotpStep(-1n, 0n)).toEqual({ accepted: false })
    expect(acceptTotpStep(1n, -1n)).toEqual({ accepted: false })
  })
})
