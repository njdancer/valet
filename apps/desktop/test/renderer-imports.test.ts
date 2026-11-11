// The renderer bundle runs in a sandboxed page with no Node built-ins. @valet/core's index pulls in
// node:util (Secret's inspect hook), so a value import from it there crashes the window at load:
// the renderer takes values from core's Node-free subpaths and only types from its index.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/renderer', 'src/shared'].map((r) => join(import.meta.dirname, '..', r))

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

describe('renderer imports', () => {
  it('takes only types from @valet/core’s index', () => {
    const offenders = ROOTS.flatMap(files).filter((file) => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/(import|export)\s+(type\s+)?\{[^}]*\}\s*from\s*'@valet\/core'/g)].some(
        (m) => m[2] === undefined,
      )
    })
    expect(offenders).toEqual([])
  })
})
