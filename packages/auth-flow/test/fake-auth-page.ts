// A scriptable AuthPage. A site is a map from URL to the state the page shows there: its elements,
// the frames and forms they belong to, its text, and where clicks and server redirects lead. Tests
// copy a site fixture and change one thing.

import {
  type AuthPage,
  type ElementInfo,
  type FetchResult,
  httpsOrigin,
  type NeedsUserReason,
  originAllowed,
  SecretValue,
  type TypeOptions,
  ValetError,
} from '@valet/core'

export interface FakeElement {
  /** Defaults to "input". */
  readonly tagName?: string
  readonly inputType?: string | null
  readonly autocomplete?: string | null
  readonly inputMode?: string | null
  /** Defaults to true. */
  readonly visible?: boolean
  /** Defaults to true. False models an element inside an out-of-process frame. */
  readonly inputReachable?: boolean
  /** A key in the state's `frames`. Defaults to the top-level page's own origin. */
  readonly frame?: string
  /** A key in the state's `forms`. Defaults to no form. */
  readonly form?: string
}

export interface FakeState {
  readonly elements?: Readonly<Record<string, FakeElement>>
  /** Frame name to the frame's security origin. */
  readonly frames?: Readonly<Record<string, string>>
  /** Form name to the resolved origin of the form's action. */
  readonly forms?: Readonly<Record<string, string>>
  readonly text?: readonly string[]
  /** A server redirect: arriving here commits this URL and moves straight on. */
  readonly redirectTo?: string
  /** Selector to the URL that clicking it navigates to. */
  readonly clicks?: Readonly<Record<string, string>>
  /** The site's bot-block page. */
  readonly blocked?: boolean
  /** Cookies the site sets on arrival here, e.g. a session cookie once login succeeds. */
  readonly setsCookies?: readonly string[]
}

export type FakeSite = Record<string, FakeState>

export interface Typed {
  readonly selector: string | null
  readonly url: string
  /** What reached the page. For a SecretValue, its plaintext, which is the page's to see. */
  readonly text: string
  /** Whether it arrived as a SecretValue rather than a string. */
  readonly secret: boolean
  readonly delayMs: number | undefined
  readonly allowedOrigins: readonly string[] | undefined
}

export class FakeAuthPage implements AuthPage {
  url = 'about:blank'
  focused: string | null = null
  readonly history: string[] = []
  readonly visited: string[] = []
  readonly clicked: string[] = []
  readonly typed: Typed[] = []
  readonly handedToUser: NeedsUserReason[] = []
  /** The auth partition's cookie jar, by name. The probe reads this; nothing copies it anywhere. */
  readonly cookies = new Set<string>()
  /** Runs before each keystroke, for tests where the page moves mid-typing. */
  beforeKeystroke: ((index: number) => void) | null = null
  closed = false
  /** Page and frame navigations so far. Typing stops if this changes under it. */
  private navigations = 0

  constructor(readonly site: FakeSite) {}

  /** Moves the page to `url` as if the site navigated it, following server redirects. */
  navigate(url: string): void {
    this.navigations += 1
    let next: string | undefined = url
    for (let hops = 0; next !== undefined && hops < 10; hops++) {
      this.url = next
      this.history.push(next)
      for (const cookie of this.state().setsCookies ?? []) this.cookies.add(cookie)
      next = this.state().redirectTo
    }
  }

  /** Navigates the frame `name` on the current page to `origin`, as the frame's own script might. */
  navigateFrame(name: string, origin: string): void {
    this.navigations += 1
    const state = this.state()
    this.site[this.url] = { ...state, frames: { ...state.frames, [name]: origin } }
  }

  isBlocked(): boolean {
    return this.state().blocked === true
  }

  async goto(url: string): Promise<void> {
    this.visited.push(url)
    this.navigate(url)
  }

  currentUrl(): string {
    return this.url
  }

  committedUrls(): readonly string[] {
    return [...this.history]
  }

  async inspect(selector: string): Promise<ElementInfo | null> {
    const state = this.state()
    const element = state.elements?.[selector]
    if (element === undefined) return null
    const formActionOrigin = element.form === undefined ? null : (state.forms?.[element.form] ?? null)
    return {
      visible: element.visible ?? true,
      tagName: element.tagName ?? 'input',
      inputType: element.inputType ?? null,
      autocomplete: element.autocomplete ?? null,
      inputMode: element.inputMode ?? null,
      frameOrigin: this.frameOrigin(selector) ?? 'null',
      formActionOrigin,
      inputReachable: element.inputReachable ?? true,
    }
  }

  async click(selector: string): Promise<void> {
    const state = this.state()
    if (state.elements?.[selector] === undefined) throw new Error(`no element ${selector}`)
    this.clicked.push(selector)
    const target = state.clicks?.[selector]
    if (target !== undefined) this.navigate(target)
  }

  async focus(selector: string): Promise<void> {
    if (this.state().elements?.[selector] === undefined) throw new Error(`no element ${selector}`)
    this.focused = selector
  }

  /**
   * Behaves as the driver is specified to. It types only into the element focus() targeted, on the
   * page and in the frame it was on when typing began: if focus moves (even to a same-origin field),
   * the element is replaced, or the page or its frame navigates (even to the same origin), it stops
   * before the next keystroke. A secret also needs allowedOrigins, and the element's frame must be
   * on one of them before every keystroke. Whatever reached the target before it stopped is
   * recorded against that target.
   */
  async type(text: string | SecretValue, options?: TypeOptions): Promise<void> {
    const secret = text instanceof SecretValue
    const allowed = options?.allowedOrigins
    if (secret && allowed === undefined) throw new Error('allowedOrigins is required for a secret')
    const target = this.focused
    const element = target === null ? undefined : this.state().elements?.[target]
    const navigation = this.navigations
    const record = {
      selector: target,
      url: this.url,
      delayMs: options?.delayMs,
      allowedOrigins: allowed,
    }
    let typed = ''
    const stop = (): never => {
      this.typed.push({ ...record, text: typed, secret })
      if (secret) throw new ValetError('secret-fill', 'origin-mismatch')
      throw new Error('focus moved')
    }
    const keystroke = async (character: string): Promise<void> => {
      this.beforeKeystroke?.(typed.length)
      if (
        target === null ||
        element === undefined ||
        this.focused !== target ||
        this.navigations !== navigation ||
        this.state().elements?.[target] !== element
      ) {
        stop()
      }
      if (allowed !== undefined) {
        const origin = target === null ? null : this.frameOrigin(target)
        if (origin === null || !originAllowed(origin, allowed)) stop()
      }
      typed += character
    }
    if (text instanceof SecretValue) await text.revealEach(keystroke)
    else for (const character of text) await keystroke(character)
    this.typed.push({ ...record, text: typed, secret })
  }

  // The flow probes through its AuthProbe hook, never through the page; these exist for the contract.
  async fetch(_url: string): Promise<FetchResult> {
    throw new ValetError('probe', 'unsupported')
  }

  async cookieNames(_cookieDomains: readonly string[]): Promise<readonly string[]> {
    throw new ValetError('probe', 'unsupported')
  }

  async textPresent(text: string): Promise<boolean> {
    return this.state().text?.some((line) => line.includes(text)) ?? false
  }

  async handToUser(reason: NeedsUserReason): Promise<void> {
    this.handedToUser.push(reason)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** The security origin of the frame holding `selector` on the current page, or null if it's gone. */
  private frameOrigin(selector: string): string | null {
    const state = this.state()
    const element = state.elements?.[selector]
    if (element === undefined) return null
    if (element.frame === undefined) return httpsOrigin(this.url)
    return state.frames?.[element.frame] ?? null
  }

  private state(): FakeState {
    return this.site[this.url] ?? {}
  }
}
