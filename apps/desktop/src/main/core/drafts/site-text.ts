// What of a page may reach an agent outside a `fromSite` value (docs/authoring-tools.md#prompt-injection):
// only names from fixed sets. A tag, role, input type or content type the site made up becomes a
// plain stand-in, so injected words can't arrive looking like Valet's own fields.

const TAGS = new Set(
  (
    'a abbr address article aside b bdi blockquote button caption cite code dd del details dfn div dl dt ' +
    'em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header i img input ins kbd label legend li ' +
    'main mark nav ol optgroup option output p pre q s samp section select small span strong sub summary sup ' +
    'table tbody td textarea tfoot th thead time tr u ul var'
  ).split(' '),
)

const ROLES = new Set(
  (
    'alert article banner button cell checkbox columnheader combobox complementary contentinfo definition ' +
    'dialog document feed figure form grid gridcell group heading img link list listbox listitem main menu ' +
    'menubar menuitem menuitemcheckbox menuitemradio navigation note option presentation progressbar radio ' +
    'radiogroup region row rowgroup rowheader search searchbox separator slider spinbutton status switch tab ' +
    'table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem'
  ).split(' '),
)

const INPUT_TYPES = new Set(
  (
    'button checkbox color date datetime-local email file hidden image month number password radio range ' +
    'reset search submit tel text time url week'
  ).split(' '),
)

/** A tag as the agent may see it: a standard HTML tag, else "element". */
export function siteTag(tag: string): string {
  const lower = tag.toLowerCase()
  return TAGS.has(lower) ? lower : 'element'
}

/** A role from the ARIA list, else null. */
export function siteRole(role: string | null): string | null {
  if (role === null) return null
  const lower = role.trim().toLowerCase()
  return ROLES.has(lower) ? lower : null
}

/** An input type browsers know, else "text" (which is what a browser makes of an unknown one). */
export function siteInputType(type: string | null): string | null {
  if (type === null) return null
  const lower = type.toLowerCase()
  return INPUT_TYPES.has(lower) ? lower : 'text'
}

const MIME_TYPES = new Set(['application', 'text', 'image', 'font', 'audio', 'video', 'multipart'])
const MIME_SUBTYPES = new Set(
  (
    'json ld+json problem+json manifest+json x-ndjson graphql-response+json html xhtml+xml plain javascript ' +
    'x-javascript ecmascript css xml csv event-stream octet-stream x-www-form-urlencoded form-data png jpeg ' +
    'gif webp avif svg+xml x-icon vnd.microsoft.icon woff woff2 ttf otf mpeg mp4 webm ogg wasm pdf'
  ).split(' '),
)

/**
 * A content type as the agent may see it: type/subtype from the usual ones, without parameters;
 * another subtype of a known type as type/other; anything else null.
 */
export function siteMime(mime: string | null): string | null {
  if (mime === null) return null
  const [type = '', subtype = ''] = (mime.split(';')[0] ?? '').trim().toLowerCase().split('/')
  if (!MIME_TYPES.has(type)) return null
  return `${type}/${MIME_SUBTYPES.has(subtype) ? subtype : 'other'}`
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** A request method: a standard one, else "OTHER" (a page's script may make up its own). */
export function siteMethod(method: string): string {
  const upper = method.toUpperCase()
  return METHODS.has(upper) ? upper : 'OTHER'
}
