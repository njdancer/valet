import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

describe('reveal() in this package', () => {
  it('is called only by sdkClientFactory, once, to hand the token to the SDK', async () => {
    // CONTRIBUTING.md allows this one exception to "only the filler reveals"; anything new here
    // must be argued for there first.
    const calls: string[] = []
    for (const name of (await readdir(SRC)).filter((file) => file.endsWith('.ts')).sort()) {
      const source = await readFile(join(SRC, name), 'utf8')
      for (const _ of source.matchAll(/\.reveal\s*\(|\[\s*['"`]reveal['"`]\s*\]/g)) calls.push(name)
    }
    expect(calls).toEqual(['onepassword-sdk.ts'])
  })
})
