/// <reference types="vite/client" />
// The built-in adapters, as packages (docs/adapter-packages.md): every .ts file under each
// adapter's src/, embedded by the bundler when it compiles the main process, plus the manifest the
// adapter's own code makes for this build (the real site, or the fake one in demo mode). The app
// seeds them into its adapter store at launch and runs them exactly as any other installed
// package: compiled by Valet, from these sources, so the hash covers what runs.

import { createManifest as wikipedia } from '@valet/adapter-wikipedia'
import { type ManifestOptions, createManifest as woolworths } from '@valet/adapter-woolworths'
import { createManifest as yahooFinance } from '@valet/adapter-yahoo-finance'
import { type PackageFiles, packageOf } from '@valet/core'

const WOOLWORTHS_SOURCES = import.meta.glob<string>('../../../../adapters/woolworths/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const YAHOO_FINANCE_SOURCES = import.meta.glob<string>('../../../../adapters/yahoo-finance/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const WIKIPEDIA_SOURCES = import.meta.glob<string>('../../../../adapters/wikipedia/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * Paths relative to the adapter's package, so the hash doesn't depend on where the repo is.
 * `folder` is the package's folder under adapters/.
 */
export function relativeSources(
  sources: Readonly<Record<string, string>>,
  folder = 'woolworths',
): Record<string, string> {
  const files: Record<string, string> = {}
  const marker = `/adapters/${folder}/`
  for (const [path, text] of Object.entries(sources)) {
    const at = path.indexOf(marker)
    if (at === -1) continue
    files[path.slice(at + marker.length)] = text
  }
  return files
}

/** The built-ins this build ships, Woolworths first. */
export function builtinPackages(woolworthsOptions: ManifestOptions = {}): PackageFiles[] {
  return [
    packageOf(woolworths(woolworthsOptions), relativeSources(WOOLWORTHS_SOURCES)),
    // No login: public data, from the real sites in every build, demo mode included.
    packageOf(yahooFinance(), relativeSources(YAHOO_FINANCE_SOURCES, 'yahoo-finance')),
    packageOf(wikipedia(), relativeSources(WIKIPEDIA_SOURCES, 'wikipedia')),
  ]
}
