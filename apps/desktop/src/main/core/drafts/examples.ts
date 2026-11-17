/// <reference types="vite/client" />
// The worked examples an agent can start a draft from (docs/adapter-kinds.md#h-example-adapters):
// every package under examples/, embedded by the bundler, one per kind of adapter. A draft from an
// example is the example's files with the agent's own id and name in its manifest; nothing in an
// example is installed or approved until the person approves the draft, like any other.

import type { PackageFiles } from '@valet/core'

const SOURCES = import.meta.glob<string>(
  [
    '../../../../../../examples/*/manifest.json',
    '../../../../../../examples/*/README.md',
    '../../../../../../examples/*/src/**/*.ts',
    '../../../../../../examples/*/test/*.json',
    '../../../../../../examples/*/fixtures/**/*',
  ],
  { query: '?raw', import: 'default', eager: true },
)

export interface Example {
  readonly name: string
  /** The manifest's own description: what the example shows. */
  readonly description: string
  readonly runtime: string
  readonly files: PackageFiles
}

/** The examples by folder name, from the embedded files. Exported for tests. */
export function examplesFrom(sources: Readonly<Record<string, string>>): ReadonlyMap<string, Example> {
  const byName = new Map<string, Record<string, string>>()
  for (const [path, text] of Object.entries(sources)) {
    const match = /\/examples\/([a-z0-9-]+)\/(.+)$/.exec(path)
    if (match === null) continue
    const [, name, file] = match as unknown as [string, string, string]
    const files = byName.get(name) ?? {}
    files[file] = text
    byName.set(name, files)
  }
  const out = new Map<string, Example>()
  for (const [name, files] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    let manifest: { description?: unknown; runtime?: unknown }
    try {
      manifest = JSON.parse(files['manifest.json'] ?? '')
    } catch {
      continue
    }
    out.set(name, {
      name,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      runtime: typeof manifest.runtime === 'string' ? manifest.runtime : 'browser',
      files,
    })
  }
  return out
}

export const EXAMPLES: ReadonlyMap<string, Example> = examplesFrom(SOURCES)

/** An example's files with the draft's id and name in its manifest. */
export function draftFromExample(
  example: Example,
  adapterId: string,
  name: string | undefined,
): PackageFiles {
  const manifest = JSON.parse(example.files['manifest.json'] ?? '{}') as Record<string, unknown>
  manifest['id'] = adapterId
  if (name !== undefined) manifest['name'] = name
  return { ...example.files, 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` }
}
