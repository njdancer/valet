import { describe, expect, it } from 'vitest'
import { parseItemRef, secretReference } from '../src/item-ref'

describe('parseItemRef', () => {
  it('accepts op://<vault>/<item>', () => {
    expect(parseItemRef('op://valet/Woolworths')).toEqual({ vault: 'valet', item: 'Woolworths' })
  })

  it('accepts names with inner spaces, dots, dashes and parentheses, and item IDs', () => {
    expect(parseItemRef('op://Site Adapter/Woolworths (AU) v1.2-b')).toEqual({
      vault: 'Site Adapter',
      item: 'Woolworths (AU) v1.2-b',
    })
    expect(parseItemRef('op://valet/kq3y7l2zjd4m5x6n7p8r9s0t1u')?.item).toBe('kq3y7l2zjd4m5x6n7p8r9s0t1u')
  })

  it('rejects other schemes and missing prefixes', () => {
    expect(parseItemRef('valet/Woolworths')).toBeNull()
    expect(parseItemRef('OP://valet/Woolworths')).toBeNull()
    expect(parseItemRef('https://valet/Woolworths')).toBeNull()
  })

  it('rejects a reference that names a field, so a grant cannot pick its own field', () => {
    expect(parseItemRef('op://valet/Woolworths/password')).toBeNull()
    expect(parseItemRef('op://valet/Woolworths/Security/answer')).toBeNull()
  })

  it('rejects query parameters and fragments smuggled into the item', () => {
    expect(parseItemRef('op://valet/Woolworths?attribute=otp')).toBeNull()
    expect(parseItemRef('op://valet/Woolworths#x')).toBeNull()
  })

  it('rejects a missing vault or item', () => {
    expect(parseItemRef('op://valet')).toBeNull()
    expect(parseItemRef('op://valet/')).toBeNull()
    expect(parseItemRef('op:///Woolworths')).toBeNull()
  })

  it('rejects quotes, control characters and leading or trailing spaces', () => {
    expect(parseItemRef('op://valet/Wool"worths')).toBeNull()
    expect(parseItemRef("op://valet/Nick's")).toBeNull()
    expect(parseItemRef('op://valet/Wool\nworths')).toBeNull()
    expect(parseItemRef('op://valet/ Woolworths')).toBeNull()
    expect(parseItemRef('op://valet/Woolworths ')).toBeNull()
  })

  it('rejects a name that looks like a command-line flag', () => {
    expect(parseItemRef('op://--help/Woolworths')).toBeNull()
  })

  it('rejects names longer than 128 characters', () => {
    expect(parseItemRef(`op://valet/${'a'.repeat(128)}`)).not.toBeNull()
    expect(parseItemRef(`op://valet/${'a'.repeat(129)}`)).toBeNull()
  })
})

describe('secretReference', () => {
  const ref = { vault: 'valet', item: 'Woolworths' }

  it('maps each field to its 1Password field', () => {
    expect(secretReference(ref, 'username', 'otp')).toBe('op://valet/Woolworths/username')
    expect(secretReference(ref, 'password', 'otp')).toBe('op://valet/Woolworths/password')
    expect(secretReference(ref, 'otp', 'otp')).toBe('op://valet/Woolworths/one-time password?attribute=otp')
  })

  it('uses the attribute name the caller asks for', () => {
    expect(secretReference(ref, 'otp', 'totp')).toBe('op://valet/Woolworths/one-time password?attribute=totp')
  })
})
