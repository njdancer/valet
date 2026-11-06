import { describe, expect, it } from 'vitest'
import { attributedBodyText } from '../src/typedstream'
import { ARCHIVE_PREFIX, ARCHIVE_SUFFIX, archived, lengthBytes } from './typedstream-fixture'

describe('attributedBodyText', () => {
  it('reads a string with a one-byte length', () => {
    expect(attributedBodyText(archived('Your code is 123456', 'byte'))).toBe('Your code is 123456')
  })

  it('reads a string with a 0x81 two-byte little-endian length', () => {
    const text = `Your code is 123456. ${'x'.repeat(300)}`
    expect(attributedBodyText(archived(text, 'int16'))).toBe(text)
  })

  it('reads a string with a 0x82 four-byte little-endian length', () => {
    const text = `Your code is 123456. ${'y'.repeat(70_000)}`
    expect(attributedBodyText(archived(text, 'int32'))).toBe(text)
  })

  it('reads multi-byte UTF-8 by byte length', () => {
    expect(attributedBodyText(archived('Código: 654321 ✓'))).toBe('Código: 654321 ✓')
  })

  it('reads a blob that is a view into a larger buffer', () => {
    const blob = archived('code 111222')
    const backing = Buffer.concat([Buffer.from('junk NSString + junk'), blob])
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 20, blob.length)
    expect(attributedBodyText(view)).toBe('code 111222')
  })

  it('uses the first NSString, not ones in the attribute dictionary', () => {
    expect(attributedBodyText(archived('first'))).toBe('first')
  })

  it('returns null without the NSString class name', () => {
    expect(attributedBodyText(Buffer.from('streamtyped + nothing here'))).toBeNull()
    expect(attributedBodyText(new Uint8Array())).toBeNull()
  })

  it('returns null when no string tag follows the class name', () => {
    const blob = Buffer.concat([Buffer.from('NSString'), Buffer.alloc(32, 0x01)])
    expect(attributedBodyText(blob)).toBeNull()
  })

  it('returns null when the blob ends at the length', () => {
    expect(attributedBodyText(ARCHIVE_PREFIX)).toBeNull()
    expect(attributedBodyText(Buffer.concat([ARCHIVE_PREFIX, Buffer.from([0x81, 0x01])]))).toBeNull()
    expect(
      attributedBodyText(Buffer.concat([ARCHIVE_PREFIX, Buffer.from([0x82, 0x01, 0x00, 0x00])])),
    ).toBeNull()
  })

  it('returns null for a length tag it does not know', () => {
    expect(
      attributedBodyText(Buffer.concat([ARCHIVE_PREFIX, Buffer.from([0x83, 0x05]), ARCHIVE_SUFFIX])),
    ).toBeNull()
  })

  it('returns null when the length runs past the end', () => {
    const blob = Buffer.concat([ARCHIVE_PREFIX, lengthBytes(70_000, 'int32'), Buffer.from('short')])
    expect(attributedBodyText(blob)).toBeNull()
  })
})
