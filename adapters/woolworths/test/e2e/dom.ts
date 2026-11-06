// Just enough of a DOM for the fake site's server-rendered pages: the elements, which form each
// sits in, live values and checked state, and the compound CSS selectors the manifest uses
// (tag, #id, .class, [attr], [attr="value"], :checked, :not(:checked)). Anything else throws, so a
// selector the harness can't evaluate fails loudly instead of matching wrongly.

export interface Element {
  readonly tag: string
  readonly attrs: ReadonlyMap<string, string>
  /** Index into Doc.forms of the form this element is inside, or null. */
  readonly form: number | null
  value: string
  checked: boolean
}

export interface Doc {
  readonly elements: readonly Element[]
  readonly forms: readonly Element[]
  readonly text: string
}

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
const INVISIBLE_TAGS = new Set(['head', 'title', 'meta', 'script', 'style', 'template'])

function decode(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

export function parseHtml(html: string): Doc {
  const elements: Element[] = []
  const forms: Element[] = []
  let form: number | null = null
  let text = ''
  let last = 0
  TAG.lastIndex = 0
  for (let match = TAG.exec(html); match !== null; match = TAG.exec(html)) {
    text += html.slice(last, match.index)
    last = TAG.lastIndex
    const [, closing, rawTag, rawAttrs = ''] = match
    if (rawTag === undefined) continue
    const tag = rawTag.toLowerCase()
    if (closing === '/') {
      if (tag === 'form') form = null
      continue
    }
    const attrs = new Map<string, string>()
    ATTRIBUTE.lastIndex = 0
    for (let attr = ATTRIBUTE.exec(rawAttrs); attr !== null; attr = ATTRIBUTE.exec(rawAttrs)) {
      const [, name = '', double, single, bare] = attr
      attrs.set(name.toLowerCase(), decode(double ?? single ?? bare ?? ''))
    }
    const element: Element = {
      tag,
      attrs,
      form: tag === 'form' ? null : form,
      value: attrs.get('value') ?? '',
      checked: attrs.has('checked'),
    }
    elements.push(element)
    if (tag === 'form') {
      forms.push(element)
      form = forms.length - 1
    }
    if (tag === 'script' || tag === 'style') {
      const end = html.toLowerCase().indexOf(`</${tag}>`, TAG.lastIndex)
      TAG.lastIndex = end === -1 ? html.length : end
      last = TAG.lastIndex
    }
  }
  text += html.slice(last)
  return { elements, forms, text: decode(text.replace(/\s+/g, ' ')) }
}

export function isVisible(element: Element): boolean {
  return (
    !INVISIBLE_TAGS.has(element.tag) && element.attrs.get('type') !== 'hidden' && !element.attrs.has('hidden')
  )
}

type Test = (element: Element) => boolean

const SIMPLE = /^([a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|:not\(:checked\)|:checked)*)$/
const PART = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(:not\(:checked\))|(:checked)/g

function compile(selector: string): Test {
  const shape = SIMPLE.exec(selector)
  if (shape === null) throw new Error(`the harness does not support the selector ${selector}`)
  const tests: Test[] = []
  const tag = shape[1]?.toLowerCase()
  if (tag !== undefined) tests.push((e) => e.tag === tag)
  const rest = shape[2] ?? ''
  PART.lastIndex = 0
  for (let part = PART.exec(rest); part !== null; part = PART.exec(rest)) {
    const [, id, className, attr, value, notChecked, checked] = part
    if (id !== undefined) tests.push((e) => e.attrs.get('id') === id)
    else if (className !== undefined) {
      tests.push((e) => (e.attrs.get('class') ?? '').split(/\s+/).includes(className))
    } else if (attr !== undefined) {
      tests.push((e) => (value === undefined ? e.attrs.has(attr) : e.attrs.get(attr) === value))
    } else if (notChecked !== undefined) tests.push((e) => !e.checked)
    else if (checked !== undefined) tests.push((e) => e.checked)
  }
  return (element) => tests.every((test) => test(element))
}

/** The first element matching `selector`, as querySelector would find it. */
export function query(doc: Doc, selector: string): Element | null {
  const test = compile(selector)
  return doc.elements.find(test) ?? null
}
