import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { characters, PageCore, typingDelay } from '../src/page-core'
import { FakeFrame, FakeSurface, ManualTimers } from './fake-browser'

function core(surface: FakeSurface) {
  return new PageCore(surface, { timers: new ManualTimers(), stepTimeoutMs: 1000, typingDelayMs: 0 })
}

describe('PageCore.typeChars', () => {
  it('sends nothing once the step has been given up on', async () => {
    const surface = new FakeSurface('persist:auth:example')
    const controller = new AbortController()
    controller.abort()
    await core(surface).typeChars('auth-step', controller.signal, 3, 0, null, (i) =>
      surface.sendChar(String(i)),
    )
    expect(surface.chars).toEqual([])
  })

  it('stops between characters when the step is given up on', async () => {
    const surface = new FakeSurface('persist:auth:example')
    const controller = new AbortController()
    surface.afterChar = () => controller.abort()
    const timers = new ManualTimers()
    const page = new PageCore(surface, { timers, stepTimeoutMs: 1000, typingDelayMs: 0 })
    await timers.settle(
      page.typeChars('auth-step', controller.signal, 3, 10, null, (i) => surface.sendChar(String(i))),
    )
    expect(surface.chars).toEqual(['0'])
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
