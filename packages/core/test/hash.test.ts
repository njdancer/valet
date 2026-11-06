import { describe, expect, it } from 'vitest'
import { bundleHash, canonicalJson, sha256Hex } from '../src/hash'

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}',
    )
  })

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('passes primitives and null through', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson('x')).toBe('"x"')
  })
})

describe('sha256Hex', () => {
  it('hashes strings and bytes identically', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'))
  })
})

describe('bundleHash', () => {
  it('does not depend on the order files were added', () => {
    expect(bundleHash({ 'a.json': '1', 'b.ts': '2' })).toBe(bundleHash({ 'b.ts': '2', 'a.json': '1' }))
  })

  it('changes when any file changes', () => {
    expect(bundleHash({ 'a.json': '1', 'b.ts': '2' })).not.toBe(bundleHash({ 'a.json': '1', 'b.ts': '3' }))
  })

  it('changes when a file is renamed', () => {
    expect(bundleHash({ 'a.json': '1' })).not.toBe(bundleHash({ 'c.json': '1' }))
  })

  it('cannot be forged by moving bytes between path and contents', () => {
    expect(bundleHash({ ab: 'c' })).not.toBe(bundleHash({ a: 'bc' }))
  })

  it('treats string and byte contents the same', () => {
    expect(bundleHash({ 'a.txt': 'hi' })).toBe(bundleHash({ 'a.txt': new TextEncoder().encode('hi') }))
  })
})
