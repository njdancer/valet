// Phones at the Mac's own address, end to end (docs/blind-relay.md#phones): the built app with the
// blind relay and a CA that really checks TLS-ALPN-01, and a test phone speaking the iPhone app's
// frames. There is no other way for a phone to reach the Mac: no hub, no Worker relay.
//
//   1. The Mac gets its certificate through the blind relay, and phones reach it there over TLS
//      that ends on the Mac, with remote access off.
//   2. A new phone pairs from the QR code, which names the Mac's own address, and approves an
//      agent's request there.
//   3. A request made while the phone is closed is there when it opens at the Mac's own address.
//   4. A cloud agent's sign-in is a card on the phone: the browser's code typed there and approved
//      with the phone's key signs the agent in, with the Mac left alone. Answered at the Mac
//      instead, the phone's card goes.
//   5. The Mac removes the phone: it is shut out at once.

import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { join } from 'node:path'
import { createSecureContext, connect as tlsConnect } from 'node:tls'
import { expect, type Page, test } from '@playwright/test'
import { generateP256, privateKeyPem, selfSignedCertificate, toPem } from '@valet/acme'
import { type RunningBlindRelay, startBlindRelay } from '@valet/blind-relay'
import { pairingCode, pairingOfferId, pairingSealKey } from '@valet/core'
import { type FakeAcme, startFakeAcme } from '@valet/fake-acme'
import { WebSocket as WsWebSocket } from 'ws'
import { Phone } from '../test/phone'
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

const CONTROL_HOST = 'blind.valet.test'
const MAC_DOMAIN = 'macs.valet.test'
const PREFIX = 'valet-pair:'

let blind: RunningBlindRelay
let blindPort = 0
let acme: FakeAcme
let userData: string
let launched: Launched
let control: Page
let client: McpClient
let phone: Phone
let macId = ''
let macHost = ''
const closers: (() => void)[] = []

const controlKeys = generateP256()
const controlPem = toPem(
  selfSignedCertificate(controlKeys, { names: [CONTROL_HOST], ips: ['127.0.0.1'] }),
  'CERTIFICATE',
)
const controlContext = createSecureContext({ key: privateKeyPem(controlKeys), cert: controlPem })

const lookup: LookupFunction = (_host, options, cb) => {
  if (typeof options === 'object' && options.all === true)
    (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 },
    ])
  else cb(null, '127.0.0.1', 4)
}

async function until<T>(check: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The phone at the Mac's own address: TLS for its name through the blind relay, trusting the CA. */
function atOwnAddress(p: Phone): void {
  p.url = `https://${macHost}`
  p.origin = `https://${macHost}`
  p.connect = (url) => {
    const target = new URL(url)
    target.port = String(blindPort)
    return new WsWebSocket(target.toString(), {
      ca: acme.rootPem,
      lookup,
    }) as unknown as WebSocket
  }
}

function closeCode(p: Phone): Promise<number> {
  return new Promise((resolve) => {
    const socket = p.socket
    if (socket === null || socket.readyState === WebSocket.CLOSED) return resolve(-1)
    socket.addEventListener('close', (event) => resolve((event as CloseEvent).code))
  })
}

async function reconnect(p: Phone): Promise<Record<string, unknown>> {
  const from = p.frames.length
  await p.dial((nonce) => p.hello(nonce))
  return until(() => p.frames.slice(from).find((f) => f['type'] === 'ready'))
}

/** A request from the agent, and the card for it on the phone. */
async function cardFor(setting: string, value: unknown, from = 0): Promise<Record<string, unknown>> {
  const asked = await callToolOnce(client, 'valet_set_setting', { setting, value })
  expect(asked.isError, asked.text).toBe(false)
  return until(() => phone.messages.slice(from).find((m) => m['type'] === 'approval-request'))
}

/** A request to the Mac's own address through the blind relay, as an agent or a browser makes it. */
function atMac(
  path: string,
  init: { method?: string; body?: string; type?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: macHost,
        port: blindPort,
        path,
        method: init.method ?? 'GET',
        headers: {
          host: macHost,
          ...(init.type === undefined ? {} : { 'content-type': init.type }),
          ...(init.body === undefined ? {} : { 'content-length': Buffer.byteLength(init.body) }),
        },
        ca: acme.rootPem,
        lookup,
        agent: false,
      },
      (res) => {
        let text = ''
        res.on('data', (c) => {
          text += String(c)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end(init.body)
  })
}

const REDIRECT = 'https://agent.example/callback'

/** A cloud agent starts to sign in: registered, its browser at the Mac's page with the code. */
async function startSignIn(name: string): Promise<{ code: string; wait: string; clientId: string }> {
  const registered = await atMac('/register', {
    method: 'POST',
    type: 'application/json',
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: name,
    }),
  })
  expect(registered.status, registered.text).toBe(201)
  const { client_id: clientId } = JSON.parse(registered.text) as { client_id: string }
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'abc',
    resource: `https://${macHost}/mcp`,
  })
  const page = await atMac(`/authorize?${query}`)
  expect(page.status, page.text).toBe(200)
  const code = /class="code">([A-Z]{4}-[A-Z]{4})</.exec(page.text)?.[1] ?? ''
  expect(code).toMatch(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/)
  const wait = (/url=([^"]+)"/.exec(page.text)?.[1] ?? '').replace(/&amp;/g, '&')
  expect(wait).not.toBe('')
  return { code, wait, clientId }
}

test.beforeAll(async () => {
  blind = await startBlindRelay({
    controlHost: CONTROL_HOST,
    macDomain: MAC_DOMAIN,
    controlCertificate: () => controlContext,
    port: 0,
    host: '127.0.0.1',
  })
  blindPort = blind.port
  acme = await startFakeAcme({ validationPort: blindPort })
  userData = tempDir('phones-blind')
  const caFile = join(userData, '..', `phones-blind-ca-${process.pid}.pem`)
  writeFileSync(caFile, controlPem)
  launched = await launch(userData, appDir, {
    env: {
      VALET_BLIND_RELAY: CONTROL_HOST,
      VALET_BLIND_MAC_DOMAIN: MAC_DOMAIN,
      VALET_BLIND_RELAY_CONNECT: `wss://127.0.0.1:${blindPort}`,
      VALET_ACME_DIRECTORY: acme.directoryUrl,
      VALET_MAC_NAME: 'Test Mac',
      NODE_EXTRA_CA_CERTS: caFile,
    },
  })
  control = await windowWithTitle(launched.app, CONTROL)
  client = await connectMcp(control, userData, 'Claude Code')
})

test.afterAll(async () => {
  for (const close of closers) close()
  await client?.close().catch(() => undefined)
  await launched?.close()
  await blind?.close()
  await acme?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

test('the Mac serves phones at its own address, with remote access off', async () => {
  await expect.poll(() => blind.macs().length, { timeout: 60_000 }).toBe(1)
  macId = blind.macs()[0] as string
  macHost = `${macId}.${MAC_DOMAIN}`
  // The certificate comes through the blind relay; remote access stays off throughout (e2e's default).
  await expect.poll(() => acme.validations.length, { timeout: 60_000 }).toBe(1)
  expect(acme.validations[0]).toEqual({ name: macHost, ok: true, why: 'ok' })
  // A phone's request is answered with the Mac's own certificate, through a relay that only reads names.
  await expect
    .poll(
      () =>
        new Promise<string>((resolve) => {
          const socket = tlsConnect({
            host: '127.0.0.1',
            port: blindPort,
            servername: macHost,
            ca: acme.rootPem,
            ALPNProtocols: ['http/1.1'],
          })
          let text = ''
          socket.on('secureConnect', () =>
            socket.write(`GET /v1/phone/${macId} HTTP/1.1\r\nhost: ${macHost}\r\nconnection: close\r\n\r\n`),
          )
          socket.on('data', (c) => {
            text += String(c)
          })
          socket.on('close', () => resolve(text.split('\r\n')[0] ?? ''))
          socket.on('error', (e) => resolve(String(e)))
        }),
      { timeout: 60_000 },
    )
    // No WebSocket upgrade asked for, so the door says there's nothing else here.
    .toBe('HTTP/1.1 404 Not Found')
})

test('a new phone pairs from the QR code, which names the Mac’s own address', async () => {
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
  expect(offer.macId).toBe(macId)
  expect(offer.relay).toBe(`https://${macHost}`)
  const offerId = pairingOfferId(offer.secret)
  const key = pairingSealKey(offer.secret, offer.macId)
  phone = new Phone(`https://${macHost}`, offer.macId, offer.macAgreementKey, offer.relay, (c) =>
    closers.push(c),
  )
  atOwnAddress(phone)
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
  await closeCode(phone)
  await reconnect(phone)
  expect(
    phone.frames.find((f) => f['type'] === 'challenge' && f['relay'] === `https://${macHost}`),
  ).toBeDefined()
  await until(() => phone.messages.find((m) => m['type'] === 'status'))
  // Settings › Devices shows it connected.
  await expect(control.getByText('Test iPhone', { exact: true })).toBeVisible()
})

test('an agent’s request reaches the phone at the Mac’s own address, and its approval comes back', async () => {
  const card = await cardFor('traceRetentionDays', 7)
  await phone.send({ type: 'ack', ackSeq: card['seq'] })
  await phone.send({ type: 'approval-decision', decision: phone.approve(String(card['requestText']), macId) })
  await expect
    .poll(async () => (await callToolOnce(client, 'valet_get_approval', {})).text, { timeout: 20_000 })
    .toMatch(/approved/i)
})

test('a request made while the phone is closed is there when it opens at the Mac’s own address', async () => {
  phone.socket?.close()
  await new Promise((r) => setTimeout(r, 500))
  const asked = await callToolOnce(client, 'valet_set_setting', { setting: 'traceRetentionDays', value: 2 })
  expect(asked.isError, asked.text).toBe(false)
  const before = phone.messages.length
  await reconnect(phone)
  const card = await until(() => phone.messages.slice(before).find((m) => m['type'] === 'approval-request'))
  const request = JSON.parse(String(card['requestText'])) as { id: string }
  await phone.send({ type: 'approval-decline', requestId: request.id, note: 'Later' })
  await expect
    .poll(async () => (await callToolOnce(client, 'valet_get_approval', {})).text, { timeout: 20_000 })
    .toMatch(/declined/i)
})

test('a cloud agent’s sign-in is a card on the phone, and the code typed there signs it in', async () => {
  // A site cloud agents may use: the fake shop, approved, its search on for remote.
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  const hash = pending?.find((p) => p.adapterId === 'woolworths')?.to.hash ?? ''
  await control.evaluate((h) => window.valet?.approvals.approve('woolworths', h), hash)
  await control.evaluate(() => window.valet?.remote.setEnabled(true))
  await control.evaluate(() => window.valet?.remote.setTool('woolworths', 'search_products', true))

  const before = phone.messages.length
  const { code, wait, clientId: registeredId } = await startSignIn('Claude')
  const card = await until(() =>
    phone.messages
      .slice(before)
      .find(
        (m) =>
          m['type'] === 'approval-request' && JSON.parse(String(m['requestText'])).kind === 'remote-client',
      ),
  )
  const request = JSON.parse(String(card['requestText'])) as {
    id: string
    subject: { host: string; tools: string[] }
  }
  // The card names the agent by its claimed host and offers the tools that only read; never the code.
  expect(request.subject.host).toBe('agent.example')
  expect(request.subject.tools).toEqual(['woolworths.search_products'])
  expect(String(card['requestText'])).not.toContain(code)
  await phone.send({ type: 'ack', ackSeq: card['seq'] })

  // A wrong code from the phone doesn't sign anyone in.
  await phone.send({
    type: 'approval-decision',
    decision: phone.approve(
      String(card['requestText']),
      macId,
      code === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH',
    ),
  })
  expect((await atMac(wait)).status).toBe(200)

  // The right code, typed on the phone: the browser goes on to the agent with its sign-in code.
  await phone.send({
    type: 'approval-decision',
    decision: phone.approve(String(card['requestText']), macId, code),
  })
  // The browser's waiting page goes on once, so keep the answer that does.
  const seen: { back: Awaited<ReturnType<typeof atMac>> | null } = { back: null }
  await expect
    .poll(
      async () => {
        seen.back = await atMac(wait)
        return seen.back.status
      },
      { timeout: 20_000 },
    )
    .toBe(302)
  const location = new URL(String(seen.back?.headers['location'] ?? 'https://x.invalid/'))
  expect(location.origin + location.pathname).toBe(REDIRECT)
  // The agent redeems it: its token is for the tools the phone's card offered.
  const token = await atMac('/token', {
    method: 'POST',
    type: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registeredId,
      code: location.searchParams.get('code') ?? '',
      code_verifier: 'v'.repeat(64),
      redirect_uri: REDIRECT,
    }).toString(),
  })
  expect(token.status, token.text).toBe(200)
  const clients = await control.evaluate(() => window.valet?.remote.clients())
  expect(clients?.find((c) => c.host === 'agent.example')?.grant?.tools, JSON.stringify(clients)).toEqual([
    'woolworths.search_products',
  ])
})

test('a sign-in answered at the Mac takes its card off the phone', async () => {
  const before = phone.messages.length
  const { code } = await startSignIn('Other agent')
  const card = await until(() =>
    phone.messages
      .slice(before)
      .find(
        (m) =>
          m['type'] === 'approval-request' && JSON.parse(String(m['requestText'])).kind === 'remote-client',
      ),
  )
  const request = JSON.parse(String(card['requestText'])) as { id: string }
  await control.evaluate(() => {
    window.location.hash = '#/connections/approve'
  })
  const sheet = control.getByRole('dialog')
  await sheet.getByLabel('Code from your browser').fill(code)
  await sheet.getByRole('button', { name: 'Approve' }).click()
  await expect(sheet.getByText(/^Approved\./)).toBeVisible()
  await until(() =>
    phone.messages
      .slice(before)
      .find((m) => m['type'] === 'approval-closed' && m['requestId'] === request.id),
  )
})

test('the Mac removes the phone: it is shut out at its own address at once', async () => {
  const closed = closeCode(phone)
  const removed = await control.evaluate(async (id) => {
    await window.valet?.phones.remove(id)
    return true
  }, phone.deviceId)
  expect(removed).toBe(true)
  expect(await closed).toBe(4403)
  await phone.dial((nonce) => phone.hello(nonce))
  expect(await closeCode(phone)).toBe(4401)
})
