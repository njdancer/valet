// The built-in adapters as packages, read from the repo the way the app embeds them: every .ts file
// under src/, plus the manifest the adapter's own code makes.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createManifest as wikipedia } from '@valet/adapter-wikipedia'
import { createManifest as woolworths } from '@valet/adapter-woolworths'
import { createManifest as yahooFinance } from '@valet/adapter-yahoo-finance'
import { type AdapterManifest, type PackageFiles, packageOf } from '@valet/core'
import { buildToolLibrary } from '@valet/runtime/tool-script'

const ADAPTERS = join(import.meta.dirname, '../../../adapters')

export function sourcesOf(folder: string): Record<string, string> {
  const root = join(ADAPTERS, folder)
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) files[relative(root, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(join(root, 'src'))
  return files
}

export const MANIFESTS: Readonly<Record<string, () => AdapterManifest>> = {
  woolworths: () => woolworths(),
  'yahoo-finance': () => yahooFinance(),
  wikipedia: () => wikipedia(),
}

export function builtinPackage(folder: string): PackageFiles {
  const manifest = MANIFESTS[folder]
  if (manifest === undefined) throw new Error(folder)
  return packageOf(manifest(), sourcesOf(folder))
}

let prelude: Promise<string> | null = null
export function libraryPrelude(): Promise<string> {
  prelude ??= buildToolLibrary()
  return prelude
}
