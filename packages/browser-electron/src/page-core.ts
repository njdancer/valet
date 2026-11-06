// What the auth and tool pages share: tolerant navigation, step timeouts, locating an element
// across frames, trusted clicks and paced trusted typing. Everything that comes back from a page is
// checked before use: subframes run our scripts in their own world, so their answers are untrusted.

import { SiteAdapterError, type Stage } from '@siteadapter/core'
import type { BrowserSurface, FrameHandle, Timers } from './platform'
import { sleep } from './platform'
import { focusScript, frameOffsetScript, pointScript } from './scripts'
import { withTimeout } from './timeout'

export interface PageTiming {
  readonly timers: Timers
  /** Budget for one primitive. Typing gets this plus its own pacing. */
  readonly stepTimeoutMs: number
  /** Default gap between typed characters. Sites time keystrokes. */
  readonly typingDelayMs: number
}

/** A frame's answer to a script that looks for one element. */
export type FrameMatch<T> = { readonly frameIndex: number; readonly frame: FrameHandle; readonly value: T }

export class PageCore {
  private commits = 0
  private readonly mainFrameUrls: string[] = []

  constructor(
    readonly surface: BrowserSurface,
    readonly timing: PageTiming,
  ) {
    surface.onNavigation((event) => {
      if (event.kind === 'commit') this.commits++
      if (event.isMainFrame) this.mainFrameUrls.push(event.url)
    })
  }

  /** Main-frame commits and redirects, in order. */
  committedUrls(): readonly string[] {
    return [...this.mainFrameUrls]
  }

  /** Runs one primitive under the step timeout. Anything that isn't a SiteAdapterError becomes internal. */
  async step<T>(stage: Stage, work: (signal: AbortSignal) => Promise<T>, extraMs = 0): Promise<T> {
    if (this.surface.isDestroyed()) throw new SiteAdapterError(stage, 'aborted')
    try {
      return await withTimeout(this.timing.timers, this.timing.stepTimeoutMs + extraMs, work)
    } catch (error) {
      if (error instanceof SiteAdapterError) throw error
      throw new SiteAdapterError(stage, 'internal')
    }
  }

  /**
   * Loads a URL. ERR_ABORTED means the page started another navigation of its own (a client-side
   * redirect, usually), so wait for loading to stop instead of failing. Returns the failure code
   * for anything else.
   */
  async load(url: string): Promise<string | null> {
    const result = await this.surface.load(url)
    if (result.ok) return null
    if (result.code !== 'ERR_ABORTED') return result.code
    if (this.surface.isLoading()) await this.surface.nextStopLoading()
    return null
  }

  /**
   * Runs a lookup script in every frame, main frame first, and returns the first frame that found
   * something. A frame whose script fails (it navigated, or was detached) counts as not found.
   */
  async locate<T>(
    stage: Stage,
    script: string,
    parse: (raw: unknown) => T | null,
  ): Promise<FrameMatch<T> | null> {
    for (const [frameIndex, frame] of this.surface.frames().entries()) {
      const raw = await runQuietly(frame, script)
      if (isRecord(raw) && raw['error'] === 'invalid-selector') throw new SiteAdapterError(stage, 'invalid')
      const value = parse(raw)
      if (value !== null) return { frameIndex, frame, value }
    }
    return null
  }

  /** Scrolls the element into view and sends a trusted click at its centre. */
  async click(stage: Stage, selector: string): Promise<void> {
    const match = await this.locate(stage, pointScript(selector), parsePoint)
    if (match === null) throw new SiteAdapterError(stage, 'element-missing')
    const point = match.value
    if (point === 'not-visible' || !point.hit) throw new SiteAdapterError(stage, 'element-unsuitable')
    const frames = this.surface.frames()
    let { x, y } = point
    let childIndex = point.indexInParent
    let frame: FrameHandle | undefined = match.frame
    // Climb to the main frame, adding each iframe's offset in its parent.
    while (frame !== undefined && frame.parentIndex !== null) {
      const parent: FrameHandle | undefined = frames[frame.parentIndex]
      if (parent === undefined || childIndex === null) throw new SiteAdapterError(stage, 'element-unsuitable')
      const offset = parseOffset(await runQuietly(parent, frameOffsetScript(childIndex)))
      if (offset === null) throw new SiteAdapterError(stage, 'element-unsuitable')
      x += offset.x
      y += offset.y
      childIndex = offset.indexInParent
      frame = parent
    }
    this.surface.click(Math.round(x), Math.round(y))
  }

  async focus(stage: Stage, selector: string): Promise<void> {
    this.surface.focus()
    const match = await this.locate(stage, focusScript(selector), parseFocus)
    if (match === null) throw new SiteAdapterError(stage, 'element-missing')
    if (!match.value.focused) throw new SiteAdapterError(stage, 'element-unsuitable')
  }

  /**
   * Sends `count` trusted characters, `delayMs` apart. `send(i)` must send the i-th one; it is given
   * an index rather than a string so that a secret's characters stay inside its reveal callback.
   * Stops if the step times out, and fails if any frame commits a navigation while typing: the
   * remaining characters would land in a different document.
   */
  async typeChars(
    stage: Stage,
    signal: AbortSignal,
    count: number,
    delayMs: number,
    send: (index: number) => void,
  ): Promise<void> {
    const commitsAtStart = this.commits
    this.surface.focus()
    for (let index = 0; index < count; index++) {
      if (index > 0) await sleep(this.timing.timers, delayMs)
      if (signal.aborted) return
      if (this.surface.isDestroyed() || this.commits !== commitsAtStart) {
        throw new SiteAdapterError(stage, 'aborted')
      }
      send(index)
    }
  }
}

async function runQuietly(frame: FrameHandle, script: string): Promise<unknown> {
  try {
    return await frame.run(script)
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function frameIndexOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

type Point = { x: number; y: number; hit: boolean; indexInParent: number | null }

function parsePoint(raw: unknown): Point | 'not-visible' | null {
  if (!isRecord(raw)) return null
  if (raw['error'] === 'not-visible') return 'not-visible'
  const { x, y, hit } = raw
  if (!finite(x) || !finite(y)) return null
  return { x, y, hit: hit === true, indexInParent: frameIndexOf(raw['indexInParent']) }
}

function parseOffset(raw: unknown): { x: number; y: number; indexInParent: number | null } | null {
  if (!isRecord(raw)) return null
  const { x, y } = raw
  if (!finite(x) || !finite(y)) return null
  return { x, y, indexInParent: frameIndexOf(raw['indexInParent']) }
}

function parseFocus(raw: unknown): { focused: boolean } | null {
  return isRecord(raw) && typeof raw['focused'] === 'boolean' ? { focused: raw['focused'] } : null
}

const MAX_TYPING_DELAY_MS = 5_000

/** A usable gap between characters: the default for anything missing or nonsensical, and capped. */
export function typingDelay(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) return fallback
  return Math.min(requested, MAX_TYPING_DELAY_MS)
}

/** Code points, so that a character outside the BMP goes as one char event. */
export function characters(text: string): string[] {
  return Array.from(text)
}
