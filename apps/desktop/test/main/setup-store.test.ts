// @vitest-environment node
// setup.json: whether first-run setup is finished, so that later launches stop opening it.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPaths } from '../../src/main/core/constants'
import { SetupStore } from '../../src/main/core/setup'

const dirs: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sa-setup-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const T1 = Date.parse('2026-11-07T10:00:00Z')
const T2 = Date.parse('2026-11-08T10:00:00Z')

describe('SetupStore', () => {
  it('reads as not finished until finish(), then keeps the first time, owner-only', async () => {
    const path = dataPaths(dir()).setup
    let now = T1
    const store = new SetupStore(path, () => now)
    expect(await store.status()).toEqual({ completedAt: null })
    expect(await store.finish()).toEqual({ completedAt: new Date(T1).toISOString() })
    now = T2
    expect(await store.finish()).toEqual({ completedAt: new Date(T1).toISOString() })
    expect(await new SetupStore(path, () => now).status()).toEqual({
      completedAt: new Date(T1).toISOString(),
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ completedAt: new Date(T1).toISOString() })
  })

  it('reads a file that doesn’t validate as not finished, and finishing writes a good one', async () => {
    const path = join(dir(), 'setup.json')
    for (const bad of ['{', '{"completedAt": "yesterday"}', '{"completedAt": null, "extra": 1}', '[]']) {
      writeFileSync(path, bad)
      expect(await new SetupStore(path, () => T1).status()).toEqual({ completedAt: null })
    }
    expect(await new SetupStore(path, () => T1).finish()).toEqual({ completedAt: new Date(T1).toISOString() })
    expect(await new SetupStore(path, () => T2).status()).toEqual({ completedAt: new Date(T1).toISOString() })
  })
})
