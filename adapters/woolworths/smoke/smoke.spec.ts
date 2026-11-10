// Drift detection's smoke test (M4): the adapter's three read requests through the real Electron
// driver, each response checked against the adapter's schemas (src/drift.ts). The report is
// written under out/smoke/ with keys, types and status codes only.
//
// - The dry run, against the fake site on this machine, always runs (CI runs it too), so the
//   harness can't rot between live runs.
// - The live run skips unless VALET_LIVE_SMOKE=1. It is anonymous, read-only, three requests 10 s
//   apart, and is run only by Nick, by hand, at most once a day (plan.md, "Live smoke tests"):
//     VALET_LIVE_SMOKE=1 pnpm --filter @valet/adapter-woolworths test:smoke

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { _electron, type ElectronApplication, expect, test } from '@playwright/test'
import type { SmokeResult } from '../src/smoke'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string
const live = process.env.VALET_LIVE_SMOKE === '1'
const reports = join(import.meta.dirname, '..', 'out', 'smoke')

interface SmokeRun {
  readonly target: 'fake' | 'live'
  readonly result: SmokeResult
  readonly refused: Record<string, number>
}

async function run(target: 'fake' | 'live', env: Record<string, string> = {}): Promise<SmokeRun> {
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      executablePath: electronPath,
      args: [join(import.meta.dirname, 'harness', 'main.mjs')],
      env: { ...process.env, ...env, SMOKE_TARGET: target } as Record<string, string>,
    })
    const report = (await app.evaluate(async () => {
      const harness = await (globalThis as { smoke?: Promise<{ run: () => Promise<unknown> }> }).smoke
      if (harness === undefined) throw new Error('no smoke harness')
      return harness.run()
    })) as SmokeRun & { at: string }
    mkdirSync(reports, { recursive: true })
    const file = join(reports, `${target}-${report.at.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[smoke] ${target}: ${report.result.ok ? 'no drift' : 'DRIFT OR STOPPED'}; report in ${file}`)
    return report
  } finally {
    await app?.close()
  }
}

/** One line per finding, for the failure message: what changed, never a value. */
function findings(result: SmokeResult): string[] {
  const lines: string[] = []
  if (result.stopped !== null) lines.push(`stopped: ${JSON.stringify(result.stopped)}`)
  for (const step of result.steps) {
    for (const issue of step.report?.issues ?? []) {
      lines.push(
        `${step.endpoint} ${issue.path}: ${issue.code}, expected ${issue.expected}, got ${issue.received}`,
      )
    }
    for (const path of step.report?.absent ?? []) lines.push(`${step.endpoint} ${path}: absent`)
  }
  return lines
}

test('dry run: the fake site has no drift, through the real driver', async () => {
  test.skip(process.env.VALET_SKIP_E2E === '1', 'VALET_SKIP_E2E=1')
  const report = await run('fake')
  expect(findings(report.result)).toEqual([])
  expect(report.result.steps.map((step) => `${step.method} ${step.path} ${step.status}`)).toEqual([
    'POST /apis/ui/Search/products 200',
    'GET /apis/ui/product/detail/88436 200',
    'GET /apis/ui/Trolley 200',
  ])
  // Nothing the reads or the fake's pages sent was refused. Chromium's own background requests
  // (component updates, say) are refused by the egress proxy too, and are left out here.
  expect(
    Object.keys(report.refused).filter((key) => key.startsWith('tool ') || key.includes('woolworths')),
  ).toEqual([])
})

test('dry run: a fake that changed shape is reported by field, never by value', async () => {
  test.skip(process.env.VALET_SKIP_E2E === '1', 'VALET_SKIP_E2E=1')
  const renamed = await run('fake', { SMOKE_FAKE_DRIFT: 'renamed-field' })
  expect(findings(renamed.result)).toEqual([
    'search Products[].Products[].Price: absent',
    'productDetail Product.Price: absent',
  ])
  const changed = await run('fake', { SMOKE_FAKE_DRIFT: 'changed-type' })
  expect(findings(changed.result)).toEqual([
    'search Products[].Products[].Stockcode: invalid_type, expected number, got string',
    'productDetail Product.Stockcode: invalid_type, expected number, got string',
  ])
  expect(JSON.stringify(changed)).not.toContain('Dairy Farmers')
})

test('live: woolworths.com.au has no drift (VALET_LIVE_SMOKE=1, Nick only)', async () => {
  test.skip(!live, 'live smoke runs only with VALET_LIVE_SMOKE=1, by Nick, by hand')
  const report = await run('live')
  expect(findings(report.result)).toEqual([])
  expect(report.result.steps).toHaveLength(3)
})
