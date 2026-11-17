// The hub's pages in a real browser, with Chromium's virtual authenticator standing in for a
// passkey: sign up, add a Mac with the code it shows, see it online, sign out and back in. Opt-in
// (VALET_HUB_BROWSER=1), since it needs Playwright's Chromium; screenshots go to HUB_SCREENSHOTS.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SIGNING_DOMAINS } from '@valet/core'
import { RelayClient, type RelayEvent } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { testKey } from './keys'
import { HUB_SETUP_SECRET, RELAY_ORIGIN, startRelay } from './runtime'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

describe.runIf(process.env['VALET_HUB_BROWSER'] === '1')('the hub in a browser', () => {
  it('signs up with a passkey, adds a Mac, and signs in again', async () => {
    const { chromium } = await import('@playwright/test')
    const port = 18_000 + Math.floor(Math.random() * 1000)
    const origin = `http://localhost:${port}`
    const runtime = await startRelay({ port, hub: { host: 'localhost', origin } })
    cleanup.push(() => runtime.close())
    const shots = process.env['HUB_SCREENSHOTS']
    if (shots !== undefined) mkdirSync(shots, { recursive: true })

    const executablePath = process.env['HUB_CHROMIUM']
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    cleanup.push(() => browser.close())
    const context = await browser.newContext({ viewport: { width: 720, height: 760 } })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
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
    const shot = async (name: string) => {
      if (shots !== undefined) await page.screenshot({ path: join(shots, `${name}.png`) })
    }

    await page.goto(`${origin}/sign-up`)
    await page.fill('#setup', HUB_SETUP_SECRET)
    await page.fill('#email', 'nick@example.com')
    await shot('1-sign-up')
    await page.click('#sign-up button[type=submit]')
    await page.waitForURL(`${origin}/`)
    await page.getByText('Signed in as nick@example.com').waitFor()
    await shot('2-no-nodes')

    // A Mac asks to join and shows a code.
    const transport = testKey()
    const approval = testKey()
    let code = ''
    const client = new RelayClient({
      relay: RELAY_ORIGIN,
      connectUrl: runtime.url,
      macId: approval.id,
      signer: transport,
      binding: {
        approvalKey: approval.publicKey,
        signature: approval.signDomain(SIGNING_DOMAINS.relayBinding, transport.publicKey),
      },
      listener: () => null,
      consent: () => ({ state: 'declined' }),
      onEvent: (event: RelayEvent) => {
        if (event.type === 'hub-status' && event.hub.state === 'linking') code = event.hub.code
      },
      onStatus: (status) => {
        if (status.state === 'online') client.send({ type: 'hub-link-start', name: 'Nick’s MacBook Pro' })
      },
      backoff: { minMs: 50, maxMs: 200 },
    })
    cleanup.push(() => client.stop())
    client.start()
    await expect.poll(() => code, { timeout: 10_000 }).not.toBe('')

    await page.click('text=Add a Mac')
    await page.fill('#code', code.toLowerCase())
    await shot('3-type-code')
    await page.click('#find button[type=submit]')
    await page.getByText('Add Nick’s MacBook Pro to your account?').waitFor()
    await page.fill('#slug', 'mbp')
    await shot('4-confirm')
    await page.click('#confirm button[type=submit]')
    await page.waitForURL(`${origin}/`)
    await page.getByText('Nick’s MacBook Pro (mbp)').waitFor()
    await page.getByText('Online').waitFor()
    await shot('5-node-online')

    await page.click('text=Passkeys and sign-in')
    await page.locator('#passkeys li').first().waitFor()
    await shot('6-security')

    await page.goto(`${origin}/`)
    await page.click('#sign-out')
    await page.waitForURL(`${origin}/sign-in`)
    await shot('7-sign-in')
    await page.click('#passkey')
    await page.waitForURL(`${origin}/`)
    await page.getByText('Nick’s MacBook Pro (mbp)').waitFor()
  })

  it('keeps an agent’s sign-in waiting in the browser that opened it', async () => {
    const { chromium } = await import('@playwright/test')
    const port = 18_000 + Math.floor(Math.random() * 1000)
    const origin = `http://localhost:${port}`
    const runtime = await startRelay({ port, hub: { host: 'localhost', origin } })
    cleanup.push(() => runtime.close())
    const executablePath = process.env['HUB_CHROMIUM']
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    cleanup.push(() => browser.close())
    const page = await (await browser.newContext()).newPage()

    const registered = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:1/cb'], client_name: 'Claude' }),
    })
    const { client_id: clientId } = (await registered.json()) as { client_id: string }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost:1/cb',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      state: 'st',
    })
    await page.goto(`${origin}/authorize?${query}`)
    // The browser kept the consent cookie: its polls say pending, not expired (a `__Host-` cookie
    // with any other Path is dropped, and every sign-in looked expired at once).
    const cookies = await page.context().cookies()
    expect(cookies.map((c) => c.name)).toContain('__Host-valet-consent')
    await page.waitForTimeout(2_500)
    expect(await page.locator('#state').textContent()).toBe('Waiting for you to approve…')
    const id = JSON.parse((await page.locator('body').getAttribute('data-consent')) ?? '{}').id as string
    const state = await page.evaluate(
      async (consent) => (await (await fetch(`/authorize/status?id=${consent}`)).json()).state,
      id,
    )
    expect(state).toBe('pending')
  })
})
