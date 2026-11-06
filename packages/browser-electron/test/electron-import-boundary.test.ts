// Only the browser driver's Electron layer and the desktop app may import Electron. Everything else
// must run, and be tested, in plain Node. See docs/architecture.md, "Shape".

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importsElectron } from './import-scan'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const ALLOWED = [
  'packages/browser-electron/src/electron/',
  // The e2e harness is an Electron main process by definition.
  'packages/browser-electron/e2e/',
  'apps/desktop/',
]

// Throwaway experiments that predate the framework, by name: nothing imports them, and a new file
// that imports Electron, in spikes/ or anywhere else outside ALLOWED, fails this test.
const EXISTING_SPIKES = [
  'spikes/01-woolworths-electron/main.mjs',
  'spikes/02-woolworths-shapes/probe.mjs',
  'spikes/02-woolworths-shapes/probe-login.mjs',
]

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'coverage', 'results'])

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dot-directories include .git and, in a main checkout, other agents' worktrees.
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path))
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      files.push(relative(REPO_ROOT, path).split(sep).join('/'))
    }
  }
  return files
}

describe('electron import boundary', () => {
  const files = sourceFiles(REPO_ROOT)
  const importers = files.filter((file) => importsElectron(readFileSync(join(REPO_ROOT, file), 'utf8')))

  it('finds the Electron layer, so the scan is not passing vacuously', () => {
    expect(importers).toContain('packages/browser-electron/src/electron/platform.ts')
    expect(files.length).toBeGreaterThan(20)
  })

  it('finds no Electron import anywhere else', () => {
    expect(
      importers.filter(
        (file) => !ALLOWED.some((prefix) => file.startsWith(prefix)) && !EXISTING_SPIKES.includes(file),
      ),
    ).toEqual([])
  })

  it('lists only spikes that exist and import Electron, so the exemption cannot outlive them', () => {
    for (const spike of EXISTING_SPIKES) expect(importers, spike).toContain(spike)
  })

  it('keeps the package entry point free of Electron, so plain Node can import it', () => {
    expect(importers).not.toContain('packages/browser-electron/src/index.ts')
  })
})
