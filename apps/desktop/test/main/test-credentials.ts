// Credentials for the main-process tests: the fake site's account behind the in-memory test provider
// (FakeCredentialProvider), and Messages codes from `otp`. What demo mode used before it ran Valet's
// real 1Password wiring over the fake 1Password (src/main/core/demo.ts); kept here because these
// tests are about the service, not about 1Password.

import { CredentialError, type OtpReader } from '@valet/core'
import { FakeCredentialProvider } from '@valet/credentials'
import type { Credentials } from '../../src/main/core/credentials'
import { DEMO_ACCOUNT } from '../../src/main/core/demo'
import type { VaultItem } from '../../src/shared/api'

export const TEST_ITEM: VaultItem = { id: 'demo-woolworths', title: 'Woolworths (demo account)' }

export function testCredentials(otp: OtpReader): Credentials {
  const fake = new FakeCredentialProvider({
    items: { [TEST_ITEM.id]: { username: DEMO_ACCOUNT.username, password: DEMO_ACCOUNT.password } },
  })
  return {
    providers: () => ({ fake }),
    otpReader: () => otp,
    async status() {
      return [
        { kind: 'fake', available: true, unavailableReason: null },
        { kind: 'onepassword-service-account', available: false, unavailableReason: 'disabled' },
        { kind: 'onepassword-cli', available: false, unavailableReason: 'disabled' },
        { kind: 'messages', available: true, unavailableReason: null },
      ]
    },
    async vaultItems(provider) {
      return provider === 'fake' ? [TEST_ITEM] : []
    },
    async configure() {},
    copyItem: () => Promise.reject(new CredentialError('unavailable')),
    async refreshCopies() {},
    async forgetCopy() {},
    erase: async () => [],
  }
}
