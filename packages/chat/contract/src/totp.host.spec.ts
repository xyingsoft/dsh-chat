import { describe, expect, it } from 'vitest'

import { DEFAULT_TOTP_CONFIG } from './totp.js'

describe('TOTP contract profile', () => {
  it('defines the single P0 default interoperability profile', () => {
    expect(DEFAULT_TOTP_CONFIG).toEqual({
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      toleranceSteps: 1,
    })
  })

  it('is immutable at runtime', () => {
    expect(Object.isFrozen(DEFAULT_TOTP_CONFIG)).toBe(true)
  })
})
