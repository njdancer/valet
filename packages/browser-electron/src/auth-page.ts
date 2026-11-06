// The auth partition's page. Only the declarative interpreter holds one. It runs no adapter script:
// every script it runs is one of src/scripts.ts with the selector or text as JSON data.
//
// Leaving the manifest's navigation origins in the main frame, by any route, poisons the page:
// the navigation is prevented and every later primitive fails with navigation-escaped, so the auth
// action aborts rather than carrying on somewhere unexpected.

import {
  type AuthPage,
  type BlockedRequest,
  type ElementInfo,
  type FetchResult,
  httpsOrigin,
  type NeedsUserReason,
  originAllowed,
  SecretValue,
  SiteAdapterError,
  type Stage,
  type TypeOptions,
  urlOriginAllowed,
} from '@siteadapter/core'
import { cookiesForDomains } from './cookies'
import { authBlock, authNavigationAllowed } from './guards'
import { needsUserTitle } from './needs-user'
import {
  characters,
  type FocusTarget,
  isRecord,
  PageCore,
  type PageTiming,
  type TypingGuard,
  typingDelay,
} from './page-core'
import { type BrowserSurface, type PartitionSession, sleep } from './platform'
import { inspectScript, textPresentScript } from './scripts'
import { MAX_PROBE_BYTES, PROBE_ACCEPT, ProbeRedirects, probeResult, probeTarget } from './session-fetch'

export interface AuthPageOptions {
  /** The manifest's auth.frameOrigins: origins besides navigation's that subframes may load. */
  readonly frameOrigins?: readonly string[]
  /** The manifest's name, for the hand-off window's title. */
  readonly siteName?: string
  /**
   * The auth partition's session, for fetch() and cookieNames(). Without it both fail with
   * probe/unsupported.
   */
  readonly session?: Pick<PartitionSession, 'fetch' | 'getCookies'>
  /**
   * Headers fetch() restates so that it presents as the page does: the clean Chrome UA and en-AU,
   * by default. Accept is always sent.
   */
  readonly fetchHeaders?: Readonly<Record<string, string>>
  /**
   * Told about each navigation the guard refuses: the main frame leaving the navigation origins
   * (which also poisons the page) and a subframe off navigation and frameOrigins. Initiator 'page'.
   */
  readonly onBlocked?: (blocked: BlockedRequest) => void
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
  private readonly siteName: string
  private escaped = false
  /**
   * Bumped by goto() and by every main-frame commit. A primitive that started under an older
   * generation must not leave state behind for a newer one.
   */
  private generation = 0
  /** Set by focus(). A secret is only ever typed into the element this names. */
  private focusTarget: BoundFocus | null = null
  private readonly inspected = new Map<string, Inspected>()
  private readonly session: Pick<PartitionSession, 'fetch' | 'getCookies'> | null
  private readonly fetchHeaders: Readonly<Record<string, string>>

  constructor(
    private readonly surface: BrowserSurface,
    private readonly navigation: readonly string[],
    private readonly timing: PageTiming,
    options: AuthPageOptions = {},
  ) {
    this.core = new PageCore(surface, timing)
    this.siteName = options.siteName ?? 'The site'
    this.session = options.session ?? null
    this.fetchHeaders = { ...options.fetchHeaders, accept: PROBE_ACCEPT }
    const frameOrigins = options.frameOrigins ?? []
    const onBlocked = options.onBlocked
    surface.guardNavigation((pending) => {
      const allowed = authNavigationAllowed(pending, navigation, frameOrigins)
      if (!allowed && pending.isMainFrame) this.escaped = true
      if (!allowed && onBlocked !== undefined) {
        try {
          onBlocked(authBlock(pending.url))
        } catch {
          // A failing reporter must not turn a refusal into an allow.
        }
      }
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
   * reports and whether trusted input can reach that frame. Remembers the frame, so that focus()
   * can refuse to land anywhere else.
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
        inputReachable: match.frame.receivesInput,
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
   * focus and then, before every character, that it still would: see PageCore.beforeKey. Literal
   * text without a focus() goes wherever focus is, unless `allowedOrigins` is given.
   *
   * A secret needs `allowedOrigins`, and inspect() and focus() on the same selector first, so that
   * the frame it is typed into is the frame whose origin was checked against the grant.
   */
  async type(text: string | SecretValue, options?: TypeOptions): Promise<void> {
    if (text instanceof SecretValue) return this.typeSecret(text, options)
    const delayMs = typingDelay(options?.delayMs, this.timing.typingDelayMs)
    const chars = characters(text)
    const target = this.focusTarget
    const allowedOrigins = options?.allowedOrigins
    if (allowedOrigins !== undefined && target === null) {
      throw new SiteAdapterError('auth-step', 'origin-mismatch')
    }
    const guard: TypingGuard = {
      stage: 'auth-step',
      target,
      moved: 'aborted',
      before: () => this.assertInside('auth-step'),
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    }
    return this.core.step(
      'auth-step',
      async (signal) => {
        this.assertInside('auth-step')
        if (target !== null && !(await this.core.stillFocused(target))) {
          throw new SiteAdapterError('auth-step', 'element-unsuitable')
        }
        if (allowedOrigins !== undefined && !originAllowed(target?.origin ?? '', allowedOrigins)) {
          throw new SiteAdapterError('auth-step', 'origin-mismatch')
        }
        await this.core.typeChars(guard, signal, chars.length, delayMs, (i) =>
          this.core.sendChar(chars[i] ?? ''),
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
   * GETs `url` with the auth partition's cookies, for the session probe. The driver makes the
   * request from the main process, so no script runs and the page can't see or shape it. Only to
   * the navigation origins (probe/host-not-allowed otherwise), and a redirect is followed only while
   * it stays on them: one that leaves is refused, not followed, and the probe fails with
   * probe/host-not-allowed. At most MAX_PROBE_BYTES of body are read. Runs under the step timeout.
   */
  fetch(url: string): Promise<FetchResult> {
    return this.core.step('probe', async (signal) => {
      this.assertInside('probe')
      const target = probeTarget(url, this.navigation)
      const session = this.session
      if (session === null) throw new SiteAdapterError('probe', 'unsupported')
      const redirects = new ProbeRedirects(this.navigation)
      const response = await session.fetch({
        url: target,
        headers: this.fetchHeaders,
        allowRedirect: redirects.allow,
        maxBytes: MAX_PROBE_BYTES,
        signal,
      })
      return probeResult(response, redirects)
    })
  }

  /** Names, never values, of the auth partition's cookies on `cookieDomains`. */
  cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]> {
    return this.core.step('probe', async () => {
      this.assertInside('probe')
      const session = this.session
      if (session === null) throw new SiteAdapterError('probe', 'unsupported')
      if (!Array.isArray(cookieDomains) || cookieDomains.some((domain) => typeof domain !== 'string')) {
        throw new SiteAdapterError('probe', 'invalid')
      }
      const cookies = cookiesForDomains(await session.getCookies(), cookieDomains)
      return [...new Set(cookies.map((cookie) => cookie.name))]
    })
  }

  /**
   * Shows the window to the person, titled with the app's wording for `reason`. Closing it hides it
   * again instead of destroying it, so the interpreter can carry on from wherever the person left
   * the page. Only that one close is intercepted: once this resolves, closing the window (or
   * quitting the app) closes it.
   */
  handToUser(reason: NeedsUserReason): Promise<void> {
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
      this.surface.show(needsUserTitle(reason, this.siteName))
    })
  }

  async close(): Promise<void> {
    if (!this.surface.isDestroyed()) this.surface.destroy()
  }

  /**
   * Types a secret one code point at a time through SecretValue.revealEach, so the whole plaintext
   * never exists as one JavaScript string: only single characters reach the heap, each inside its
   * own callback. Each keystroke is a step of its own, since the length is never known up front,
   * and runs beforeKey's checks against the grant's origins first. If the frame navigates or focus
   * moves partway, typing stops with secret-fill/origin-mismatch.
   */
  private async typeSecret(secret: SecretValue, options: TypeOptions | undefined): Promise<void> {
    const stage: Stage = 'secret-fill'
    const delayMs = typingDelay(options?.delayMs, this.timing.typingDelayMs)
    this.assertInside(stage)
    const allowedOrigins = options?.allowedOrigins
    if (allowedOrigins === undefined || allowedOrigins.length === 0) {
      throw new SiteAdapterError(stage, 'origin-mismatch')
    }
    const target = this.focusTarget
    if (target === null || !target.inspected) throw new SiteAdapterError(stage, 'element-unsuitable')
    if (httpsOrigin(target.origin) === null || !originAllowed(target.origin, allowedOrigins)) {
      throw new SiteAdapterError(stage, 'origin-mismatch')
    }
    if (secret.disposed) throw new SiteAdapterError(stage, 'aborted')
    const guard: TypingGuard = {
      stage,
      target,
      allowedOrigins,
      moved: 'origin-mismatch',
      before: () => this.assertInside(stage),
    }
    const mark = this.core.commitMark(target)
    await this.core.step(stage, async () => {
      this.assertInside(stage)
      if (!(await this.core.stillFocused(target))) throw new SiteAdapterError(stage, 'element-unsuitable')
    })
    let index = 0
    try {
      await secret.revealEach(async (char) => {
        if (index++ > 0) await sleep(this.timing.timers, delayMs)
        await this.core.step(stage, async (signal) => {
          await this.core.beforeKey(guard, mark, signal)
          this.core.sendChar(char)
        })
      })
    } catch (error) {
      if (error instanceof SiteAdapterError) throw error
      // revealEach found the secret disposed partway.
      throw new SiteAdapterError(stage, 'aborted')
    }
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

type Inspection = Omit<ElementInfo, 'frameOrigin' | 'formActionOrigin' | 'inputReachable'> & {
  formAction: string | null
}

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
