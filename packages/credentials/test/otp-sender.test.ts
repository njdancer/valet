import { describe, expect, it } from 'vitest'
import { parseOtpSender, sameOtpSender } from '../src/otp-sender'

describe('parseOtpSender', () => {
  it('reads an E.164 number, with or without spacing, as an SMS phone handle', () => {
    const expected = { kind: 'phone', handle: '+61400000000', services: ['SMS', 'RCS'] }
    expect(parseOtpSender('+61400000000')).toEqual(expected)
    expect(parseOtpSender('+61 400 000 000')).toEqual(expected)
    expect(parseOtpSender(' +61 (400) 000-000 ')).toEqual(expected)
  })

  it('reads digits alone as a short code', () => {
    expect(parseOtpSender('12345')).toEqual({ kind: 'short-code', handle: '12345', services: ['SMS', 'RCS'] })
  })

  it('reads a sender ID of up to 11 characters, lowercased', () => {
    expect(parseOtpSender('Woolworths')).toEqual({
      kind: 'alphanumeric',
      handle: 'woolworths',
      services: ['SMS', 'RCS'],
    })
    expect(parseOtpSender('NAB Alert')?.handle).toBe('nab alert')
  })

  it('reads an email address as an iMessage handle, lowercased', () => {
    expect(parseOtpSender('Codes@Example.com')).toEqual({
      kind: 'email',
      handle: 'codes@example.com',
      services: ['iMessage'],
    })
  })

  it('refuses a local number, whose handle would depend on the country', () => {
    expect(parseOtpSender('0400 000 000')).toBeNull()
  })

  it('refuses anything that could only match as part of a handle', () => {
    expect(parseOtpSender('')).toBeNull()
    expect(parseOtpSender('12')).toBeNull()
    expect(parseOtpSender('+0400000000')).toBeNull()
    expect(parseOtpSender('Woolworths Group')).toBeNull()
    expect(parseOtpSender('woolworths.com.au')).toBeNull()
    expect(parseOtpSender('@icloud.com')).toBeNull()
    expect(parseOtpSender('%')).toBeNull()
    expect(parseOtpSender('_woolworths')).toBeNull()
  })
})

describe('sameOtpSender', () => {
  it('matches the same handle however it is written', () => {
    expect(sameOtpSender('+61 400 000 000', '+61400000000')).toBe(true)
    expect(sameOtpSender('Woolworths', 'woolworths')).toBe(true)
    expect(sameOtpSender('Codes@Example.com', 'codes@example.com')).toBe(true)
    expect(sameOtpSender('12345', ' 12345 ')).toBe(true)
  })

  it('does not match a handle that only contains or starts like the other', () => {
    expect(sameOtpSender('Woolworths', 'Woolworth')).toBe(false)
    expect(sameOtpSender('+61400000000', '+614000000001')).toBe(false)
    expect(sameOtpSender('codes@example.com', 'fake.codes@example.com')).toBe(false)
  })

  it('never matches when either side is not a sender, even two identical non-senders', () => {
    expect(sameOtpSender('', '')).toBe(false)
    expect(sameOtpSender('Woolworths Group', 'Woolworths Group')).toBe(false)
    expect(sameOtpSender('woolworths', 'woolworths.com.au')).toBe(false)
  })
})
