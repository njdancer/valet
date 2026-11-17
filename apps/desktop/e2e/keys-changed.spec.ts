// This Mac's approval keys are lost and made again (persona QA: the cautious person's Mac). What the
// old keys signed stops counting, which is the safe outcome, and stays so: the site is off and its
// logins aren't handed out. What this checks is that the app says why, in plain words, in Needs you
// and on the site, rather than reading as a first run; and that once the person approves and grants
// again the notice goes, with no "Ready" over a grant that still doesn't count on the way.
//
// No login runs, so the fake shop's pacing doesn't slow it.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  CONTROL,
  COPY_ITEM_TITLE,
  connectFakeOnePassword,
  type Launched,
  launch,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial', timeout: 300_000 })

let userData = ''
let launched: Launched | null = null
let control: Page

function app(): Launched {
  if (launched === null) throw new Error('not launched')
  return launched
}

async function route(hash: string): Promise<void> {
  await control.evaluate((hash) => {
    window.location.hash = hash
  }, hash)
}

async function attentionKinds(): Promise<string[]> {
  return control.evaluate(async () => ((await window.valet?.attention.list()) ?? []).map((i) => i.kind))
}

test.beforeAll(() => {
  userData = tempDir('keys-changed')
})

test.afterAll(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('approved and granted, setup finished', async () => {
  launched = await launch(userData)
  control = await windowWithTitle(app().app, CONTROL)
  await connectFakeOnePassword(app(), control)
  await route('#/sites')
  await control
    .getByRole('link', { name: /^Review Woolworths/ })
    .first()
    .click()
  const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
  if (await ack.isVisible().catch(() => false)) await ack.check()
  await control
    .getByRole('button', { name: /^Approve / })
    .first()
    .click()
  const sheet = control.getByRole('dialog')
  await sheet.getByText(COPY_ITEM_TITLE).click()
  await sheet.getByRole('button', { name: 'Use this login' }).click()
  await sheet.waitFor({ state: 'hidden' })
  await route('#/sites/woolworths')
  await control.getByRole('link', { name: 'Choose…' }).first().click()
  await sheet.getByRole('button', { name: 'Allow these codes' }).click()
  await sheet.waitFor({ state: 'hidden' })
  await control.evaluate(() => window.valet?.setup.finish())
  const grants = await control.evaluate(() => window.valet?.grants.list())
  expect(grants?.map((g) => g.secret).sort()).toEqual(['login', 'messages'])
  expect(await attentionKinds()).not.toContain('keys-changed')
})

test('the keys are lost: Valet says so in plain words, and trusts nothing the old keys signed', async () => {
  await app().close()
  // Only the keys: deleting the ledger's anchor would read as tampering and lock Valet down.
  rmSync(join(userData, 'dev-approval-keys.json'))
  launched = await launch(userData)
  control = await windowWithTitle(app().app, CONTROL)
  await connectFakeOnePassword(app(), control)

  // Still safe: not approved, nothing handed out.
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.approval).toBe('unapproved')
  expect(detail?.approvedBefore).toBe(true)
  expect(await control.evaluate(() => window.valet?.grants.list())).toEqual([])

  await route('#/needs-you')
  const list = control.getByRole('list', { name: 'Waiting for you' })
  await expect(list.getByText('This Mac’s approval keys changed', { exact: true })).toBeVisible()
  await expect(list).toContainText(
    'The approvals and logins you gave before no longer count. Review each site again to turn it back on: Woolworths (approve again, login, SMS codes).',
  )
  await expect(list.getByText('Approve Woolworths again')).toBeVisible()
  await expect(control.getByText('Review Woolworths before first use')).toHaveCount(0)
  // Setup was finished before; the keys item says what to do, not a first-run "Finish setup".
  await expect(control.getByText(/^Finish setup/)).toHaveCount(0)

  const log = join(userData, 'logs', 'valet.log')
  expect(existsSync(log) && readFileSync(log, 'utf8').includes('approval-keys-changed')).toBe(true)

  await route('#/sites/woolworths')
  await expect(control.getByText('Approve Woolworths again: this Mac’s approval keys changed.')).toBeVisible()
  await expect(control.getByText('Not approved yet')).toHaveCount(0)
})

test('approved and granted again: no "Ready" over the lapsed code grant, then the notice goes', async () => {
  await route('#/needs-you')
  await control.getByRole('button', { name: 'Review Woolworths again' }).click()
  await expect(control.getByRole('heading', { name: 'Approve Woolworths again' })).toBeVisible()
  await control
    .getByRole('button', { name: /^Approve / })
    .first()
    .click()
  const sheet = control.getByRole('dialog')
  await sheet.getByText(COPY_ITEM_TITLE).click()
  await sheet.getByRole('button', { name: 'Use this login' }).click()
  await sheet.waitFor({ state: 'hidden' })

  // The code grant still in grants.json doesn't count: the site says so, never "Ready". (No store was
  // chosen here, so that leads the health line; site-status's own tests cover the line without it.)
  await route('#/sites/woolworths')
  await expect(control.getByText('Not now: what you allowed before no longer counts')).toBeVisible()
  await expect(control.getByText('Ready', { exact: true })).toHaveCount(0)
  const summary = await control.evaluate(async () =>
    (await window.valet?.adapters.list())?.find((a) => a.id === 'woolworths'),
  )
  expect(summary?.messagesSources.every((m) => !m.granted && m.lapsed === true)).toBe(true)
  expect(await attentionKinds()).toContain('keys-changed')

  await control.getByRole('link', { name: 'Choose…' }).first().click()
  await sheet.getByRole('button', { name: 'Allow these codes' }).click()
  await sheet.waitFor({ state: 'hidden' })
  await expect.poll(attentionKinds).not.toContain('keys-changed')
  await expect(control.getByText('Not now: what you allowed before no longer counts')).toHaveCount(0)
  const grants = await control.evaluate(() => window.valet?.grants.list())
  expect(grants?.map((g) => g.secret).sort()).toEqual(['login', 'messages'])
})
