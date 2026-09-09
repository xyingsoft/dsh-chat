/** Runtime boundary for encrypted secret management. */

import type { TotpSecretEnvelope } from './totp.js'

export interface SecretKeyHandle {
  readonly keyId: string
  /** Opaque provider-owned handle; never serialized into API responses. */
  readonly handle: string
}

export interface SecretKeyProvider {
  /** Resolve a key by ID without exposing the key to business handlers. */
  resolve(keyId: string): Promise<SecretKeyHandle | undefined>
  encrypt(plaintext: Uint8Array, aad: string): Promise<TotpSecretEnvelope>
  decrypt(envelope: TotpSecretEnvelope, aad: string): Promise<Uint8Array>
  /** Explicit lifecycle hook for key rotation/shutdown. */
  close(): Promise<void>
}
