// Hacker News gives text as a little HTML: <p> between paragraphs, <i>, <a>, <pre><code> and
// entities. This turns it into plain text an agent can read. Pure, so cases test it.

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function plainText(html: string, max = 4000): string {
  const text = html
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_m, href: string, label: string) =>
      label === '' || decode(label) === decode(href) ? decode(href) : `${label} (${decode(href)})`,
    )
    .replace(/<[^>]*>/g, '')
  return decode(text).trim().slice(0, max)
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}
