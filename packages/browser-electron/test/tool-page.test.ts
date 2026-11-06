import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { SurfaceToolPage } from '../src/tool-page'
import { FakeFrame, FakeSurface, ManualTimers } from './fake-browser'
import { FakeWindow } from './fake-dom'

const EGRESS = ['www.example.com', '*.cdn.example.com']
const PARTITION = 'persist:tool:example'

function timing(timers: ManualTimers) {
  return { timers, stepTimeoutMs: 1000, typingDelayMs: 50 }
}

async function rejection(promise: Promise<unknown>): Promise<SiteAdapterError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(error instanceof SiteAdapterError))
    throw new Error(`expected a SiteAdapterError, got ${String(error)}`)
  return error
}

/** A surface already on the site's home page, whose main frame runs scripts against `window`. */
async function onHome(window: FakeWindow) {
  const timers = new ManualTimers()
  const surface = new FakeSurface(PARTITION, [
    new FakeFrame('https://www.example.com', 'https://www.example.com/', null, window),
  ])
  const page = new SurfaceToolPage(surface, EGRESS, timing(timers))
  await page.goto('https://www.example.com/')
  return { timers, surface, page }
}

describe('ToolPage.goto', () => {
  it('loads a URL on an egress host', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    await page.goto('https://www.example.com/shop/search?q=milk')
    expect(surface.loads).toEqual(['https://www.example.com/', 'https://www.example.com/shop/search?q=milk'])
    expect(page.currentUrl()).toBe('https://www.example.com/shop/search?q=milk')
  })

  it('resolves a path against the current page', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    await page.goto('/shop/trolley')
    expect(surface.loads.at(-1)).toBe('https://www.example.com/shop/trolley')
  })

  it('refuses an undeclared host before loading anything', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    for (const url of [
      'https://evil.test/',
      '//evil.test/x',
      'http://www.example.com/',
      'https://cdn.example.com/',
    ]) {
      const error = await rejection(page.goto(url))
      expect(error, url).toMatchObject({ stage: 'egress', errorClass: 'host-not-allowed' })
    }
    expect(surface.loads).toEqual(['https://www.example.com/'])
  })

  it('reports a load the network guard cancelled as an egress block', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    surface.onLoad = () => ({ ok: false, code: 'ERR_BLOCKED_BY_CLIENT' })
    const error = await rejection(page.goto('https://www.example.com/redirects-to-evil'))
    expect(error).toMatchObject({ stage: 'egress', errorClass: 'host-not-allowed' })
  })

  it('reports other failures as unavailable and tolerates ERR_ABORTED', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    surface.onLoad = () => ({ ok: false, code: 'ERR_CONNECTION_RESET' })
    expect((await rejection(page.goto('https://www.example.com/'))).errorClass).toBe('unavailable')
    surface.onLoad = () => ({ ok: false, code: 'ERR_ABORTED' })
    await expect(page.goto('https://www.example.com/')).resolves.toBeUndefined()
  })

  it('refuses something that is not a URL at all', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceToolPage(surface, EGRESS, timing(new ManualTimers()))
    const error = await rejection(page.goto('relative/before/any/page'))
    expect(error).toMatchObject({ stage: 'tool-input', errorClass: 'invalid' })
  })
})

describe('ToolPage.click and fill', () => {
  it('clicks with a trusted event', async () => {
    const window = new FakeWindow()
    window.document.add(
      '.add',
      window.document.element('BUTTON', { rect: { left: 0, top: 0, width: 20, height: 20 } }),
    )
    const { surface, page } = await onHome(window)
    await page.click('.add')
    expect(surface.clicks).toEqual([{ x: 10, y: 10 }])
  })

  it('reports a click on a missing element as a tool-run failure', async () => {
    const { page } = await onHome(new FakeWindow())
    expect(await rejection(page.click('.nothing'))).toMatchObject({
      stage: 'tool-run',
      errorClass: 'element-missing',
    })
  })

  it('fills by focusing, selecting the old value, and typing trusted characters', async () => {
    const window = new FakeWindow()
    const input = window.document.add('#search', window.document.element('INPUT', { type: 'search' }))
    const { timers, surface, page } = await onHome(window)
    await timers.settle(page.fill('#search', 'milk'))
    expect(window.document.activeElement).toBe(input)
    expect(input.selected).toBe(true)
    expect(surface.chars).toEqual(['m', 'i', 'l', 'k'])
    expect(timers.requested.filter((ms) => ms === 50)).toHaveLength(3)
  })

  it('refuses to fill anything but literal text', async () => {
    const { page } = await onHome(new FakeWindow())
    const error = await rejection(
      page.fill('#search', { secret: 'login', field: 'password' } as unknown as string),
    )
    expect(error).toMatchObject({ stage: 'tool-input', errorClass: 'invalid' })
  })
})

describe('ToolPage.extract', () => {
  it('reads text, attributes and lists from the main frame', async () => {
    const window = new FakeWindow()
    const title = window.document.add('h1', window.document.element('H1'))
    title.textContent = ' Milk 2L '
    window.document.add('a.product', window.document.element('A', { attributes: { href: '/p/1' } }))
    window.document.add('a.product', window.document.element('A', { attributes: { href: '/p/2' } }))
    const { page } = await onHome(window)
    expect(await page.extract('h1')).toBe('Milk 2L')
    expect(await page.extract('a.product', { attribute: 'href', all: true })).toEqual(['/p/1', '/p/2'])
    expect(await page.extract('.missing')).toBeNull()
  })

  it('rejects an invalid selector, and garbage from the page', async () => {
    const window = new FakeWindow()
    window.document.invalidSelectors.add('<<')
    const { surface, page } = await onHome(window)
    expect(await rejection(page.extract('<<'))).toMatchObject({ stage: 'tool-run', errorClass: 'invalid' })
    const frame = surface.frameList[0]!
    frame.run = async () => 'not an object'
    expect(await rejection(page.extract('h1'))).toMatchObject({ stage: 'tool-run', errorClass: 'internal' })
  })
})

describe('ToolPage.evaluate', () => {
  it('runs adapter source in the main frame with JSON args', async () => {
    const window = new FakeWindow()
    window.document.body = { innerText: 'Trolley (3)' }
    const { surface, page } = await onHome(window)
    expect(await page.evaluate('document.body.innerText.includes(args.word)', { word: 'Trolley' })).toBe(true)
    expect(surface.frameList[0]!.adapterScripts.at(-1)).toContain('{"word":"Trolley"}')
  })

  it('runs adapter source in the adapter’s world, never the runtime’s', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    const runtimeScripts = surface.frameList[0]!.scripts.length
    await page.evaluate('1 + 1')
    expect(surface.frameList[0]!.adapterScripts).toHaveLength(1)
    expect(surface.frameList[0]!.scripts).toHaveLength(runtimeScripts)
    await page.extract('h1')
    expect(surface.frameList[0]!.adapterScripts).toHaveLength(1)
  })

  it('reports a script that throws as internal, without its message', async () => {
    const { page } = await onHome(new FakeWindow())
    const error = await rejection(page.evaluate('(() => { throw new Error("token=abc") })()'))
    expect(error).toMatchObject({ stage: 'tool-run', errorClass: 'internal' })
    expect(error.message).not.toContain('token')
  })

  it('refuses args JSON cannot carry, and source that is not a string', async () => {
    const { page } = await onHome(new FakeWindow())
    expect(await rejection(page.evaluate('args', { n: 1n }))).toMatchObject({
      stage: 'tool-input',
      errorClass: 'invalid',
    })
    expect(await rejection(page.evaluate(42 as unknown as string))).toMatchObject({ errorClass: 'invalid' })
  })

  it('fails as aborted when the page has no frame', async () => {
    const surface = new FakeSurface(PARTITION, [])
    const page = new SurfaceToolPage(surface, EGRESS, timing(new ManualTimers()))
    expect(await rejection(page.evaluate('1'))).toMatchObject({ stage: 'tool-run', errorClass: 'aborted' })
  })
})

describe('ToolPage.fetch', () => {
  function siteWindow(seen: [string, unknown][]) {
    return new FakeWindow({
      fetch: async (url, init) => {
        seen.push([url, init])
        return {
          status: 200,
          headers: { get: () => 'application/json; charset=utf-8' },
          text: async () => '{"AvailableItems":[]}',
        }
      },
    })
  }

  it('fetches a path from the page with same-origin credentials and parses JSON', async () => {
    const seen: [string, unknown][] = []
    const { page } = await onHome(siteWindow(seen))
    expect(await page.fetch('/apis/ui/Trolley')).toEqual({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { AvailableItems: [] },
    })
    expect(seen).toEqual([
      ['https://www.example.com/apis/ui/Trolley', { method: 'GET', headers: {}, credentials: 'same-origin' }],
    ])
  })

  it('sends a JSON body and upper-cases the method', async () => {
    const seen: [string, unknown][] = []
    const { page } = await onHome(siteWindow(seen))
    await page.fetch('/api/v3/ui/trolley/update', { method: 'post', json: { items: [] } })
    expect(seen[0]).toEqual([
      'https://www.example.com/api/v3/ui/trolley/update',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: '{"items":[]}',
      },
    ])
  })

  it('refuses an undeclared host before the page sends anything', async () => {
    const seen: [string, unknown][] = []
    const { page } = await onHome(siteWindow(seen))
    for (const url of [
      'https://evil.test/collect',
      'http://www.example.com/x',
      '//evil.test/',
      'wss://www.example.com/',
    ]) {
      expect(await rejection(page.fetch(url)), url).toMatchObject({
        stage: 'egress',
        errorClass: 'host-not-allowed',
      })
    }
    expect(seen).toEqual([])
  })

  it('refuses a method or headers that could smuggle anything', async () => {
    const seen: [string, unknown][] = []
    const { page } = await onHome(siteWindow(seen))
    for (const init of [
      { method: 'GET\r\nX-Evil: 1' },
      { method: '' },
      { method: 'G E T' },
      { headers: { accept: 1 as unknown as string } },
      { headers: 'accept: x' as unknown as Record<string, string> },
    ]) {
      expect(await rejection(page.fetch('/x', init))).toMatchObject({
        stage: 'tool-input',
        errorClass: 'invalid',
      })
    }
    expect(seen).toEqual([])
  })

  it('refuses a JSON body JSON cannot carry', async () => {
    const { page } = await onHome(siteWindow([]))
    expect(await rejection(page.fetch('/x', { method: 'POST', json: { n: 1n } }))).toMatchObject({
      stage: 'tool-input',
      errorClass: 'invalid',
    })
  })

  it('reports a network failure as unavailable', async () => {
    const { page } = await onHome(new FakeWindow())
    expect(await rejection(page.fetch('/x'))).toMatchObject({ stage: 'tool-run', errorClass: 'unavailable' })
  })

  it('does not trust a malformed answer from the page', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    surface.frameList[0]!.run = async () => ({ status: '200' })
    expect(await rejection(page.fetch('/x'))).toMatchObject({ stage: 'tool-run', errorClass: 'internal' })
    surface.frameList[0]!.run = async () => ({ status: 204, contentType: 5 })
    expect(await page.fetch('/x')).toEqual({ status: 204, contentType: null, body: null })
  })
})

describe('ToolPage.close', () => {
  it('destroys the window once', async () => {
    const { surface, page } = await onHome(new FakeWindow())
    await page.close()
    await page.close()
    expect(surface.isDestroyed()).toBe(true)
    expect(await rejection(page.extract('h1'))).toMatchObject({ errorClass: 'aborted' })
  })
})
