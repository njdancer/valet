import { describe, expect, it } from 'vitest'
import { isScreenedOtpPattern } from '../src/otp-pattern'

describe('isScreenedOtpPattern', () => {
  it('accepts the patterns a real OTP step uses', () => {
    expect(isScreenedOtpPattern('code is (\\d{6})')).toBe(true)
    expect(isScreenedOtpPattern('\\d{6}')).toBe(true)
    expect(isScreenedOtpPattern('(?:code|PIN):? ?(\\d{4,8})')).toBe(true)
    expect(isScreenedOtpPattern('(?<code>[A-Z0-9]{6}) is your')).toBe(true)
    expect(isScreenedOtpPattern('(?<=code )(\\d{6})(?! digits)')).toBe(true)
    expect(isScreenedOtpPattern('(?<!not )code (\\d+?)\\b')).toBe(true)
  })

  it('accepts an optional group even when its body repeats', () => {
    // `?` runs its group at most once, so it cannot multiply the backtracking.
    expect(isScreenedOtpPattern('(?:Your code: )?(\\d+)')).toBe(true)
    expect(isScreenedOtpPattern('(\\d+){1}')).toBe(true)
    expect(isScreenedOtpPattern('(\\d+){0,1}')).toBe(true)
  })

  it('refuses a pattern that does not compile', () => {
    expect(isScreenedOtpPattern('(')).toBe(false)
    expect(isScreenedOtpPattern('[')).toBe(false)
  })

  it('refuses nested quantifiers', () => {
    expect(isScreenedOtpPattern('^(a+)+$')).toBe(false)
    expect(isScreenedOtpPattern('(\\d*)*')).toBe(false)
    expect(isScreenedOtpPattern('(?:\\w+\\s?)+$')).toBe(false)
    expect(isScreenedOtpPattern('((\\d)+)+')).toBe(false)
    expect(isScreenedOtpPattern('(\\d{2})+')).toBe(false)
    expect(isScreenedOtpPattern('(a+){2,}')).toBe(false)
    expect(isScreenedOtpPattern('(a+){1,5}')).toBe(false)
    expect(isScreenedOtpPattern('(a+){3}')).toBe(false)
    expect(isScreenedOtpPattern('(a?)+?')).toBe(false)
  })

  it('refuses a repeated alternation', () => {
    expect(isScreenedOtpPattern('(a|a)*b')).toBe(false)
    expect(isScreenedOtpPattern('(?:\\d|\\w)+!')).toBe(false)
  })

  it('refuses a repeat that is only nested a group deeper', () => {
    expect(isScreenedOtpPattern('((?:a+))+')).toBe(false)
    expect(isScreenedOtpPattern('(x(a|b))*')).toBe(false)
  })

  it('refuses backreferences', () => {
    expect(isScreenedOtpPattern('(\\d)\\1')).toBe(false)
    expect(isScreenedOtpPattern('(?<d>\\d)\\k<d>')).toBe(false)
  })

  it('is not fooled by quantifier characters inside a class or escaped', () => {
    expect(isScreenedOtpPattern('([+*|]\\d)+')).toBe(true)
    expect(isScreenedOtpPattern('(\\+\\d)+')).toBe(true)
    expect(isScreenedOtpPattern('([\\]+]x)+')).toBe(true)
  })

  it('treats a brace that is not a quantifier as a literal', () => {
    expect(isScreenedOtpPattern('(a{)+')).toBe(true)
    expect(isScreenedOtpPattern('(a{x})+')).toBe(true)
  })

  it('accepts a quantifier after a plain group', () => {
    expect(isScreenedOtpPattern('(ab)+')).toBe(true)
    expect(isScreenedOtpPattern('(a+)b+')).toBe(true)
  })
})
