import { describe, expect, it } from 'vitest'
import { isScreenedPattern } from '../src/regex-screen'

describe('isScreenedPattern', () => {
  it('accepts the patterns a real OTP step uses', () => {
    expect(isScreenedPattern('code is (\\d{6})')).toBe(true)
    expect(isScreenedPattern('\\d{6}')).toBe(true)
    expect(isScreenedPattern('(?:code|PIN):? ?(\\d{4,8})')).toBe(true)
    expect(isScreenedPattern('(?<code>[A-Z0-9]{6}) is your')).toBe(true)
    expect(isScreenedPattern('(?<=code )(\\d{6})(?! digits)')).toBe(true)
    expect(isScreenedPattern('(?<!not )code (\\d+?)\\b')).toBe(true)
  })

  it('accepts an optional group even when its body repeats', () => {
    // `?` runs its group at most once, so it cannot multiply the backtracking.
    expect(isScreenedPattern('(?:Your code: )?(\\d+)')).toBe(true)
    expect(isScreenedPattern('(\\d+){1}')).toBe(true)
    expect(isScreenedPattern('(\\d+){0,1}')).toBe(true)
  })

  it('refuses a pattern that does not compile', () => {
    expect(isScreenedPattern('(')).toBe(false)
    expect(isScreenedPattern('[')).toBe(false)
  })

  it('refuses nested quantifiers', () => {
    expect(isScreenedPattern('^(a+)+$')).toBe(false)
    expect(isScreenedPattern('(\\d*)*')).toBe(false)
    expect(isScreenedPattern('(?:\\w+\\s?)+$')).toBe(false)
    expect(isScreenedPattern('((\\d)+)+')).toBe(false)
    expect(isScreenedPattern('(\\d{2})+')).toBe(false)
    expect(isScreenedPattern('(a+){2,}')).toBe(false)
    expect(isScreenedPattern('(a+){1,5}')).toBe(false)
    expect(isScreenedPattern('(a+){3}')).toBe(false)
    expect(isScreenedPattern('(a?)+?')).toBe(false)
  })

  it('refuses a repeated alternation', () => {
    expect(isScreenedPattern('(a|a)*b')).toBe(false)
    expect(isScreenedPattern('(?:\\d|\\w)+!')).toBe(false)
  })

  it('refuses a repeat that is only nested a group deeper', () => {
    expect(isScreenedPattern('((?:a+))+')).toBe(false)
    expect(isScreenedPattern('(x(a|b))*')).toBe(false)
  })

  it('refuses backreferences', () => {
    expect(isScreenedPattern('(\\d)\\1')).toBe(false)
    expect(isScreenedPattern('(?<d>\\d)\\k<d>')).toBe(false)
  })

  it('is not fooled by quantifier characters inside a class or escaped', () => {
    expect(isScreenedPattern('([+*|]\\d)+')).toBe(true)
    expect(isScreenedPattern('(\\+\\d)+')).toBe(true)
    expect(isScreenedPattern('([\\]+]x)+')).toBe(true)
  })

  it('treats a brace that is not a quantifier as a literal', () => {
    expect(isScreenedPattern('(a{)+')).toBe(true)
    expect(isScreenedPattern('(a{x})+')).toBe(true)
  })

  it('accepts a quantifier after a plain group', () => {
    expect(isScreenedPattern('(ab)+')).toBe(true)
    expect(isScreenedPattern('(a+)b+')).toBe(true)
  })
})
