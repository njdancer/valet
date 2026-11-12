// Adapter packages (docs/adapter-packages.md), in the built app. The built-ins are seeded into the
// adapter store at launch; a development folder installs a new version (the native picker is
// replaced by VALET_E2E_INSTALL_FOLDER, which only an e2e launch reads), whose review shows the
// permission diff and where it came from; approved, it serves; rolled back from the Sites page, the
// approved built-in serves again. A version tampered with on disk is refused at the next launch,
// audited, and the built-in heals from the app's own copy.
//
// Wikipedia carries the flow (no login, and no tool is called, so nothing reaches its real site).
// Woolworths only shows that a folder version of a site that logs in says it takes the session.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { appWindows, CONTROL, type Launched, launch, tempDir, windowWithTitle } from './harness'

test.describe.configure({ mode: 'serial' })

let userData: string
let folder: string
let launched: Launched | null = null
let control: Page
let builtinHash = ''
let folderHash = ''

interface StoredState {
  readonly active: string
  readonly pinned: boolean
  readonly versions: readonly { readonly hash: string; readonly source: string }[]
}

function storedState(id: string): StoredState {
  return JSON.parse(readFileSync(join(userData, 'adapters', id, 'state.json'), 'utf8')) as StoredState
}

function storedFiles(id: string, hash: string): Record<string, string> {
  const stored = JSON.parse(readFileSync(join(userData, 'adapters', id, `${hash}.json`), 'utf8')) as {
    files: Record<string, string>
  }
  return stored.files
}

function writeFolder(files: Readonly<Record<string, string>>): void {
  rmSync(folder, { recursive: true, force: true })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), text)
  }
}

function adapterEvents(): { type: string; adapterId?: string; adapterHash?: string; reason?: string }[] {
  return readFileSync(join(userData, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { event: { type: string } }).event)
    .filter((e) => e.type.startsWith('adapter-'))
}

async function relaunch(): Promise<void> {
  await launched?.close()
  launched = await launch(userData, undefined, { installFolder: folder })
  control = await windowWithTitle(launched.app, CONTROL)
}

test.beforeAll(() => {
  userData = tempDir('packages')
  folder = join(tempDir('packages-folder'), 'wikipedia')
})

test.afterAll(async () => {
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
  if (folder !== undefined) rmSync(dirname(folder), { recursive: true, force: true })
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (launched !== null && testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of appWindows(launched.app).entries())
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

test('the built-ins are seeded into the store and load from it', async () => {
  await relaunch()
  for (const id of ['woolworths', 'yahoo-finance', 'wikipedia']) {
    const state = storedState(id)
    expect(state.versions.map((v) => v.source)).toEqual(['builtin'])
    expect(state.pinned).toBe(false)
  }
  const detail = await control.evaluate(() => window.valet?.adapters.get('wikipedia'))
  builtinHash = detail?.hash ?? ''
  expect(storedState('wikipedia').active).toBe(builtinHash)
  await control.evaluate((hash) => window.valet?.approvals.approve('wikipedia', hash), builtinHash)
  expect((await control.evaluate(() => window.valet?.adapters.get('wikipedia')))?.approval).toBe('approved')
})

test('a folder version waits for review with its permission diff, and serves once approved', async () => {
  const files = { ...storedFiles('wikipedia', builtinHash) }
  const manifest = JSON.parse(files['manifest.json'] ?? '{}') as { version: string; egress: string[] }
  manifest.version = '0.2.0'
  manifest.egress = [...manifest.egress, 'upload.wikimedia.org']
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  writeFolder(files)

  const installed = await control.evaluate(() => window.valet?.adapters.installFromFolder())
  expect(installed).toMatchObject({ ok: true, adapterId: 'wikipedia' })
  folderHash = installed?.ok === true ? installed.hash : ''
  expect(folderHash).not.toBe(builtinHash)

  const review = (await control.evaluate(() => window.valet?.approvals.pending()))?.find(
    (p) => p.adapterId === 'wikipedia',
  )
  expect(review?.from?.hash).toBe(builtinHash)
  expect(review?.to).toEqual({ version: '0.2.0', hash: folderHash })
  expect(review?.origin).toBe('folder')
  expect(review?.takesSession).toBe(false)
  expect(JSON.stringify(review?.diff)).toContain('upload.wikimedia.org')
  // The review page says it isn't the app's own and runs without the sandbox.
  await control.evaluate(() => {
    location.hash = '#/sites/wikipedia/versions/review'
  })
  await expect(control.getByText(/folder/i).first()).toBeVisible()

  await control.evaluate((hash) => window.valet?.approvals.approve('wikipedia', hash), folderHash)
  const detail = await control.evaluate(() => window.valet?.adapters.get('wikipedia'))
  expect(detail?.hash).toBe(folderHash)
  expect(detail?.approval).toBe('approved')
  expect(storedState('wikipedia').active).toBe(folderHash)
})

test('a broken folder is refused in words, and nothing is stored', async () => {
  const files = { ...storedFiles('wikipedia', folderHash) }
  files['src/tools.ts'] = `${files['src/tools.ts']}\nimport './missing'\n`
  writeFolder(files)
  const before = storedState('wikipedia').versions.length
  const refused = await control.evaluate(() => window.valet?.adapters.installFromFolder())
  expect(refused?.ok).toBe(false)
  expect(refused?.ok === false ? refused.reason : '').toMatch(/did not load \(compile\)/)
  expect(storedState('wikipedia').versions).toHaveLength(before)
})

test('a folder version of a site that logs in says it takes the session', async () => {
  const state = storedState('woolworths')
  const files = { ...storedFiles('woolworths', state.active) }
  const manifest = JSON.parse(files['manifest.json'] ?? '{}') as { version: string }
  manifest.version = '9.9.9'
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  writeFolder(files)
  const installed = await control.evaluate(() => window.valet?.adapters.installFromFolder())
  expect(installed).toMatchObject({ ok: true, adapterId: 'woolworths' })
  const review = (await control.evaluate(() => window.valet?.approvals.pending()))?.find(
    (p) => p.adapterId === 'woolworths',
  )
  expect(review?.origin).toBe('folder')
  expect(review?.takesSession).toBe(true)
  const hash = installed?.ok === true ? installed.hash : ''
  await control.evaluate((h) => window.valet?.approvals.reject('woolworths', h), hash)
})

test('rolling back from the Sites page brings the approved built-in back, pinned', async () => {
  await control.evaluate(() => {
    location.hash = '#/sites/wikipedia/versions'
  })
  const kept = control.getByRole('table', { name: 'Wikipedia kept versions' })
  await expect(kept).toBeVisible()
  await kept.getByRole('button', { name: 'Roll back to 0.1.0' }).click()
  // The diff is against the version in use: going back drops upload.wikimedia.org, so nothing widens.
  const dialog = control.getByRole('alertdialog')
  await expect(dialog).toContainText('It can’t reach anything the version in use can’t.')
  await dialog.getByRole('button', { name: 'Roll back to 0.1.0' }).click()
  // The swap comes first and the approval right after it, so wait for both.
  await expect
    .poll(async () => {
      const adapter = await control.evaluate(() => window.valet?.adapters.get('wikipedia'))
      return [adapter?.hash, adapter?.approval]
    })
    .toEqual([builtinHash, 'approved'])
  // The state file is written after the in-memory swap, so wait for it too rather than reading it once.
  await expect
    .poll(() => {
      try {
        const state = storedState('wikipedia')
        return [state.active, state.pinned]
      } catch {
        return null // caught mid-write
      }
    })
    .toEqual([builtinHash, true])
  expect(
    adapterEvents()
      .filter((e) => e.adapterId === 'wikipedia')
      .map((e) => e.type),
  ).toEqual([
    'adapter-installed',
    'adapter-approved',
    'adapter-installed',
    'adapter-approved',
    'adapter-approved',
    'adapter-activated',
  ])
})

test('a version tampered with on disk is refused at launch, and the built-in heals', async () => {
  await launched?.close()
  launched = null
  const path = join(userData, 'adapters', 'wikipedia', `${builtinHash}.json`)
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, string> }
  stored.files['src/tools.ts'] = `${stored.files['src/tools.ts']}\n// changed on disk\n`
  writeFileSync(path, JSON.stringify(stored))

  await relaunch()
  expect(adapterEvents()).toContainEqual(
    expect.objectContaining({ type: 'adapter-refused', adapterId: 'wikipedia', adapterHash: builtinHash }),
  )
  // The app's own copy is written back over it: the same hash, so the approval still holds.
  const detail = await control.evaluate(() => window.valet?.adapters.get('wikipedia'))
  expect(detail?.hash).toBe(builtinHash)
  expect(detail?.approval).toBe('approved')
  expect(storedFiles('wikipedia', builtinHash)['src/tools.ts']).not.toContain('changed on disk')
})
