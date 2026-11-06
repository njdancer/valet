// Small normalisers that turn the site's strings into clean values for an LLM to read.

/** Trimmed text, or null for null, undefined, blank or non-string values. */
export function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Splits a comma-separated attribute ("Gluten Free,Low Salt") into trimmed, non-empty items. */
export function list(value: unknown): string[] {
  const raw = text(value)
  if (raw === null) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

/** Plain text from the site's HTML snippets: line breaks kept, tags dropped, entities decoded. */
export function htmlToText(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  const plain = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return text(plain)
}

/** Rounds a dollar amount to cents, avoiding results like 8.399999999. */
export function cents(amount: number): number {
  return Math.round(amount * 100) / 100
}

/** An https URL as given, or null: anything else is not worth handing to a client. */
export function httpsUrl(value: unknown): string | null {
  const raw = text(value)
  return raw?.startsWith('https://') ? raw : null
}
