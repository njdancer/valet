// A stand-in for the @1password/sdk module: createClient, DesktopAuth and the SDK's three typed
// errors, over a FakeOnePassword. Valet's own factories (credentials' serviceAccountClientFactory
// and desktopAuthClientFactory) take a module like this one, so demo mode and tests run Valet's real
// code against it. The errors carry the SDK's own messages, which Valet's classifiers match.

import { findVault, ReferenceFailed, type ReferenceFailure, resolveReference } from './references'
import {
  AuthExpiredError,
  DesktopSessionExpiredError,
  type FakeItem,
  type FakeOnePassword,
  RateLimitExceededError,
} from './state'

/** The SDK's DesktopAuth: authenticate through the desktop app, as `accountName`. */
export class DesktopAuth {
  constructor(readonly accountName: string) {}
}

export interface FakeClientConfiguration {
  readonly auth?: string | object
  readonly integrationName: string
  readonly integrationVersion: string
}

export interface ItemListFilter {
  readonly type: 'ByState'
  readonly content: { readonly active: boolean; readonly archived: boolean }
}

export interface FakeSdkClient {
  readonly secrets: { resolve(reference: string): Promise<string> }
  readonly vaults: { list(): Promise<VaultOverview[]> }
  readonly items: { list(vaultId: string, ...filters: ItemListFilter[]): Promise<ItemOverview[]> }
}

export interface VaultOverview {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly vaultType: 'userCreated'
  readonly activeItemCount: number
  readonly contentVersion: number
  readonly attributeVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ItemOverview {
  readonly id: string
  readonly title: string
  readonly category: 'Login'
  readonly vaultId: string
  readonly websites: { url: string; label: string; autofillBehavior: 'AnywhereOnWebsite' }[]
  readonly tags: string[]
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly state: 'active' | 'archived'
}

export interface FakeSdk {
  createClient(config: FakeClientConfiguration): Promise<FakeSdkClient>
  readonly DesktopAuth: typeof DesktopAuth
  readonly DesktopSessionExpiredError: typeof DesktopSessionExpiredError
  readonly AuthExpiredError: typeof AuthExpiredError
  readonly RateLimitExceededError: typeof RateLimitExceededError
}

const SDK_MESSAGES: Record<ReferenceFailure, string> = {
  'not-prefixed': 'secret reference is not prefixed with "op://"',
  'invalid-format': 'secret reference has invalid format',
  'no-vault': 'no vault matched the secret reference query',
  'no-item': 'no item matched the secret reference query',
  inactive: 'item is not in an active state',
  'no-field': 'the field cannot be found within the item',
  'bad-attribute': 'the totp attribute can only be applied to a TOTP field',
}

/** The fake SDK module for `fake`. */
export function fakeSdk(fake: FakeOnePassword): FakeSdk {
  return {
    DesktopAuth,
    DesktopSessionExpiredError,
    AuthExpiredError,
    RateLimitExceededError,
    async createClient(config) {
      if (typeof config?.integrationName !== 'string' || config.integrationName.length === 0) {
        throw new Error('invalid client configuration: integration name must be set')
      }
      const auth = config.auth
      if (auth instanceof DesktopAuth) {
        fake.record({ via: 'sdk', auth: 'desktop', op: 'createClient' })
        await fake.authorizeDesktop(
          auth.accountName,
          config.integrationName,
          String(config.integrationVersion),
          'sdk',
        )
        return client(fake, 'desktop', 'all', () => fake.useDesktop(config.integrationName))
      }
      if (typeof auth === 'string') {
        fake.record({ via: 'sdk', auth: 'service-account', op: 'createClient' })
        const account = fake.serviceAccount(auth)
        fake.meterServiceAccount(auth)
        return client(fake, 'service-account', account.vaultIds, () => fake.meterServiceAccount(auth))
      }
      throw new Error('invalid client configuration: no authentication method was given')
    },
  }
}

function client(
  fake: FakeOnePassword,
  auth: 'desktop' | 'service-account',
  vaultIds: readonly string[] | 'all',
  use: () => void,
): FakeSdkClient {
  return {
    secrets: {
      async resolve(reference) {
        use()
        fake.record({ via: 'sdk', auth, op: 'secrets.resolve', target: reference })
        try {
          return resolveReference(fake, reference, vaultIds, ['totp']).value
        } catch (error) {
          if (error instanceof ReferenceFailed) {
            throw new Error(`error resolving secret reference: ${SDK_MESSAGES[error.reason]}`)
          }
          throw error
        }
      },
    },
    vaults: {
      async list() {
        use()
        fake.record({ via: 'sdk', auth, op: 'vaults.list' })
        return fake.visibleVaults(vaultIds).map((vault) => {
          const items = fake.items.filter((i) => i.vaultId === vault.id)
          const updated = Math.max(0, ...items.map((i) => i.updatedAt.getTime()))
          return {
            id: vault.id,
            title: vault.title,
            description: '',
            vaultType: 'userCreated',
            activeItemCount: items.filter((i) => !i.archived).length,
            contentVersion: items.length + 1,
            attributeVersion: 1,
            createdAt: new Date(0),
            updatedAt: new Date(updated),
          }
        })
      },
    },
    items: {
      async list(vaultId, ...filters) {
        use()
        fake.record({ via: 'sdk', auth, op: 'items.list', target: vaultId })
        let vault: { id: string }
        try {
          vault = findVault(fake, vaultId, vaultIds)
        } catch {
          throw new Error('error listing items: resource not found')
        }
        if (vault.id !== vaultId) throw new Error('error listing items: resource not found')
        const state = filters.find((f) => f?.type === 'ByState')?.content ?? { active: true, archived: false }
        return fake.items
          .filter((i) => i.vaultId === vault.id && (i.archived ? state.archived : state.active))
          .map(overview)
      },
    },
  }
}

function overview(item: FakeItem): ItemOverview {
  return {
    id: item.id,
    title: item.title,
    category: 'Login',
    vaultId: item.vaultId,
    websites: item.websites.map((url) => ({ url, label: 'website', autofillBehavior: 'AnywhereOnWebsite' })),
    tags: [],
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
    state: item.archived ? 'archived' : 'active',
  }
}
