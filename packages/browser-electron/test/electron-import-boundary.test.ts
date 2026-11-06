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
  // Spikes are throwaway Electron experiments run by hand; nothing in the workspace imports them.
  'spikes/',
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
    expect(importers.filter((file) => !ALLOWED.some((prefix) => file.startsWith(prefix)))).toEqual([])
  })

  it('keeps the package entry point free of Electron, so plain Node can import it', () => {
    expect(importers).not.toContain('packages/browser-electron/src/index.ts')
  })
})
