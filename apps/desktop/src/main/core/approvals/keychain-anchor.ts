// Store anchors in Valet's own Keychain items (docs/agent-run-security.md#trusted-stores), through
// the valet-keychain helper, whose items only a binary signed with Valet's Team ID reads without a
// prompt. In a dev build any process running as the person can reach them, so the anchor is only
// as strong as the evidence there (B).
//
// A read that fails for any reason but "no such item" throws: the ledger then opens locked down
// instead of reading a missing anchor as a fresh start.

import { type AnchorState, anchorStateSchema, CredentialError, type StoreAnchor } from '@valet/core'
import type { KeychainStore } from '@valet/credentials'

const SERVICE = 'valet.anchor'

export class KeychainAnchor implements StoreAnchor {
  constructor(private readonly keychain: KeychainStore) {}

  async read(store: string): Promise<AnchorState | null> {
    let text: string
    try {
      const secret = await this.keychain.read(SERVICE, store)
      try {
        text = secret.reveal((plaintext) => plaintext)
      } finally {
        secret.dispose()
      }
    } catch (error) {
      if (error instanceof CredentialError && error.failure === 'not-found') return null
      throw error
    }
    return anchorStateSchema.parse(JSON.parse(text))
  }

  async write(store: string, state: AnchorState): Promise<void> {
    const valid = anchorStateSchema.parse(state)
    await this.keychain.write(
      SERVICE,
      store,
      Buffer.from(JSON.stringify(valid), 'utf8'),
      'Valet store anchor',
    )
  }
}
