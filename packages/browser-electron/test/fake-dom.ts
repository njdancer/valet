// A very small fake DOM, enough to run the real scripts from src/scripts.ts in node:vm. Elements
// are registered against the exact selector strings a test uses; anything in `invalidSelectors`
// throws as a real querySelector would on a syntax error.

import vm from 'node:vm'

// Orders focus() calls across every fake document, so a surface can tell which frame focused last.
let focusSequence = 0

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Stands in for HTMLFormElement. `action` is a prototype getter, as in a browser. */
export class FakeForm {
  constructor(readonly resolvedAction: string) {}

  get action(): unknown {
    return this.resolvedAction
  }
}

export class FakeElement {
  readonly attributes: Record<string, string>
  readonly children: FakeElement[] = []
  rect: Rect
  shown = true
  type: string | undefined
  form: FakeForm | null = null
  textContent: string | null = null
  isContentEditable = false
  focusable = true
  selected = false
  scrolledIntoView = 0
  contentWindow: unknown = null
  clientLeft = 0
  clientTop = 0

  constructor(
    readonly document: FakeDocument,
    readonly tagName: string,
    options: {
      attributes?: Record<string, string>
      rect?: Rect
      type?: string
    } = {},
  ) {
    this.attributes = options.attributes ?? {}
    this.rect = options.rect ?? { left: 10, top: 20, width: 100, height: 30 }
    this.type = options.type
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }
  }

  checkVisibility(): boolean {
    return this.shown
  }

  focus(): void {
    if (!this.focusable) return
    this.document.activeElement = this
    this.document.focusedAt = ++focusSequence
  }

  select(): void {
    this.selected = true
  }

  contains(other: unknown): boolean {
    return other === this || this.children.some((child) => child.contains(other))
  }

  scrollIntoView(): void {
    this.scrolledIntoView++
  }
}

export class FakeDocument {
  readonly bySelector = new Map<string, FakeElement[]>()
  readonly invalidSelectors = new Set<string>()
  readonly queried: string[] = []
  activeElement: FakeElement | null = null
  /** When an element in this document last took focus, in focusSequence order; 0 for never. */
  focusedAt = 0
  /** What document.hasFocus() answers. */
  windowFocused = true
  body: { innerText: string } | null = { innerText: '' }
  /** What elementFromPoint returns. By default, the last registered element containing the point. */
  hitTest: ((x: number, y: number) => FakeElement | null) | null = null
  readonly ranges: unknown[] = []
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  add(selector: string, element: FakeElement): FakeElement {
    this.bySelector.set(selector, [...(this.bySelector.get(selector) ?? []), element])
    return element
  }

  element(tagName: string, options?: ConstructorParameters<typeof FakeElement>[2]): FakeElement {
    return new FakeElement(this, tagName, options)
  }

  hasFocus(): boolean {
    return this.windowFocused
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    this.queried.push(selector)
    if (this.invalidSelectors.has(selector)) throw new SyntaxError(`'${selector}' is not a valid selector`)
    return this.bySelector.get(selector) ?? []
  }

  elementFromPoint(x: number, y: number): FakeElement | null {
    if (this.hitTest !== null) return this.hitTest(x, y)
    const all = [...this.bySelector.values()].flat().reverse()
    return (
      all.find((el) => {
        const r = el.rect
        return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height
      }) ?? null
    )
  }

  createRange(): { selectNodeContents(node: unknown): void } {
    const range = { node: null as unknown, selectNodeContents: (node: unknown) => (range.node = node) }
    this.ranges.push(range)
    return range
  }
}

export interface FakeWindowOptions {
  /** Another FakeWindow's `global`, for a frame whose parent doesn't list it. */
  readonly parent?: unknown
  readonly fetch?: (url: string, init: unknown) => Promise<unknown>
  readonly storage?: Map<string, string>
}

/**
 * A vm context standing in for one frame's window. Child frames are attached with `attachChild`,
 * which makes them reachable as window[i] and gives them window.parent.
 */
export class FakeWindow {
  readonly document = new FakeDocument()
  readonly storage: Map<string, string>
  readonly sandbox: Record<string, unknown>
  /** The context's global object: what `window` is inside it, so identity checks behave. */
  readonly global: unknown
  readonly calls: string[] = []
  private children = 0

  constructor(options: FakeWindowOptions = {}) {
    this.storage = options.storage ?? new Map()
    const storage = this.storage
    const sandbox: Record<string, unknown> = {
      document: this.document,
      HTMLFormElement: FakeForm,
      getComputedStyle: (el: FakeElement) => ({
        visibility: el.shown ? 'visible' : 'hidden',
        paddingLeft: '0px',
        paddingTop: '0px',
      }),
      getSelection: () => ({
        removeAllRanges: () => this.calls.push('removeAllRanges'),
        addRange: () => this.calls.push('addRange'),
      }),
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, String(value)),
      },
      fetch: options.fetch ?? (() => Promise.reject(new TypeError('Failed to fetch'))),
      URL,
      setTimeout,
      // Recorded rather than run: a script that manages to call alert() has broken out.
      alert: (message: unknown) => this.calls.push(`alert:${String(message)}`),
      length: 0,
    }
    this.sandbox = sandbox
    vm.createContext(sandbox)
    this.global = vm.runInContext('globalThis', sandbox)
    sandbox['window'] = this.global
    sandbox['parent'] = options.parent ?? this.global
  }

  attachChild(child: FakeWindow): number {
    const index = this.children++
    this.sandbox[String(index)] = child.global
    this.sandbox['length'] = this.children
    child.sandbox['parent'] = this.global
    return index
  }

  run(code: string): unknown {
    return vm.runInContext(code, this.sandbox)
  }
}
