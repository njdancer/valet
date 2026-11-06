import { inspect } from 'node:util'
import {
  CredentialError,
  type CredentialProvider,
  type Grant,
  SecretValue,
  SiteAdapterError,
} from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { FakeCredentialProvider } from '../src/fake'
import { CredentialResolver } from '../src/resolver'

const CANARY = 'canary-pw-c0ffee42'

const grant: Grant = {
  adapterId: 'woolworths',
  adapterHash: 'a'.repeat(64),
  secret: 'login',
  provider: 'fake',
  itemRef: 'fake://woolworths',
  origins: ['https://www.woolworths.com.au'],
  grantedAt: '2026-11-07T00:00:00.000Z',
}

async function errorOf(promise: Promise<unknown>): Promise<SiteAdapterError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SiteAdapterError) return error
    throw error
  }
  throw new Error('expected a SiteAdapterError')
}

describe('CredentialResolver', () => {
  it('refuses a provider for messages grants, which only the OtpReader reads', () => {
    const impostor: CredentialProvider = {
      kind: 'messages',
      resolve: async () => SecretValue.fromString(CANARY),
    }
    expect(() => new CredentialResolver([impostor])).toThrow()
  })

  it('reports a messages grant as unavailable rather than resolving it', async () => {
    const resolver = new CredentialResolver([new FakeCredentialProvider()])
    const messagesGrant: Grant = { ...grant, secret: 'messages', provider: 'messages', itemRef: 'Woolworths' }
    const error = await errorOf(resolver.resolve(messagesGrant, 'otp'))
    expect([error.stage, error.errorClass]).toEqual(['credential', 'unavailable'])
  })

  it('resolves through the provider the grant names, with the grant item ref', async () => {
    const fake = new FakeCredentialProvider({ items: { 'fake://woolworths': { password: CANARY } } })
    const resolver = new CredentialResolver([fake])
    const secret = await resolver.resolve(grant, 'password')
    expect(secret.reveal((p) => p)).toBe(CANARY)
    expect(fake.requests).toEqual([{ itemRef: 'fake://woolworths', field: 'password' }])
  })

  it('never falls back to another provider when the named one is missing', async () => {
    const fake = new FakeCredentialProvider({
      items: { 'op://siteadapter/Woolworths': { password: CANARY } },
    })
    const resolver = new CredentialResolver([fake])
    const error = await errorOf(resolver.resolve({ ...grant, provider: 'onepassword-cli' }, 'password'))
    expect([error.stage, error.errorClass]).toEqual(['credential', 'unavailable'])
    expect(fake.requests).toEqual([])
  })

  it('refuses two providers of the same kind', () => {
    expect(
      () => new CredentialResolver([new FakeCredentialProvider(), new FakeCredentialProvider()]),
    ).toThrow('two credential providers of kind fake')
  })

  it('turns each provider failure into a credential-stage error of the same class', async () => {
    for (const failure of ['locked', 'not-found', 'field-missing', 'unavailable'] as const) {
      const resolver = new CredentialResolver([
        new FakeCredentialProvider({ failures: { [grant.itemRef]: failure } }),
      ])
      const error = await errorOf(resolver.resolve(grant, 'password'))
      expect([error.stage, error.errorClass]).toEqual(['credential', failure])
    }
  })

  it('turns anything else a provider throws into unavailable, dropping its message', async () => {
    const leaky: CredentialProvider = {
      kind: 'fake',
      resolve: async () => {
        throw new Error(`could not read ${CANARY}`)
      },
    }
    const error = await errorOf(new CredentialResolver([leaky]).resolve(grant, 'password'))
    expect([error.stage, error.errorClass]).toEqual(['credential', 'unavailable'])
    expect(
      [error.message, String(error.stack), inspect(error), JSON.stringify(error)].join('\n'),
    ).not.toContain(CANARY)
  })

  it('does not let a forged failure class through', async () => {
    const forging: CredentialProvider = {
      kind: 'fake',
      resolve: async () => {
        throw new CredentialError(CANARY as never)
      },
    }
    const error = await errorOf(new CredentialResolver([forging]).resolve(grant, 'password'))
    expect(error.errorClass).toBe('unavailable')
    expect(error.message).not.toContain(CANARY)
  })

  it('refuses a provider that returns a bare string instead of a SecretValue', async () => {
    const careless: CredentialProvider = {
      kind: 'fake',
      resolve: async () => CANARY as unknown as SecretValue,
    }
    const error = await errorOf(new CredentialResolver([careless]).resolve(grant, 'password'))
    expect([error.stage, error.errorClass]).toEqual(['credential', 'internal'])
    expect(error.message).not.toContain(CANARY)
  })

  it('passes the SecretValue through untouched', async () => {
    const value = SecretValue.fromString(CANARY)
    const provider: CredentialProvider = { kind: 'fake', resolve: async () => value }
    expect(await new CredentialResolver([provider]).resolve(grant, 'otp')).toBe(value)
  })
})
