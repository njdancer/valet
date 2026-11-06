// @vitest-environment node
// Strict SemVer: what the downgrade check trusts. Each loose form electron-updater's `semver`
// would accept is refused here.

import { describe, expect, it } from 'vitest'
import { compareVersions, formatVersion, MAX_VERSION_LENGTH, parseVersion } from '../../src/main/updater'

function order(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) throw new Error(`unparseable: ${a} ${b}`)
  return compareVersions(x, y)
}

describe('parseVersion', () => {
  it('parses a release and a prerelease', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2.3-beta.2')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', '2'] })
    expect(parseVersion('0.0.0-0')).toEqual({ major: 0, minor: 0, patch: 0, prerelease: ['0'] })
  })

  it('accepts build metadata and drops it', () => {
    expect(parseVersion('1.2.3+sha.abc')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2.3-rc.1+b-7')?.prerelease).toEqual(['rc', '1'])
  })

  it('refuses every loose or malformed form', () => {
    for (const text of [
      'v1.2.3',
      '=1.2.3',
      ' 1.2.3',
      '1.2.3 ',
      '1.2.3\n',
      '1.2',
      '1',
      '1.2.3.4',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-',
      '1.2.3-beta..1',
      '1.2.3-01',
      '1.2.3+',
      '1.2.3-be ta',
      '1.2.3-béta',
      '-1.2.3',
      '1.2.3-beta_1',
      '',
      `1.2.3-${'a'.repeat(MAX_VERSION_LENGTH)}`,
      '9007199254740993.0.0',
    ]) {
      expect(parseVersion(text), text).toBeNull()
    }
  })

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 1.2, { version: '1.2.3' }, ['1.2.3']]) {
      expect(parseVersion(value)).toBeNull()
    }
  })

  it('accepts alphanumeric identifiers that start with digits, and leading-zero ones that are not numeric', () => {
    expect(parseVersion('1.2.3-0a')?.prerelease).toEqual(['0a'])
    expect(parseVersion('1.2.3-alpha-1')?.prerelease).toEqual(['alpha-1'])
  })
})

describe('compareVersions', () => {
  it('orders by major, minor, then patch, numerically', () => {
    expect(order('2.0.0', '1.99.99')).toBe(1)
    expect(order('1.10.0', '1.9.0')).toBe(1)
    expect(order('1.0.10', '1.0.9')).toBe(1)
    expect(order('1.0.0', '1.0.1')).toBe(-1)
  })

  it('ranks a release above its prereleases', () => {
    expect(order('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(order('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })

  it('follows the SemVer 2.0 example ordering', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(order(chain[i] as string, chain[i + 1] as string), `${chain[i]} < ${chain[i + 1]}`).toBe(-1)
      expect(order(chain[i + 1] as string, chain[i] as string)).toBe(1)
    }
  })

  it('treats versions differing only in build metadata as equal', () => {
    expect(order('1.0.0+a', '1.0.0+b')).toBe(0)
    expect(order('1.0.0-beta.1+a', '1.0.0-beta.1')).toBe(0)
  })

  it('ranks numeric identifiers below alphanumeric ones, either way round', () => {
    expect(order('1.0.0-1', '1.0.0-a')).toBe(-1)
    expect(order('1.0.0-a', '1.0.0-1')).toBe(1)
    expect(order('1.0.0-beta', '1.0.0-alpha')).toBe(1)
  })
})

describe('formatVersion', () => {
  it('prints the canonical form without build metadata', () => {
    expect(formatVersion(parseVersion('1.2.3+x') as never)).toBe('1.2.3')
    expect(formatVersion(parseVersion('1.2.3-beta.4+x') as never)).toBe('1.2.3-beta.4')
  })
})
