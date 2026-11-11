// The fake 1Password demo mode and the e2e suite use: Tess Tester's account, a Personal vault
// holding the fake shop's login among a few others, a Shared vault, and a "Valet" vault with a
// service account that can read only it. All test values.

import type { FakeOnePasswordOptions } from './state'

export const DEMO_ONEPASSWORD_ACCOUNT = {
  name: 'Tess Tester',
  uuid: 'TESTUSERUUID0000000000000A',
  email: 'tess@example.test',
  unlockPassword: 'keyhold-demo-unlock',
} as const

/** Vault and item ids are 26 lowercase letters and digits, like 1Password's. */
export const DEMO_VAULTS = {
  personal: { id: 'demopersonalvault000000000', title: 'Personal' },
  shared: { id: 'demosharedvault00000000000', title: 'Shared' },
  valet: { id: 'demovaletvault000000000000', title: 'Valet' },
} as const

export const DEMO_SHOP_ITEM_ID = 'demoshoplogin0000000000000'
export const DEMO_SHOP_ITEM_TITLE = 'Woolworths (demo account)'
/** A service-account token for the Valet vault. Test value. */
export const DEMO_SERVICE_ACCOUNT_TOKEN = 'ops_ZmFrZS1zZXJ2aWNlLWFjY291bnQtZm9yLXRlc3Rz'

export interface DemoLogin {
  readonly username: string
  readonly password: string
  /** The sign-in page the item autofills on. */
  readonly website?: string
}

/** The fake's state for a demo: `login` is the fake shop's test account. */
export function demoOnePassword(
  login: DemoLogin,
  overrides: Partial<FakeOnePasswordOptions> = {},
): FakeOnePasswordOptions {
  const website = login.website ?? 'https://auth.woolworths.test'
  return {
    account: DEMO_ONEPASSWORD_ACCOUNT,
    vaults: Object.values(DEMO_VAULTS),
    items: [
      {
        id: DEMO_SHOP_ITEM_ID,
        vaultId: DEMO_VAULTS.personal.id,
        title: DEMO_SHOP_ITEM_TITLE,
        username: login.username,
        password: login.password,
        websites: [website],
        updatedAt: '2026-11-01T09:30:00.000Z',
      },
      {
        id: 'demolibrarycard00000000000',
        vaultId: DEMO_VAULTS.personal.id,
        title: 'Library card',
        username: 'tess.tester',
        password: 'library-test-value',
        websites: ['https://library.example.test'],
      },
      {
        id: 'demostreaming0000000000000',
        vaultId: DEMO_VAULTS.personal.id,
        title: 'Streaming service',
        username: 'tess@example.test',
        password: 'streaming-test-value',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        websites: ['https://watch.example.test'],
      },
      {
        id: 'demohomewifi00000000000000',
        vaultId: DEMO_VAULTS.shared.id,
        title: 'Home Wi-Fi',
        password: 'wifi-test-value',
      },
      {
        id: 'demovaletshoplogin00000000',
        vaultId: DEMO_VAULTS.valet.id,
        // Its own title, so the person's own item is the only "Woolworths (demo account)".
        title: 'Woolworths',
        username: login.username,
        password: login.password,
        websites: [website],
      },
    ],
    serviceAccounts: [{ token: DEMO_SERVICE_ACCOUNT_TOKEN, vaultIds: [DEMO_VAULTS.valet.id] }],
    ...overrides,
  }
}
