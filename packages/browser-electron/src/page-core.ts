// What the auth and tool pages share: tolerant navigation, step timeouts, locating an element
// across frames, trusted clicks and paced trusted typing. Everything that comes back from a page is
// checked before use: subframes run our scripts in their own world, so their answers are untrusted.

import { type ErrorClass, originAllowed, type Stage, ValetError } from '@valet/core'
import type { BrowserSurface, FrameHandle, KeyEvents, Timers } from './platform'
import { sleep } from './platform'
import { focusedScript, focusScript, frameOffsetScript, pointScript } from './scripts'
import { withTimeout } from './timeout'

export interface PageTiming {
  readonly timers: Timers
  /** Budget for one primitive. Typing gets this plus its own pacing. */
  readonly stepTimeoutMs: number
  /** Default gap between typed characters. Sites time keystrokes. */
  readonly typingDelayMs: number
  /**
   * Up to this much is added to each gap, drawn afresh per keystroke, so typing never runs at one
   * even rhythm (D24). Zero unless set.
   */
  readonly typingJitterMs?: number
  /** A uniform draw in [0, 1), for the jitter. Injected so tests are deterministic. */
  readonly random?: () => number
  /** Which key events make up one typed character: char events alone unless set. */
  readonly keyEvents?: KeyEvents
}

/** What typing checks before each keystroke. See PageCore.beforeKey. */
export interface TypingGuard {
  readonly stage: Stage
  /** Where focus() left focus, or null to type wherever focus is. */
  readonly target: FocusTarget | null
  readonly allowedOrigins?: readonly string[]
  /** The error class when the target moves partway through. */
  readonly moved: ErrorClass
  /** An extra check before each keystroke, such as whether the page has been poisoned. */
  readonly before?: () => void
}

/** Where focus() left keyboard focus, so typing can check it is still there. */
export interface FocusTarget {
  readonly frameId: string
  readonly origin: string
  readonly selector: string
}

/**
 * Where commits stood when typing started. With `nodes`, the target frame and its ancestors, only
 * their commits (and commits the browser couldn't place) count as the target moving; without, any
 * commit does.
 */
export interface CommitMark {
  readonly nodes: readonly string[] | null
  readonly counts: readonly number[]
  readonly unplaced: number
  readonly total: number
}

/** A frame's answer to a script that looks for one element. */
export type FrameMatch<T> = { readonly frameIndex: number; readonly frame: FrameHandle; readonly value: T }

export class PageCore {
  private commits = 0
  /** Commits by frame tree node, and those the browser couldn't place in the tree. */
  private readonly commitsByNode = new Map<string, number>()
  private unplacedCommits = 0
  private readonly mainFrameUrls: string[] = []
  /** Called on every commit, for waits that must stop once a frame navigates. */
  private readonly commitWaiters = new Set<() => void>()

  constructor(
    readonly surface: BrowserSurface,
    readonly timing: PageTiming,
  ) {
    surface.onNavigation((event) => {
      if (event.kind === 'commit') {
        this.commits++
        if (event.frameNodeId === null) this.unplacedCommits++
        else this.commitsByNode.set(event.frameNodeId, (this.commitsByNode.get(event.frameNodeId) ?? 0) + 1)
        for (const waiter of [...this.commitWaiters]) waiter()
      }
      if (event.isMainFrame) this.mainFrameUrls.push(event.url)
    })
  }

  /** Main-frame commits and redirects, in order. */
  committedUrls(): readonly string[] {
    return [...this.mainFrameUrls]
  }

  /** Runs one primitive under the step timeout. Anything that isn't a ValetError becomes internal. */
  async step<T>(stage: Stage, work: (signal: AbortSignal) => Promise<T>, extraMs = 0): Promise<T> {
    if (this.surface.isDestroyed()) throw new ValetError(stage, 'aborted')
    try {
      return await withTimeout(this.timing.timers, this.timing.stepTimeoutMs + extraMs, work)
    } catch (error) {
      if (error instanceof ValetError) throw error
      throw new ValetError(stage, 'internal')
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
   * Stops before the next frame once `signal` says the step was given up on.
   */
  async locate<T>(
    stage: Stage,
    signal: AbortSignal,
    script: string,
    parse: (raw: unknown) => T | null,
  ): Promise<FrameMatch<T> | null> {
    for (const [frameIndex, frame] of this.surface.frames().entries()) {
      assertLive(stage, signal)
      const raw = await runQuietly(frame, script)
      if (isRecord(raw) && raw['error'] === 'invalid-selector') throw new ValetError(stage, 'invalid')
      const value = parse(raw)
      if (value !== null) return { frameIndex, frame, value }
    }
    return null
  }

  /**
   * Scrolls the element into view and sends a trusted click at its centre. Every await here can
   * outlive the step's timeout, so the signal is checked before each script and before the click:
   * a click that lands after the interpreter has moved on lands on a page it no longer expects.
   */
  async click(stage: Stage, selector: string, signal: AbortSignal): Promise<void> {
    const match = await this.locate(stage, signal, pointScript(selector), parsePoint)
    if (match === null) throw new ValetError(stage, 'element-missing')
    const point = match.value
    if (point === 'not-visible' || !point.hit) throw new ValetError(stage, 'element-unsuitable')
    if (!match.frame.receivesInput) throw new ValetError(stage, 'element-unsuitable')
    const frames = this.surface.frames()
    let { x, y } = point
    let childIndex = point.indexInParent
    let frame: FrameHandle | undefined = match.frame
    // Climb to the main frame, adding each iframe's offset in its parent.
    while (frame !== undefined && frame.parentIndex !== null) {
      const parent: FrameHandle | undefined = frames[frame.parentIndex]
      if (parent === undefined || childIndex === null || !parent.receivesInput) {
        throw new ValetError(stage, 'element-unsuitable')
      }
      assertLive(stage, signal)
      const offset = parseOffset(await runQuietly(parent, frameOffsetScript(childIndex)))
      if (offset === null) throw new ValetError(stage, 'element-unsuitable')
      x += offset.x
      y += offset.y
      childIndex = offset.indexInParent
      frame = parent
    }
    assertLive(stage, signal)
    this.surface.click(Math.round(x), Math.round(y))
  }

  /**
   * Focuses the element and checks, from the browser side, that keyboard focus really moved to its
   * frame. Returns the target so that typing can be bound to it.
   */
  async focus(stage: Stage, selector: string, signal: AbortSignal): Promise<FocusTarget> {
    assertLive(stage, signal)
    this.surface.focus()
    const match = await this.locate(stage, signal, focusScript(selector), parseFocus)
    assertLive(stage, signal)
    if (match === null) throw new ValetError(stage, 'element-missing')
    if (
      !match.value.focused ||
      !match.frame.receivesInput ||
      this.surface.focusedFrameId() !== match.frame.id
    ) {
      throw new ValetError(stage, 'element-unsuitable')
    }
    return { frameId: match.frame.id, origin: match.frame.origin, selector }
  }

  /** True when `target` still has keyboard focus: same frame, same origin, same element. */
  async stillFocused(target: FocusTarget): Promise<boolean> {
    const frame = this.surface.frames().find((candidate) => candidate.id === target.frameId)
    if (frame === undefined || frame.origin !== target.origin || !frame.receivesInput) return false
    if (this.surface.focusedFrameId() !== target.frameId) return false
    return parseFocus(await runQuietly(frame, focusedScript(target.selector)))?.focused === true
  }

  /**
   * Notes where commits stand, for beforeKey(). With a target, only the target's frame and its
   * ancestors matter: an analytics or CAPTCHA iframe elsewhere on the page that reloads mid-type
   * doesn't move the keystrokes. A target whose frame is gone, or whose ancestry can't be
   * followed, falls back to every frame.
   */
  commitMark(target: FocusTarget | null): CommitMark {
    const nodes = target === null ? null : this.lineage(target.frameId)
    return {
      nodes,
      counts: (nodes ?? []).map((node) => this.commitsByNode.get(node) ?? 0),
      unplaced: this.unplacedCommits,
      total: this.commits,
    }
  }

  /**
   * Sends `count` trusted characters, `delayMs` apart. `send(i)` must send the i-th one. Before
   * every character, beforeKey() checks that it would land where typing started.
   */
  async typeChars(
    guard: TypingGuard,
    signal: AbortSignal,
    count: number,
    delayMs: number,
    send: (index: number) => void,
  ): Promise<void> {
    const mark = this.commitMark(guard.target)
    for (let index = 0; index < count; index++) {
      if (index > 0) await sleep(this.timing.timers, this.keystrokeGap(delayMs))
      await this.beforeKey(guard, mark, signal)
      send(index)
    }
  }

  /**
   * Throws unless the next keystroke would land where typing started: the step is still live, the
   * window is there, no frame that matters has committed a navigation since `mark` (see
   * commitMark()), and, with a target, the browser still has keyboard focus in its frame, that frame is still on the target's
   * origin (and on `allowedOrigins`, when given), and the element itself still has focus. Anything
   * that moved fails with `guard.moved`, since the remaining characters would land somewhere else.
   */
  async beforeKey(guard: TypingGuard, mark: CommitMark, signal: AbortSignal): Promise<void> {
    const fail = (errorClass: ErrorClass) => new ValetError(guard.stage, errorClass)
    const live = () => {
      guard.before?.()
      if (signal.aborted || this.surface.isDestroyed()) throw fail('aborted')
      if (this.movedSince(mark)) throw fail(guard.moved)
    }
    live()
    const target = guard.target
    if (target === null) return
    const inFrame = () => {
      const frame = this.surface.frames().find((candidate) => candidate.id === target.frameId)
      const stays =
        frame !== undefined &&
        frame.origin === target.origin &&
        frame.receivesInput &&
        this.surface.focusedFrameId() === target.frameId &&
        (guard.allowedOrigins === undefined || originAllowed(frame.origin, guard.allowedOrigins))
      if (!stays) throw fail(guard.moved)
      return frame
    }
    const frame = inFrame()
    const answer = await this.unlessMoved(mark, () => runQuietly(frame, focusedScript(target.selector)))
    if (answer === MOVED) throw fail(guard.moved)
    const focused = parseFocus(answer)?.focused === true
    live()
    inFrame()
    if (!focused) throw fail(guard.moved)
  }

  /**
   * Runs `work`, but gives up on it with MOVED the moment a frame that matters commits a
   * navigation (see movedSince). Electron's WebFrameMain.executeJavaScript can stay pending for
   * good when the frame's document is replaced while the script waits, so without this a navigation
   * mid-type would surface as the step's timeout rather than as the target moving.
   */
  private async unlessMoved<T>(mark: CommitMark, work: () => Promise<T>): Promise<T | typeof MOVED> {
    let stop = (): void => undefined
    const moved = new Promise<typeof MOVED>((resolve) => {
      stop = () => {
        if (this.movedSince(mark)) resolve(MOVED)
      }
    })
    this.commitWaiters.add(stop)
    try {
      if (this.movedSince(mark)) return MOVED
      return await Promise.race([work(), moved])
    } finally {
      this.commitWaiters.delete(stop)
    }
  }

  private movedSince(mark: CommitMark): boolean {
    if (mark.nodes === null) return this.commits !== mark.total
    if (this.unplacedCommits !== mark.unplaced) return true
    return mark.nodes.some((node, index) => (this.commitsByNode.get(node) ?? 0) !== mark.counts[index])
  }

  /** The frame's node and its ancestors' up to the main frame, or null if the chain breaks. */
  private lineage(frameId: string): string[] | null {
    const frames = this.surface.frames()
    const nodes: string[] = []
    let frame = frames.find((candidate) => candidate.id === frameId)
    for (let depth = 0; frame !== undefined && depth <= frames.length; depth++) {
      nodes.push(frame.nodeId)
      if (frame.parentIndex === null) return nodes
      frame = frames[frame.parentIndex]
    }
    return null
  }

  /** Sends one trusted character, as the page's key-event setting says. */
  /** The wait before the next keystroke: `delayMs`, plus up to the jitter, never less. */
  keystrokeGap(delayMs: number): number {
    const jitter = this.timing.typingJitterMs ?? 0
    if (jitter <= 0) return delayMs
    const draw = (this.timing.random ?? Math.random)()
    const unit = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0
    return delayMs + Math.floor(unit * jitter)
  }

  /** The most typing `count` characters can wait in gaps, for a step's time budget. */
  typingBudget(count: number, delayMs: number): number {
    return count * (delayMs + (this.timing.typingJitterMs ?? 0))
  }

  sendChar(char: string): void {
    this.surface.sendChar(char, this.timing.keyEvents ?? 'char')
  }
}

/** What unlessMoved() answers instead of the work's result once the target has moved. */
const MOVED: unique symbol = Symbol('moved')

/** Throws once the step has been given up on, so nothing more is sent to the page. */
function assertLive(stage: Stage, signal: AbortSignal): void {
  if (signal.aborted) throw new ValetError(stage, 'aborted')
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
