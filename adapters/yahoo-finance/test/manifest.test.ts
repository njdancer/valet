import { hasLogin } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../src/adapter'
import { createManifest } from '../src/manifest'

describe('the Yahoo Finance manifest', () => {
  it('has no login, asks for no secrets, and reads only', () => {
    const manifest = createManifest()
    expect(hasLogin(manifest)).toBe(false)
    expect(manifest.secrets).toEqual({})
    expect(manifest.tools.every((t) => t.sideEffect === 'read')).toBe(true)
    expect(manifest.requests.every((r) => r.method === 'GET' && r.purpose === 'read')).toBe(true)
  })

  it('reaches only the site and its API host', () => {
    expect(createManifest().egress).toEqual(['finance.yahoo.com', 'query1.finance.yahoo.com'])
    expect(createManifest({ origin: 'https://finance.yahoo.test' }).egress).toEqual([
      'finance.yahoo.test',
      'query1.finance.yahoo.test',
    ])
  })

  it('implements every tool it declares', () => {
    expect(() => createAdapter()).not.toThrow()
  })
})
