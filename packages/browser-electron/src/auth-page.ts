// The auth partition's page. Only the declarative interpreter holds one. It runs no adapter script:
// every script it runs is one of src/scripts.ts with the selector or text as JSON data.
//
// Leaving the manifest's navigation origins in the main frame, by any route, poisons the page:
// the navigation is prevented and every later primitive fails with navigation-escaped, so the auth
// action aborts rather than carrying on somewhere unexpected.

import {
  type AuthPage,
  type ElementInfo,
  SecretValue,
  SiteAdapterError,
  type Stage,
  urlOriginAllowed,
} from '@siteadapter/core'
import { authNavigationAllowed } from './guards'
import { characters, isRecord, PageCore, type PageTiming, typingDelay } from './page-core'
import type { BrowserSurface } from './platform'
import { inspectScript, textPresentScript } from './scripts'

export class SurfaceAuthPage implements AuthPage {
  private readonly core: PageCore
  private escaped = false

  constructor(
    private readonly surface: BrowserSurface,
    private readonly navigation: readonly string[],
    private readonly timing: PageTiming,
  ) {
    this.core = new PageCore(surface, timing)
    surface.guardNavigation((pending) => {
      const allowed = authNavigationAllowed(pending, navigation)
      if (!allowed && pending.isMainFrame) this.escaped = true
      return allowed
    })
    // Belt and braces: a main-frame commit off the list that slipped past the guard still poisons.
    surface.onNavigation((event) => {
      if (event.kind === 'commit' && event.isMainFrame && !urlOriginAllowed(event.url, navigation)) {
        this.escaped = true
        surface.stop()
      }
    })
  }

  async goto(url: string): Promise<void> {
    this.assertInside('navigate')
    if (!urlOriginAllowed(url, this.navigation)) throw new SiteAdapterError('navigate', 'navigation-escaped')
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

  inspect(selector: string): Promise<ElementInfo | null> {
    return this.core.step('auth-step', async () => {
      this.assertInside('auth-step')
      const match = await this.core.locate('auth-step', inspectScript(selector), parseInspection)
      if (match === null) return null
      const { formAction, ...rest } = match.value
      return {
        ...rest,
        frameOrigin: match.frame.origin,
        formActionOrigin: formAction === null ? null : originOf(formAction),
      }
    })
  }

  click(selector: string): Promise<void> {
    return this.core.step('auth-step', async () => {
      this.assertInside('auth-step')
      await this.core.click('auth-step', selector)
    })
  }

  focus(selector: string): Promise<void> {
    return this.core.step('auth-step', async () => {
      this.assertInside('auth-step')
      await this.core.focus('auth-step', selector)
    })
  }

  /**
   * A secret's characters are read one at a time inside its own reveal callback and handed straight
   * to the input event; neither the plaintext nor a character outlives that callback.
   */
  async type(text: string | SecretValue, options?: { readonly delayMs?: number }): Promise<void> {
    const stage: Stage = text instanceof SecretValue ? 'secret-fill' : 'auth-step'
    const delayMs = typingDelay(options?.delayMs, this.timing.typingDelayMs)
    const count = text instanceof SecretValue ? revealLength(stage, text) : characters(text).length
    const send =
      text instanceof SecretValue
        ? (index: number) => revealCharacter(stage, text, index, (char) => this.surface.sendChar(char))
        : (index: number) => this.surface.sendChar(characters(text)[index] ?? '')
    return this.core.step(
      stage,
      async (signal) => {
        this.assertInside(stage)
        await this.core.typeChars(stage, signal, count, delayMs, (index) => {
          this.assertInside(stage)
          send(index)
        })
      },
      count * delayMs,
    )
  }

  textPresent(text: string): Promise<boolean> {
    return this.core.step('auth-step', async () => {
      this.assertInside('auth-step')
      const match = await this.core.locate('auth-step', textPresentScript(text), (raw) =>
        raw === true ? true : null,
      )
      return match !== null
    })
  }

  /**
   * Shows the window to the person. Closing it hides it again instead of destroying it, so the
   * interpreter can carry on from wherever the person left the page.
   */
  handToUser(reason: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.surface.isDestroyed()) {
        resolve()
        return
      }
      this.surface.onCloseRequested(() => {
        this.surface.hide()
        resolve()
        return true
      })
      this.surface.onDestroyed(resolve)
      this.surface.show(reason)
    })
  }

  async close(): Promise<void> {
    if (!this.surface.isDestroyed()) this.surface.destroy()
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

function revealLength(stage: Stage, secret: SecretValue): number {
  try {
    return secret.reveal((plaintext) => characters(plaintext).length)
  } catch {
    throw new SiteAdapterError(stage, 'aborted')
  }
}

function revealCharacter(
  stage: Stage,
  secret: SecretValue,
  index: number,
  use: (char: string) => void,
): void {
  let sent = false
  try {
    secret.reveal((plaintext) => {
      const char = characters(plaintext)[index]
      if (char === undefined) return
      use(char)
      sent = true
    })
  } catch {
    throw new SiteAdapterError(stage, 'aborted')
  }
  // The secret changed length under us (it was disposed and the slot reused, or similar).
  if (!sent) throw new SiteAdapterError(stage, 'aborted')
}
