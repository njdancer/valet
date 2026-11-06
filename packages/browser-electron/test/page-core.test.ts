import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { characters, PageCore, typingDelay } from '../src/page-core'
import { FakeFrame, FakeSurface, ManualTimers } from './fake-browser'
import { FakeWindow } from './fake-dom'

function core(surface: FakeSurface) {
  return new PageCore(surface, { timers: new ManualTimers(), stepTimeoutMs: 1000, typingDelayMs: 0 })
}

const ANYWHERE = { stage: 'auth-step', target: null, moved: 'aborted' } as const

describe('PageCore.typeChars', () => {
  it('sends nothing once the step has been given up on', async () => {
    const surface = new FakeSurface('persist:auth:example')
    const controller = new AbortController()
    controller.abort()
    const error = await core(surface)
      .typeChars(ANYWHERE, controller.signal, 3, 0, (i) => surface.sendChar(String(i), 'char'))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'aborted' })
    expect(surface.chars).toEqual([])
  })

  it('stops between characters when the step is given up on', async () => {
    const surface = new FakeSurface('persist:auth:example')
    const controller = new AbortController()
    surface.afterChar = () => controller.abort()
    const timers = new ManualTimers()
    const page = new PageCore(surface, { timers, stepTimeoutMs: 1000, typingDelayMs: 0 })
    await timers
      .settle(page.typeChars(ANYWHERE, controller.signal, 3, 10, (i) => surface.sendChar(String(i), 'char')))
      .catch(() => {})
    expect(surface.chars).toEqual(['0'])
  })
})

/** A main frame whose #user input has focus, and the target focus() would have left. */
function focusedInput() {
  const window = new FakeWindow()
  const input = window.document.add('#user', window.document.element('INPUT', { type: 'email' }))
  input.focus()
  const frame = new FakeFrame('https://www.example.com', 'https://www.example.com/', null, window)
  const surface = new FakeSurface('persist:auth:example', [frame])
  const target = { frameId: frame.id, origin: frame.origin, selector: '#user' }
  return { window, frame, surface, target }
}

describe('PageCore.beforeKey', () => {
  it('passes while the target still has focus on an allowed origin', async () => {
    const { surface, target } = focusedInput()
    const guard = { ...ANYWHERE, target, allowedOrigins: ['https://www.example.com'] }
    await expect(core(surface).beforeKey(guard, 0, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('fails with the guard’s class when the frame is not on the allowed origins', async () => {
    const { surface, target } = focusedInput()
    const guard = {
      ...ANYWHERE,
      target,
      moved: 'origin-mismatch',
      allowedOrigins: ['https://login.test'],
    } as const
    const error = await core(surface)
      .beforeKey(guard, 0, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'origin-mismatch' })
  })

  it('fails when focus moved to another element in the same frame', async () => {
    const { surface, target, window } = focusedInput()
    window.document.add('#q', window.document.element('INPUT', { type: 'search' })).focus()
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, moved: 'origin-mismatch' }, 0, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('fails when the frame can no longer take trusted input', async () => {
    const { surface, target, frame } = focusedInput()
    frame.receivesInput = false
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, moved: 'origin-mismatch' }, 0, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('fails when a frame commits while it asks the page whether the element has focus', async () => {
    const { surface, target, frame } = focusedInput()
    const page = core(surface)
    const run = frame.run.bind(frame)
    frame.run = async (code) => {
      surface.commit('https://www.example.com/next', false)
      return run(code)
    }
    const error = await page
      .beforeKey(
        { ...ANYWHERE, target, moved: 'origin-mismatch' },
        page.commitCount,
        new AbortController().signal,
      )
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('fails when the frame changes origin while it asks the page', async () => {
    const { surface, target, frame } = focusedInput()
    const run = frame.run.bind(frame)
    frame.run = async (code) => {
      frame.origin = 'https://evil.test'
      return run(code)
    }
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, moved: 'origin-mismatch' }, 0, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('runs the guard’s own check first, and lets its error through', async () => {
    const { surface, target } = focusedInput()
    const before = () => {
      throw new SiteAdapterError('navigate', 'navigation-escaped')
    }
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, before }, 0, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ stage: 'navigate', errorClass: 'navigation-escaped' })
  })
})

describe('PageCore.sendChar', () => {
  it('sends char events alone unless the page is set to full key events', () => {
    const surface = new FakeSurface('persist:auth:example')
    core(surface).sendChar('a')
    new PageCore(surface, {
      timers: new ManualTimers(),
      stepTimeoutMs: 1000,
      typingDelayMs: 0,
      keyEvents: 'full',
    }).sendChar('b')
    expect(surface.chars).toEqual(['a', 'b'])
    expect(surface.keyEvents).toEqual(['char', 'full'])
  })
})

describe('PageCore.click with malformed answers', () => {
  it('treats a point that is not a number as not found', async () => {
    const frame = new FakeFrame('https://www.example.com', 'https://www.example.com/', null)
    frame.run = async () => ({ x: Number.NaN, y: 1, hit: true })
    const surface = new FakeSurface('persist:auth:example', [frame])
    const error = await core(surface)
      .click('auth-step', '#go', new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SiteAdapterError)
    expect(error).toMatchObject({ errorClass: 'element-missing' })
  })

  it('refuses an offset that is not a number', async () => {
    const parent = new FakeFrame('https://www.example.com', 'https://www.example.com/', null)
    parent.run = async () => ({ x: 'left', y: 0 })
    const child = new FakeFrame('https://login.example.com', 'https://login.example.com/', 0)
    child.run = async () => ({ x: 1, y: 1, hit: true, indexInParent: 0 })
    const surface = new FakeSurface('persist:auth:example', [parent, child])
    const error = await core(surface)
      .click('auth-step', '#go', new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'element-unsuitable' })
    expect(surface.clicks).toEqual([])
  })

  it('refuses a frame index that is not a whole number', async () => {
    const parent = new FakeFrame('https://www.example.com', 'https://www.example.com/', null)
    parent.run = async () => null
    const child = new FakeFrame('https://login.example.com', 'https://login.example.com/', 0)
    child.run = async () => ({ x: 1, y: 1, hit: true, indexInParent: 0.5 })
    const surface = new FakeSurface('persist:auth:example', [parent, child])
    const error = await core(surface)
      .click('auth-step', '#go', new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'element-unsuitable' })
  })
})

describe('typingDelay', () => {
  it('keeps a sensible delay, defaults nonsense and caps the rest', () => {
    expect(typingDelay(80, 60)).toBe(80)
    expect(typingDelay(0, 60)).toBe(0)
    expect(typingDelay(undefined, 60)).toBe(60)
    expect(typingDelay(-1, 60)).toBe(60)
    expect(typingDelay(Number.POSITIVE_INFINITY, 60)).toBe(60)
    expect(typingDelay(10_000, 60)).toBe(5000)
  })
})

describe('characters', () => {
  it('splits by code point', () => {
    expect(characters('a😀é')).toEqual(['a', '😀', 'é'])
  })
})
