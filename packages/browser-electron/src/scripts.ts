// Runtime-authored scripts that run inside pages. Each is a fixed function; the only thing that
// varies is its data, which goes in as a JSON literal argument. Nothing is ever concatenated into
// the function body, so a selector or text can't become code. Adapter-supplied source exists only
// in `evaluateScript`, which the tool partition alone uses.
//
// The functions are strings rather than TypeScript because they run in the page, not in Node: the
// e2e suite runs them in Chromium, and the unit tests run them against a fake document.

/** A JavaScript literal for a JSON value. Rejects what JSON can't carry instead of guessing. */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

export function jsonLiteral(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('value is not JSON-serialisable')
  // Valid in string literals since ES2019, but escaping them costs nothing and removes the doubt.
  return json.replaceAll(LINE_SEPARATOR, '\\u2028').replaceAll(PARAGRAPH_SEPARATOR, '\\u2029')
}

function invoke(fn: string, ...args: unknown[]): string {
  return `(${fn})(${args.map(jsonLiteral).join(', ')})`
}

// Finds one element, or reports an invalid selector without throwing page text back to Node.
const FIND = `(selector) => {
  try { return { element: document.querySelector(selector) } } catch { return { invalid: true } }
}`

// This frame's index in its parent's window.frames. Index access and length are allowed across
// origins, so this works inside a cross-origin iframe too.
const FRAME_INDEX = `() => {
  if (window.parent === window) return null
  for (let i = 0; i < window.parent.length; i++) if (window.parent[i] === window) return i
  return null
}`

const INSPECT = `(selector) => {
  const found = (${FIND})(selector)
  if (found.invalid) return { error: 'invalid-selector' }
  const el = found.element
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  const shown = typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    : getComputedStyle(el).visibility !== 'hidden'
  const lower = (name) => { const v = el.getAttribute(name); return v === null ? null : v.toLowerCase() }
  const tagName = el.tagName.toLowerCase()
  const form = el.form instanceof HTMLFormElement ? el.form : null
  // Read action through the prototype: a control named "action" shadows form.action.
  const action = form === null ? null
    : Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get.call(form)
  return {
    visible: shown && rect.width > 0 && rect.height > 0,
    tagName,
    inputType: tagName === 'input' ? String(el.type).toLowerCase() : null,
    autocomplete: lower('autocomplete'),
    inputMode: lower('inputmode'),
    formAction: action,
  }
}`

const POINT = `(selector) => {
  const found = (${FIND})(selector)
  if (found.invalid) return { error: 'invalid-selector' }
  const el = found.element
  if (el === null) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return { error: 'not-visible' }
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const hit = document.elementFromPoint(x, y)
  return { x, y, hit: hit !== null && (hit === el || el.contains(hit)), indexInParent: (${FRAME_INDEX})() }
}`

// Runs in a parent frame: where the content box of its childIndex-th child frame starts.
const FRAME_OFFSET = `(childIndex) => {
  const child = window[childIndex]
  if (child === undefined) return null
  const el = Array.from(document.querySelectorAll('iframe, frame')).find((f) => f.contentWindow === child)
  if (el === undefined) return null
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  return {
    x: rect.left + el.clientLeft + parseFloat(style.paddingLeft),
    y: rect.top + el.clientTop + parseFloat(style.paddingTop),
    indexInParent: (${FRAME_INDEX})(),
  }
}`

// Focuses and selects the element's contents, so typing replaces what is there.
const FOCUS = `(selector) => {
  const found = (${FIND})(selector)
  if (found.invalid) return { error: 'invalid-selector' }
  const el = found.element
  if (el === null) return null
  el.focus()
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    try { el.select() } catch {}
  } else if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return { focused: document.activeElement === el && document.hasFocus() }
}`

// Whether the element still has focus, without touching anything.
const FOCUSED = `(selector) => {
  const found = (${FIND})(selector)
  if (found.invalid) return { error: 'invalid-selector' }
  const el = found.element
  return { focused: el !== null && document.activeElement === el && document.hasFocus() }
}`

const TEXT_PRESENT = `(text) => document.body !== null && document.body.innerText.includes(text)`

const EXTRACT = `(selector, attribute, all) => {
  let elements
  try { elements = Array.from(document.querySelectorAll(selector)) } catch { return { error: 'invalid-selector' } }
  const read = (el) => attribute === null ? (el.textContent || '').trim() : el.getAttribute(attribute)
  return { value: all ? elements.map(read) : elements.length === 0 ? null : read(elements[0]) }
}`

const FETCH = `async (request) => {
  const headers = { ...request.headers }
  const init = { method: request.method, headers, credentials: 'same-origin' }
  if (request.hasJson) {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json'
    }
    init.body = JSON.stringify(request.json)
  }
  let response
  try { response = await fetch(request.url, init) } catch { return { error: 'network' } }
  const text = await response.text()
  let body = text
  try { body = JSON.parse(text) } catch {}
  return { status: response.status, contentType: response.headers.get('content-type'), body }
}`

const READ_STORAGE = `(keys) => {
  const values = {}
  for (const key of keys) values[key] = window.localStorage.getItem(key)
  return values
}`

const WRITE_STORAGE = `(entries) => {
  for (const [key, value] of entries) window.localStorage.setItem(key, value)
  return true
}`

export const inspectScript = (selector: string): string => invoke(INSPECT, selector)
export const pointScript = (selector: string): string => invoke(POINT, selector)
export const frameOffsetScript = (childIndex: number): string => invoke(FRAME_OFFSET, childIndex)
export const focusScript = (selector: string): string => invoke(FOCUS, selector)
export const focusedScript = (selector: string): string => invoke(FOCUSED, selector)
export const textPresentScript = (text: string): string => invoke(TEXT_PRESENT, text)
export const readStorageScript = (keys: readonly string[]): string => invoke(READ_STORAGE, keys)
export const writeStorageScript = (entries: readonly (readonly [string, string])[]): string =>
  invoke(WRITE_STORAGE, entries)

export function extractScript(selector: string, attribute: string | null, all: boolean): string {
  return invoke(EXTRACT, selector, attribute, all)
}

export interface FetchRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly hasJson: boolean
  readonly json: unknown
}

export const fetchScript = (request: FetchRequest): string => invoke(FETCH, request)

/**
 * Wraps adapter-supplied source: an expression or async IIFE that may read `args`. Tool partition
 * only. The result is passed through JSON so that only plain data comes back.
 */
export function evaluateScript(source: string, args: unknown): string {
  return `(async () => {
  const result = await (async (args) => (
${source}
))(${jsonLiteral(args ?? null)})
  return result === undefined ? null : JSON.parse(JSON.stringify(result))
})()`
}
