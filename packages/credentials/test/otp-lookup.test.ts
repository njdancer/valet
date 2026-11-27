import { type Grant, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { messagesQueryFor } from '../src/otp-lookup'

const WOOLWORTHS = { sender: 'Woolworths', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 }
// The person approved codes from Woolworths, to be typed on its auth origin.
const WOOLWORTHS_GRANT: Grant = {
  adapterId: 'woolworths',
  adapterHash: 'a'.repeat(64),
  secret: 'messages',
  provider: 'messages',
  itemRef: 'Woolworths',
  origins: ['https://auth.woolworths.com.au'],
  grantedAt: '2026-11-07T00:00:00.000Z',
}

describe('messagesQueryFor', () => {
  it('builds the query from the granted sender and the source pattern and age', () => {
    const query = messagesQueryFor(WOOLWORTHS_GRANT, { ...WOOLWORTHS, sender: 'woolworths' })
    expect(query).toEqual({ sender: 'Woolworths', pattern: WOOLWORTHS.pattern, maxAgeSeconds: 300 })
  })

  it('refuses a source whose sender is not the granted one', () => {
    expect(() => messagesQueryFor(WOOLWORTHS_GRANT, { ...WOOLWORTHS, sender: '+61400000000' })).toThrow(
      new ValetError('otp', 'not-granted'),
    )
  })

  it('refuses a grant from a credential provider', () => {
    expect(() => messagesQueryFor({ ...WOOLWORTHS_GRANT, provider: 'onepassword-cli' }, WOOLWORTHS)).toThrow(
      new ValetError('otp', 'not-granted'),
    )
  })
})
