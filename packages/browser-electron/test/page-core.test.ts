import { ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { awaitPageFocus, characters, PageCore, typingDelay } from '../src/page-core'
import { FakeFrame, FakeSurface, ManualTimers } from './fake-browser'
import { FakeWindow } from './fake-dom'

function core(surface: FakeSurface) {
  return new PageCore(surface, { timers: new ManualTimers(), stepTimeoutMs: 1000, typingDelayMs: 0 })
}

const ANYWHERE = { stage: 'auth-step', target: null, moved: 'aborted' } as const

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

/** Where commits stand on a page that has seen none. */
const START = { nodes: null, counts: [], unplaced: 0, total: 0 } as const

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
    await expect(core(surface).beforeKey(guard, START, new AbortController().signal)).resolves.toBeUndefined()
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
      .beforeKey(guard, START, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'origin-mismatch' })
  })

  it('fails when focus moved to another element in the same frame', async () => {
    const { surface, target, window } = focusedInput()
    window.document.add('#q', window.document.element('INPUT', { type: 'search' })).focus()
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, moved: 'origin-mismatch' }, START, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('fails when the frame can no longer take trusted input', async () => {
    const { surface, target, frame } = focusedInput()
    frame.receivesInput = false
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, moved: 'origin-mismatch' }, START, new AbortController().signal)
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
        page.commitMark(target),
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
      .beforeKey({ ...ANYWHERE, target, moved: 'origin-mismatch' }, START, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('runs the guard’s own check first, and lets its error through', async () => {
    const { surface, target } = focusedInput()
    const before = () => {
      throw new ValetError('navigate', 'navigation-escaped')
    }
    const error = await core(surface)
      .beforeKey({ ...ANYWHERE, target, before }, START, new AbortController().signal)
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
    expect(error).toBeInstanceOf(ValetError)
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

describe('PageCore.focus', () => {
  /** A main frame with a #user field, and a page core whose timers the test fires. */
  function page(focusHoldMs?: number) {
    const { surface, frame } = focusedInput()
    const timers = new ManualTimers()
    const core = new PageCore(surface, { timers, stepTimeoutMs: 1000, typingDelayMs: 0, focusHoldMs })
    return { surface, frame, timers, core }
  }

  it('returns once focus has stayed on the field for a moment', async () => {
    const { surface, frame, timers, core } = page()
    const target = await timers.settle(core.focus('auth-step', '#user', new AbortController().signal))
    expect(target).toEqual({ frameId: frame.id, origin: frame.origin, selector: '#user' })
    expect(surface.focusCalls).toBe(1)
    expect(timers.now).toBeGreaterThanOrEqual(150)
  })

  // Seen on macOS: focus given to a hidden window lands some milliseconds late and puts keyboard
  // focus back on the main frame, just after the field took it. Nothing has been typed yet.
  it('focuses the field again when focus moves away before typing starts', async () => {
    const { surface, frame, timers, core } = page()
    let asked = 0
    const real = surface.focusedFrameId.bind(surface)
    surface.focusedFrameId = () => (++asked === 2 ? 'main-body' : real())
    const target = await timers.settle(core.focus('auth-step', '#user', new AbortController().signal))
    expect(target.frameId).toBe(frame.id)
    // Giving the window focus again would only start the late effects over.
    expect(surface.focusCalls).toBe(1)
  })

  it('gives up when focus keeps moving away', async () => {
    const { surface, timers, core } = page()
    let asked = 0
    const real = surface.focusedFrameId.bind(surface)
    surface.focusedFrameId = () => (++asked % 2 === 0 ? 'main-body' : real())
    const error = await timers.settle(
      rejection(core.focus('auth-step', '#user', new AbortController().signal)),
    )
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'element-unsuitable' })
  })

  it('stops watching when the step is given up on', async () => {
    const { timers, core } = page()
    const controller = new AbortController()
    const focusing = core.focus('auth-step', '#user', controller.signal)
    await timers.advance(30)
    controller.abort()
    const error = await timers.settle(rejection(focusing))
    expect(error).toMatchObject({ stage: 'auth-step', errorClass: 'aborted' })
  })
})

describe('awaitPageFocus', () => {
  // Focus given from the browser side reaches the page on its own channel, so the page's
  // document.hasFocus() can be false for a moment after focus() on a busy machine.
  it('waits for focus that arrives late', async () => {
    const timers = new ManualTimers()
    let asks = 0
    const run = async () => ++asks >= 4
    await expect(timers.settle(awaitPageFocus(run, timers))).resolves.toBe(true)
    expect(asks).toBe(4)
  })

  it('asks again when the frame is going away mid-question', async () => {
    const timers = new ManualTimers()
    let asks = 0
    const run = async () => {
      if (++asks === 1) throw new Error('frame gone')
      return true
    }
    await expect(timers.settle(awaitPageFocus(run, timers))).resolves.toBe(true)
  })

  it('gives up after about two seconds, so the caller’s own focus check decides', async () => {
    const timers = new ManualTimers()
    await expect(timers.settle(awaitPageFocus(async () => false, timers))).resolves.toBe(false)
    expect(timers.now).toBe(2000)
  })

  it('stops at once when the step is given up on', async () => {
    const timers = new ManualTimers()
    const controller = new AbortController()
    let asks = 0
    const run = async () => {
      asks++
      controller.abort()
      return 'not yet'
    }
    await expect(timers.settle(awaitPageFocus(run, timers, controller.signal))).resolves.toBe(false)
    expect(asks).toBe(1)
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

/** A main frame with two iframes: the login form, where #code has focus, and an analytics frame. */
function framedInput() {
  const main = new FakeFrame('https://www.example.com', 'https://www.example.com/', null)
  const formWindow = new FakeWindow()
  formWindow.document.add('#code', formWindow.document.element('INPUT', { type: 'text' })).focus()
  const form = new FakeFrame('https://www.example.com', 'https://www.example.com/form', 0, formWindow)
  const analytics = new FakeFrame('https://www.example.com', 'https://www.example.com/pixel', 0)
  const surface = new FakeSurface('persist:auth:example', [main, form, analytics])
  surface.focusedFrame = form.id
  const target = { frameId: form.id, origin: form.origin, selector: '#code' }
  return { main, form, analytics, surface, target }
}

describe('PageCore commits while typing', () => {
  const GUARD = { stage: 'secret-fill', moved: 'origin-mismatch' } as const

  it('types on when an unrelated sibling iframe reloads mid-type', async () => {
    const { surface, target, analytics } = framedInput()
    surface.afterChar = (index) => {
      if (index === 0) surface.commit('https://www.example.com/pixel?2', false, analytics.nodeId)
    }
    const timers = new ManualTimers()
    const page = new PageCore(surface, { timers, stepTimeoutMs: 1000, typingDelayMs: 0 })
    await timers.settle(
      page.typeChars({ ...GUARD, target }, new AbortController().signal, 3, 10, (i) =>
        surface.sendChar(String(i), 'char'),
      ),
    )
    expect(surface.chars).toEqual(['0', '1', '2'])
  })

  it('stops when the target frame itself commits, even on the same origin', async () => {
    const { surface, target, form } = framedInput()
    surface.afterChar = (index) => {
      if (index === 0) surface.commit('https://www.example.com/form?again', false, form.nodeId)
    }
    const timers = new ManualTimers()
    const page = new PageCore(surface, { timers, stepTimeoutMs: 1000, typingDelayMs: 0 })
    const error = await timers
      .settle(
        page.typeChars({ ...GUARD, target }, new AbortController().signal, 3, 10, (i) =>
          surface.sendChar(String(i), 'char'),
        ),
      )
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(surface.chars).toEqual(['0'])
  })

  it('stops when an ancestor of the target frame commits', async () => {
    const { surface, target } = framedInput()
    const page = core(surface)
    const mark = page.commitMark(target)
    surface.commit('https://www.example.com/elsewhere')
    const error = await page
      .beforeKey({ ...GUARD, target }, mark, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('stops on a commit the browser could not place in the frame tree', async () => {
    const { surface, target } = framedInput()
    const page = core(surface)
    const mark = page.commitMark(target)
    surface.commit('https://www.example.com/somewhere', false, null)
    const error = await page
      .beforeKey({ ...GUARD, target }, mark, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('falls back to every frame when the target’s frame is gone', async () => {
    const { surface, target, analytics } = framedInput()
    const page = core(surface)
    const mark = page.commitMark({ ...target, frameId: 'frame-gone' })
    expect(mark.nodes).toBeNull()
    surface.commit('https://www.example.com/pixel?2', false, analytics.nodeId)
    const error = await page
      .beforeKey({ ...GUARD, target: null }, mark, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('falls back to every frame when the target’s ancestry is broken', async () => {
    const { surface, target, form } = framedInput()
    ;(form as { parentIndex: number | null }).parentIndex = 7
    expect(core(surface).commitMark(target).nodes).toBeNull()
  })

  it('falls back to every frame when the frame tree loops', async () => {
    const { surface, target, form, main } = framedInput()
    ;(main as { parentIndex: number | null }).parentIndex = 1
    ;(form as { parentIndex: number | null }).parentIndex = 0
    expect(core(surface).commitMark(target).nodes).toBeNull()
  })

  it('lists the target frame and its ancestors in the mark', () => {
    const { surface, target, form, main } = framedInput()
    expect(core(surface).commitMark(target).nodes).toEqual([form.nodeId, main.nodeId])
  })
})
