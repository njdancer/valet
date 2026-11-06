import { CredentialError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { FakeCredentialProvider } from '../src/fake'

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error.failure
    throw error
  }
  throw new Error('expected a CredentialError')
}

describe('FakeCredentialProvider', () => {
  it('resolves fields of items it holds', async () => {
    const provider = new FakeCredentialProvider({
      items: { 'fake://woolworths': { username: 'nick@example.com', password: 'canary-pw' } },
    })
    expect(provider.kind).toBe('fake')
    expect((await provider.resolve('fake://woolworths', 'username')).reveal((p) => p)).toBe(
      'nick@example.com',
    )
    expect((await provider.resolve('fake://woolworths', 'password')).reveal((p) => p)).toBe('canary-pw')
  })

  it('hands out a fresh value each time, so disposing one does not break the next', async () => {
    const provider = new FakeCredentialProvider({ items: { item: { password: 'canary-pw' } } })
    const first = await provider.resolve('item', 'password')
    first.dispose()
    expect((await provider.resolve('item', 'password')).reveal((p) => p)).toBe('canary-pw')
  })

  it('reports an unknown item as not-found and a missing field as field-missing', async () => {
    const provider = new FakeCredentialProvider({ items: { item: { password: 'canary-pw' } } })
    expect(await failureOf(provider.resolve('other', 'password'))).toBe('not-found')
    expect(await failureOf(provider.resolve('item', 'otp'))).toBe('field-missing')
  })

  it('fails the way it is told to for an item', async () => {
    const provider = new FakeCredentialProvider({
      items: { item: { password: 'canary-pw' } },
      failures: { item: 'locked' },
    })
    expect(await failureOf(provider.resolve('item', 'password'))).toBe('locked')
  })

  it('records what was asked for, failures included', async () => {
    const provider = new FakeCredentialProvider()
    await failureOf(provider.resolve('item', 'otp'))
    expect(provider.requests).toEqual([{ itemRef: 'item', field: 'otp' }])
  })
})
