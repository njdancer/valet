/// <reference types="vite/client" />
// The built-in adapters and the source files their hashes cover. The sources are embedded by the
// bundler when it compiles the main process, from the same files it compiles the adapter from, so
// the hash is over exactly the code this build runs: in a packaged build and under `electron-vite
// dev` (which rebuilds on change) alike. Transitive imports (core, zod) are not covered (D11).

import toolScripts from 'virtual:valet-tool-scripts'
import { createAdapter, type ManifestOptions } from '@valet/adapter-woolworths'
import { createAdapter as createYahooFinance } from '@valet/adapter-yahoo-finance'
import { type BuiltinAdapter, builtinAdapter } from './core/registry'

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

export function builtinAdapters(woolworths: ManifestOptions = {}): BuiltinAdapter[] {
  return [
    builtinAdapter(
      createAdapter(woolworths),
      relativeSources(WOOLWORTHS_SOURCES),
      toolScripts['woolworths'] ?? null,
    ),
    // No login: quotes are public. Live in every build, demo mode included.
    builtinAdapter(
      createYahooFinance(),
      relativeSources(YAHOO_FINANCE_SOURCES, 'yahoo-finance'),
      toolScripts['yahoo-finance'] ?? null,
    ),
  ]
}
