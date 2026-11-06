import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

// Any word starting with "reveal" outside comments: reveal(), revealEach() and whatever variant
// comes next, whether called directly, reached through a computed key or destructured. Comments are
// dropped first so prose can say "reveals"; a string naming the method still counts, on purpose.
const REVEAL = /\breveal\w*/g
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm

function revealsIn(source: string): number {
  return [...source.replace(COMMENTS, '$1').matchAll(REVEAL)].length
}

describe('reveal() in this package', () => {
  it('is called only by sdkClientFactory, once, to hand the token to the SDK', async () => {
    // CONTRIBUTING.md allows this one exception to "only the filler reveals"; anything new here
    // must be argued for there first.
    const calls: string[] = []
    for (const name of (await readdir(SRC)).filter((file) => file.endsWith('.ts')).sort()) {
      const count = revealsIn(await readFile(join(SRC, name), 'utf8'))
      for (let i = 0; i < count; i++) calls.push(name)
    }
    expect(calls).toEqual(['onepassword-sdk.ts'])
  })
})

describe('the pattern the guard uses', () => {
  it('catches reveal() called directly', () => {
    expect(revealsIn('token.reveal((plain) => use(plain))')).toBe(1)
  })

  it('catches revealEach(), which hands out the plaintext one code point at a time', () => {
    expect(revealsIn('value.revealEach(async (c) => { out += c })')).toBe(1)
  })

  it('catches revealEach reached through a computed key', () => {
    expect(revealsIn('value["revealEach"](f)')).toBe(1)
    expect(revealsIn("value[ 'revealEach' ](f)")).toBe(1)
    expect(revealsIn('value[`reveal`](f)')).toBe(1)
  })

  it('catches a reveal method taken without calling it, to be called later', () => {
    expect(revealsIn('const leak = value.revealEach')).toBe(1)
    expect(revealsIn('const { revealEach } = value')).toBe(1)
  })

  it('ignores the word in comments, but not in code on the same line', () => {
    expect(revealsIn('// only the filler reveals a secret\n/* reveal() here is prose */')).toBe(0)
    expect(revealsIn('value.revealEach(f) // reveals one code point at a time')).toBe(1)
  })

  it('catches a future variant and whitespace before the name', () => {
    expect(revealsIn('value.revealAll()')).toBe(1)
    expect(revealsIn('value\n  .revealEach(f)')).toBe(1)
  })
})
