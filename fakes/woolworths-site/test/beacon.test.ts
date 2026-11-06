// The hostile page-script variant: on only when the harness asks, on www pages only, and its
// settings are checked before they go into a page.

import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BEACON_INTERVAL_MS, validBeacon } from '../src/beacon'
import { type FakeWoolworths, startFakeWoolworths } from '../src/server'
import { Client, sensorValueIn } from './support/client'

const sites: FakeWoolworths[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function start(options: Parameters<typeof startFakeWoolworths>[0] = {}): Promise<FakeWoolworths> {
  const site = await startFakeWoolworths(options)
  sites.push(site)
  return site
}

const TARGET = { host: 'evil.test', port: 4711 }
const TAG = '<script id="page-beacon">'

describe('the page beacon variant', () => {
  it('is off by default', async () => {
    const site = await start()
    expect((await new Client(site.origin).get('/')).text).not.toContain(TAG)
  })

  it('is on every www page when given as an option, beside the sensor script', async () => {
    const site = await start({ hostile: { pageBeacon: TARGET } })
    const client = new Client(site.origin)
    for (const path of ['/', '/shop/securelogin', '/shop/search/products?searchTerm=milk', '/nowhere']) {
      const page = await client.get(path)
      expect([path, page.text.includes(TAG)]).toEqual([path, true])
      expect(page.text).toContain('evil.test:4711')
      // The adapter e2e reads the sensor value from the page; the beacon must not disturb that.
      expect(sensorValueIn(page.text)).not.toBeNull()
    }
  })

  it('uses the interval it is given', async () => {
    const site = await start({ hostile: { pageBeacon: { ...TARGET, intervalMs: 500 } } })
    expect((await new Client(site.origin).get('/')).text).toContain('setInterval(fire, 500)')
  })

  it('can be started and stopped while running', async () => {
    const site = await start()
    const client = new Client(site.origin)
    site.setPageBeacon(TARGET)
    expect((await client.get('/')).text).toContain(TAG)
    site.setPageBeacon(null)
    expect((await client.get('/')).text).not.toContain(TAG)
  })

  it('is not on the auth origin’s pages or in API answers', async () => {
    const site = await start({ hostile: { pageBeacon: TARGET } })
    const client = new Client(site.origin)
    await client.visit('/')
    expect((await client.get('/apis/ui/Trolley')).text).not.toContain(TAG)
    const authorize = await client.get('/auth/login')
    const identifier = new URL(authorize.headers.get('location') ?? '', site.authOrigin)
    const auth = new Client(site.authOrigin)
    const first = await auth.get(`${identifier.pathname}${identifier.search}`)
    const next = first.headers.get('location')
    const page = next === null ? first : await auth.get(next)
    expect(page.text).not.toContain(TAG)
  })

  it('refuses settings that could reshape the script', async () => {
    for (const host of ['', 'evil.test"></script>', 'evil test', 'a/b', '-evil.test']) {
      expect(() => validBeacon({ host, port: 1 })).toThrow(/host/)
    }
    for (const port of [0, 65_536, 1.5, Number.NaN]) {
      expect(() => validBeacon({ host: 'evil.test', port })).toThrow(/port/)
    }
    for (const intervalMs of [0, 9, 60_001, 2.5]) {
      expect(() => validBeacon({ host: 'evil.test', port: 1, intervalMs })).toThrow(/interval/)
    }
    await expect(startFakeWoolworths({ hostile: { pageBeacon: { host: 'x"y', port: 1 } } })).rejects.toThrow()
    const site = await start()
    expect(() => site.setPageBeacon({ host: 'evil.test', port: 0 })).toThrow(/port/)
  })

  it('defaults to 200 ms and lower-cases the host', () => {
    expect(DEFAULT_BEACON_INTERVAL_MS).toBe(200)
    expect(validBeacon({ host: 'Evil.Test', port: 80 })).toEqual({
      host: 'evil.test',
      port: 80,
      intervalMs: 200,
    })
  })
})
