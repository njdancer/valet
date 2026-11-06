// The auth partition's page. Only the declarative interpreter holds one. It runs no adapter script:
// every script it runs is one of src/scripts.ts with the selector or text as JSON data.
//
// Leaving the manifest's navigation origins in the main frame, by any route, poisons the page:
// the navigation is prevented and every later primitive fails with navigation-escaped, so the auth
// action aborts rather than carrying on somewhere unexpected.

import {
  type AuthPage,
  type ElementInfo,
  httpsOrigin,
  originAllowed,
  SecretValue,
  SiteAdapterError,
  type Stage,
  urlOriginAllowed,
} from '@siteadapter/core'
import { authNavigationAllowed, type FrameRule } from './guards'
import { characters, type FocusTarget, isRecord, PageCore, type PageTiming, typingDelay } from './page-core'
import type { BrowserSurface } from './platform'
import { inspectScript, textPresentScript } from './scripts'

export interface TypeOptions {
  readonly delayMs?: number
  /**
   * The grant's origins. When given, a secret is only typed if the frame that has keyboard focus,
   * as the browser process sees it, is on one of them. Not yet on core's AuthPage.type.
   */
  readonly allowedOrigins?: readonly string[]
}

/** The frame inspect() last found a selector in. focus() must land in that same frame. */
interface Inspected {
  readonly frameId: string
  readonly origin: string
}

/** Where focus() left keyboard focus, and whether that is the frame inspect() reported. */
interface BoundFocus extends FocusTarget {
  readonly inspected: boolean
}

export class SurfaceAuthPage implements AuthPage {
  private readonly core: PageCore
  private escaped = false
  /**
   * Bumped by goto() and by every main-frame commit. A primitive that started under an older
   * generation must not leave state behind for a newer one.
   */
  private generation = 0
  /** Set by focus(). A secret is only ever typed into the element this names. */
  private focusTarget: BoundFocus | null = null
  private readonly inspected = new Map<string, Inspected>()

  constructor(
    private readonly surface: BrowserSurface,
    private readonly navigation: readonly string[],
    private readonly timing: PageTiming,
    frames: FrameRule = 'any-https',
  ) {
    this.core = new PageCore(surface, timing)
    surface.guardNavigation((pending) => {
      const allowed = authNavigationAllowed(pending, navigation, frames)
      if (!allowed && pending.isMainFrame) this.escaped = true
      return allowed
    })
    surface.onNavigation((event) => {
      if (event.kind !== 'commit' || !event.isMainFrame) return
      // A new document: whatever was inspected or focused belonged to the old one.
      this.forget()
      // Belt and braces: a main-frame commit off the list that slipped past the guard still poisons.
      if (!urlOriginAllowed(event.url, navigation)) {
        this.escaped = true
        surface.stop()
      }
    })
  }

  async goto(url: string): Promise<void> {
    this.assertInside('navigate')
    if (!urlOriginAllowed(url, this.navigation)) throw new SiteAdapterError('navigate', 'navigation-escaped')
    this.forget()
    await this.core.step('navigate', async () => {
      const failure = await this.core.load(url)
      this.assertInside('navigate')
      if (failure !== null) throw new SiteAdapterError('navigate', 'unavailable')
    })
  }

  currentUrl(): string {
    return this.surface.url()
  }

  committedUrls(): readonly string[] {
    return this.core.committedUrls()
  }

  /**
   * Describes the first frame's match for `selector`, with the frame origin the browser process
   * reports. Remembers that frame, so that focus() can refuse to land anywhere else.
   */
  inspect(selector: string): Promise<ElementInfo | null> {
    return this.core.step('auth-step', async (signal) => {
      this.assertInside('auth-step')
      const generation = this.generation
      this.inspected.delete(selector)
      const match = await this.core.locate('auth-step', signal, inspectScript(selector), parseInspection)
      if (match === null) return null
      if (!signal.aborted && generation === this.generation) {
        this.inspected.set(selector, { frameId: match.frame.id, origin: match.frame.origin })
      }
      const { formAction, ...rest } = match.value
      return {
        ...rest,
        frameOrigin: match.frame.origin,
        formActionOrigin: formAction === null ? null : originOf(formAction),
      }
    })
  }

  click(selector: string): Promise<void> {
    return this.core.step('auth-step', async (signal) => {
      this.assertInside('auth-step')
      await this.core.click('auth-step', selector, signal)
    })
  }

  /**
   * Focuses the element. If inspect() has described `selector`, focus must land in the frame it
   * described, at the origin it reported: the interpreter checked the grant against that origin,
   * and a DOM change in between must not move the secret to a frame nobody checked.
   */
  focus(selector: string): Promise<void> {
    return this.core.step('auth-step', async (signal) => {
      this.assertInside('auth-step')
      this.focusTarget = null
      const generation = this.generation
      const target = await this.core.focus('auth-step', selector, signal)
      // The step timed out, or the page moved on, while we waited: leave no target behind.
      if (signal.aborted || generation !== this.generation) {
        throw new SiteAdapterError('auth-step', 'aborted')
      }
      const inspected = this.inspected.get(selector)
      if (
        inspected !== undefined &&
        (inspected.frameId !== target.frameId || inspected.origin !== target.origin)
      ) {
        throw new SiteAdapterError('auth-step', 'element-unsuitable')
      }
      this.focusTarget = { ...target, inspected: inspected !== undefined }
    })
  }

  /**
   * Types into the element the last focus() targeted, checking first that it still has keyboard
   * focus and then, before every character, that focus hasn't left its frame. Literal text without
   * a focus() goes wherever focus is.
   *
   * A secret needs inspect() and focus() on the same selector first, so that the frame it is typed
   * into is the frame whose origin was checked, and that frame must be on https (and on
   * `allowedOrigins`, when given).
   */
  async type(text: string | SecretValue, options?: TypeOptions): Promise<void> {
    if (text instanceof SecretValue) return this.typeSecret(text, options)
    const delayMs = typingDelay(options?.delayMs, this.timing.typingDelayMs)
    const chars = characters(text)
    const target = this.focusTarget
    return this.core.step(
      'auth-step',
      async (signal) => {
        this.assertInside('auth-step')
        if (target !== null && !(await this.core.stillFocused(target))) {
          throw new SiteAdapterError('auth-step', 'element-unsuitable')
        }
        await this.core.typeChars(
          'auth-step',
          signal,
          chars.length,
          delayMs,
          target?.frameId ?? null,
          (i) => {
            this.assertInside('auth-step')
            this.surface.sendChar(chars[i] ?? '')
          },
        )
      },
      chars.length * delayMs,
    )
  }

  textPresent(text: string): Promise<boolean> {
    return this.core.step('auth-step', async (signal) => {
      this.assertInside('auth-step')
      const match = await this.core.locate('auth-step', signal, textPresentScript(text), (raw) =>
        raw === true ? true : null,
      )
      return match !== null
    })
  }

  /**
   * Shows the window to the person. Closing it hides it again instead of destroying it, so the
   * interpreter can carry on from wherever the person left the page. Only that one close is
   * intercepted: once this resolves, closing the window (or quitting the app) closes it.
   */
  handToUser(reason: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.surface.isDestroyed()) {
        resolve()
        return
      }
      const disposers: (() => void)[] = []
      const finish = () => {
        for (const dispose of disposers) dispose()
        resolve()
      }
      disposers.push(
        this.surface.onCloseRequested(() => {
          this.surface.hide()
          finish()
          return true
        }),
        this.surface.onDestroyed(finish),
      )
      this.surface.show(reason)
    })
  }

  async close(): Promise<void> {
    if (!this.surface.isDestroyed()) this.surface.destroy()
  }

  /**
   * The secret is decoded once per fill, inside its reveal callback, and the typing runs inside
   * that callback too, so neither the plaintext nor its characters are reachable from anywhere once
   * the fill settles. JavaScript strings can't be zeroed, so that one decoded copy stays on the heap
   * until it is collected; zeroing it would need a core API that yields one code point at a time.
   */
  private async typeSecret(secret: SecretValue, options: TypeOptions | undefined): Promise<void> {
    const stage: Stage = 'secret-fill'
    const delayMs = typingDelay(options?.delayMs, this.timing.typingDelayMs)
    this.assertInside(stage)
    const target = this.focusTarget
    if (target === null || !target.inspected) throw new SiteAdapterError(stage, 'element-unsuitable')
    if (httpsOrigin(target.origin) === null) throw new SiteAdapterError(stage, 'origin-mismatch')
    const allowed = options?.allowedOrigins
    if (allowed !== undefined && !originAllowed(target.origin, allowed)) {
      throw new SiteAdapterError(stage, 'origin-mismatch')
    }
    let typing: Promise<void>
    try {
      typing = secret.reveal((plaintext) => {
        const chars = characters(plaintext)
        return this.core.step(
          stage,
          async (signal) => {
            this.assertInside(stage)
            if (!(await this.core.stillFocused(target)))
              throw new SiteAdapterError(stage, 'element-unsuitable')
            await this.core.typeChars(stage, signal, chars.length, delayMs, target.frameId, (index) => {
              this.assertInside(stage)
              if (secret.disposed) throw new SiteAdapterError(stage, 'aborted')
              this.surface.sendChar(chars[index] ?? '')
            })
          },
          chars.length * delayMs,
        )
      })
    } catch {
      // Disposed before the fill started.
      throw new SiteAdapterError(stage, 'aborted')
    }
    return typing
  }

  private forget(): void {
    this.generation++
    this.focusTarget = null
    this.inspected.clear()
  }

  private assertInside(stage: Stage): void {
    if (this.escaped) throw new SiteAdapterError('navigate', 'navigation-escaped')
    if (this.surface.isDestroyed()) throw new SiteAdapterError(stage, 'aborted')
  }
}

type Inspection = Omit<ElementInfo, 'frameOrigin' | 'formActionOrigin'> & { formAction: string | null }

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function parseInspection(raw: unknown): Inspection | null {
  if (!isRecord(raw)) return null
  const { visible, tagName } = raw
  const inputType = nullableString(raw['inputType'])
  const autocomplete = nullableString(raw['autocomplete'])
  const inputMode = nullableString(raw['inputMode'])
  const formAction = nullableString(raw['formAction'])
  if (typeof visible !== 'boolean' || typeof tagName !== 'string') return null
  if (
    inputType === undefined ||
    autocomplete === undefined ||
    inputMode === undefined ||
    formAction === undefined
  ) {
    return null
  }
  return { visible, tagName, inputType, autocomplete, inputMode, formAction }
}

/** The origin a form submits to. Anything unparseable or opaque is the string "null", which no allowlist holds. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}
