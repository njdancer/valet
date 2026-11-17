// Just enough MIME for the fake server to answer ENVELOPE, BODYSTRUCTURE and BODY[section] the
// way a real one does. Test messages are written by the tests, so this is simple, not defensive.

export interface MimeNode {
  readonly headers: readonly [string, string][]
  /** The raw header block, CRLFs included, with the blank line after it. */
  readonly headerBytes: Buffer
  readonly body: Buffer
  readonly type: string
  readonly subtype: string
  readonly params: ReadonlyMap<string, string>
  readonly children: readonly MimeNode[]
}

function splitHead(raw: Buffer): { head: Buffer; body: Buffer } {
  const at = raw.indexOf('\r\n\r\n')
  if (at === -1) return { head: raw, body: Buffer.alloc(0) }
  return { head: raw.subarray(0, at + 4), body: raw.subarray(at + 4) }
}

export function parseHeaders(head: Buffer): [string, string][] {
  const out: [string, string][] = []
  for (const line of head.toString('latin1').split('\r\n')) {
    if (line === '') continue
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1] as [string, string]
      last[1] += ` ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon > 0) out.push([line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()])
  }
  return out
}

export function header(headers: readonly [string, string][], name: string): string | null {
  return headers.find(([k]) => k === name)?.[1] ?? null
}

/** `text/plain; charset="utf-8"` as its type, subtype and parameters. */
export function contentType(value: string | null): { type: string; subtype: string; params: Map<string, string> } {
  const params = new Map<string, string>()
  if (value === null) return { type: 'text', subtype: 'plain', params: new Map([['charset', 'us-ascii']]) }
  const [main = '', ...rest] = value.split(';')
  const [type = 'text', subtype = 'plain'] = main.trim().toLowerCase().split('/')
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    params.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim().replace(/^"|"$/g, ''))
  }
  return { type, subtype, params }
}

export function parseMime(raw: Buffer): MimeNode {
  const { head, body } = splitHead(raw)
  const headers = parseHeaders(head)
  const { type, subtype, params } = contentType(header(headers, 'content-type'))
  const children: MimeNode[] = []
  const boundary = params.get('boundary')
  if (type === 'multipart' && boundary !== undefined) {
    const text = body.toString('latin1')
    const marker = `--${boundary}`
    const pieces = text.split(marker)
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith('--')) break
      const content = piece.replace(/^\r\n/, '').replace(/\r\n$/, '')
      children.push(parseMime(Buffer.from(content, 'latin1')))
    }
  }
  return { headers, headerBytes: head, body, type, subtype, params, children }
}

/** The node for a section number (`1`, `2.1`); a single-part message's `1` is itself. */
export function sectionNode(root: MimeNode, section: string): MimeNode | null {
  let node: MimeNode | null = root
  for (const n of section.split('.').map(Number)) {
    if (node === null) return null
    if (node.children.length === 0) {
      node = n === 1 ? node : null
      continue
    }
    node = node.children[n - 1] ?? null
  }
  return node
}

export function quote(value: string | null): string {
  if (value === null) return 'NIL'
  const bytes = Buffer.from(value, 'utf8')
  if (/[\r\n"\\]/.test(value) || bytes.some((b) => b >= 0x80)) return `{${bytes.length}}\r\n${value}`
  return `"${value}"`
}

function addressList(value: string | null): string {
  if (value === null || value.trim() === '') return 'NIL'
  const entries = value.split(',').map((one) => {
    const angle = /^(.*)<([^>]*)>\s*$/.exec(one.trim())
    const name = angle === null ? null : (angle[1] as string).trim().replace(/^"|"$/g, '') || null
    const address = angle === null ? one.trim() : (angle[2] as string)
    const [local = '', domain = ''] = address.split('@')
    return `(${quote(name)} NIL ${quote(local)} ${quote(domain)})`
  })
  return `(${entries.join('')})`
}

export function envelope(root: MimeNode): string {
  const h = (n: string) => header(root.headers, n)
  const from = h('from')
  return `(${[
    quote(h('date')),
    quote(h('subject')),
    addressList(from),
    addressList(h('sender') ?? from),
    addressList(h('reply-to') ?? from),
    addressList(h('to')),
    addressList(h('cc')),
    addressList(h('bcc')),
    quote(h('in-reply-to')),
    quote(h('message-id')),
  ].join(' ')})`
}

function paramList(params: ReadonlyMap<string, string>, skip: readonly string[] = []): string {
  const entries = [...params].filter(([k]) => !skip.includes(k))
  if (entries.length === 0) return 'NIL'
  return `(${entries.map(([k, v]) => `${quote(k.toUpperCase())} ${quote(v)}`).join(' ')})`
}

export function bodyStructure(node: MimeNode): string {
  if (node.children.length > 0) {
    return `(${node.children.map(bodyStructure).join('')} ${quote(node.subtype.toUpperCase())} ${paramList(node.params)} NIL NIL NIL)`
  }
  const encoding = header(node.headers, 'content-transfer-encoding') ?? '7BIT'
  const dispositionHeader = header(node.headers, 'content-disposition')
  let disposition = 'NIL'
  if (dispositionHeader !== null) {
    const parsed = contentType(`x/${dispositionHeader}`)
    const kind = (dispositionHeader.split(';')[0] ?? '').trim().toUpperCase()
    disposition = `(${quote(kind)} ${paramList(parsed.params)})`
  }
  const fields = [
    quote(node.type.toUpperCase()),
    quote(node.subtype.toUpperCase()),
    paramList(node.params),
    quote(header(node.headers, 'content-id')),
    quote(header(node.headers, 'content-description')),
    quote(encoding.toUpperCase()),
    String(node.body.length),
  ]
  if (node.type === 'text') fields.push(String(node.body.toString('latin1').split('\r\n').length))
  if (node.type === 'message' && node.subtype === 'rfc822') {
    const inner = parseMime(node.body)
    fields.push(envelope(inner), bodyStructure(inner), String(node.body.toString('latin1').split('\r\n').length))
  }
  fields.push('NIL', disposition, 'NIL', 'NIL')
  return `(${fields.join(' ')})`
}
