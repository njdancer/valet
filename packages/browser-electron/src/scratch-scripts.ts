// The scratch browser's page scripts (docs/authoring-tools.md#the-scratch-browser-pr-2). Like
// scripts.ts, each is a fixed function whose only input is a JSON literal, run in the runtime's
// isolated world. They read the page for an agent that is writing an adapter: what is on it and
// what can be clicked, never an input's value, a script, a comment or anything hidden.

import { jsonLiteral } from './scripts'

function invoke(fn: string, ...args: unknown[]): string {
  return `(${fn})(${args.map(jsonLiteral).join(', ')})`
}

/** One node of a snapshot. `path` is a selector Valet keeps behind the ref; the agent never sees it. */
export interface SnapshotNode {
  readonly kind: 'interactive' | 'text'
  readonly tag: string
  readonly role: string | null
  /** The node's own text, or for a control its label, placeholder or name; never its value. */
  readonly text: string
  readonly href: string | null
  readonly inputType: string | null
  readonly path: string
}

export interface SnapshotResult {
  readonly title: string
  readonly url: string
  readonly nodes: readonly SnapshotNode[]
  /** True when there were more nodes than the limit. */
  readonly cut: boolean
}

// A selector that finds this element again: ids where they are plain, else nth-of-type steps.
const PATH = `(el) => {
  const steps = []
  let node = el
  while (node !== null && node.nodeType === 1 && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase()
    const id = node.getAttribute('id')
    if (id !== null && /^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(id) && document.querySelectorAll('#' + id).length === 1) {
      steps.unshift('#' + id)
      break
    }
    let index = 1
    for (let s = node.previousElementSibling; s !== null; s = s.previousElementSibling)
      if (s.tagName === node.tagName) index++
    steps.unshift(tag + ':nth-of-type(' + index + ')')
    node = node.parentElement
  }
  if (steps.length === 0 || !steps[0].startsWith('#')) steps.unshift('html')
  return steps.join(' > ')
}`

// Hidden is anything a person looking at the page can't read: not rendered, see-through, too small,
// clipped away or placed off the page. Pages hide instructions for agents in all of these.
const HIDDEN = `(el) => {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true
  if (style.opacity !== '' && Number(style.opacity) < 0.1) return true
  if (parseFloat(style.fontSize) < 4) return true
  if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return true
  // Geometry only where the page is laid out (a DOM with no layout, as in tests, has no boxes).
  if (style.display === 'contents' || document.documentElement.getBoundingClientRect().width === 0) return false
  const rect = el.getBoundingClientRect()
  if (el.getClientRects().length === 0) return true
  if ((rect.width < 2 || rect.height < 2) && style.overflow !== 'visible') return true
  const doc = document.documentElement
  if (rect.right <= 0 || rect.bottom <= 0) return true
  if (rect.left >= Math.max(doc.scrollWidth, innerWidth) || rect.top >= Math.max(doc.scrollHeight, innerHeight)) return true
  const color = style.color.replace(/\\s/g, '')
  if (/^rgba\\(\\d+,\\d+,\\d+,0(\\.0+)?\\)$/.test(color) || color === 'transparent') return true
  return false
}`

const SNAPSHOT = `(options) => {
  const path = ${PATH}
  const hidden = ${HIDDEN}
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'head'])
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])
  const TEXT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'dt', 'dd', 'label', 'caption', 'figcaption', 'span', 'div', 'strong', 'em', 'b', 'small'])
  const ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch', 'combobox', 'searchbox', 'textbox'])
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, options.textLimit)
  const ownText = (el) => {
    let out = ''
    for (const child of el.childNodes) if (child.nodeType === 3) out += child.nodeValue
    return clean(out)
  }
  const labelOf = (el) => {
    const tag = el.tagName.toLowerCase()
    // A control's visible words win; an aria-label, title or alt (which no one sees) only names a
    // control that shows none, as an icon button does.
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      const visible = clean(typeof el.innerText === 'string' ? el.innerText : el.textContent)
      if (visible !== '') return visible
    }
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const id = el.getAttribute('id')
      if (id) {
        const label = Array.from(document.querySelectorAll('label')).find((l) => l.getAttribute('for') === id)
        if (label) return clean(label.textContent)
      }
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'submit' || type === 'button') return clean(el.getAttribute('value'))
      return clean(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title'))
    }
    const img = el.querySelector('img[alt]')
    return clean(el.getAttribute('title') || (img === null ? '' : img.getAttribute('alt')))
  }
  let root = document.body || document.documentElement
  if (options.root !== null) {
    try { root = document.querySelector(options.root) } catch { return { error: 'invalid-selector' } }
    if (root === null) return { error: 'not-found' }
  }
  const nodes = []
  let cut = false
  const walk = (el) => {
    if (cut) return
    const tag = el.tagName.toLowerCase()
    if (SKIP.has(tag) || hidden(el)) return
    const role = el.getAttribute('role')
    const interactive = INTERACTIVE.has(tag) || (role !== null && ROLES.has(role))
    if (interactive) {
      if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return
      if (nodes.length >= options.maxNodes) { cut = true; return }
      const href = tag === 'a' ? el.getAttribute('href') : null
      nodes.push({
        kind: 'interactive', tag, role, text: labelOf(el),
        href: href === null ? null : String(href).slice(0, 300),
        inputType: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
        path: path(el),
      })
      if (tag !== 'a' && tag !== 'button' && tag !== 'summary') return
    } else if (TEXT.has(tag)) {
      const text = ownText(el)
      if (text !== '') {
        if (nodes.length >= options.maxNodes) { cut = true; return }
        nodes.push({ kind: 'text', tag, role, text, href: null, inputType: null, path: path(el) })
      }
    }
    if (interactive) return
    for (const child of el.children) walk(child)
  }
  walk(root)
  return { title: clean(document.title), url: String(location.href).slice(0, 2000), nodes, cut }
}`

export interface QueryMatch {
  readonly tag: string
  readonly id: string | null
  readonly classes: string
  readonly text: string
  readonly visible: boolean
}

const QUERY = `(selector) => {
  const hiddenSelf = ${HIDDEN}
  // Hidden by itself or by any element it sits in, as a snapshot (which stops at a hidden parent) has it.
  const hidden = (el) => {
    for (let node = el; node !== null && node !== document.documentElement; node = node.parentElement)
      if (hiddenSelf(node)) return true
    return false
  }
  let found
  try { found = Array.from(document.querySelectorAll(selector)) } catch { return { error: 'invalid-selector' } }
  const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n)
  return {
    count: found.length,
    matches: found.slice(0, 10).map((el) => {
      const tag = el.tagName.toLowerCase()
      const secret = tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'script' || tag === 'style'
      return {
        tag,
        id: el.getAttribute('id') === null ? null : clean(el.getAttribute('id'), 80),
        classes: clean(el.getAttribute('class'), 120),
        text: secret ? '' : clean(el.textContent, 80),
        visible: !hidden(el),
      }
    }),
  }
}`

/** What kind of field a selector finds, so typing can refuse passwords and one-time codes. */
const FIELD = `(selector) => {
  let el
  try { el = document.querySelector(selector) } catch { return { error: 'invalid-selector' } }
  if (el === null) return null
  const tag = el.tagName.toLowerCase()
  const lower = (name) => (el.getAttribute(name) || '').toLowerCase()
  return {
    tag,
    inputType: tag === 'input' ? (lower('type') || 'text') : null,
    autocomplete: lower('autocomplete'),
    name: lower('name') + ' ' + lower('id'),
  }
}`

/** The document as the browser holds it now, for a fixture. */
const DOCUMENT = `() => {
  const doctype = document.doctype === null ? '' : '<!doctype ' + document.doctype.name + '>\\n'
  return doctype + document.documentElement.outerHTML
}`

export const snapshotScript = (options: {
  readonly root: string | null
  readonly maxNodes: number
  readonly textLimit: number
}): string => invoke(SNAPSHOT, options)
export const queryScript = (selector: string): string => invoke(QUERY, selector)
export const fieldScript = (selector: string): string => invoke(FIELD, selector)
export const documentScript = (): string => invoke(DOCUMENT)
