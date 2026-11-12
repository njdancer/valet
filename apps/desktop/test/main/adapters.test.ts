// @vitest-environment node
// The built-in adapters as packages: every source file under each adapter's src/, and the manifest
// its own code makes, hashed exactly as the built-ins were before packages, so Nick's approvals and
// grants carry over.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAdapter as wikipedia } from '@valet/adapter-wikipedia'
import { createAdapter as woolworths } from '@valet/adapter-woolworths'
import { createAdapter as yahooFinance } from '@valet/adapter-yahoo-finance'
import { checkPackage } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { builtinPackages, relativeSources } from '../../src/main/adapters'
import { builtinAdapter } from '../../src/main/core/registry'

function onDisk(folder: string): Record<string, string> {
  const dir = join(import.meta.dirname, `../../../../adapters/${folder}/src`)
  const files: Record<string, string> = {}
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.ts'))
        files[`src/${prefix}${entry.name}`] = readFileSync(join(at, entry.name), 'utf8')
    }
  }
  walk(dir, '')
  return files
}

describe('builtinPackages', () => {
  it('ships Woolworths, Yahoo Finance and Wikipedia, each with its sources and manifest', () => {
    const packages = builtinPackages().map(checkPackage)
    expect(packages.map((p) => p.manifest.id)).toEqual(['woolworths', 'yahoo-finance', 'wikipedia'])
    for (const p of packages) {
      const sources = Object.fromEntries(Object.entries(p.files).filter(([path]) => path.startsWith('src/')))
      expect(sources).toEqual(onDisk(p.manifest.id))
    }
  })

  it('hashes each built-in exactly as before packages', () => {
    const before = [woolworths(), yahooFinance(), wikipedia()].map(
      (definition) => builtinAdapter(definition, onDisk(definition.manifest.id)).hash,
    )
    expect(builtinPackages().map((files) => checkPackage(files).adapterHash)).toEqual(before)
  })

  it('gives the fake site’s Woolworths a hash of its own', () => {
    const [real] = builtinPackages().map(checkPackage)
    const [demo] = builtinPackages({
      origin: 'https://www.woolworths.test:8443',
      authOrigin: 'https://auth.woolworths.test:8444',
    }).map(checkPackage)
    expect(demo?.manifest.navigation).toEqual([
      'https://www.woolworths.test:8443',
      'https://auth.woolworths.test:8444',
    ])
    expect(demo?.adapterHash).not.toBe(real?.adapterHash)
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
