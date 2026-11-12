// Pairing a phone with the built app, and approving an agent's request on it (docs/phone-channel.md):
// the app's Settings › Devices sheet, the real relay in a local Workers runtime, and a phone written
// with core's primitives that speaks the relay's frames as the iPhone app does. The walkthrough
// (walkthrough.spec.ts) runs the same story with the real iPhone app in the simulator.

import { type ChildProcess, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { pairingCode, pairingOfferId, pairingSealKey } from '@valet/core'
import { Phone } from '../../relay/test/phone'
import {
  appDir,
  CONTROL,
  callToolOnce,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

const RELAY_PORT = 8797
const RELAY_ORIGIN = 'https://relay.valet.test'
const PREFIX = 'valet-pair:'

let relay: ChildProcess
let userData: string
let launched: Launched
let control: Page
let client: McpClient
let phone: Phone
let macId = ''
const closers: (() => void)[] = []

async function until<T>(check: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

test.beforeAll(async () => {
  relay = spawn('node', [join(appDir, '../relay/scripts/local.mjs'), '--port', String(RELAY_PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve) =>
    relay.stdout?.on('data', (c) => /relay listening/.test(String(c)) && resolve()),
  )
  userData = tempDir('phones')
  launched = await launch(userData, appDir, {
    env: {
      VALET_RELAY_ORIGIN: RELAY_ORIGIN,
      VALET_RELAY_CONNECT: `http://127.0.0.1:${RELAY_PORT}`,
      VALET_MAC_NAME: 'Test Mac',
    },
  })
  control = await windowWithTitle(launched.app, CONTROL)
  client = await connectMcp(control, userData, 'Claude Code')
})

test.afterAll(async () => {
  for (const close of closers) close()
  await client?.close().catch(() => undefined)
  await launched?.close()
  relay?.kill('SIGINT')
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

test('pairs a phone from Settings › Devices', async () => {
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await expect(control.getByText(/Connected to the relay/)).toBeVisible({ timeout: 30_000 })
  await control.getByRole('button', { name: 'Pair an iPhone' }).click()
  const qr = control.locator('svg[data-pairing-qr]')
  await qr.waitFor()
  const text = (await qr.getAttribute('data-pairing-qr')) ?? ''
  expect(text.startsWith(PREFIX)).toBe(true)
  const offerText = Buffer.from(text.slice(PREFIX.length), 'base64url').toString()
  const offer = JSON.parse(offerText)
  macId = offer.macId
  const offerId = pairingOfferId(offer.secret)
  const key = pairingSealKey(offer.secret, offer.macId)
  phone = new Phone(`http://127.0.0.1:${RELAY_PORT}`, offer.macId, offer.macAgreementKey, RELAY_ORIGIN, (c) =>
    closers.push(c),
  )
  await phone.dial(() => undefined)
  const reply = phone.sendPairingReply(offer, offerId, key, 'Test iPhone')
  const challenge = await until(() => phone.frames.find((f) => f['type'] === 'pairing-challenge'))
  const code = pairingCode(offer.secret, offer.macId, offerText, reply, challenge['macNonce'] as string)
  const dialog = control.getByRole('dialog')
  await dialog.getByRole('button', { name: `${code.slice(0, 3)} ${code.slice(3)}` }).click()
  await expect(dialog.getByText(/Test iPhone gets Valet’s approvals now/)).toBeVisible()
  await until(() => phone.frames.find((f) => f['type'] === 'pairing-result'))
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(control.getByText('Test iPhone', { exact: true })).toBeVisible()
  phone.socket?.close()
  await phone.dial((nonce) => phone.hello(nonce))
  await until(() => phone.frames.find((f) => f['type'] === 'ready'))
  await until(() => phone.messages.find((m) => m['type'] === 'status'))
})

test('an agent’s request reaches the phone, and its approval comes back', async () => {
  const asked = await callToolOnce(client, 'valet_set_setting', { setting: 'traceRetentionDays', value: 7 })
  expect(asked.isError, asked.text).toBe(false)
  const card = await until(() => phone.messages.find((m) => m['type'] === 'approval-request'))
  await phone.send({ type: 'ack', ackSeq: card['seq'] })
  await phone.send({ type: 'approval-decision', decision: phone.approve(String(card['requestText']), macId) })
  await expect
    .poll(async () => (await callToolOnce(client, 'valet_get_approval', {})).text, { timeout: 20_000 })
    .toMatch(/approved/i)
  const settings = await control.evaluate(() => window.valet?.settings.get())
  expect(settings?.traceRetentionDays).toBe(7)
})

test('a request made while the phone is closed is there when it opens, and a decline reaches the agent', async () => {
  phone.socket?.close()
  await new Promise((r) => setTimeout(r, 500))
  const asked = await callToolOnce(client, 'valet_set_setting', {
    setting: 'messagesOtpEnabled',
    value: true,
  })
  expect(asked.isError, asked.text).toBe(false)
  const before = phone.messages.length
  await phone.dial((nonce) => phone.hello(nonce))
  const card = await until(() =>
    phone.messages
      .slice(before)
      .find((m) => m['type'] === 'approval-request' && String(m['requestText']).includes('messages')),
  )
  const request = JSON.parse(String(card['requestText'])) as { id: string }
  await phone.send({ type: 'approval-decline', requestId: request.id, note: 'Not now' })
  await expect
    .poll(async () => (await callToolOnce(client, 'valet_get_approval', {})).text, { timeout: 20_000 })
    .toMatch(/declined/i)
})
