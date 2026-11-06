import { describe, expect, it } from 'vitest'
import { parseItemRef, secretReference } from '../src/item-ref'

describe('parseItemRef', () => {
  it('accepts op://<vault>/<item>', () => {
    expect(parseItemRef('op://siteadapter/Woolworths')).toEqual({ vault: 'siteadapter', item: 'Woolworths' })
  })

  it('accepts names with inner spaces, dots, dashes and parentheses, and item IDs', () => {
    expect(parseItemRef('op://Site Adapter/Woolworths (AU) v1.2-b')).toEqual({
      vault: 'Site Adapter',
      item: 'Woolworths (AU) v1.2-b',
    })
    expect(parseItemRef('op://siteadapter/kq3y7l2zjd4m5x6n7p8r9s0t1u')?.item).toBe(
      'kq3y7l2zjd4m5x6n7p8r9s0t1u',
    )
  })

  it('rejects other schemes and missing prefixes', () => {
    expect(parseItemRef('siteadapter/Woolworths')).toBeNull()
    expect(parseItemRef('OP://siteadapter/Woolworths')).toBeNull()
    expect(parseItemRef('https://siteadapter/Woolworths')).toBeNull()
  })

  it('rejects a reference that names a field, so a grant cannot pick its own field', () => {
    expect(parseItemRef('op://siteadapter/Woolworths/password')).toBeNull()
    expect(parseItemRef('op://siteadapter/Woolworths/Security/answer')).toBeNull()
  })

  it('rejects query parameters and fragments smuggled into the item', () => {
    expect(parseItemRef('op://siteadapter/Woolworths?attribute=otp')).toBeNull()
    expect(parseItemRef('op://siteadapter/Woolworths#x')).toBeNull()
  })

  it('rejects a missing vault or item', () => {
    expect(parseItemRef('op://siteadapter')).toBeNull()
    expect(parseItemRef('op://siteadapter/')).toBeNull()
    expect(parseItemRef('op:///Woolworths')).toBeNull()
  })

  it('rejects quotes, control characters and leading or trailing spaces', () => {
    expect(parseItemRef('op://siteadapter/Wool"worths')).toBeNull()
    expect(parseItemRef("op://siteadapter/Nick's")).toBeNull()
    expect(parseItemRef('op://siteadapter/Wool\nworths')).toBeNull()
    expect(parseItemRef('op://siteadapter/ Woolworths')).toBeNull()
    expect(parseItemRef('op://siteadapter/Woolworths ')).toBeNull()
  })

  it('rejects a name that looks like a command-line flag', () => {
    expect(parseItemRef('op://--help/Woolworths')).toBeNull()
  })

  it('rejects names longer than 128 characters', () => {
    expect(parseItemRef(`op://siteadapter/${'a'.repeat(128)}`)).not.toBeNull()
    expect(parseItemRef(`op://siteadapter/${'a'.repeat(129)}`)).toBeNull()
  })
})

describe('secretReference', () => {
  const ref = { vault: 'siteadapter', item: 'Woolworths' }

  it('maps each field to its 1Password field', () => {
    expect(secretReference(ref, 'username', 'otp')).toBe('op://siteadapter/Woolworths/username')
    expect(secretReference(ref, 'password', 'otp')).toBe('op://siteadapter/Woolworths/password')
    expect(secretReference(ref, 'otp', 'otp')).toBe(
      'op://siteadapter/Woolworths/one-time password?attribute=otp',
    )
  })

  it('uses the attribute name the caller asks for', () => {
    expect(secretReference(ref, 'otp', 'totp')).toBe(
      'op://siteadapter/Woolworths/one-time password?attribute=totp',
    )
  })
})
