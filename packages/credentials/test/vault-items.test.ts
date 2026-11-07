import { inspect } from 'node:util'
import { CredentialError, SecretValue, type TokenSource } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { OnePasswordCliProvider } from '../src/onepassword-cli'
import {
  type ItemStateFilter,
  OnePasswordServiceAccountProvider,
  type SecretsClient,
} from '../src/onepassword-sdk'
import { isVaultName, MAX_VAULT_ITEMS, parseOpItemList, summariseItems } from '../src/vault-items'
import { ManualTimers, scriptedSpawner } from './fake-process'

const OP_PATH = '/opt/homebrew/bin/op'
const FOUND = { searchPath: null, isExecutable: async (path: string) => path === OP_PATH }
const TOKEN = 'ops_canary-token-list-5c19'
const FIELD_CANARY = 'canary-field-value-e03b'
const VAULT = 'valet'
const VAULT_ID = 'vaultid000000000000000001'
const ITEM_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
const ITEM_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

function rendered(value: unknown): string {
  return [inspect(value, { depth: 10 }), JSON.stringify(value), String(value)].join('\n')
}

class CountingTokenSource implements TokenSource {
  handedOut: SecretValue[] = []
  async token(): Promise<SecretValue> {
    const token = SecretValue.fromString(TOKEN)
    this.handedOut.push(token)
    return token
  }
}

interface ListingClient {
  client: SecretsClient
  itemCalls: { vaultId: string; filters: ItemStateFilter[] }[]
  resolves: string[]
}

function listingClient(
  vaults: () => Promise<readonly unknown[]>,
  items: (vaultId: string) => Promise<readonly unknown[]>,
): ListingClient {
  const itemCalls: ListingClient['itemCalls'] = []
  const resolves: string[] = []
  return {
    itemCalls,
    resolves,
    client: {
      secrets: {
        resolve: async (reference) => {
          resolves.push(reference)
          return FIELD_CANARY
        },
      },
      vaults: { list: vaults as SecretsClient['vaults']['list'] },
      items: {
        list: ((vaultId: string, ...filters: ItemStateFilter[]) => {
          itemCalls.push({ vaultId, filters })
          return items(vaultId)
        }) as SecretsClient['items']['list'],
      },
    },
  }
}

// What the SDK's ItemOverview carries, with a canary in every field that isn't id or title.
function overview(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    category: 'Login',
    vaultId: VAULT_ID,
    websites: [
      { url: `https://${FIELD_CANARY}.test`, label: FIELD_CANARY, autofillBehavior: 'AnywhereOnWebsite' },
    ],
    tags: [FIELD_CANARY],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    state: 'active',
  }
}

describe('summariseItems', () => {
  it('keeps only id and title', () => {
    expect(
      summariseItems([overview(ITEM_A, 'Woolworths'), { ...overview(ITEM_B, 'Coles'), password: 'x' }]),
    ).toEqual([
      { id: ITEM_A, title: 'Woolworths' },
      { id: ITEM_B, title: 'Coles' },
    ])
  })

  it('drops entries whose id could add a segment or query to a reference, or has no title', () => {
    expect(
      summariseItems([
        { id: 'a/b', title: 'x' },
        { id: 'a?attribute=otp', title: 'x' },
        { id: '', title: 'x' },
        { id: 'a'.repeat(65), title: 'x' },
        { id: 7, title: 'x' },
        { id: ITEM_A },
        { id: ITEM_A, title: 7 },
        null,
        'item',
        42,
        { id: ITEM_B, title: 'kept' },
      ]),
    ).toEqual([{ id: ITEM_B, title: 'kept' }])
  })

  it('removes control and bidi characters from titles and cuts them at 200 code points', () => {
    const [item] = summariseItems([{ id: ITEM_A, title: 'Wool‮worths\u0000\n' }])
    expect(item?.title).toBe('Woolworths')
    const [long] = summariseItems([{ id: ITEM_A, title: `${'a'.repeat(199)}😀😀` }])
    expect([...(long?.title ?? '')]).toHaveLength(200)
    expect(long?.title.endsWith('😀')).toBe(true)
  })

  it('skips an entry whose getters throw, and anything that is not an array', () => {
    const hostile = {
      get id(): string {
        throw new Error('boom')
      },
    }
    expect(summariseItems([hostile, { id: ITEM_A, title: 'ok' }])).toEqual([{ id: ITEM_A, title: 'ok' }])
    expect(summariseItems({ id: ITEM_A, title: 'x' })).toEqual([])
    expect(summariseItems(null)).toEqual([])
  })

  it('stops at MAX_VAULT_ITEMS', () => {
    const many = Array.from({ length: MAX_VAULT_ITEMS + 5 }, () => ({ id: ITEM_A, title: 't' }))
    expect(summariseItems(many)).toHaveLength(MAX_VAULT_ITEMS)
  })
})

describe('parseOpItemList', () => {
  it('parses op item list --format json', () => {
    const stdout = JSON.stringify([
      {
        id: ITEM_A,
        title: 'Woolworths',
        version: 3,
        vault: { id: VAULT_ID, name: VAULT },
        category: 'LOGIN',
      },
    ])
    expect(parseOpItemList(stdout)).toEqual([{ id: ITEM_A, title: 'Woolworths' }])
    expect(parseOpItemList('[]')).toEqual([])
  })

  it('returns null for output that is not a JSON array', () => {
    expect(parseOpItemList('not json')).toBeNull()
    expect(parseOpItemList('{"id":"x"}')).toBeNull()
    expect(parseOpItemList('')).toBeNull()
  })
})

describe('isVaultName', () => {
  it('accepts names and ids, and refuses anything that could reshape an argument or reference', () => {
    expect(isVaultName(VAULT)).toBe(true)
    expect(isVaultName('Shared Logins')).toBe(true)
    for (const bad of ['', '-vault', '--format=table', 'a/b', 'a?b', ' padded', 'x\n']) {
      expect([bad, isVaultName(bad)]).toEqual([bad, false])
    }
  })
})

describe('OnePasswordCliProvider.listItems', () => {
  it('runs op item list for the vault by absolute path and returns ids and titles', async () => {
    const stdout = JSON.stringify([
      {
        id: ITEM_A,
        title: 'Woolworths',
        urls: [{ href: FIELD_CANARY }],
        additional_information: FIELD_CANARY,
      },
    ])
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, stdout))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    const items = await provider.listItems(VAULT)
    expect(items).toEqual([{ id: ITEM_A, title: 'Woolworths' }])
    expect(rendered(items)).not.toContain(FIELD_CANARY)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(OP_PATH)
    expect(calls[0]?.args).toEqual(['item', 'list', '--vault', VAULT, '--format', 'json'])
  })

  it('refuses a vault name that is not a valid name without running op', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, '[]'))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    for (const bad of ['--account=evil', 'a/b', '']) {
      expect((await failureOf(provider.listItems(bad))).failure).toBe('not-found')
    }
    expect(calls).toHaveLength(0)
  })

  it('reports no op as unavailable', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, '[]'))
    const provider = new OnePasswordCliProvider({
      searchPath: null,
      isExecutable: async () => false,
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })

  it('maps op failures: locked, missing vault, and a field complaint as unavailable', async () => {
    const cases: [string, CredentialError['failure']][] = [
      ['[ERROR] 2026/11/07 authorization prompt dismissed, please try again', 'locked'],
      [`[ERROR] "${VAULT}" isn't a vault in this account`, 'not-found'],
      ['[ERROR] no field matched', 'unavailable'],
      ['[ERROR] something else', 'unavailable'],
    ]
    for (const [stderr, failure] of cases) {
      const { spawner } = scriptedSpawner((child) => child.finish(1, '', stderr))
      const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
      expect([stderr, (await failureOf(provider.listItems(VAULT))).failure]).toEqual([stderr, failure])
    }
  })

  it('does not let the vault name steer the classification', async () => {
    // A vault called "locked" would otherwise make every failure look like a locked app.
    const { spawner } = scriptedSpawner((child) => child.finish(1, '', '[ERROR] locked: unknown error'))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.listItems('locked'))).failure).toBe('unavailable')
  })

  it('reports output that is not a JSON array as unavailable', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, 'oops, not json'))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
  })

  it('reports a listing that never answers as locked after the timeout', async () => {
    const timers = new ManualTimers()
    const { spawner, calls } = scriptedSpawner(() => {})
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers, timeoutMs: 7_000 })
    const pending = provider.listItems(VAULT)
    await vi.waitFor(() => expect(timers.pending.size).toBe(1))
    expect([...timers.pending.values()][0]?.ms).toBe(7_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('locked')
    expect(calls[0]?.child.kills.length).toBeGreaterThan(0)
  })

  it('looks for op again after it disappears, and reports a spawn failure as unavailable', async () => {
    let attempt = 0
    const { spawner, calls } = scriptedSpawner((child) => {
      attempt += 1
      queueMicrotask(() => {
        if (attempt === 1) child.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' }))
        else if (attempt === 2) child.emit('error', new Error('EACCES'))
        else child.finish(0, '[]')
      })
    })
    const checked: string[] = []
    const provider = new OnePasswordCliProvider({
      searchPath: null,
      isExecutable: async (path) => {
        checked.push(path)
        return path === OP_PATH
      },
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
    expect(await provider.listItems(VAULT)).toEqual([])
    expect(calls).toHaveLength(3)
    expect(checked.filter((path) => path === OP_PATH)).toHaveLength(2)
  })

  it('reports output past 4 MiB as unavailable', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, `[${' '.repeat(4 * 1024 * 1024)}]`))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
  })
})

describe('OnePasswordServiceAccountProvider.listItems', () => {
  it('finds the vault by title, lists its active items, and returns only ids and titles', async () => {
    const { client, itemCalls, resolves } = listingClient(
      async () => [
        { id: 'othervault', title: 'Private' },
        { id: VAULT_ID, title: VAULT },
      ],
      async () => [overview(ITEM_A, 'Woolworths'), overview(ITEM_B, 'Coles')],
    )
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    const items = await provider.listItems(VAULT)
    expect(items).toEqual([
      { id: ITEM_A, title: 'Woolworths' },
      { id: ITEM_B, title: 'Coles' },
    ])
    expect(rendered(items)).not.toContain(FIELD_CANARY)
    expect(itemCalls).toEqual([
      { vaultId: VAULT_ID, filters: [{ type: 'ByState', content: { active: true, archived: false } }] },
    ])
    // Listing never resolves a field.
    expect(resolves).toEqual([])
  })

  it('finds the vault by id too', async () => {
    const { client, itemCalls } = listingClient(
      async () => [{ id: VAULT_ID, title: 'Something else' }],
      async () => [],
    )
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    expect(await provider.listItems(VAULT_ID)).toEqual([])
    expect(itemCalls[0]?.vaultId).toBe(VAULT_ID)
  })

  it('reports no matching vault, or more than one, as not-found without listing items', async () => {
    for (const vaults of [
      [],
      [{ id: 'x1', title: 'Other' }],
      [
        { id: 'x1', title: VAULT },
        { id: 'x2', title: VAULT },
      ],
      [{ id: 7, title: VAULT }],
      [null, undefined],
    ]) {
      const { client, itemCalls } = listingClient(
        async () => vaults,
        async () => [],
      )
      const provider = new OnePasswordServiceAccountProvider({
        tokenSource: new CountingTokenSource(),
        clientFactory: async () => client,
        timers: new ManualTimers(),
      })
      expect((await failureOf(provider.listItems(VAULT))).failure).toBe('not-found')
      expect(itemCalls).toEqual([])
    }
  })

  it('refuses a malformed vault name without creating a client', async () => {
    const factory = vi.fn()
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.listItems('a/b'))).failure).toBe('not-found')
    expect(factory).not.toHaveBeenCalled()
  })

  it('shares one client with resolve, so the token is handed to the factory once and disposed', async () => {
    const tokens = new CountingTokenSource()
    const { client } = listingClient(
      async () => [{ id: VAULT_ID, title: VAULT }],
      async () => [overview(ITEM_A, 'Woolworths')],
    )
    const factory = vi.fn(async (_token: SecretValue) => client)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: tokens,
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    await provider.listItems(VAULT)
    await provider.resolve(`op://${VAULT}/${ITEM_A}`, 'password')
    await provider.listItems(VAULT)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(tokens.handedOut).toHaveLength(1)
    expect(tokens.handedOut[0]?.disposed).toBe(true)
  })

  it('drops the client on an auth error and builds a fresh one next time', async () => {
    let calls = 0
    const { client } = listingClient(
      async () => {
        calls += 1
        if (calls === 1)
          throw new Error('invalid service account token, please make sure you provide a valid one')
        return [{ id: VAULT_ID, title: VAULT }]
      },
      async () => [],
    )
    const factory = vi.fn(async () => client)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
    expect(await provider.listItems(VAULT)).toEqual([])
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('maps SDK errors: permissions as not-found, a field complaint and anything else as unavailable', async () => {
    const cases: [unknown, CredentialError['failure']][] = [
      [new Error("you don't have the right permissions to access this resource"), 'not-found'],
      [new Error('the specified field cannot be found within the item'), 'unavailable'],
      [new Error('rate limit exceeded'), 'unavailable'],
      [Object.create(null), 'unavailable'],
    ]
    for (const [thrown, failure] of cases) {
      const { client } = listingClient(
        async () => [{ id: VAULT_ID, title: VAULT }],
        () => Promise.reject(thrown),
      )
      const provider = new OnePasswordServiceAccountProvider({
        tokenSource: new CountingTokenSource(),
        clientFactory: async () => client,
        timers: new ManualTimers(),
      })
      expect((await failureOf(provider.listItems(VAULT))).failure).toBe(failure)
    }
  })

  it('passes a locked token source through, re-created', async () => {
    const original = new CredentialError('locked')
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: {
        token: async () => {
          throw original
        },
      },
      clientFactory: vi.fn(),
      timers: new ManualTimers(),
    })
    const error = await failureOf(provider.listItems(VAULT))
    expect(error.failure).toBe('locked')
    expect(error).not.toBe(original)
  })

  it('reports a non-array answer as unavailable', async () => {
    for (const answer of [{ items: [] }, null]) {
      const { client } = listingClient(
        async () => [{ id: VAULT_ID, title: VAULT }],
        async () => answer as unknown as unknown[],
      )
      const provider = new OnePasswordServiceAccountProvider({
        tokenSource: new CountingTokenSource(),
        clientFactory: async () => client,
        timers: new ManualTimers(),
      })
      expect((await failureOf(provider.listItems(VAULT))).failure).toBe('unavailable')
    }
    const { client } = listingClient(
      async () => ({ vaults: [] }) as unknown as unknown[],
      async () => [],
    )
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.listItems(VAULT))).failure).toBe('not-found')
  })

  it('reports a listing that never answers as unavailable after the timeout', async () => {
    const timers = new ManualTimers()
    const { client } = listingClient(
      async () => [{ id: VAULT_ID, title: VAULT }],
      () => new Promise<never>(() => {}),
    )
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers,
      timeoutMs: 4_000,
    })
    const pending = provider.listItems(VAULT)
    await vi.waitFor(() => expect(timers.pending.size).toBe(1))
    expect([...timers.pending.values()][0]?.ms).toBe(4_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('unavailable')
  })

  it('keeps the token, the SDK message and item contents out of errors', async () => {
    const { client } = listingClient(
      async () => [{ id: VAULT_ID, title: VAULT }],
      () => Promise.reject(new Error(`listing failed for ${TOKEN}: ${FIELD_CANARY}`)),
    )
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    const error = await failureOf(provider.listItems(VAULT))
    const text = [rendered(error), String(error.stack)].join('\n')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(FIELD_CANARY)
    expect(text).not.toContain('listing failed')
  })
})
