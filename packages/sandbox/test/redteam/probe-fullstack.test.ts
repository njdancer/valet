// End-to-end red-team: tool code in QuickJS reaching ctx.local through the whole runtime stack
// (bootstrap -> runIsolated -> dispatchLocal -> liveLocal -> localFiles), against a temp home with
// one declared files read exception.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AdapterDefinition,
  type AdapterManifest,
  defineAdapter,
  type SandboxDeclaration,
  type ToolDeclaration,
} from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { systemSleep } from '../../../runtime/src/clock'
import type { ToolHostOptions } from '../../../runtime/src/tool-host'
import { call, fixture, manifest } from '../../../runtime/test/fixtures'
import { scriptFor } from '../../../runtime/test/isolation/processes'
import { inProcessQuickJS } from '../../src/in-process'
import { createLocalAccess } from '../../src/local/access'
import { nodeQuickJS } from '../../src/node-module'
import { tools as attackTools } from './attack-tools'

const ATTACK = join(import.meta.dirname, 'attack-tools.ts')
let factory: Awaited<ReturnType<typeof nodeQuickJS>>
let home: string
beforeEach(async () => {
  factory = await nodeQuickJS()
  home = await realpath(await mkdtemp(join(tmpdir(), 'valet-home-')))
  await mkdir(join(home, 'Documents/Receipts'), { recursive: true })
  await mkdir(join(home, 'Documents/Secret'), { recursive: true })
  await mkdir(join(home, '.ssh'), { recursive: true })
  await writeFile(join(home, 'Documents/Receipts/march.txt'), 'milk 3.10')
  await writeFile(join(home, 'Documents/Secret/diary.txt'), 'SECRET-DIARY')
  await writeFile(join(home, '.ssh/id_ed25519'), 'PRIVATE-KEY')
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function world(
  tools: AdapterDefinition['tools'],
  declaration: SandboxDeclaration,
  overrides: Partial<ToolHostOptions> = {},
  sideEffect: ToolDeclaration['sideEffect'] = 'read',
) {
  const script = await scriptFor(ATTACK)
  const m: AdapterManifest = {
    ...manifest,
    tools: Object.keys(tools).map((name) => ({ name, title: name, description: name, sideEffect })),
  }
  const definition = defineAdapter({ manifest: m, tools })
  const local = createLocalAccess(declaration, 'declared', { home })
  const w = fixture(definition, overrides, {
    script,
    start: inProcessQuickJS(factory),
    local,
  })
  return { ...w, run: (tool: string, input: unknown = {}) => w.host.call({ ...call, tool, input }) }
}

const readReceipts: SandboxDeclaration = {
  mode: 'sandboxed',
  exceptions: [{ kind: 'files', access: 'read', paths: ['~/Documents/Receipts/**'], purpose: 't' }],
}

describe('full-stack: declared files read exception', () => {
  it('reads inside the pattern but refuses everything outside it', async () => {
    const w = await world(attackTools, readReceipts)
    const result = await w.run('escape_files', {
      paths: [
        '~/Documents/Receipts/march.txt',
        '~/Documents/Secret/diary.txt',
        '~/.ssh/id_ed25519',
        '/etc/passwd',
      ],
    })
    expect(result.status).toBe('ok')
    const out = (result as { output: Record<string, string> }).output
    expect(out['~/Documents/Receipts/march.txt']).toBe('OK:milk 3.10')
    expect(out['~/Documents/Secret/diary.txt']).toBe('tool-run/not-granted')
    expect(out['~/.ssh/id_ed25519']).toBe('tool-run/not-granted')
    expect(out['/etc/passwd']).toBe('tool-run/not-granted')
  })

  it('refuses local.files when the adapter declares no files exception', async () => {
    const w = await world(attackTools, { mode: 'sandboxed', exceptions: [] })
    const result = await w.run('escape_files', { paths: ['~/Documents/Receipts/march.txt'] })
    expect((result as { output: Record<string, string> }).output['~/Documents/Receipts/march.txt']).toBe(
      'tool-run/not-granted',
    )
  })

  it('does not carry QuickJS or prototype state from one run to the next', async () => {
    const w = await world(attackTools, { mode: 'sandboxed', exceptions: [] })
    expect((await w.run('stash')).status).toBe('ok')
    // A fresh runtime per call: the second run must see null, not the first run's stash.
    expect(await w.run('stash')).toEqual({ status: 'ok', output: { seen: null, proto: 'left behind' } })
  })

  it('survives a JSON.stringify hijack that forges an oversized done message', async () => {
    const w = await world(
      attackTools,
      { mode: 'sandboxed', exceptions: [] },
      {
        sleep: systemSleep,
        pacingSleep: systemSleep,
        timeoutMs: 20_000,
      },
    )
    // 8 MB forged value: exceeds MAX_MESSAGE_CHARS (4 MB). The host must not accept it as output.
    const result = await w.run('hijack_json', { size: 8 * 1024 * 1024 })
    expect(result.status).not.toBe('ok')
  }, 25_000)

  it('bounds a flood of local.files calls without hanging', async () => {
    const w = await world(attackTools, readReceipts, {
      sleep: systemSleep,
      pacingSleep: systemSleep,
      timeoutMs: 20_000,
    })
    const result = await w.run('stat_flood', { n: 2000 })
    expect(result.status).toBe('ok')
  }, 25_000)
})
