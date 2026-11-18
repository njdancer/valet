// The Valet account end to end (docs/relay-hub.md), the way Nick met it on 2026-11-17: the built
// app, the real relay and hub in a local Workers runtime, Playwright's Chromium as the person's
// browser (a virtual passkey, real cookies), and the MCP SDK's own OAuth client as the agent.
//
//   1. Sign up on the hub and put the Mac on the account from Settings › Devices.
//   2. An agent signs in: its browser shows a code, typed into the Mac's Approve sheet; the browser
//      carries on, and the agent lists and calls the Mac's tools at the hub's one address.
//   3. Several sign-ins at once: a stale one beside a fresh one, the code picks; each declines.
//   4. Connections lists the agent approved through the account, and removes it everywhere.
//   5. The Mac gets new keys (as after the 2026-11-17 key loss): removed on the hub's page, added
//      again, and a sign-in works again.
//   6. A phone on the account (step 4c): paired once, it goes on the account's device list and
//      reads the account at the hub. The Mac loses its keys again; the phone adds the new Mac, and
//      nobody pairs again: the phone's approvals reach the new Mac, and the agent's sign-in, which
//      the old Mac approved, still works.
//   7. A new iPhone signs in to the account with the passkey (step 4d): no QR code, no pairing and
//      nothing on the Mac. The Mac put the account's passkey on the list by itself; the passkey
//      signs the phone in on the hub's page; the Mac then trusts the phone and its approvals.
//
// Nothing here is mocked between the parts: every bug the first live sign-in found sat between them.

import { type ChildProcess, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { type Browser, type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import { joinRecordDevice, pairingCode, pairingOfferId, pairingSealKey } from '@valet/core'
import { HubPhone } from '../../relay/test/hub-phone'
import { Phone } from '../../relay/test/phone'
import {
  appDir,
  appWindows,
  CONTROL,
  callToolOnce,
  chooseStore,
  connectMcp,
  type Launched,
  launch,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

const PORT = 8801
/** The hub's pages, as the person's browser and the agent reach them. */
const HUB = `http://localhost:${PORT}`
/** Where the agent's sign-in comes back to: a page that only says so (a route can't catch a redirect). */
const REDIRECT = 'http://127.0.0.1:48123/callback'
const MAC_NAME = 'Test Mac'
const RELAY_ORIGIN = 'https://relay.valet.test'
const RELAY_CONNECT = `http://127.0.0.1:${PORT}`
const SETUP_SECRET = 'e2e-setup-secret'

let relay: ChildProcess
let relayData: string
let userData: string
let launched: Launched
let control: Page
let browser: Browser
let person: BrowserContext
let hubPage: Page
let callback: Server

async function startApp(): Promise<void> {
  launched = await launch(userData, appDir, {
    env: {
      VALET_RELAY_ORIGIN: RELAY_ORIGIN,
      VALET_RELAY_CONNECT: RELAY_CONNECT,
      VALET_MAC_NAME: MAC_NAME,
    },
  })
  control = await windowWithTitle(launched.app, CONTROL)
}

/** The relay and hub in a local Workers runtime, keeping their storage across restarts. */
async function startRelay(): Promise<void> {
  relay = spawn(
    'node',
    [
      join(appDir, '../relay/scripts/local.mjs'),
      ...['--port', String(PORT), '--origin', RELAY_ORIGIN],
      ...['--hub-origin', HUB, '--hub-setup', SETUP_SECRET, '--persist', relayData],
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  await new Promise<void>((resolve) =>
    relay.stdout?.on('data', (c) => /relay listening/.test(String(c)) && resolve()),
  )
}

test.beforeAll(async () => {
  callback = createServer((_request, response) => response.end('signed in'))
  await new Promise<void>((resolve) => callback.listen(Number(new URL(REDIRECT).port), '127.0.0.1', resolve))
  relayData = tempDir('hub-relay')
  await startRelay()
  userData = tempDir('hub')
  await startApp()
  const executablePath = process.env['HUB_CHROMIUM']
  browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  person = await browser.newContext()
  hubPage = await person.newPage()
  const cdp = await person.newCDPSession(hubPage)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
})

test.afterAll(async () => {
  await browser?.close()
  callback?.close()
  await launched?.close()
  relay?.kill('SIGINT')
  if (relayData !== undefined) rmSync(relayData, { recursive: true, force: true })
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of appWindows(launched.app).entries())
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

/** Puts the Mac on the account: its code from Settings › Devices, typed on the hub's page. */
async function linkMac(): Promise<void> {
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await expect(control.getByText(/Connected to the relay/)).toBeVisible({ timeout: 30_000 })
  await control.getByRole('button', { name: 'Connect to your Valet account' }).click()
  const code =
    (await control
      .locator('[data-value-copy], .font-mono')
      .filter({ hasText: /^[A-Z]{4}-[A-Z]{4}$/ })
      .first()
      .textContent()) ?? ''
  expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
  await hubPage.goto(`${HUB}/`)
  await hubPage.click('text=Add a Mac')
  await hubPage.fill('#code', code)
  await hubPage.click('#find button[type=submit]')
  await hubPage.getByText(`Add ${MAC_NAME} to your account?`).waitFor()
  await hubPage.click('#confirm button[type=submit]')
  await hubPage.waitForURL(`${HUB}/`)
  // Settings › Devices leads with the account: a dot and one plain line, then where.
  await expect(control.getByTestId('account-line')).toHaveText(/^connected to .*’s account as /)
  await expect(control.getByText(/^At localhost/)).toBeVisible()
}

/**
 * An agent as Claude's connector is one: the MCP SDK's OAuth client, discovering the hub from its
 * 401, registering itself, and sending the person's browser to /authorize.
 */
class Agent implements OAuthClientProvider {
  private information: OAuthClientInformationMixed | undefined
  private saved: OAuthTokens | undefined
  private verifier = ''
  authorizationUrl: URL | null = null
  /** The person's browser tab for this sign-in. */
  page: Page | null = null
  client: Client | null = null

  constructor(readonly name: string) {}

  get redirectUrl(): string {
    return REDIRECT
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  clientInformation() {
    return this.information
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.information = information
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }

  private transport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), { authProvider: this })
  }

  /** Connects, is sent to sign in, and opens the sign-in in the person's browser. Returns its code. */
  async startSignIn(): Promise<string> {
    const client = new Client({ name: this.name, version: '1' })
    const transport = this.transport()
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError)
    if (this.authorizationUrl === null) throw new Error('never sent to sign in')
    this.page = await person.newPage()
    await this.page.goto(this.authorizationUrl.toString())
    await expect(this.page.locator('#state')).toHaveText('Waiting for you to approve…')
    const code = (await this.page.locator('#code').textContent()) ?? ''
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    this.pending = transport
    return code
  }
  private pending: StreamableHTTPClientTransport | null = null

  /** The browser came back with a code: the agent trades it for tokens and connects. */
  async finishSignIn(): Promise<Client> {
    const page = this.page
    if (page === null || this.pending === null) throw new Error('no sign-in started')
    await page.waitForURL(`${REDIRECT}**`, { timeout: 20_000 })
    const back = new URL(page.url())
    expect(back.searchParams.get('error')).toBeNull()
    await this.pending.finishAuth(back.searchParams.get('code') ?? '')
    const client = new Client({ name: this.name, version: '1' })
    await client.connect(this.transport())
    this.client = client
    return client
  }

  /** The browser came back refused. */
  async declined(): Promise<void> {
    const page = this.page
    if (page === null) throw new Error('no sign-in started')
    await page.waitForURL(`${REDIRECT}**`, { timeout: 20_000 })
    expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied')
  }
}

/** Types the code into the Mac's Approve sheet and approves (the e2e build's Touch ID says yes). */
async function approveOnMac(code: string): Promise<void> {
  await control.evaluate(() => {
    window.location.hash = '#/connections/approve'
  })
  const sheet = control.getByRole('dialog')
  await sheet.getByLabel('Code from your browser').fill(code)
  const approve = sheet.getByRole('button', { name: 'Approve' })
  await expect(approve).toBeEnabled()
  await approve.click()
  // Alone, or beside sign-ins still waiting (which once looked as if nothing had happened).
  await expect(sheet.getByText('Approved. Your browser carries on to the connector by itself.')).toBeVisible()
}

/** What cloud agents may use carries over a key loss, or is turned on again the same way. */
async function keepToolForAgents(): Promise<void> {
  const setup = await control.evaluate(() => window.valet?.remote.setup())
  if (!setup?.tools.some((t) => t.enabled && t.ref === 'woolworths.search_products')) {
    const pending = await control.evaluate(() => window.valet?.approvals.pending())
    const hash = pending?.find((p) => p.adapterId === 'woolworths')?.to.hash
    if (hash !== undefined)
      await control.evaluate((h) => window.valet?.approvals.approve('woolworths', h), hash)
    await control.evaluate(() => window.valet?.remote.setEnabled(true))
    await control.evaluate(() => window.valet?.remote.setTool('woolworths', 'search_products', true))
  }
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort()

test('signs up on the hub and puts the Mac on the account', async () => {
  await hubPage.goto(`${HUB}/sign-up`)
  await hubPage.fill('#setup', SETUP_SECRET)
  await hubPage.fill('#email', 'person@example.com')
  await hubPage.click('#sign-up button[type=submit]')
  await hubPage.waitForURL(`${HUB}/`)
  // Asking for a code, then cancelling, leaves the Mac as it was.
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await control.getByRole('button', { name: 'Connect to your Valet account' }).click()
  await control.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(control.getByRole('button', { name: 'Connect to your Valet account' })).toBeVisible()
  await linkMac()
  await expect(control.getByText(/device list/i)).toBeVisible()
  await expect(hubPage.getByText(`${MAC_NAME} (test-mac)`)).toBeVisible()

  // A site whose tools cloud agents may use: the fake shop, approved, one tool on for remote.
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  const hash = pending?.find((p) => p.adapterId === 'woolworths')?.to.hash ?? ''
  await control.evaluate((h) => window.valet?.approvals.approve('woolworths', h), hash)
  await chooseStore(control)
  await control.evaluate(() => window.valet?.remote.setEnabled(true))
  const setup = await control.evaluate(() =>
    window.valet?.remote.setTool('woolworths', 'search_products', true),
  )
  expect(setup?.tools.filter((t) => t.enabled).map((t) => t.ref)).toEqual(['woolworths.search_products'])
})

test('an agent signs in with the code its browser shows, and uses the Mac’s tools at the hub', async () => {
  const claude = new Agent('Claude')
  const code = await claude.startSignIn()
  await approveOnMac(code)
  const client = await claude.finishSignIn()
  expect(await toolNames(client)).toEqual(['test-mac__woolworths_search_products'])
  const found = await client.callTool({
    name: 'test-mac__woolworths_search_products',
    arguments: { query: 'bread' },
  })
  expect(found.isError, JSON.stringify(found.content)).toBeFalsy()
  agents.push(claude)
})

const agents: Agent[] = []

test('with several sign-ins waiting, the code picks one; the rest decline from the Mac', async () => {
  const stale = new Agent('Claude (stale)')
  const staleCode = await stale.startSignIn()
  const fresh = new Agent('Claude (fresh)')
  const freshCode = await fresh.startSignIn()
  expect(freshCode).not.toBe(staleCode)

  // Connections shows both waiting, and the sheet says the code picks.
  await control.evaluate(() => {
    window.location.hash = '#/connections'
  })
  await expect(control.getByText('2 asking to connect')).toBeVisible()
  await control.evaluate(() => {
    window.location.hash = '#/connections/approve'
  })
  await expect(control.getByText('2 cloud agents are asking. Your code picks yours.')).toBeVisible()
  await control.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await approveOnMac(freshCode)
  await expect(
    control.getByText('Another request is still waiting. If you didn’t start it, decline it.'),
  ).toBeVisible()
  await fresh.finishSignIn()
  // The stale one is still waiting, alone, and its Decline reaches the hub and its browser.
  await control.evaluate(() => {
    window.location.hash = '#/connections'
  })
  await expect(control.getByText('1 asking to connect')).toBeVisible()
  await control.getByRole('button', { name: 'Decline', exact: true }).click()
  await stale.declined()
  await expect(control.getByText(/asking to connect/)).toHaveCount(0)
  agents.push(fresh)

  // Decline all, from the sheet.
  const one = new Agent('Claude (one)')
  const two = new Agent('Claude (two)')
  await one.startSignIn()
  await two.startSignIn()
  await control.evaluate(() => {
    window.location.hash = '#/connections/approve'
  })
  await control.getByRole('dialog').getByRole('button', { name: 'Decline all' }).click()
  await one.declined()
  await two.declined()
})

test('Connections lists the agents approved through the account, and removes one everywhere', async () => {
  await control.evaluate(() => {
    window.location.hash = '#/connections'
  })
  const table = control.getByRole('table', { name: 'Agents through your Valet account' })
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(control.getByText('2 cloud agents approved')).toBeVisible()
  const [first, second] = agents
  if (first?.client == null || second?.client == null) throw new Error('no agents')
  await table.getByRole('button', { name: 'Remove 127.0.0.1' }).first().click()
  await expect(table.getByRole('row')).toHaveCount(2)
  // One of the two can't list any more; the other still can.
  const results = await Promise.allSettled([first.client.listTools(), second.client.listTools()])
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
})

test('the relay restarts: the Mac comes back by itself, and the agent’s sign-in still works', async () => {
  const survivor = (
    await Promise.all(
      agents.map(async (a) =>
        (await a.client?.listTools().then(
          () => true,
          () => false,
        ))
          ? a
          : null,
      ),
    )
  ).find((a) => a !== null)
  if (survivor?.client == null) throw new Error('no agent still signed in')
  relay.kill('SIGINT')
  await new Promise((resolve) => relay.once('exit', resolve))
  await startRelay()
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await expect(control.getByText(/Connected to the relay/)).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(async () => (await survivor.client?.listTools().catch(() => null))?.tools.map((t) => t.name), {
      timeout: 30_000,
    })
    .toEqual(['test-mac__woolworths_search_products'])
})

test('the Mac gets new keys: removed on the hub’s page, added again, and sign-ins work again', async () => {
  // As on 2026-11-17: the Mac's approval key is lost and it makes new ones, a new Mac to the hub,
  // with the account's old device list still pinned in its own files.
  await launched.close()
  // Only the keys: the ledger and its anchor stay, with the old list pinned and the old approvals.
  rmSync(join(userData, 'dev-approval-keys.json'))
  await startApp()
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await expect(control.getByRole('button', { name: 'Connect to your Valet account' })).toBeVisible({
    timeout: 30_000,
  })

  // The old Mac, offline, is removed on the hub's page; that ends the list it started, and its grants.
  await hubPage.goto(`${HUB}/`)
  const old = hubPage.locator('li', { hasText: `${MAC_NAME} (test-mac)` })
  await expect(old).toContainText('Offline')
  await old.getByRole('button', { name: 'Remove' }).click()
  await old.getByRole('button', { name: `Remove ${MAC_NAME}?` }).click()
  await expect(old).toHaveCount(0)
  for (const agent of agents)
    await expect(agent.client?.listTools() ?? Promise.reject(new Error('none'))).rejects.toThrow()

  await linkMac()
  await expect(control.getByText(/device list/i)).toBeVisible()
  await expect(control.getByText(/doesn’t check|Couldn’t/i)).toHaveCount(0)
  expect((await control.evaluate(() => window.valet?.app.status()))?.lockedDown).toBe(false)

  await keepToolForAgents()

  const again = new Agent('Claude (again)')
  await approveOnMac(await again.startSignIn())
  const client = await again.finishSignIn()
  expect(await toolNames(client)).toEqual(['test-mac__woolworths_search_products'])
})

let phone: Phone
let hubPhone: HubPhone
const closers: (() => void)[] = []
test.afterAll(() => {
  for (const close of closers) close()
})

async function until<T>(check: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const devicesLine = (n: number) =>
  `Your account’s device list has ${n} devices, each added by one already on it.`

test('a phone paired once goes on the account’s device list, and reads the account at the hub', async () => {
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await control.getByRole('button', { name: 'Pair an iPhone' }).click()
  const qr = control.locator('svg[data-pairing-qr]')
  await qr.waitFor()
  const text = (await qr.getAttribute('data-pairing-qr')) ?? ''
  const offerText = Buffer.from(text.slice('valet-pair:'.length), 'base64url').toString()
  const offer = JSON.parse(offerText)
  const offerId = pairingOfferId(offer.secret)
  const key = pairingSealKey(offer.secret, offer.macId)
  phone = new Phone(RELAY_CONNECT, offer.macId, offer.macAgreementKey, RELAY_ORIGIN, (c) => closers.push(c))
  await phone.dial(() => undefined)
  const reply = phone.sendPairingReply(offer, offerId, key, 'Test iPhone')
  const challenge = await until(() => phone.frames.find((f) => f['type'] === 'pairing-challenge'))
  const code = pairingCode(offer.secret, offer.macId, offerText, reply, challenge['macNonce'] as string)
  const dialog = control.getByRole('dialog')
  await dialog.getByRole('button', { name: `${code.slice(0, 3)} ${code.slice(3)}` }).click()
  await expect(dialog.getByText(/Test iPhone gets Valet’s approvals now/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  // The Mac puts it on the account's list by itself (the e2e build's Touch ID says yes).
  await expect(control.getByText(devicesLine(2))).toBeVisible()

  // Signed in to the Mac's relay object, the phone hears which account it is on, and where.
  phone.socket?.close()
  await phone.dial((nonce) => phone.hello(nonce))
  const status = await until(() =>
    phone.messages.findLast((m) => m['type'] === 'status' && m['account'] !== undefined),
  )
  const told = status['account'] as { hub: string; accountId: string }
  expect(told.hub).toBe(HUB)

  hubPhone = new HubPhone(phone, told.hub, (path, body) =>
    fetch(`${told.hub}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  const account = await hubPhone.account()
  expect(account.account).toBe(told.accountId)
  expect(account.relay).toBe(RELAY_ORIGIN)
  expect([...HubPhone.roster(account).devices.keys()]).toEqual([offer.macId, phone.deviceId])
  expect(account.nodes).toMatchObject([{ slug: 'test-mac', name: MAC_NAME, online: true }])
  expect(account.joining).toEqual([])
})

test('the Mac loses its keys again: the phone adds the new Mac, and nobody pairs again', async () => {
  // An agent the old Mac approved, which should outlive it.
  const claude = new Agent('Claude (outlives the Mac)')
  await approveOnMac(await claude.startSignIn())
  await claude.finishSignIn()
  phone.socket?.close()

  await launched.close()
  rmSync(join(userData, 'dev-approval-keys.json'))
  await startApp()
  await control.evaluate(() => {
    window.location.hash = '#/settings/devices'
  })
  await expect(control.getByRole('button', { name: 'Connect to your Valet account' })).toBeVisible({
    timeout: 30_000,
  })
  // Removing the old Mac on the hub's page keeps the account's list now: the phone carries it on.
  await hubPage.goto(`${HUB}/`)
  const old = hubPage.locator('li', { hasText: `${MAC_NAME} (test-mac)` })
  await expect(old).toContainText('Offline')
  await old.getByRole('button', { name: 'Remove' }).click()
  await old.getByRole('button', { name: `Remove ${MAC_NAME}?` }).click()
  await expect(old).toHaveCount(0)
  // The Mac's own first change, the account's passkey it put on the list, and the phone it paired.
  expect((await hubPhone.account()).changes).toHaveLength(3)

  // The new Mac is added with its code, and asks to join; the phone sees it waiting, and adds it.
  await linkMac()
  await expect(control.getByText(/Waiting for your iPhone/)).toBeVisible()
  await expect.poll(async () => (await hubPhone.account()).joining.length, { timeout: 20_000 }).toBe(1)
  const asked = (await hubPhone.account()).joining[0]
  if (asked === undefined) throw new Error('the new Mac never asked to join')
  const newMac = joinRecordDevice(asked.record, { macId: asked.macId })
  expect(newMac).toMatchObject({ role: 'mac', name: MAC_NAME })
  if (newMac === null) throw new Error('a join record that does not check')
  const added = await hubPhone.addWaitingMacs()
  expect(added.refused).toBeUndefined()
  expect([...HubPhone.roster(added).devices.keys()]).toContain(newMac.deviceId)
  await expect(control.getByText(devicesLine(3))).toBeVisible()
  await expect(control.getByText('Test iPhone', { exact: true })).toBeVisible()
  expect((await control.evaluate(() => window.valet?.app.status()))?.lockedDown).toBe(false)

  // The phone reaches the new Mac with the keys it already had, and gets its status.
  const again = new Phone(
    RELAY_CONNECT,
    newMac.deviceId,
    newMac.agreementKey,
    RELAY_ORIGIN,
    (c) => closers.push(c),
    phone,
  )
  await again.dial((nonce) => again.hello(nonce))
  await until(() => again.frames.find((f) => f['type'] === 'ready'))
  await until(() => again.messages.find((m) => m['type'] === 'status'))

  // An agent's request on this Mac reaches the phone, and its approval comes back.
  const local = await connectMcp(control, userData, 'Claude Code')
  const set = await callToolOnce(local, 'valet_set_setting', { setting: 'traceRetentionDays', value: 9 })
  expect(set.isError, set.text).toBe(false)
  const card = await until(() => again.messages.find((m) => m['type'] === 'approval-request'))
  await again.send({ type: 'ack', ackSeq: card['seq'] })
  await again.send({
    type: 'approval-decision',
    decision: again.approve(String(card['requestText']), newMac.deviceId),
  })
  await expect
    .poll(async () => (await control.evaluate(() => window.valet?.settings.get()))?.traceRetentionDays, {
      timeout: 20_000,
    })
    .toBe(9)
  await local.close()

  // The agent the old Mac approved still works, through the new one: its approver is still on the list.
  await keepToolForAgents()
  await expect
    .poll(async () => (await claude.client?.listTools().catch(() => null))?.tools.map((t) => t.name), {
      timeout: 30_000,
    })
    .toEqual(['test-mac__woolworths_search_products'])
})

test('a new iPhone signs in with the account’s passkey: no QR code, no pairing, nothing on the Mac', async () => {
  // The Mac put the account's passkey on the list by itself, from the hub's word and its own signature.
  const before = HubPhone.roster(await hubPhone.account())
  expect(before.passkeys.size).toBe(1)
  const macs = [...before.devices.values()].filter((d) => d.role === 'mac')
  const newMac = macs.at(-1)
  if (newMac === undefined) throw new Error('no Mac on the list')

  // The iPhone app opens the hub's page with the keys it made; the person uses their passkey.
  const fresh = new Phone(RELAY_CONNECT, newMac.deviceId, newMac.agreementKey, RELAY_ORIGIN, (c) =>
    closers.push(c),
  )
  const signInPhone = new HubPhone(fresh, HUB, (path, body) =>
    fetch(`${HUB}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  await expect(signInPhone.account()).rejects.toThrow(/401/)
  const device = signInPhone.device('Second iPhone')
  // The person's browser tab, with the virtual authenticator that holds the passkey.
  const page = hubPage
  await page.goto(`${HUB}/phone#device=${Buffer.from(JSON.stringify(device)).toString('base64url')}`)
  await expect(page.locator('#what')).toHaveText(
    'Use the passkey you set up for Valet to add Second iPhone to your account.',
  )
  await page.click('#go')
  await expect(page.locator('#done')).toBeVisible()
  await expect(page.locator('#error')).toHaveText('')

  // The phone is on the account now: the hub lets it in, and the list says the passkey added it.
  const account = await signInPhone.account()
  const roster = HubPhone.roster(account)
  expect(roster.devices.get(fresh.deviceId)).toEqual(device)
  expect(JSON.parse(account.changes.at(-1)?.payload ?? '{}')).toMatchObject({ by: 'passkey' })
  expect(account.nodes).toMatchObject([{ slug: 'test-mac', online: true }])
  await expect(control.getByText('Second iPhone', { exact: true })).toBeVisible({ timeout: 20_000 })

  // The Mac trusts it, without ever having paired it: it signs in, and an approval it sends counts.
  await fresh.dial((nonce) => fresh.hello(nonce))
  await until(() => fresh.frames.find((f) => f['type'] === 'ready'))
  await until(() => fresh.messages.find((m) => m['type'] === 'status'))
  const local = await connectMcp(control, userData, 'Claude Code')
  const set = await callToolOnce(local, 'valet_set_setting', { setting: 'traceRetentionDays', value: 7 })
  expect(set.isError, set.text).toBe(false)
  const card = await until(() => fresh.messages.find((m) => m['type'] === 'approval-request'))
  await fresh.send({ type: 'ack', ackSeq: card['seq'] })
  await fresh.send({
    type: 'approval-decision',
    decision: fresh.approve(String(card['requestText']), newMac.deviceId),
  })
  await expect
    .poll(async () => (await control.evaluate(() => window.valet?.settings.get()))?.traceRetentionDays, {
      timeout: 20_000,
    })
    .toBe(7)
  await local.close()

  // Signing in again is harmless: the page says it's done, and nothing changes.
  const again = hubPage
  await again.goto(`${HUB}/sign-in`)
  await again.goto(`${HUB}/phone#device=${Buffer.from(JSON.stringify(device)).toString('base64url')}`)
  await again.click('#go')
  await expect(again.locator('#done')).toBeVisible()
  expect((await signInPhone.account()).changes).toHaveLength(account.changes.length)
})
