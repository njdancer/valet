// vCard 3.0 (RFC 2426, as iCloud writes it), as much as finding a person needs: unfolding, grouped
// properties ("item1.EMAIL"), parameters, and escaped text. Pure, so cases test it.

export interface Card {
  readonly name: string
  readonly emails: string[]
  readonly phones: string[]
  readonly organisation: string | null
}

function unescape(value: string): string {
  return value.replace(/\\([\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** One card's properties, or null if the text isn't a vCard. */
export function readCard(text: string): Card | null {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  if (lines[0]?.trim() !== 'BEGIN:VCARD') return null
  let name: string | null = null
  const emails: string[] = []
  const phones: string[] = []
  let organisation: string | null = null
  for (const line of lines) {
    const match = /^(?:[A-Za-z0-9-]+\.)?([A-Za-z-]+)(;[^:]*)?:(.*)$/.exec(line)
    if (match === null) continue
    const property = (match[1] as string).toUpperCase()
    const value = match[3] as string
    if (property === 'FN') name = unescape(value).slice(0, 200)
    else if (property === 'EMAIL' && emails.length < 10) emails.push(unescape(value).slice(0, 200))
    else if (property === 'TEL' && phones.length < 10) phones.push(unescape(value).slice(0, 50))
    else if (property === 'ORG') {
      // ORG is the organisation then its units, split on unescaped semicolons.
      const first = unescape(value.split(/(?<!\\);/)[0] ?? '').trim()
      organisation = first === '' ? null : first.slice(0, 200)
    }
  }
  return name === null ? null : { name, emails, phones, organisation }
}
