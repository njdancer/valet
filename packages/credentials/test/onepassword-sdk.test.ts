import { inspect } from 'node:util'
import { CredentialError, SecretValue, type TokenSource } from '@siteadapter/core'
import { describe, expect, it, vi } from 'vitest'
import {
  classifySdkError,
  OnePasswordServiceAccountProvider,
  type SecretsClient,
  sdkClientFactory,
} from '../src/onepassword-sdk'
import { ManualTimers } from './fake-process'

// The real SDK loads a WebAssembly core; tests only check what the factory hands it.
vi.mock('@1password/sdk', () => ({
  createClient: vi.fn(async (config: unknown) => ({ config, secrets: { resolve: async () => 'x' } })),
}))

const CANARY = 'canary-pw-0b9d4e17'
const TOKEN = 'ops_canary-token-77aa31'
const ITEM = 'op://siteadapter/Woolworths'

class CountingTokenSource implements TokenSource {
  handedOut: SecretValue[] = []
  async token(): Promise<SecretValue> {
    const token = SecretValue.fromString(TOKEN)
    this.handedOut.push(token)
    return token
  }
}

// SDK errors are matched by class name, so the fakes reuse the SDK's names.
class AuthExpiredError extends Error {}
class DesktopSessionExpiredError extends Error {}
class RateLimitExceededError extends Error {}

function recordingClient(answer: (reference: string) => Promise<string>): {
  client: SecretsClient
  references: string[]
} {
  const references: string[] = []
  return {
    references,
    client: {
      secrets: {
        resolve: (reference) => {
          references.push(reference)
          return answer(reference)
        },
      },
      vaults: { list: () => Promise.reject(new Error('not used here')) },
      items: { list: () => Promise.reject(new Error('not used here')) },
    },
  }
}

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

describe('OnePasswordServiceAccountProvider', () => {
  it('resolves op://vault/item/field through the client', async () => {
    const { client, references } = recordingClient(async () => CANARY)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    const secret = await provider.resolve(ITEM, 'password')
    expect(secret.reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(references).toEqual(['op://siteadapter/Woolworths/password'])
    expect(provider.kind).toBe('onepassword-service-account')
  })

  it('asks the SDK for TOTP codes with attribute=totp', async () => {
    const { client, references } = recordingClient(async () => '123456')
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'otp')
    await provider.resolve(ITEM, 'username')
    expect(references).toEqual([
      'op://siteadapter/Woolworths/one-time password?attribute=totp',
      'op://siteadapter/Woolworths/username',
    ])
  })

  it('creates the client lazily, once, and disposes the token after creating it', async () => {
    const tokens = new CountingTokenSource()
    const seen: string[] = []
    const { client } = recordingClient(async () => CANARY)
    const factory = vi.fn(async (token: SecretValue) => {
      seen.push(token.reveal((plaintext) => plaintext))
      return client
    })
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: tokens,
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect(factory).not.toHaveBeenCalled()
    await Promise.all([provider.resolve(ITEM, 'password'), provider.resolve(ITEM, 'username')])
    await provider.resolve(ITEM, 'password')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([TOKEN])
    expect(tokens.handedOut).toHaveLength(1)
    expect(tokens.handedOut[0]?.disposed).toBe(true)
  })

  it('rejects a malformed item reference as not-found without creating a client', async () => {
    const factory = vi.fn()
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    for (const bad of ['op://siteadapter/Woolworths/password', 'op://v/i?attribute=otp', 'x']) {
      expect((await failureOf(provider.resolve(bad, 'password'))).failure).toBe('not-found')
    }
    expect(factory).not.toHaveBeenCalled()
  })

  it('drops the client on an auth error and builds a fresh one next time', async () => {
    const tokens = new CountingTokenSource()
    let calls = 0
    const { client } = recordingClient(async () => {
      calls += 1
      if (calls === 1) throw new AuthExpiredError('auth expired')
      return CANARY
    })
    const factory = vi.fn(async () => client)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: tokens,
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    await provider.resolve(ITEM, 'password')
    expect(factory).toHaveBeenCalledTimes(2)
    expect(tokens.handedOut.every((token) => token.disposed)).toBe(true)
  })

  it('keeps the client after a not-found', async () => {
    const { client } = recordingClient(async () => {
      throw new Error('error resolving secret reference: no item matched the secret reference query')
    })
    const factory = vi.fn(async () => client)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('not-found')
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('not-found')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('does not cache a client that failed to come up', async () => {
    const tokens = new CountingTokenSource()
    const { client } = recordingClient(async () => CANARY)
    const factory = vi
      .fn<(token: SecretValue) => Promise<SecretsClient>>()
      .mockRejectedValueOnce(
        new Error('invalid service account token, please make sure you provide a valid token'),
      )
      .mockResolvedValueOnce(client)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: tokens,
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    expect((await provider.resolve(ITEM, 'password')).reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(tokens.handedOut.every((token) => token.disposed)).toBe(true)
  })

  it('passes a token source failure through and retries the token next time', async () => {
    const { client } = recordingClient(async () => CANARY)
    let attempts = 0
    const tokenSource: TokenSource = {
      token: async () => {
        attempts += 1
        if (attempts === 1) throw new CredentialError('locked')
        return SecretValue.fromString(TOKEN)
      },
    }
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource,
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('locked')
    await provider.resolve(ITEM, 'password')
    expect(attempts).toBe(2)
  })

  it('reports a resolve that never answers as unavailable after the timeout', async () => {
    const timers = new ManualTimers()
    const { client } = recordingClient(() => new Promise<string>(() => {}))
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers,
      timeoutMs: 5_000,
    })
    const pending = provider.resolve(ITEM, 'password')
    await vi.waitFor(() => expect(timers.pending.size).toBe(1))
    expect([...timers.pending.values()][0]?.ms).toBe(5_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('unavailable')
  })

  it('reports a client factory that never answers as unavailable, by default after 30 seconds', async () => {
    const timers = new ManualTimers()
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: () => new Promise<SecretsClient>(() => {}),
      timers,
    })
    const pending = provider.resolve(ITEM, 'password')
    await vi.waitFor(() => expect(timers.pending.size).toBe(1))
    expect([...timers.pending.values()][0]?.ms).toBe(30_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('unavailable')
  })

  it('reports an empty value as field-missing', async () => {
    const { client } = recordingClient(async () => '')
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'otp'))).failure).toBe('field-missing')
  })

  it('keeps the secret, the token and the SDK message out of errors', async () => {
    const { client } = recordingClient(async () => {
      throw new Error(`error resolving secret reference: ${CANARY} ${TOKEN} no item matched`)
    })
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
      timers: new ManualTimers(),
    })
    const error = await failureOf(provider.resolve(ITEM, 'password'))
    const rendered = [error.message, String(error.stack), inspect(error), JSON.stringify(error)].join('\n')
    expect(rendered).not.toContain(CANARY)
    expect(rendered).not.toContain(TOKEN)
    expect(rendered).not.toContain('resolving')
  })

  it('reports a missing service-account token as unavailable, not as a missing item', async () => {
    // The Keychain has no token: the account isn't set up. Calling that not-found would tell the
    // person their 1Password item is gone and send them to re-grant it.
    const factory = vi.fn()
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: {
        token: async () => {
          throw new CredentialError('not-found')
        },
      },
      clientFactory: factory,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    expect(factory).not.toHaveBeenCalled()
  })

  it('reports any other token source failure as unavailable, and a field-missing one too', async () => {
    for (const thrown of [new CredentialError('field-missing'), new Error('not found'), 'x']) {
      const provider = new OnePasswordServiceAccountProvider({
        tokenSource: {
          token: async () => {
            throw thrown
          },
        },
        clientFactory: vi.fn(),
        timers: new ManualTimers(),
      })
      expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    }
  })

  it('rejects with a CredentialError when the SDK throws something with no prototype', async () => {
    for (const thrown of [Object.create(null), 42, undefined]) {
      const provider = new OnePasswordServiceAccountProvider({
        tokenSource: new CountingTokenSource(),
        clientFactory: async () => recordingClient(() => Promise.reject(thrown)).client,
        timers: new ManualTimers(),
      })
      expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    }
  })

  it('re-creates a token source CredentialError rather than passing the original object on', async () => {
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
    const error = await failureOf(provider.resolve(ITEM, 'password'))
    expect(error).not.toBe(original)
    expect(error.failure).toBe('locked')
  })

  it('uses the real timers by default', async () => {
    const { client } = recordingClient(async () => CANARY)
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: new CountingTokenSource(),
      clientFactory: async () => client,
    })
    expect((await provider.resolve(ITEM, 'password')).reveal((plaintext) => plaintext)).toBe(CANARY)
  })
})

describe('classifySdkError', () => {
  it('drops the client and reports locked when the desktop session expired', () => {
    expect(classifySdkError(new DesktopSessionExpiredError('desktop session expired'))).toEqual({
      failure: 'locked',
      dropClient: true,
    })
  })

  it('drops the client on auth failures', () => {
    for (const error of [
      new AuthExpiredError('whatever'),
      new Error('invalid service account token, please make sure you provide a valid service account token'),
      new Error('bad service account token, please rotate it: x'),
      new Error('service account token base64 decoding failed, please create another token'),
      new Error('service account deserialization failed, please create another token'),
      new Error('you are not authenticated'),
    ]) {
      expect([error.message, classifySdkError(error)]).toEqual([
        error.message,
        { failure: 'unavailable', dropClient: true },
      ])
    }
  })

  it('maps missing fields', () => {
    for (const message of [
      'error resolving secret reference: the specified field cannot be found within the item',
      'error resolving secret reference: no section matched the secret reference',
      'error resolving secret reference: more than one field matched the secret reference',
      'error resolving secret reference: TOTP attribute can only be applied to TOTP-type fields',
      'error resolving secret reference: TOTP code could not be generated: x',
    ]) {
      expect([message, classifySdkError(new Error(message))]).toEqual([
        message,
        { failure: 'field-missing', dropClient: false },
      ])
    }
  })

  it('maps missing vaults and items, including ones the account cannot see', () => {
    for (const message of [
      'error resolving secret reference: no vault matched the secret reference query',
      'error resolving secret reference: no item matched the secret reference query',
      'error resolving secret reference: more than one item matched the secret reference query',
      'error resolving secret reference: item is not in an active state',
      'resource not found',
      "you don't have the right permissions to access this resource",
      'the secret reference could not be parsed: secret reference is not prefixed with "op://"',
      'invalid character in secret reference: secret references must only contain alphanumeric',
    ]) {
      expect([message, classifySdkError(new Error(message))]).toEqual([
        message,
        { failure: 'not-found', dropClient: false },
      ])
    }
  })

  it('classifies values that cannot be stringified or inspected without throwing', () => {
    const throwingGetter = {
      get constructor(): never {
        throw new Error('no constructor')
      },
    }
    const badMessage = Object.assign(new Error('x'), { message: 7 })
    for (const error of [Object.create(null), throwingGetter, badMessage, 42, Symbol('s')]) {
      expect(classifySdkError(error)).toEqual({ failure: 'unavailable', dropClient: false })
    }
  })

  it('reports rate limits, network failures and non-errors as unavailable without dropping', () => {
    for (const error of [
      new RateLimitExceededError('rate limit exceeded'),
      new Error('request timeout'),
      'x',
      null,
    ]) {
      expect(classifySdkError(error)).toEqual({ failure: 'unavailable', dropClient: false })
    }
  })
})

describe('sdkClientFactory', () => {
  it('hands the revealed token to createClient with the integration name', async () => {
    const sdk = await import('@1password/sdk')
    const client = (await sdkClientFactory(SecretValue.fromString(TOKEN))) as unknown as { config: unknown }
    expect(sdk.createClient).toHaveBeenCalledTimes(1)
    expect(client.config).toEqual({
      auth: TOKEN,
      integrationName: 'siteadapter',
      integrationVersion: '0.0.0',
    })
  })
})
