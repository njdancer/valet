// What a call was about, in a few words for the Activity list (F27): the search it ran, or the
// products it touched with their quantities, e.g. "Dairy Farmers Milk 2L × 2". Worked out from the
// call's input and its (already redacted) output, kept in RunMemory only: never written to disk,
// since trolley contents and searches stay out of the audit log.
//
// It reads shapes, not adapter names: an input `query`, an input `stockcode` or `items[].stockcode`
// with an optional `quantity`, and anything in the output with a `stockcode` and a `name`.

export interface CallLine {
  readonly stockcode: string
  readonly quantity: number | null
}

export interface CallSubject {
  readonly query: string | null
  readonly lines: readonly CallLine[]
}

const MAX_QUERY = 40
const MAX_NAME = 60
const NAMED_LINES = 2
const MAX_DEPTH = 6

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Printable text, one line, clipped. Site text and agent input are both untrusted. */
function clean(text: string, max: number): string {
  const visible = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...visible]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : visible
}

function codeOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return clean(value, 20)
  return null
}

function lineOf(value: unknown): CallLine | null {
  if (!isRecord(value)) return null
  const stockcode = codeOf(value['stockcode'])
  if (stockcode === null) return null
  const quantity = value['quantity']
  return { stockcode, quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : null }
}

export function subjectOf(input: unknown): CallSubject {
  if (!isRecord(input)) return { query: null, lines: [] }
  const query = typeof input['query'] === 'string' ? clean(input['query'], MAX_QUERY) : null
  const lines: CallLine[] = []
  const single = lineOf(input)
  if (single !== null) lines.push(single)
  const items = input['items']
  if (Array.isArray(items)) {
    for (const item of items) {
      const line = lineOf(item)
      if (line !== null) lines.push(line)
    }
  }
  return { query: query === '' ? null : query, lines }
}

/** Every `stockcode` → `name` pair in the output, first one wins. */
function namesIn(output: unknown): Map<string, string> {
  const names = new Map<string, string>()
  const walk = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (!isRecord(value)) return
    const code = codeOf(value['stockcode'])
    const name = value['name']
    if (code !== null && typeof name === 'string' && !names.has(code)) {
      const cleaned = clean(name, MAX_NAME)
      if (cleaned !== '') names.set(code, cleaned)
    }
    for (const child of Object.values(value)) walk(child, depth + 1)
  }
  walk(output, 0)
  return names
}

/** The words for a call, or null when there's nothing more to say than the tool's name. */
export function detailOf(subject: CallSubject, output: unknown): string | null {
  if (subject.query !== null) return `“${subject.query}”`
  if (subject.lines.length === 0) return null
  const names = namesIn(output)
  const words = subject.lines.map((line) => {
    const name = names.get(line.stockcode) ?? `product ${line.stockcode}`
    return line.quantity !== null && line.quantity > 1 ? `${name} × ${line.quantity}` : name
  })
  if (words.length <= NAMED_LINES) return words.join(' and ')
  return `${words.slice(0, NAMED_LINES).join(', ')} and ${words.length - NAMED_LINES} more`
}
