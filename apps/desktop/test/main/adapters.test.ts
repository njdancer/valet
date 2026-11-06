// @vitest-environment node
// The built-in adapters: hashed over the Woolworths source exactly as this build compiles it.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleHash, canonicalJson } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { builtinAdapters, relativeSources } from '../../src/main/adapters'
import { MANIFEST_ENTRY } from '../../src/main/core/registry'

const SRC = join(import.meta.dirname, '../../../../adapters/woolworths/src')

describe('builtinAdapters', () => {
  it('hashes every Woolworths source file and the effective manifest', () => {
    const [woolworths] = builtinAdapters()
    const onDisk = Object.fromEntries(
      readdirSync(SRC)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => [`src/${f}`, readFileSync(join(SRC, f), 'utf8')]),
    )
    expect(woolworths?.files).toEqual(onDisk)
    expect(woolworths?.hash).toBe(
      bundleHash({ ...onDisk, [MANIFEST_ENTRY]: canonicalJson(woolworths?.definition.manifest) }),
    )
  })

  it('gives the fake site’s manifest a hash of its own', () => {
    const [real] = builtinAdapters()
    const [demo] = builtinAdapters({
      origin: 'https://www.woolworths.test:8443',
      authOrigin: 'https://auth.woolworths.test:8444',
    })
    expect(demo?.definition.manifest.navigation).toEqual([
      'https://www.woolworths.test:8443',
      'https://auth.woolworths.test:8444',
    ])
    expect(demo?.hash).not.toBe(real?.hash)
  })

  it('keys sources by their path inside the adapter package only', () => {
    expect(
      relativeSources({
        '../../../../adapters/woolworths/src/a.ts': 'a',
        '/elsewhere/b.ts': 'b',
      }),
    ).toEqual({ 'src/a.ts': 'a' })
  })
})
