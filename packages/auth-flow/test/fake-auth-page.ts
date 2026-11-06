// A scriptable AuthPage. A site is a map from URL to the state the page shows there: its elements,
// the frames and forms they belong to, its text, and where clicks and server redirects lead. Tests
// copy a site fixture and change one thing.

import { type AuthPage, type ElementInfo, httpsOrigin, SecretValue } from '@siteadapter/core'

export interface FakeElement {
  /** Defaults to "input". */
  readonly tagName?: string
  readonly inputType?: string | null
  readonly autocomplete?: string | null
  readonly inputMode?: string | null
  /** Defaults to true. */
  readonly visible?: boolean
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
}

export class FakeAuthPage implements AuthPage {
  url = 'about:blank'
  focused: string | null = null
  readonly history: string[] = []
  readonly visited: string[] = []
  readonly clicked: string[] = []
  readonly typed: Typed[] = []
  readonly handedToUser: string[] = []
  closed = false

  constructor(readonly site: FakeSite) {}

  /** Moves the page to `url` as if the site navigated it, following server redirects. */
  navigate(url: string): void {
    let next: string | undefined = url
    for (let hops = 0; next !== undefined && hops < 10; hops++) {
      this.url = next
      this.history.push(next)
      next = this.state().redirectTo
    }
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
    const frameOrigin =
      element.frame === undefined
        ? (httpsOrigin(this.url) ?? 'null')
        : (state.frames?.[element.frame] ?? 'null')
    const formActionOrigin = element.form === undefined ? null : (state.forms?.[element.form] ?? null)
    return {
      visible: element.visible ?? true,
      tagName: element.tagName ?? 'input',
      inputType: element.inputType ?? null,
      autocomplete: element.autocomplete ?? null,
      inputMode: element.inputMode ?? null,
      frameOrigin,
      formActionOrigin,
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

  async type(text: string | SecretValue, options?: { readonly delayMs?: number }): Promise<void> {
    const secret = text instanceof SecretValue
    const plaintext = text instanceof SecretValue ? text.reveal((value) => value) : text
    this.typed.push({
      selector: this.focused,
      url: this.url,
      text: plaintext,
      secret,
      delayMs: options?.delayMs,
    })
  }

  async textPresent(text: string): Promise<boolean> {
    return this.state().text?.some((line) => line.includes(text)) ?? false
  }

  async handToUser(reason: string): Promise<void> {
    this.handedToUser.push(reason)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private state(): FakeState {
    return this.site[this.url] ?? {}
  }
}
