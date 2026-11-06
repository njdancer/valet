import { inspect } from 'node:util'
import { SecretValue, SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { SurfaceAuthPage } from '../src/auth-page'
import { needsUserTitle } from '../src/needs-user'
import { FakeFrame, FakeSurface, flush, ManualTimers } from './fake-browser'
import { FakeForm, FakeWindow } from './fake-dom'

const NAVIGATION = ['https://www.example.com', 'https://login.example.com']
const PARTITION = 'persist:auth:example'
/** A grant for both login origins, so a test fails only on the check it is about. */
const GRANT = { allowedOrigins: NAVIGATION }

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

/** A main frame on www.example.com holding a login form, and a cross-origin iframe. */
function loginFrames() {
  const mainWindow = new FakeWindow()
  const user = mainWindow.document.add(
    '#user',
    mainWindow.document.element('INPUT', { type: 'email', attributes: { autocomplete: 'username' } }),
  )
  user.form = new FakeForm('https://www.example.com/login')
  const childWindow = new FakeWindow()
  mainWindow.attachChild(childWindow)
  const iframe = mainWindow.document.add(
    'iframe, frame',
    mainWindow.document.element('IFRAME', { rect: { left: 200, top: 100, width: 400, height: 300 } }),
  )
  iframe.contentWindow = childWindow.global
  const password = childWindow.document.add(
    '#password',
    childWindow.document.element('INPUT', {
      type: 'password',
      rect: { left: 10, top: 20, width: 100, height: 30 },
    }),
  )
  password.form = new FakeForm('https://login.example.com/session')
  const main = new FakeFrame('https://www.example.com', 'https://www.example.com/login', null, mainWindow)
  const child = new FakeFrame('https://login.example.com', 'https://login.example.com/frame', 0, childWindow)
  return { main, child, mainWindow, childWindow }
}

describe('AuthPage.goto', () => {
  it('loads a URL on the navigation list and records the commit', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await page.goto('https://www.example.com/login')
    expect(surface.loads).toEqual(['https://www.example.com/login'])
    expect(page.currentUrl()).toBe('https://www.example.com/login')
    expect(page.committedUrls()).toEqual(['https://www.example.com/login'])
  })

  it('refuses a URL off the list without loading it', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    for (const url of [
      'https://www.example.com.evil.test/',
      'http://www.example.com/',
      'https://evil.test/',
    ]) {
      const error = await rejection(page.goto(url))
      expect(error).toMatchObject({ stage: 'navigate', errorClass: 'navigation-escaped' })
    }
    expect(surface.loads).toEqual([])
  })

  it('waits for loading to stop after ERR_ABORTED, when the page navigated itself', async () => {
    const surface = new FakeSurface(PARTITION)
    surface.onLoad = (url) => {
      surface.commit(url)
      surface.loading = true
      return { ok: false, code: 'ERR_ABORTED' }
    }
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    let done = false
    const going = page.goto('https://www.example.com/').then(() => (done = true))
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    surface.commit('https://www.example.com/shop')
    surface.finishLoading()
    await going
    expect(page.committedUrls()).toEqual(['https://www.example.com/', 'https://www.example.com/shop'])
  })

  it('treats ERR_ABORTED as done when nothing is loading any more', async () => {
    const surface = new FakeSurface(PARTITION)
    surface.onLoad = () => ({ ok: false, code: 'ERR_ABORTED' })
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await expect(page.goto('https://www.example.com/')).resolves.toBeUndefined()
  })

  it('reports any other load failure as unavailable, without the network error', async () => {
    const surface = new FakeSurface(PARTITION)
    surface.onLoad = () => ({ ok: false, code: 'ERR_NAME_NOT_RESOLVED' })
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const error = await rejection(page.goto('https://www.example.com/'))
    expect(error).toMatchObject({ stage: 'navigate', errorClass: 'unavailable' })
    expect(error.message).toBe('navigate: unavailable')
  })

  it('times out a load that never finishes', async () => {
    const timers = new ManualTimers()
    const surface = new FakeSurface(PARTITION)
    surface.onLoad = () => new Promise(() => {})
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    const error = await timers.settle(rejection(page.goto('https://www.example.com/')))
    expect(error).toMatchObject({ stage: 'timeout', errorClass: 'timed-out' })
    expect(timers.now).toBe(1000)
  })

  it('turns an unexpected throw from the browser into internal, without its message', async () => {
    const surface = new FakeSurface(PARTITION)
    surface.onLoad = () => {
      throw new Error('renderer crashed while showing hunter2')
    }
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const error = await rejection(page.goto('https://www.example.com/'))
    expect(error).toMatchObject({ stage: 'navigate', errorClass: 'internal' })
    expect(error.message).not.toContain('hunter2')
  })
})

describe('AuthPage navigation guard', () => {
  it('stops a server redirect off the list during goto, and poisons the page', async () => {
    const surface = new FakeSurface(PARTITION)
    surface.onLoad = () => {
      const allowed = surface.attemptNavigation('https://evil.test/landing', true)
      return allowed ? { ok: true } : { ok: false, code: 'ERR_ABORTED' }
    }
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const error = await rejection(page.goto('https://www.example.com/login?next=https://evil.test/landing'))
    expect(error).toMatchObject({ stage: 'navigate', errorClass: 'navigation-escaped' })
    const later = await rejection(page.inspect('#password'))
    expect(later).toMatchObject({ stage: 'navigate', errorClass: 'navigation-escaped' })
  })

  it('stops a page-initiated main-frame navigation off the list, and every later primitive fails', async () => {
    const surface = new FakeSurface(PARTITION, [loginFrames().main])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    expect(surface.attemptNavigation('https://evil.test/', true)).toBe(false)
    for (const attempt of [
      () => page.goto('https://www.example.com/'),
      () => page.inspect('#user'),
      () => page.click('#user'),
      () => page.focus('#user'),
      () => page.type('x'),
      () => page.type(SecretValue.fromString('hunter2'), GRANT),
      () => page.textPresent('x'),
    ]) {
      const error = await rejection(attempt())
      expect(error).toMatchObject({ stage: 'navigate', errorClass: 'navigation-escaped' })
    }
    expect(surface.chars).toEqual([])
  })

  it('allows main-frame navigation between the listed origins', () => {
    const surface = new FakeSurface(PARTITION)
    new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    expect(surface.attemptNavigation('https://login.example.com/mfa', true)).toBe(true)
    expect(surface.attemptNavigation('https://www.example.com/', true)).toBe(true)
  })

  it('stops a subframe on an origin nobody declared, without poisoning the page', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    expect(surface.attemptNavigation('https://captcha.test/frame', false)).toBe(false)
    await expect(page.goto('https://www.example.com/')).resolves.toBeUndefined()
  })

  it('lets a subframe load a navigation origin or one of the manifest’s frame origins', () => {
    const surface = new FakeSurface(PARTITION)
    new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()), {
      frameOrigins: ['https://captcha.test'],
    })
    expect(surface.attemptNavigation('https://captcha.test/frame', false)).toBe(true)
    expect(surface.attemptNavigation('https://login.example.com/frame', false)).toBe(true)
    expect(surface.attemptNavigation('https://widget.test/frame', false)).toBe(false)
    // A frame origin never opens the main frame.
    expect(surface.attemptNavigation('https://captcha.test/', true)).toBe(false)
  })

  it('stops a subframe loading a script URL, still without poisoning the page', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    expect(surface.attemptNavigation('javascript:alert(1)', false)).toBe(false)
    await expect(page.goto('https://www.example.com/')).resolves.toBeUndefined()
  })

  it('poisons the page and stops it when an off-list main-frame commit slips past the guard', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    surface.commit('https://evil.test/')
    expect(surface.stopCalls).toBe(1)
    const error = await rejection(page.click('#user'))
    expect(error.errorClass).toBe('navigation-escaped')
  })

  it('records main-frame commits and redirects, not subframe ones', () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    surface.redirect('https://www.example.com/login')
    surface.commit('https://login.example.com/start')
    surface.commit('https://captcha.test/frame', false)
    surface.redirect('https://captcha.test/next', false)
    expect(page.committedUrls()).toEqual(['https://www.example.com/login', 'https://login.example.com/start'])
  })

  it('hands out a copy of the committed URLs', () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    surface.commit('https://www.example.com/')
    ;(page.committedUrls() as string[]).push('https://evil.test/')
    expect(page.committedUrls()).toEqual(['https://www.example.com/'])
  })
})

describe('AuthPage.inspect', () => {
  it('describes an element in the main frame, with the origin the browser reports', async () => {
    const { main, child } = loginFrames()
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#user')).toEqual({
      visible: true,
      tagName: 'input',
      inputType: 'email',
      autocomplete: 'username',
      inputMode: null,
      frameOrigin: 'https://www.example.com',
      formActionOrigin: 'https://www.example.com',
      inputReachable: true,
    })
  })

  it('says trusted input cannot reach an element in an out-of-process frame', async () => {
    const { main, child } = loginFrames()
    child.receivesInput = false
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#password')).toMatchObject({
      frameOrigin: 'https://login.example.com',
      inputReachable: false,
    })
    expect(await page.inspect('#user')).toMatchObject({ inputReachable: true })
  })

  it('finds an element in a cross-origin iframe and reports that frame’s origin', async () => {
    const { main, child } = loginFrames()
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#password')).toMatchObject({
      inputType: 'password',
      frameOrigin: 'https://login.example.com',
      formActionOrigin: 'https://login.example.com',
    })
  })

  it('takes the frame origin from the browser, so a page cannot claim another', async () => {
    const { main, child, childWindow } = loginFrames()
    // A hostile frame's own idea of its origin plays no part.
    childWindow.sandbox['origin'] = 'https://www.example.com'
    child.origin = 'https://ads.test'
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#password')).toMatchObject({ frameOrigin: 'https://ads.test' })
  })

  it('prefers the main frame when both frames match', async () => {
    const { main, child, childWindow } = loginFrames()
    childWindow.document.add('#user', childWindow.document.element('INPUT', { type: 'text' }))
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#user')).toMatchObject({ frameOrigin: 'https://www.example.com' })
  })

  it('reports where a password would really be submitted', async () => {
    const { main, mainWindow } = loginFrames()
    const search = mainWindow.document.add('#q', mainWindow.document.element('INPUT', { type: 'search' }))
    search.form = new FakeForm('https://analytics.test/search?q=')
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#q')).toMatchObject({ formActionOrigin: 'https://analytics.test' })
  })

  it('reports an opaque or unparseable form action as "null", which no allowlist holds', async () => {
    const { main, mainWindow } = loginFrames()
    const a = mainWindow.document.add('#a', mainWindow.document.element('INPUT', { type: 'password' }))
    a.form = new FakeForm('javascript:void(0)')
    const b = mainWindow.document.add('#b', mainWindow.document.element('INPUT', { type: 'password' }))
    b.form = new FakeForm('not a url')
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#a')).toMatchObject({ formActionOrigin: 'null' })
    expect(await page.inspect('#b')).toMatchObject({ formActionOrigin: 'null' })
  })

  it('gives null when no frame has the element', async () => {
    const { main, child } = loginFrames()
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#nothing')).toBeNull()
  })

  it('skips a frame whose script fails, as when it is mid-navigation', async () => {
    const { main, child } = loginFrames()
    main.fail = true
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#user')).toBeNull()
    expect(await page.inspect('#password')).toMatchObject({ frameOrigin: 'https://login.example.com' })
  })

  it('does not trust a malformed answer from a frame', async () => {
    const { main } = loginFrames()
    const hostile = new FakeFrame('https://ads.test', 'https://ads.test/', 0)
    hostile.run = async () => ({ visible: 'yes', tagName: 'input' })
    const alsoHostile = new FakeFrame('https://ads.test', 'https://ads.test/', 0)
    alsoHostile.run = async () => ({ visible: true, tagName: 'input', inputType: 7 })
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, hostile, alsoHostile]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.inspect('#password')).toBeNull()
  })

  it('rejects an invalid selector', async () => {
    const { main, mainWindow } = loginFrames()
    mainWindow.document.invalidSelectors.add('input[')
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    const error = await rejection(page.inspect('input['))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'invalid' })
  })
})

describe('AuthPage.click', () => {
  it('sends a trusted click at the centre of a main-frame element', async () => {
    const { main, mainWindow } = loginFrames()
    mainWindow.document.add(
      '#go',
      mainWindow.document.element('BUTTON', { rect: { left: 100, top: 500, width: 80, height: 40 } }),
    )
    const surface = new FakeSurface(PARTITION, [main])
    await new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#go')
    expect(surface.clicks).toEqual([{ x: 140, y: 520 }])
  })

  it('adds the iframe’s offset for an element inside it', async () => {
    const { main, child } = loginFrames()
    const surface = new FakeSurface(PARTITION, [main, child])
    await new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#password')
    expect(surface.clicks).toEqual([{ x: 260, y: 135 }])
  })

  it('adds every iframe’s offset for an element two frames down', async () => {
    const { main, child, childWindow } = loginFrames()
    const grandchildWindow = new FakeWindow()
    childWindow.attachChild(grandchildWindow)
    const inner = childWindow.document.add(
      'iframe, frame',
      childWindow.document.element('IFRAME', { rect: { left: 5, top: 7, width: 300, height: 200 } }),
    )
    inner.contentWindow = grandchildWindow.global
    grandchildWindow.document.add(
      '#otp',
      grandchildWindow.document.element('INPUT', {
        type: 'text',
        rect: { left: 0, top: 0, width: 20, height: 10 },
      }),
    )
    const grandchild = new FakeFrame(
      'https://otp.example.com',
      'https://otp.example.com/',
      1,
      grandchildWindow,
    )
    const surface = new FakeSurface(PARTITION, [main, child, grandchild])
    await new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#otp')
    expect(surface.clicks).toEqual([{ x: 200 + 5 + 10, y: 100 + 7 + 5 }])
  })

  it('refuses to click when something covers the element', async () => {
    const { main, mainWindow } = loginFrames()
    mainWindow.document.add('#go', mainWindow.document.element('BUTTON'))
    const banner = mainWindow.document.element('DIV')
    mainWindow.document.hitTest = () => banner
    const surface = new FakeSurface(PARTITION, [main])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#go'),
    )
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'element-unsuitable' })
    expect(surface.clicks).toEqual([])
  })

  it('refuses to click an element with no size', async () => {
    const { main, mainWindow } = loginFrames()
    mainWindow.document.add(
      '#go',
      mainWindow.document.element('BUTTON', { rect: { left: 0, top: 0, width: 0, height: 0 } }),
    )
    const surface = new FakeSurface(PARTITION, [main])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#go'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('refuses when it cannot place the iframe in its parent, rather than clicking somewhere else', async () => {
    const { main, child, mainWindow } = loginFrames()
    mainWindow.document.bySelector.delete('iframe, frame')
    const surface = new FakeSurface(PARTITION, [main, child])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#password'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.clicks).toEqual([])
  })

  it('refuses when a child frame cannot say where it sits in its parent', async () => {
    const { main, childWindow } = loginFrames()
    const orphan = new FakeFrame('https://login.example.com', 'https://login.example.com/', 0, childWindow)
    childWindow.sandbox['parent'] = new FakeWindow().global
    const surface = new FakeSurface(PARTITION, [main, orphan])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#password'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('refuses when a frame names a parent that is not there', async () => {
    const { childWindow } = loginFrames()
    const lost = new FakeFrame('https://login.example.com', 'https://login.example.com/', 5, childWindow)
    const surface = new FakeSurface(PARTITION, [lost])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#password'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('reports a missing element', async () => {
    const { main } = loginFrames()
    const error = await rejection(
      new SurfaceAuthPage(new FakeSurface(PARTITION, [main]), NAVIGATION, timing(new ManualTimers())).click(
        '#x',
      ),
    )
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'element-missing' })
  })
})

describe('AuthPage.focus', () => {
  it('focuses the element in whichever frame has it', async () => {
    const { main, child, childWindow } = loginFrames()
    const surface = new FakeSurface(PARTITION, [main, child])
    await new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).focus('#password')
    expect(childWindow.document.activeElement).toBe(childWindow.document.querySelector('#password'))
    expect(surface.focusCalls).toBe(1)
  })

  it('reports an element that will not take focus', async () => {
    const { main, mainWindow } = loginFrames()
    const label = mainWindow.document.add('#label', mainWindow.document.element('SPAN'))
    label.focusable = false
    const error = await rejection(
      new SurfaceAuthPage(new FakeSurface(PARTITION, [main]), NAVIGATION, timing(new ManualTimers())).focus(
        '#label',
      ),
    )
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('reports a missing element', async () => {
    const { main } = loginFrames()
    const error = await rejection(
      new SurfaceAuthPage(new FakeSurface(PARTITION, [main]), NAVIGATION, timing(new ManualTimers())).focus(
        '#x',
      ),
    )
    expect(error.errorClass).toBe('element-missing')
  })
})

/**
 * The login page with keyboard focus already on `selector`, as the interpreter leaves it: it
 * inspects the element (and checks the grant against its frame origin), then focuses it.
 */
async function focusedOn(selector: string) {
  const timers = new ManualTimers()
  const frames = loginFrames()
  const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
  const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
  await page.inspect(selector)
  await page.focus(selector)
  return { timers, surface, page, ...frames }
}

describe('AuthPage.type', () => {
  it('sends one trusted char per character, paced in Node', async () => {
    const { timers, surface, page } = await focusedOn('#user')
    await timers.settle(page.type('nick@example.com'))
    expect(surface.chars.join('')).toBe('nick@example.com')
    // inspect()'s and focus()'s step timeouts, type()'s, then one gap between each pair of characters.
    expect(timers.requested).toEqual([1000, 1000, 1000 + 16 * 50, ...Array(15).fill(50)])
  })

  it('types literal text with no focus() first, wherever focus is', async () => {
    const timers = new ManualTimers()
    const surface = new FakeSurface(PARTITION)
    await timers.settle(new SurfaceAuthPage(surface, NAVIGATION, timing(timers)).type('abc'))
    expect(surface.chars).toEqual(['a', 'b', 'c'])
  })

  it('uses the delay it is given, and the default for nonsense', async () => {
    const { timers, surface, page } = await focusedOn('#user')
    await timers.settle(page.type('ab', { delayMs: 120 }))
    await timers.settle(page.type('cd', { delayMs: -5 }))
    await timers.settle(page.type('ef', { delayMs: Number.NaN }))
    await timers.settle(page.type('gh', { delayMs: 60_000 }))
    expect(timers.requested.filter((ms) => ms < 1000)).toEqual([120, 50, 50])
    expect(timers.requested).toContain(5000)
    expect(surface.chars.join('')).toBe('abcdefgh')
  })

  it('sends a character outside the BMP as one event', async () => {
    const { timers, surface, page } = await focusedOn('#user')
    await timers.settle(page.type('a🔑b'))
    expect(surface.chars).toEqual(['a', '🔑', 'b'])
  })

  it('types a secret one code point at a time, never revealing the whole plaintext', async () => {
    const { timers, surface, page } = await focusedOn('#password')
    const secret = SecretValue.fromString('correct 🐴')
    const revealEach = secret.revealEach.bind(secret)
    let wholeReveals = 0
    secret.reveal = () => {
      wholeReveals++
      throw new Error('the whole plaintext must not be revealed')
    }
    const handed: string[] = []
    let settled = false
    secret.revealEach = (use) =>
      revealEach(async (character) => {
        handed.push(character)
        await use(character)
      }).finally(() => (settled = true))
    const afterSettled: number[] = []
    surface.afterChar = (index) => {
      if (settled) afterSettled.push(index)
    }
    await timers.settle(page.type(secret, GRANT))
    expect(surface.chars).toEqual(['c', 'o', 'r', 'r', 'e', 'c', 't', ' ', '🐴'])
    expect(handed).toEqual(surface.chars)
    expect(wholeReveals).toBe(0)
    expect(afterSettled).toEqual([])
  })

  it('runs each keystroke of a secret as a step of its own, paced in Node', async () => {
    const { timers, page } = await focusedOn('#password')
    await timers.settle(page.type(SecretValue.fromString('abc'), GRANT))
    // inspect()'s and focus()'s steps, the pre-check, then a step per key with a gap between.
    expect(timers.requested).toEqual([1000, 1000, 1000, 1000, 50, 1000, 50, 1000])
  })

  it('times out a keystroke whose checks hang, and sends nothing more', async () => {
    const { timers, surface, page, child } = await focusedOn('#password')
    surface.afterChar = () => {
      child.run = () => new Promise(() => {})
    }
    const error = await timers.settle(rejection(page.type(SecretValue.fromString('hunter2'), GRANT)))
    expect(error).toMatchObject({ stage: 'timeout', errorClass: 'timed-out' })
    expect(surface.chars).toEqual(['h'])
  })

  it('refuses a secret without the grant’s origins, before anything else', async () => {
    const { surface, page } = await focusedOn('#password')
    for (const options of [undefined, {}, { allowedOrigins: [] }]) {
      const error = await rejection(page.type(SecretValue.fromString('hunter2'), options))
      expect(error, JSON.stringify(options)).toMatchObject({
        stage: 'secret-fill',
        errorClass: 'origin-mismatch',
      })
    }
    expect(surface.chars).toEqual([])
  })

  it('stops typing a secret when the focused frame leaves the grant’s origins partway', async () => {
    const { timers, surface, page, child } = await focusedOn('#password')
    surface.afterChar = (index) => {
      if (index === 1) child.origin = 'https://www.example.com'
    }
    const error = await timers.settle(
      rejection(
        page.type(SecretValue.fromString('hunter2'), { allowedOrigins: ['https://login.example.com'] }),
      ),
    )
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual(['h', 'u'])
  })

  it('stops typing a secret when the site moves focus to another element in the same frame', async () => {
    const { timers, surface, page, childWindow } = await focusedOn('#password')
    const search = childWindow.document.add('#q', childWindow.document.element('INPUT', { type: 'search' }))
    surface.afterChar = (index) => {
      if (index === 2) search.focus()
    }
    const error = await timers.settle(rejection(page.type(SecretValue.fromString('hunter2'), GRANT)))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual(['h', 'u', 'n'])
  })

  it('types literal text only on the given origins, when given them', async () => {
    const { timers, surface, page } = await focusedOn('#user')
    const refused = await rejection(page.type('nick', { allowedOrigins: ['https://login.example.com'] }))
    expect(refused).toMatchObject({ stage: 'auth-step', errorClass: 'origin-mismatch' })
    await timers.settle(page.type('nick', { allowedOrigins: ['https://www.example.com'] }))
    expect(surface.chars.join('')).toBe('nick')
  })

  it('refuses literal text with origins to check but no focus() target to check them on', async () => {
    const surface = new FakeSurface(PARTITION, [loginFrames().main])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const error = await rejection(page.type('nick', { allowedOrigins: NAVIGATION }))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual([])
  })

  it('sends full key events when the page is set to', async () => {
    const timers = new ManualTimers()
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, { ...timing(timers), keyEvents: 'full' })
    await page.inspect('#password')
    await page.focus('#password')
    await timers.settle(page.type(SecretValue.fromString('ab'), GRANT))
    await timers.settle(page.type('c'))
    expect(surface.keyEvents).toEqual(['full', 'full', 'full'])
  })

  it('keeps nothing of the secret on the page object', async () => {
    const { timers, surface, page } = await focusedOn('#password')
    await timers.settle(page.type(SecretValue.fromString('canary-7f3a'), GRANT))
    surface.chars.length = 0 // the fake records what it was sent; the page must hold nothing
    expect(inspect(page, { depth: 10, showHidden: true })).not.toContain('canary-7f3a')
  })

  it('refuses a secret with no focus() first, rather than typing wherever focus happens to be', async () => {
    const surface = new FakeSurface(PARTITION, [loginFrames().main])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('refuses when the site moved focus to another element after focus()', async () => {
    const { surface, page, mainWindow } = await focusedOn('#user')
    mainWindow.document.add('#q', mainWindow.document.element('INPUT', { type: 'search' })).focus()
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('refuses literal text too when the site moved focus after focus()', async () => {
    const { surface, page, mainWindow } = await focusedOn('#user')
    mainWindow.document.add('#q', mainWindow.document.element('INPUT', { type: 'search' })).focus()
    const error = await rejection(page.type('nick@example.com'))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('refuses a secret on a window that is gone', async () => {
    const { surface, page } = await focusedOn('#password')
    surface.destroy()
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'aborted' })
  })

  it('refuses when the browser says keyboard focus is in another frame', async () => {
    const { surface, page, child } = await focusedOn('#user')
    surface.focusedFrame = child.id
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('refuses when the focused frame now holds another origin', async () => {
    const { surface, page, child } = await focusedOn('#password')
    child.origin = 'https://ads.test'
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.chars).toEqual([])
  })

  it('refuses when the focused frame is gone', async () => {
    const { surface, page, main } = await focusedOn('#password')
    surface.frameList = [main]
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('refuses after a goto, which leaves the focused element behind', async () => {
    const { surface, page } = await focusedOn('#user')
    await page.goto('https://www.example.com/login')
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.chars).toEqual([])
  })

  it('refuses when the window has lost focus', async () => {
    const { surface, page, mainWindow } = await focusedOn('#user')
    mainWindow.document.windowFocused = false
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.chars).toEqual([])
  })

  it('stops the moment keyboard focus leaves the frame partway through', async () => {
    const { timers, surface, page, main } = await focusedOn('#password')
    surface.afterChar = (index) => {
      if (index === 1) surface.focusedFrame = main.id
    }
    const error = await timers.settle(rejection(page.type(SecretValue.fromString('hunter2'), GRANT)))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual(['h', 'u'])
  })

  it('stops literal text as aborted when keyboard focus leaves the frame partway through', async () => {
    const { timers, surface, page, child } = await focusedOn('#user')
    surface.afterChar = (index) => {
      if (index === 1) surface.focusedFrame = child.id
    }
    const error = await timers.settle(rejection(page.type('nick@example.com')))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'aborted' })
    expect(surface.chars).toEqual(['n', 'i'])
  })

  it('stops typing a secret that is disposed partway, and says nothing about it', async () => {
    const { timers, surface, page } = await focusedOn('#password')
    const secret = SecretValue.fromString('hunter2')
    surface.afterChar = (index) => {
      if (index === 2) secret.dispose()
    }
    const error = await timers.settle(rejection(page.type(secret, GRANT)))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'aborted' })
    expect(error.message).toBe('secret-fill: aborted')
    expect(surface.chars).toEqual(['h', 'u', 'n'])
  })

  it('refuses a secret that is already disposed', async () => {
    const { surface, page } = await focusedOn('#password')
    const secret = SecretValue.fromString('hunter2')
    secret.dispose()
    const error = await rejection(page.type(secret, GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'aborted' })
    expect(surface.chars).toEqual([])
  })

  it('stops the moment any frame commits a navigation, so no character lands in another document', async () => {
    const { timers, surface, page } = await focusedOn('#password')
    surface.afterChar = (index) => {
      if (index === 1) surface.commit('https://login.example.com/frame', false)
    }
    const error = await timers.settle(rejection(page.type(SecretValue.fromString('hunter2'), GRANT)))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual(['h', 'u'])
  })

  it('stops when the page is poisoned partway through', async () => {
    const { timers, surface, page } = await focusedOn('#password')
    surface.afterChar = (index) => {
      if (index === 0) surface.attemptNavigation('https://evil.test/', true)
    }
    const error = await timers.settle(rejection(page.type(SecretValue.fromString('hunter2'), GRANT)))
    expect(error.errorClass).toBe('navigation-escaped')
    expect(surface.chars).toEqual(['h'])
  })

  it('stops when the window is destroyed partway through', async () => {
    const { timers, surface, page } = await focusedOn('#user')
    surface.afterChar = (index) => {
      if (index === 0) surface.destroy()
    }
    const error = await timers.settle(rejection(page.type('abc')))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'aborted' })
    expect(surface.chars).toEqual(['a'])
  })

  it('types nothing for an empty secret', async () => {
    const { surface, page } = await focusedOn('#password')
    await page.type(SecretValue.fromString(''), GRANT)
    expect(surface.chars).toEqual([])
  })
})

describe('trusted input and out-of-process frames', () => {
  it('refuses to focus an element in a frame trusted input cannot reach', async () => {
    const frames = loginFrames()
    frames.child.receivesInput = false
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const error = await rejection(page.focus('#password'))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'element-unsuitable' })
    expect((await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))).errorClass).toBe(
      'element-unsuitable',
    )
    expect(surface.chars).toEqual([])
  })

  it('refuses to click an element in such a frame, rather than clicking the iframe around it', async () => {
    const frames = loginFrames()
    frames.child.receivesInput = false
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#password'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.clicks).toEqual([])
  })

  it('refuses a click whose path passes through such a frame', async () => {
    const frames = loginFrames()
    frames.child.receivesInput = false
    const grandchildWindow = new FakeWindow()
    frames.childWindow.attachChild(grandchildWindow)
    grandchildWindow.document.add('#otp', grandchildWindow.document.element('INPUT', { type: 'text' }))
    const grandchild = new FakeFrame(
      'https://www.example.com',
      'https://www.example.com/otp',
      1,
      grandchildWindow,
    )
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child, grandchild])
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).click('#otp'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.clicks).toEqual([])
  })

  it('refuses focus the browser says did not land in the element’s frame', async () => {
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    surface.focusedFrame = frames.main.id
    const error = await rejection(
      new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).focus('#password'),
    )
    expect(error.errorClass).toBe('element-unsuitable')
  })
})

describe('AuthPage.textPresent', () => {
  it('looks in every frame', async () => {
    const { main, child, childWindow } = loginFrames()
    childWindow.document.body = { innerText: 'Enter the code we sent' }
    const page = new SurfaceAuthPage(
      new FakeSurface(PARTITION, [main, child]),
      NAVIGATION,
      timing(new ManualTimers()),
    )
    expect(await page.textPresent('code we sent')).toBe(true)
    expect(await page.textPresent('Welcome back')).toBe(false)
  })
})

describe('AuthPage.handToUser', () => {
  it('shows the window and resolves when the person closes it, keeping the page alive', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    let done = false
    const handed = page.handToUser('captcha').then(() => (done = true))
    expect(surface.shown).toEqual([
      'The site showed a verification check that siteadapter won’t solve for you. Close this window when you’re done.',
    ])
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    expect(surface.requestClose()).toBe(true)
    await handed
    expect(surface.hideCalls).toBe(1)
    expect(surface.isDestroyed()).toBe(false)
  })

  it('resolves if the window is destroyed instead', async () => {
    const surface = new FakeSurface(PARTITION)
    const handed = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).handToUser(
      'login-required',
    )
    surface.destroy()
    await expect(handed).resolves.toBeUndefined()
  })

  it('resolves at once for a window that is already gone', async () => {
    const surface = new FakeSurface(PARTITION)
    surface.destroy()
    await new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers())).handToUser('login-required')
    expect(surface.shown).toEqual([])
  })
})

describe('AuthPage.close', () => {
  it('destroys the window, after which primitives fail as aborted', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await page.close()
    await page.close()
    expect(surface.isDestroyed()).toBe(true)
    const error = await rejection(page.goto('https://www.example.com/'))
    expect(error).toMatchObject({ stage: 'navigate', errorClass: 'aborted' })
    expect((await rejection(page.inspect('#user'))).errorClass).toBe('aborted')
  })
})

/** Makes `frame` answer each script only once the test releases it. The script itself runs at once. */
function answerLate(frame: FakeFrame): () => void {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const run = frame.run.bind(frame)
  frame.run = async (code) => {
    const result = await run(code)
    await gate
    return result
  }
  return release
}

describe('the frame a secret is typed into is the frame inspect() reported', () => {
  it('refuses focus when the selector’s first match has moved to another frame since inspect', async () => {
    const frames = loginFrames()
    // A same-site widget on a sibling subdomain, which inspect never reported.
    const widgetWindow = new FakeWindow()
    frames.mainWindow.attachChild(widgetWindow)
    const widget = new FakeFrame('https://widget.example.com', 'https://widget.example.com/', 0, widgetWindow)
    const surface = new FakeSurface(PARTITION, [frames.main, widget, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    expect(await page.inspect('#password')).toMatchObject({ frameOrigin: 'https://login.example.com' })
    // The DOM changes between inspect and focus: the widget now has a matching field, first in order.
    widgetWindow.document.add('#password', widgetWindow.document.element('INPUT', { type: 'password' }))
    const error = await rejection(page.focus('#password'))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'element-unsuitable' })
    const typed = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(typed).toMatchObject({ stage: 'secret-fill', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('refuses focus when the inspected frame now holds another origin', async () => {
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await page.inspect('#password')
    frames.child.origin = 'https://ads.test'
    expect((await rejection(page.focus('#password'))).errorClass).toBe('element-unsuitable')
  })

  it('refuses a secret after a focus() that no inspect() of the same selector preceded', async () => {
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await page.inspect('#user')
    await page.focus('#password')
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('still types literal text after a focus() with no inspect()', async () => {
    const timers = new ManualTimers()
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    await page.focus('#user')
    await timers.settle(page.type('nick'))
    expect(surface.chars.join('')).toBe('nick')
  })

  it('forgets what it inspected when the main frame commits a new document', async () => {
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await page.inspect('#password')
    surface.commit('https://www.example.com/login?step=2')
    await page.focus('#password')
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
    expect(surface.chars).toEqual([])
  })

  it('forgets the focus target when the main frame commits a new document', async () => {
    const { surface, page } = await focusedOn('#password')
    surface.commit('https://www.example.com/login?step=2')
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('refuses a secret for a frame that is not on https', async () => {
    const frames = loginFrames()
    frames.child.origin = 'null'
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    await page.inspect('#password')
    await page.focus('#password')
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual([])
  })

  it('checks the focused frame against the grant’s origins, when given them', async () => {
    const { timers, surface, page } = await focusedOn('#password')
    const refused = await rejection(
      page.type(SecretValue.fromString('hunter2'), { allowedOrigins: ['https://www.example.com'] }),
    )
    expect(refused).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual([])
    await timers.settle(
      page.type(SecretValue.fromString('hunter2'), { allowedOrigins: ['https://login.example.com'] }),
    )
    expect(surface.chars.join('')).toBe('hunter2')
  })
})

describe('a primitive whose step has timed out does nothing more', () => {
  it('sends no click when the element’s position arrives after the timeout', async () => {
    const timers = new ManualTimers()
    const { main, mainWindow } = loginFrames()
    mainWindow.document.add('#go', mainWindow.document.element('BUTTON'))
    const release = answerLate(main)
    const surface = new FakeSurface(PARTITION, [main])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    const clicking = rejection(page.click('#go'))
    await timers.advance(1000)
    expect(await clicking).toMatchObject({ stage: 'timeout', errorClass: 'timed-out' })
    release()
    await flush()
    await flush()
    expect(surface.clicks).toEqual([])
  })

  it('sends no click when an iframe’s offset arrives after the timeout', async () => {
    const timers = new ManualTimers()
    const { main, child } = loginFrames()
    const release = answerLate(main)
    const surface = new FakeSurface(PARTITION, [main, child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    // The main frame has no #password, so its (late) answer comes first; then the child's offset.
    const clicking = rejection(page.click('#password'))
    await timers.advance(1000)
    expect((await clicking).errorClass).toBe('timed-out')
    release()
    for (let i = 0; i < 5; i++) await flush()
    expect(surface.clicks).toEqual([])
    // It stopped before asking the child frame anything.
    expect(child.scripts).toEqual([])
  })

  it('leaves no focus target when focus answers after the timeout', async () => {
    const timers = new ManualTimers()
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    await page.inspect('#user')
    const release = answerLate(frames.main)
    const focusing = rejection(page.focus('#user'))
    await timers.advance(1000)
    expect((await focusing).errorClass).toBe('timed-out')
    release()
    for (let i = 0; i < 5; i++) await flush()
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'element-unsuitable' })
    expect(surface.chars).toEqual([])
  })

  it('leaves no focus target when a goto happened while focus waited', async () => {
    const timers = new ManualTimers()
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    await page.inspect('#user')
    const release = answerLate(frames.main)
    const focusing = rejection(page.focus('#user'))
    await flush()
    await page.goto('https://www.example.com/login')
    release()
    expect(await focusing).toMatchObject({ stage: 'auth-step', errorClass: 'aborted' })
    const error = await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))
    expect(error.errorClass).toBe('element-unsuitable')
  })

  it('does not bind a selector whose inspection answers after the timeout', async () => {
    const timers = new ManualTimers()
    const frames = loginFrames()
    const surface = new FakeSurface(PARTITION, [frames.main, frames.child])
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(timers))
    const release = answerLate(frames.main)
    const inspecting = rejection(page.inspect('#user'))
    await timers.advance(1000)
    expect((await inspecting).errorClass).toBe('timed-out')
    release()
    for (let i = 0; i < 5; i++) await flush()
    frames.main.run = FakeFrame.prototype.run.bind(frames.main)
    await page.focus('#user')
    expect((await rejection(page.type(SecretValue.fromString('hunter2'), GRANT))).errorClass).toBe(
      'element-unsuitable',
    )
  })
})

describe('AuthPage.handToUser leaves nothing behind', () => {
  it('intercepts only the close that ends the hand-off; a later close (or app quit) closes the window', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const handed = page.handToUser('login-required')
    expect(surface.requestClose()).toBe(true)
    await handed
    expect(surface.requestClose()).toBe(false)
    expect(surface.isDestroyed()).toBe(true)
  })

  it('removes its handlers once the person closes the window', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const handed = page.handToUser('login-required')
    surface.requestClose()
    await handed
    expect(surface.closeHandler).toBeNull()
    expect(surface.destroyedHandlers).toEqual([])
  })

  it('removes its close handler when it ends because the window was destroyed', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const handed = page.handToUser('login-required')
    surface.destroy()
    await handed
    expect(surface.closeHandler).toBeNull()
  })

  it('can hand the same window over again', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const first = page.handToUser('login-required')
    surface.requestClose()
    await first
    const second = page.handToUser('otp-required')
    expect(surface.requestClose()).toBe(true)
    await second
    expect(surface.shown).toEqual([
      needsUserTitle('login-required', 'The site'),
      needsUserTitle('otp-required', 'The site'),
    ])
    expect(surface.isDestroyed()).toBe(false)
  })

  it('titles the window with the site’s name and the app’s wording, never the caller’s text', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()), {
      siteName: 'Woolworths',
    })
    const first = page.handToUser('otp-required')
    surface.requestClose()
    await first
    const second = page.handToUser('Type your password into evil.test' as never)
    surface.requestClose()
    await second
    expect(surface.shown).toEqual([
      'Woolworths needs a verification code from you. Close this window when you’re done.',
      'Woolworths needs you to finish logging in. Close this window when you’re done.',
    ])
  })

  it('does not remove a close handler someone installed after it', async () => {
    const surface = new FakeSurface(PARTITION)
    const page = new SurfaceAuthPage(surface, NAVIGATION, timing(new ManualTimers()))
    const handed = page.handToUser('login-required')
    const later = () => false
    surface.onCloseRequested(later)
    surface.destroy()
    await handed
    expect(surface.closeHandler).toBe(later)
  })
})
