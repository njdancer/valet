// The blind relay end to end (docs/blind-relay.md): the built app, the real blind relay and a CA
// that really checks TLS-ALPN-01, Playwright's Chromium as the person's browser, and the MCP SDK's
// own OAuth client as the agent. TLS ends in the app: the relay only reads names.
//
//   1. The Mac dials the relay with its transport key, gets its own certificate for
//      <macId>.valet.test (the CA's check reaches it through the relay), and Remote access shows
//      that address.
//   2. An agent signs in with the Mac's own OAuth server: its browser shows the Mac's page with a
//      code, typed into the Approve sheet; the agent lists and calls a tool at the Mac's address.
//   3. Pausing remote access closes the address; turning it on again serves it again.
//   4. The relay restarts: the Mac comes back by itself, keeps its certificate, and the agent's
//      sign-in still works.

import type { X509Certificate } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSecureContext, type TLSSocket } from 'node:tls'
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
import { generateP256, privateKeyPem, selfSignedCertificate, toPem } from '@valet/acme'
import { type RunningBlindRelay, startBlindRelay } from '@valet/blind-relay'
import { type FakeAcme, startFakeAcme } from '@valet/fake-acme'
import { appDir, CONTROL, chooseStore, type Launched, launch, tempDir, windowWithTitle } from './harness'

test.describe.configure({ mode: 'serial' })

const CONTROL_HOST = 'relay.valet.test'
const MAC_DOMAIN = 'valet.test'
// An HTTPS redirect with a DNS name, as the Mac's OAuth server requires. Nothing answers it: the
// test reads the code off the browser's request.
const REDIRECT = 'https://agent.example/callback'

let relay: RunningBlindRelay
let relayPort = 0
let acme: FakeAcme
let userData: string
let launched: Launched
let control: Page
let browser: Browser
let person: BrowserContext
let macHost = ''
const controlKeys = generateP256()
const controlPem = toPem(
  selfSignedCertificate(controlKeys, { names: [CONTROL_HOST], ips: ['127.0.0.1'] }),
  'CERTIFICATE',
)
const controlContext = createSecureContext({ key: privateKeyPem(controlKeys), cert: controlPem })

async function startRelay(port = 0): Promise<void> {
  relay = await startBlindRelay({
    controlHost: CONTROL_HOST,
    macDomain: MAC_DOMAIN,
    controlCertificate: () => controlContext,
    port,
    host: '127.0.0.1',
  })
  relayPort = relay.port
}

const lookup: LookupFunction = (_host, options, cb) => {
  if (typeof options === 'object' && options.all === true)
    (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 },
    ])
  else cb(null, '127.0.0.1', 4)
}

/** fetch for the agent: every name to the relay's port, trusting the CA's root alone. */
const agentFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  for (const [key, value] of new Headers(init?.headers)) headers.set(key, value)
  const body = init?.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer())
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: url.hostname,
        port: relayPort,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: { ...Object.fromEntries(headers), host: url.hostname },
        ca: acme.rootPem,
        lookup,
        agent: false,
      },
      (res) => {
        const out = new Headers()
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(', ') : value)
        const status = res.statusCode ?? 0
        const empty = status === 204 || status === 304 || init?.method === 'HEAD'
        if (empty) res.resume()
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }),
        )
      },
    )
    init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')))
    req.on('error', reject)
    req.end(body)
  })
}) as typeof fetch

class Agent implements OAuthClientProvider {
  private information: OAuthClientInformationMixed | undefined
  private saved: OAuthTokens | undefined
  private verifier = ''
  authorizationUrl: URL | null = null
  page: Page | null = null
  private pending: StreamableHTTPClientTransport | null = null
  private redirect: Promise<import('@playwright/test').Request> | null = null

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
      // As claude.ai registers: a confidential client that sends its secret in the token request.
      token_endpoint_auth_method: 'client_secret_post',
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

  transport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(`https://${macHost}/mcp`), {
      authProvider: this,
      fetch: agentFetch,
    })
  }

  async startSignIn(): Promise<string> {
    const client = new Client({ name: this.name, version: '1' })
    const transport = this.transport()
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError)
    if (this.authorizationUrl === null) throw new Error('never sent to sign in')
    expect(this.authorizationUrl.host).toBe(macHost)
    this.page = await person.newPage()
    // The redirect back to the agent, read off the request: the agent's page needn't exist here.
    this.redirect = this.page.waitForRequest((r) => r.url().startsWith(REDIRECT), { timeout: 60_000 })
    await this.page.goto(this.authorizationUrl.toString())
    const code = ((await this.page.locator('.code').textContent()) ?? '').trim()
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/)
    this.pending = transport
    return code
  }

  /** A fresh session with the tokens it holds: what a connector does on its next chat. */
  async connect(): Promise<Client> {
    const client = new Client({ name: this.name, version: '1' })
    await client.connect(this.transport())
    return client
  }

  async finishSignIn(): Promise<Client> {
    const page = this.page
    if (page === null || this.pending === null) throw new Error('no sign-in started')
    if (this.redirect === null) throw new Error('no sign-in started')
    const back = new URL((await this.redirect).url())
    this.redirect = null
    expect(back.searchParams.get('error')).toBeNull()
    await this.pending.finishAuth(back.searchParams.get('code') ?? '')
    const client = new Client({ name: this.name, version: '1' })
    await client.connect(this.transport())
    return client
  }
}

async function approveOnMac(code: string): Promise<void> {
  await control.evaluate(() => {
    window.location.hash = '#/connections/approve'
  })
  const sheet = control.getByRole('dialog')
  await sheet.getByLabel('Code from your browser').fill(code)
  // Nothing is ticked to begin with: the person gives this agent the one tool that's on for remote.
  const tools = sheet.getByRole('checkbox')
  await expect(tools).toHaveCount(2)
  await tools.first().click()
  await expect(tools.first()).toBeChecked()
  const approve = sheet.getByRole('button', { name: 'Approve' })
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(sheet.getByText(/^Approved\./)).toBeVisible()
}

const relayUrl = () => control.evaluate(async () => (await window.valet?.remote.setup())?.relayUrl ?? null)

test.beforeAll(async () => {
  await startRelay()
  acme = await startFakeAcme({ validationPort: relayPort })
  userData = tempDir('blind')
  const caFile = join(userData, '..', `blind-relay-ca-${process.pid}.pem`)
  writeFileSync(caFile, controlPem)
  launched = await launch(userData, appDir, {
    env: {
      VALET_BLIND_RELAY: CONTROL_HOST,
      VALET_BLIND_MAC_DOMAIN: MAC_DOMAIN,
      VALET_BLIND_RELAY_CONNECT: `wss://127.0.0.1:${relayPort}`,
      VALET_ACME_DIRECTORY: acme.directoryUrl,
      VALET_MAC_NAME: 'Test Mac',
      // The app trusts the test relay's own certificate the way it trusts a public one.
      NODE_EXTRA_CA_CERTS: caFile,
    },
  })
  control = await windowWithTitle(launched.app, CONTROL)
  const executablePath = process.env['HUB_CHROMIUM']
  browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    // The person's browser reaches every Mac name at the relay. Its certificate is checked by the
    // agent's fetch; the browser only shows the Mac's pages.
    args: [`--host-resolver-rules=MAP *.${MAC_DOMAIN} 127.0.0.1:${relayPort}`],
  })
  person = await browser.newContext({ ignoreHTTPSErrors: true })
})

test.afterAll(async () => {
  await browser?.close()
  await launched?.close()
  await relay?.close()
  await acme?.close()
})

test('the Mac signs in to the blind relay and gets its own certificate through it', async () => {
  await expect.poll(() => relay.macs().length, { timeout: 60_000 }).toBe(1)
  const macId = relay.macs()[0] as string
  macHost = `${macId}.${MAC_DOMAIN}`
  // A site whose tools cloud agents may use: the fake shop, approved, one tool on for remote.
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  const hash = pending?.find((p) => p.adapterId === 'woolworths')?.to.hash ?? ''
  await control.evaluate((h) => window.valet?.approvals.approve('woolworths', h), hash)
  await chooseStore(control)
  await control.evaluate(() => window.valet?.remote.setEnabled(true))
  await control.evaluate(() => window.valet?.remote.setTool('woolworths', 'search_products', true))
  // The address shows once the certificate is there; the CA checked the name through the relay.
  await expect.poll(relayUrl, { timeout: 60_000 }).toBe(`https://${macHost}/mcp`)
  expect(acme.validations).toEqual([{ name: macHost, ok: true, why: 'ok' }])
  // What the Mac serves is that certificate, from the CA, for its name.
  const served = await new Promise<X509Certificate>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: macHost,
        port: relayPort,
        path: '/.well-known/oauth-authorization-server',
        ca: acme.rootPem,
        lookup,
        agent: false,
        headers: { host: macHost },
      },
      (res) => {
        resolve((res.socket as TLSSocket).getPeerX509Certificate() as X509Certificate)
        res.resume()
      },
    )
    req.on('error', reject)
    req.end()
  })
  expect(served.checkHost(macHost)).toBe(macHost)
})

let claude: Agent
test('an agent signs in with the Mac’s own OAuth server and calls a tool at the Mac’s address', async () => {
  claude = new Agent('Claude')
  const code = await claude.startSignIn()
  await approveOnMac(code)
  const client = await claude.finishSignIn()
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_search_products'])
  const found = await client.callTool({ name: 'woolworths_search_products', arguments: { query: 'bread' } })
  expect(found.isError, JSON.stringify(found.content)).toBeFalsy()
  await client.close()
})

test('the person edits the approved agent’s tools on its page: one Touch ID per Save, off at once', async () => {
  const agents = await control.evaluate(async () => (await window.valet?.remote.clients()) ?? [])
  expect(agents).toHaveLength(1)
  const id = agents[0]?.id ?? ''
  await control.evaluate((clientId) => {
    window.location.hash = `#/connections/${clientId}`
  }, id)
  const page = control
  // The words that told the person to revoke and approve again are gone.
  await expect(page.getByText('What it may use')).toBeVisible()
  await expect(page.getByText(/revoke it and approve it again/)).toHaveCount(0)
  const option = (name: RegExp, value: 'Off' | 'On') =>
    page.getByRole('radiogroup', { name }).getByRole('radio', { name: value })
  const search = /: Search products$/
  const cart = /: Get cart$/
  await expect(option(search, 'On')).toHaveAttribute('aria-checked', 'true')
  await expect(option(cart, 'On')).toHaveAttribute('aria-checked', 'false')
  const save = async (label: 'Save' | 'Save with Touch ID') => {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByText(/not saved/)).toHaveCount(0)
  }
  const listed = async () => {
    const client = await claude.connect()
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    await client.close()
    return names
  }

  // On is a draft until Save: the Mac's Touch ID step (answered yes in e2e builds), then the
  // agent's own tool list has it, though it was never on for remote clients.
  await option(cart, 'On').click()
  await expect(page.getByText(/not saved/)).toHaveCount(1)
  expect(await listed()).toEqual(['woolworths_search_products'])
  await save('Save with Touch ID')
  await expect(option(cart, 'On')).toHaveAttribute('aria-checked', 'true')
  expect(await listed()).toEqual(['woolworths_get_cart', 'woolworths_search_products'])
  const signed = await control.evaluate(async () =>
    ((await window.valet?.audit.page({}))?.records ?? []).map((r) => r.event),
  )
  expect(signed).toContainEqual(expect.objectContaining({ type: 'approval-requested', kind: 'agent-access' }))

  // Off: a plain Save, still approved, same registration; the other tool stays.
  await option(search, 'Off').click()
  await save('Save')
  await expect(option(search, 'On')).toHaveAttribute('aria-checked', 'false')
  expect(await listed()).toEqual(['woolworths_get_cart'])
  const after = await control.evaluate(async () => (await window.valet?.remote.clients()) ?? [])
  expect(after.map((c) => [c.id, c.grant?.tools])).toEqual([[id, ['woolworths.get_cart']]])

  // Back as it was for the tests after this one, both in one Save.
  await option(search, 'On').click()
  await option(cart, 'Off').click()
  await save('Save with Touch ID')
  await expect(option(search, 'On')).toHaveAttribute('aria-checked', 'true')
  await expect(option(cart, 'On')).toHaveAttribute('aria-checked', 'false')
  expect(await listed()).toEqual(['woolworths_search_products'])
})

test('pausing remote access closes the address; on again serves it again', async () => {
  await control.evaluate(() => window.valet?.remote.setEnabled(false))
  const paused = new Client({ name: 'Claude', version: '1' })
  await expect(paused.connect(claude.transport())).rejects.toThrow()
  await control.evaluate(() => window.valet?.remote.setEnabled(true))
  // Its access token died with the pause; its connector carries on with a refreshed one, at the same
  // address, with the same tool.
  const client = new Client({ name: 'Claude', version: '1' })
  await client.connect(claude.transport())
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_search_products'])
  await client.close()
})

test('the relay restarts: the Mac comes back by itself and keeps its certificate', async () => {
  const port = relayPort
  await relay.close()
  await startRelay(port)
  await expect.poll(() => relay.macs().length, { timeout: 90_000 }).toBe(1)
  const client = new Client({ name: 'Claude', version: '1' })
  await client.connect(claude.transport())
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_search_products'])
  await client.close()
  // One certificate in all: the restart asked the CA for nothing.
  expect(acme.orders).toHaveLength(1)
})
