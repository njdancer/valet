// The fixture browser: a case's pages from the draft's fixtures, and nothing else, ever.

import { ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { FixtureBrowser } from '../src/fixture-browser'
import { FakePlatform } from './fake-browser'

const PAGE = 'https://finance.example.com/quote/AAPL'

async function open(platform = new FakePlatform()) {
  const browser = await FixtureBrowser.open({
    platform,
    partition: 'fixture:dr-aaaaaaaaaa:1',
    pages: { [PAGE]: '<html><body><p class="price">1.50</p></body></html>' },
    egress: ['finance.example.com'],
  })
  return { browser, platform, session: platform.session('fixture:dr-aaaaaaaaaa:1') }
}

describe('the fixture browser', () => {
  it('serves only the case’s pages, from memory, and sends nothing to the network', async () => {
    const { session, platform } = await open()
    const served = session.served
    expect(served?.(PAGE)).toMatchObject({ status: 200, body: expect.stringContaining('1.50') })
    expect(served?.(`${PAGE}#top`)).toMatchObject({ status: 200 })
    expect(served?.('https://finance.example.com/quote/MSFT')).toBeNull()
    const allow = session.filter
    expect(allow?.({ url: PAGE, method: 'GET', resourceType: 'mainFrame', id: 1 })).toBe(true)
    expect(allow?.({ url: PAGE, method: 'POST', resourceType: 'mainFrame', id: 2 })).toBe(false)
    expect(
      allow?.({ url: 'http://finance.example.com/', method: 'GET', resourceType: 'mainFrame', id: 4 }),
    ).toBe(false)
    expect(
      allow?.({ url: 'https://cdn.example.com/x.js', method: 'GET', resourceType: 'script', id: 3 }),
    ).toBe(false)
    // The proxy refuses every host.
    expect(await platform.proxies[0]?.policy('finance.example.com', 443)).toBe(false)
    expect(session.hardened).toBe(1)
  })

  it('refuses a kept partition, a page that isn’t https, and too many pages', async () => {
    const platform = new FakePlatform()
    const base = { platform, egress: [] as string[] }
    await expect(
      FixtureBrowser.open({ ...base, partition: 'persist:tool:x', pages: {} }),
    ).rejects.toBeInstanceOf(ValetError)
    await expect(
      FixtureBrowser.open({ ...base, partition: 'fixture:x', pages: { 'http://a.test/': '' } }),
    ).rejects.toBeInstanceOf(ValetError)
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`https://a.test/${i}`, '']))
    await expect(
      FixtureBrowser.open({ ...base, partition: 'fixture:y', pages: many }),
    ).rejects.toBeInstanceOf(ValetError)
  })

  it('closes its window and proxy', async () => {
    const { browser, platform } = await open()
    browser.close()
    browser.close()
    expect(platform.surfaces[0]?.destroyed).toBe(true)
    await Promise.resolve()
    expect(platform.proxies[0]?.closed).toBe(true)
  })
})
