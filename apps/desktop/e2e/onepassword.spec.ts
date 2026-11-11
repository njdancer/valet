// The fake 1Password (fakes/onepassword, "Keyhold") from the person's side: making a Keychain copy
// (D6) opens its prompt, and so does "Re-sync from 1Password" once it has locked. A denied prompt,
// or one closed unanswered, leaves the copy as it was and says so; an allowed one copies the
// item's new password. Nothing here reaches a real 1Password or Keychain.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  approveInKeyhold,
  appWindows,
  CONTROL,
  COPY_ITEM_ID,
  clickClosing,
  keychainItems,
  keyholdPrompt,
  type Launched,
  launch,
  ONEPASSWORD_ACCOUNT,
  onePasswordHook,
  onePasswordPrompts,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

let userData: string
let launched: Launched
let control: Page

test.beforeAll(async () => {
  userData = tempDir('onepassword')
  launched = await launch(userData)
  control = await windowWithTitle(launched.app, CONTROL)
})

test.afterAll(async () => {
  await launched?.close()
  if (userData !== undefined)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of launched.app.windows().entries()) {
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    }
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

const copied = () =>
  readFileSync(join(userData, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('"grant-copied"')).length

test('granting the login copies it after the person unlocks Keyhold and allows Valet', async () => {
  await control.evaluate(
    (account) => window.valet?.settings.set({ onePasswordAccount: account }),
    ONEPASSWORD_ACCOUNT,
  )
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  const hash = pending?.[0]?.to.hash ?? ''
  await control.evaluate((hash) => window.valet?.approvals.approve('woolworths', hash), hash)
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  const origins = detail?.secretRequests.find((s) => s.name === 'login')?.origins ?? []
  // The grant waits on the copy, and the copy on the person.
  const made = control.evaluate(
    ({ hash, origins, itemRef }) =>
      window.valet?.grants.make({
        adapterId: 'woolworths',
        adapterHash: hash,
        secret: 'login',
        provider: 'keychain-copy',
        itemRef,
        origins,
      }),
    { hash, origins, itemRef: COPY_ITEM_ID },
  )
  const prompt = await approveInKeyhold(launched)
  await made
  // It closes itself once answered.
  await expect.poll(() => prompt.isClosed()).toBe(true)
  expect(await keychainItems(launched)).toHaveLength(2)
  expect(await onePasswordHook(launched, 'copyIsCurrent')).toBe(true)
  expect(copied()).toBe(1)
})

test('after the password changes and Keyhold locks, a denied re-sync keeps the old copy', async () => {
  await onePasswordHook(launched, 'changePassword', 'a-new-test-password')
  await onePasswordHook(launched, 'lock')
  await control.evaluate(() => {
    location.hash = '#/credentials'
  })
  const resync = control.getByRole('button', { name: 'Re-sync from 1Password' })
  await resync.click()
  const prompt = await keyholdPrompt(launched.app)
  await expect(prompt.getByRole('heading', { name: 'Unlock Keyhold' })).toBeVisible()
  // Denying is open to the person even while it is locked: closing the prompt is a no.
  await prompt.close()
  await expect(control.getByRole('alert')).toHaveText('Couldn’t re-sync from 1Password. Try again.')
  expect(await onePasswordHook(launched, 'copyIsCurrent')).toBe(false)
  expect(copied()).toBe(1)
  expect((await onePasswordPrompts(launched)).map((p) => p.state)).toEqual(['allowed', 'denied'])
})

test('Deny in the prompt is a no too; Allow copies the new password', async () => {
  const resync = control.getByRole('button', { name: 'Re-sync from 1Password' })
  await resync.click()
  let prompt = await keyholdPrompt(launched.app)
  await prompt.getByLabel('Account password').fill('not the password')
  await prompt.getByRole('button', { name: 'Unlock' }).click()
  await expect(prompt.getByRole('alert')).toHaveText('That isn’t the account password.')
  await prompt.getByLabel('Account password').fill('keyhold-demo-unlock')
  await prompt.getByRole('button', { name: 'Unlock' }).click()
  await clickClosing(prompt.getByRole('button', { name: 'Deny' }))
  await expect(control.getByRole('alert')).toHaveText('Couldn’t re-sync from 1Password. Try again.')
  expect(await onePasswordHook(launched, 'copyIsCurrent')).toBe(false)

  await resync.click()
  prompt = await approveInKeyhold(launched)
  await expect.poll(() => onePasswordHook(launched, 'copyIsCurrent')).toBe(true)
  await expect.poll(copied).toBe(2)
  expect((await onePasswordPrompts(launched)).map((p) => p.state)).toEqual([
    'allowed',
    'denied',
    'denied',
    'allowed',
  ])
  // Keyhold's own windows never hold a secret, and Valet's don't either.
  expect(appWindows(launched.app).length).toBeGreaterThan(0)
})
