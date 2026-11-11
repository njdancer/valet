// The fake shop's own made-up brand. The fake follows woolworths.com.au's flows, origins and API
// shapes, because that is what the adapter has to work against, but what a person sees on its
// pages (name, logo, colours) is invented: it is not Woolworths and borrows none of its marks.
// The catalogue's captured product names keep the real site's house brand unless `houseBrand` is
// passed to startFakeWoolworths (demo mode does), so the adapter's fixtures stay as captured.

/** The shop's name, on every page it serves. */
export const STORE_NAME = 'Gumleaf Grocer'

/** The house brand the shop's own products carry when the fake is rebranded. */
export const HOUSE_BRAND = 'Gumleaf'

/** The captured house brand, as it appears in product names and messages. */
const CAPTURED_BRAND = /\bWoolworths\b/g

/** `text` with the captured house brand swapped for `brand`. */
export function rebrandText(text: string, brand: string): string {
  return text.replace(CAPTURED_BRAND, brand)
}

/** A JSON value with every string rebranded (keys untouched). */
export function rebrandJson(value: unknown, brand: string): unknown {
  if (typeof value === 'string') return rebrandText(value, brand)
  if (Array.isArray(value)) return value.map((item) => rebrandJson(item, brand))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrandJson(item, brand)]))
  }
  return value
}

/** The logo: a gum leaf in a rounded square, inline so a page makes no extra request. */
export const LOGO_SVG = `<svg class="logo-mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#1f6f5c"/><path d="M9 23c0-9 6-14 15-15-1 9-6 15-15 15z" fill="#f2c14e"/><path d="M9 23l9-9" stroke="#1f6f5c" stroke-width="1.6" stroke-linecap="round"/></svg>`

/** Shared styles for the shop and its sign-in pages. */
export const BASE_CSS = `
:root{--leaf:#1f6f5c;--leaf-dark:#164f42;--wattle:#f2c14e;--ink:#1d2523;--muted:#5d6b67;--line:#e3e8e6;--bg:#f6f7f4;--card:#fff;--sale:#c8412d}
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--leaf)}
.button,button.primary{display:inline-block;background:var(--leaf);color:#fff;border:0;border-radius:999px;padding:10px 20px;font:600 15px/1 inherit;font-family:inherit;text-decoration:none;cursor:pointer}
.button:hover,button.primary:hover{background:var(--leaf-dark)}
.button.secondary{background:#fff;color:var(--leaf);border:1.5px solid var(--leaf)}
`
