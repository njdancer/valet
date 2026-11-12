// The example local-data adapter (examples/local-portfolio) end to end: its package loads as an
// installed one would, its schemas are described in QuickJS, and get_portfolio reads its one
// declared file through ctx.local and nothing else.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPackage, readPackageFolder } from '@valet/adapter-store'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { json } from '../../runtime/test/fakes'
import { call, fixture } from '../../runtime/test/fixtures'
import { inProcessQuickJS } from '../src/in-process'
import { createLocalAccess } from '../src/local/access'
import { nodeQuickJS } from '../src/node-module'

const FOLDER = join(import.meta.dirname, '../../../examples/local-portfolio')
const chart = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`

let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'valet-portfolio-')))
  await mkdir(join(home, 'Documents/Valet'), { recursive: true })
  await writeFile(join(home, 'Documents/Valet/portfolio.csv'), 'symbol,quantity\nBHP.AX,10\n# sold\nAAPL,2\n')
  await writeFile(join(home, 'Documents/Valet/other.csv'), 'secret')
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function installed() {
  const start = inProcessQuickJS(await nodeQuickJS())
  const loaded = await loadPackage(await readPackageFolder(FOLDER), {
    prelude: await buildToolLibrary(),
    start,
  })
  const declaration = loaded.manifest.sandbox
  if (declaration === undefined) throw new Error('the example declares its sandbox')
  const local = createLocalAccess(declaration, 'declared', { home })
  const world = fixture(
    loaded.definition,
    { approvals: { isApproved: async () => true } },
    { script: loaded.script, start, local },
  )
  world.page.route(
    'GET',
    chart('BHP.AX'),
    json({ chart: { result: [{ meta: { regularMarketPrice: 45.5, currency: 'AUD' } }] } }),
  )
  world.page.route(
    'GET',
    chart('AAPL'),
    json({ chart: { result: [{ meta: { regularMarketPrice: 200, currency: 'USD' } }] } }),
  )
  return { world, loaded, local }
}

describe('the example local-data adapter', () => {
  it('declares one read of one file, and loads with the schemas QuickJS describes', async () => {
    const { loaded } = await installed()
    expect(loaded.manifest.sandbox).toEqual({
      mode: 'sandboxed',
      exceptions: [
        expect.objectContaining({
          kind: 'files',
          access: 'read',
          paths: ['~/Documents/Valet/portfolio.csv'],
        }),
      ],
    })
    expect(Object.keys(loaded.definition.tools)).toEqual(['get_portfolio'])
  })

  it('values the holdings in the file through its exception', async () => {
    const { world } = await installed()
    const result = await world.host.call({
      ...call,
      adapterId: 'local-portfolio',
      tool: 'get_portfolio',
      input: {},
    })
    expect(result).toEqual({
      status: 'ok',
      output: {
        holdings: [
          { symbol: 'BHP.AX', quantity: 10, price: 45.5, currency: 'AUD', value: 455 },
          { symbol: 'AAPL', quantity: 2, price: 200, currency: 'USD', value: 400 },
        ],
        totals: [
          { currency: 'AUD', value: 455 },
          { currency: 'USD', value: 400 },
        ],
      },
    })
    expect(world.audit.events.filter((e) => e.type === 'local-access')).toEqual([
      {
        type: 'local-access',
        adapterId: 'local-portfolio',
        callId: 'call-1',
        capability: 'files.read',
        errorClass: null,
      },
    ])
  })

  it('reaches nothing but that file', async () => {
    const { local } = await installed()
    await expect(local.files.read('~/Documents/Valet/other.csv')).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
    await expect(local.files.list('~/Documents/Valet')).rejects.toMatchObject({ errorClass: 'not-granted' })
    await expect(local.files.write('~/Documents/Valet/portfolio.csv', 'x')).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
    await expect(local.fetch('https://query1.finance.yahoo.com/')).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
  })
})
