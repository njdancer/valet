// Hash routes for the control panel, without React: the main process checks every route it is asked
// to open against parseRoute too (app.openControlPanel), so this module must stay importable from
// plain Node. router.ts re-exports it with the hook.
//
// The information architecture (docs/ux/information-architecture.md, section 3) has six places:
// Needs you, Sites, Activity (Calls and Audit log tabs), Connections, Secrets and Settings. The
// routes before it (#/adapters…, #/audit, #/clients, #/remote, #/credentials, #/activity/<id>) still
// parse, to the same pages, because notifications and tool results already printed may name them;
// the control panel then replaces the address with the canonical one (canonicalHref).

import type { HashRoute } from '../../shared/api'

/** First-run setup's steps, in order (AC2, AC3). */
export const SETUP_STEPS = ['welcome', 'onepassword', 'approve', 'grant', 'store', 'clients'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

function isSetupStep(value: string): value is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(value)
}

/** The draft store's id rule (drafts/store.ts). */
const DRAFT_ID = /^dr-[a-z2-7]{10}$/

export const SITE_TABS = ['overview', 'tools', 'permissions', 'versions'] as const
export type SiteTab = (typeof SITE_TABS)[number]

export const SETTINGS_SECTIONS = ['general', 'notifications', 'data', 'updates', 'reset'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const CALL_OUTCOMES = ['ok', 'failed', 'blocked', 'needs-you', 'declined', 'running'] as const
export type CallOutcomeFilter = (typeof CALL_OUTCOMES)[number]

/** Filters on the Calls tab; every one lives in the address so a link can name it. */
export interface CallFilters {
  readonly site: string | null
  readonly tool: string | null
  readonly client: string | null
  readonly outcome: CallOutcomeFilter | null
  /** A login, as `<site>/<secret>`: the calls that used it. */
  readonly login: string | null
}

export const AUDIT_CATEGORIES = [
  'tool-calls',
  'logins',
  'secret-use',
  'blocked',
  'confirmations',
  'approvals-grants',
] as const
export type AuditCategoryFilter = (typeof AUDIT_CATEGORIES)[number]

export interface AuditFilters {
  readonly category: AuditCategoryFilter | null
  readonly site: string | null
  /** A call id: the records of one call. */
  readonly call: string | null
}

export type Route =
  /** Needs you. `item` opens one waiting item (a notification's deep link). */
  | { readonly page: 'needs-you'; readonly item: string | null }
  | { readonly page: 'sites' }
  | { readonly page: 'site'; readonly adapterId: string; readonly tab: SiteTab }
  /** A draft adapter an agent is writing (wireframe `mac-draft-page`). */
  | { readonly page: 'draft'; readonly draftId: string }
  /** The full review page of a site's pending bundle (update or first install). */
  | { readonly page: 'review'; readonly adapterId: string }
  /** The grant sheet ("Give Valet your login") over the site's page. */
  | { readonly page: 'grant'; readonly adapterId: string; readonly secret: string }
  /** The store (setting) sheet over the site's page. */
  | { readonly page: 'setting'; readonly adapterId: string; readonly setting: string }
  | { readonly page: 'calls'; readonly callId: string | null; readonly filters: CallFilters }
  | { readonly page: 'audit'; readonly seq: number | null; readonly filters: AuditFilters }
  | { readonly page: 'connections' }
  | { readonly page: 'client'; readonly clientId: string }
  /** Remote access: on/off, public names, the tools cloud agents may call. */
  | { readonly page: 'remote' }
  /** The "Approve a connection" code sheet over Connections. */
  | { readonly page: 'approve-connection' }
  | { readonly page: 'secrets' }
  /** One login a site may use, and the calls that used it. */
  | { readonly page: 'login'; readonly adapterId: string; readonly secret: string }
  | { readonly page: 'settings'; readonly section: SettingsSection }
  | { readonly page: 'confirm'; readonly confirmationId: string }
  | { readonly page: 'needs-user'; readonly adapterId: string }
  /**
   * First-run setup. A null step resumes at the first one not done. On the approve step, `review`
   * shows the adapter's review over it; on the grant step, `secret` opens the grant sheet for it.
   */
  | {
      readonly page: 'setup'
      readonly step: SetupStep | null
      readonly review: boolean
      readonly secret: string | null
    }
  | { readonly page: 'not-found' }

export type Page = Route['page']

const NOT_FOUND: Route = { page: 'not-found' }
const MAX_SEGMENT = 200

function decode(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment)
    return value.length > 0 && value.length <= MAX_SEGMENT ? value : null
  } catch {
    return null
  }
}

function query(search: string): Map<string, string> | null {
  const out = new Map<string, string>()
  if (search.length === 0) return out
  for (const pair of search.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    const key = decode(eq === -1 ? pair : pair.slice(0, eq))
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1))
    if (key === null || value === null) return null
    out.set(key, value)
  }
  return out
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function callFilters(q: Map<string, string>): CallFilters {
  return {
    site: q.get('site') ?? null,
    tool: q.get('tool') ?? null,
    client: q.get('client') ?? null,
    outcome: pick(q.get('outcome'), CALL_OUTCOMES),
    login: q.get('login') ?? null,
  }
}

function auditFilters(q: Map<string, string>): AuditFilters {
  return {
    category: pick(q.get('category'), AUDIT_CATEGORIES),
    site: q.get('site') ?? null,
    call: q.get('call') ?? null,
  }
}

export const NO_CALL_FILTERS: CallFilters = {
  site: null,
  tool: null,
  client: null,
  outcome: null,
  login: null,
}
export const NO_AUDIT_FILTERS: AuditFilters = { category: null, site: null, call: null }

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const at = raw.indexOf('?')
  const path = at === -1 ? raw : raw.slice(0, at)
  const q = query(at === -1 ? '' : raw.slice(at + 1))
  if (q === null) return NOT_FOUND
  const parts = path
    .split('/')
    .filter((s) => s.length > 0)
    .map(decode)
  if (parts.some((p) => p === null)) return NOT_FOUND
  const segs = parts as string[]
  const [head, a, b, c] = segs
  const n = segs.length
  switch (head) {
    case undefined:
      return { page: 'needs-you', item: null }
    case 'needs-you':
      if (n === 1) return { page: 'needs-you', item: null }
      if (n === 2 && a !== undefined) return { page: 'needs-you', item: a }
      return NOT_FOUND
    case 'sites':
      return siteRoute(segs.slice(1))
    // Before the IA: #/adapters, #/adapters/<id>, #/adapters/<id>/review, #/adapters/<id>/grant/<s>.
    case 'adapters':
      if (n === 1) return { page: 'sites' }
      if (n === 2 && a !== undefined) return { page: 'site', adapterId: a, tab: 'overview' }
      if (n === 3 && a !== undefined && b === 'review') return { page: 'review', adapterId: a }
      if (n === 4 && a !== undefined && b === 'grant' && c !== undefined)
        return { page: 'grant', adapterId: a, secret: c }
      return NOT_FOUND
    case 'activity':
      if (n === 1) return { page: 'calls', callId: null, filters: callFilters(q) }
      if (a === 'calls') {
        if (n === 2) return { page: 'calls', callId: null, filters: callFilters(q) }
        if (n === 3 && b !== undefined) return { page: 'calls', callId: b, filters: callFilters(q) }
        return NOT_FOUND
      }
      if (a === 'audit') {
        if (n === 2) return { page: 'audit', seq: null, filters: auditFilters(q) }
        if (n === 3 && b !== undefined && /^\d{1,15}$/.test(b))
          return { page: 'audit', seq: Number(b), filters: auditFilters(q) }
        return NOT_FOUND
      }
      // Before the IA: #/activity/<callId>.
      if (n === 2 && a !== undefined) return { page: 'calls', callId: a, filters: NO_CALL_FILTERS }
      return NOT_FOUND
    case 'audit':
      return n === 1 ? { page: 'audit', seq: null, filters: NO_AUDIT_FILTERS } : NOT_FOUND
    case 'connections':
      if (n === 1) return { page: 'connections' }
      if (n === 2 && a === 'remote') return { page: 'remote' }
      if (n === 2 && a === 'approve') return { page: 'approve-connection' }
      if (n === 2 && a !== undefined) return { page: 'client', clientId: a }
      return NOT_FOUND
    case 'clients':
      return n === 1 ? { page: 'connections' } : NOT_FOUND
    case 'remote':
      return n === 1 ? { page: 'remote' } : NOT_FOUND
    case 'secrets':
      if (n === 1) return { page: 'secrets' }
      if (n === 3 && a !== undefined && b !== undefined) return { page: 'login', adapterId: a, secret: b }
      return NOT_FOUND
    case 'credentials':
      return n === 1 ? { page: 'secrets' } : NOT_FOUND
    case 'settings': {
      if (n === 1) return { page: 'settings', section: 'general' }
      const section = pick(a, SETTINGS_SECTIONS)
      return n === 2 && section !== null ? { page: 'settings', section } : NOT_FOUND
    }
    case 'confirm':
      return n === 2 && a !== undefined ? { page: 'confirm', confirmationId: a } : NOT_FOUND
    case 'needs-user':
      return n === 2 && a !== undefined ? { page: 'needs-user', adapterId: a } : NOT_FOUND
    case 'setup':
      return setupRoute(a, b, n)
    default:
      return NOT_FOUND
  }
}

function siteRoute(rest: readonly string[]): Route {
  const [id, tab, x] = rest
  if (id === undefined) return { page: 'sites' }
  // Draft ids start dr-, which no site tab does, so an adapter named "drafts" keeps its tabs.
  if (id === 'drafts' && rest.length === 2 && tab !== undefined && DRAFT_ID.test(tab))
    return { page: 'draft', draftId: tab }
  if (rest.length === 1) return { page: 'site', adapterId: id, tab: 'overview' }
  if (rest.length === 2) {
    const t = pick(tab, SITE_TABS)
    return t === null ? NOT_FOUND : { page: 'site', adapterId: id, tab: t }
  }
  if (rest.length === 3 && tab === 'versions' && x === 'review') return { page: 'review', adapterId: id }
  if (rest.length === 3 && tab === 'login' && x !== undefined)
    return { page: 'grant', adapterId: id, secret: x }
  if (rest.length === 3 && tab === 'store' && x !== undefined)
    return { page: 'setting', adapterId: id, setting: x }
  return NOT_FOUND
}

function setupRoute(step: string | undefined, sub: string | undefined, length: number): Route {
  const at = (s: SetupStep | null, review = false, secret: string | null = null): Route => ({
    page: 'setup',
    step: s,
    review,
    secret,
  })
  if (step === undefined) return at(null)
  if (!isSetupStep(step) || length > 3) return NOT_FOUND
  if (sub === undefined) return at(step)
  if (step === 'approve' && sub === 'review' && length === 3) return at(step, true)
  if (step === 'grant' && length === 3) return at(step, false, sub)
  return NOT_FOUND
}

const enc = encodeURIComponent

function withQuery(path: string, entries: readonly (readonly [string, string | number | null])[]): HashRoute {
  const qs = entries
    .filter((e): e is readonly [string, string | number] => e[1] !== null)
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&')
  return (qs.length === 0 ? path : `${path}?${qs}`) as HashRoute
}

/**
 * Routes shown only in a window of their own (the confirmation panel, the hand-off banner), never
 * in the control panel: there they would have no sidebar and no way back, and a confirmation
 * couldn't be approved, since only the panel opened for it may approve.
 */
export function panelOnlyRoute(hash: string): boolean {
  const page = parseRoute(hash).page
  return page === 'confirm' || page === 'needs-user'
}

/** Builders for every route. Each returns a HashRoute, the only kind app.openControlPanel takes. */
export const href = {
  needsYou: (item?: string): HashRoute => (item === undefined ? '#/needs-you' : `#/needs-you/${enc(item)}`),
  sites: (): HashRoute => '#/sites',
  site: (id: string, tab: SiteTab = 'overview'): HashRoute =>
    tab === 'overview' ? `#/sites/${enc(id)}` : `#/sites/${enc(id)}/${tab}`,
  review: (id: string): HashRoute => `#/sites/${enc(id)}/versions/review`,
  draft: (draftId: string): HashRoute => `#/sites/drafts/${enc(draftId)}`,
  grant: (id: string, secret: string): HashRoute => `#/sites/${enc(id)}/login/${enc(secret)}`,
  setting: (id: string, setting: string): HashRoute => `#/sites/${enc(id)}/store/${enc(setting)}`,
  calls: (filters: Partial<CallFilters> = {}): HashRoute =>
    withQuery('#/activity/calls', [
      ['site', filters.site ?? null],
      ['tool', filters.tool ?? null],
      ['client', filters.client ?? null],
      ['outcome', filters.outcome ?? null],
      ['login', filters.login ?? null],
    ]),
  call: (callId: string, filters: Partial<CallFilters> = {}): HashRoute =>
    withQuery(`#/activity/calls/${enc(callId)}`, [
      ['site', filters.site ?? null],
      ['tool', filters.tool ?? null],
      ['client', filters.client ?? null],
      ['outcome', filters.outcome ?? null],
      ['login', filters.login ?? null],
    ]),
  audit: (filters: Partial<AuditFilters> = {}, seq?: number): HashRoute =>
    withQuery(seq === undefined ? '#/activity/audit' : `#/activity/audit/${seq}`, [
      ['category', filters.category ?? null],
      ['site', filters.site ?? null],
      ['call', filters.call ?? null],
    ]),
  connections: (): HashRoute => '#/connections',
  client: (id: string): HashRoute => `#/connections/${enc(id)}`,
  remote: (): HashRoute => '#/connections/remote',
  approveConnection: (): HashRoute => '#/connections/approve',
  secrets: (): HashRoute => '#/secrets',
  login: (adapterId: string, secret: string): HashRoute => `#/secrets/${enc(adapterId)}/${enc(secret)}`,
  settings: (section: SettingsSection = 'general'): HashRoute =>
    section === 'general' ? '#/settings' : `#/settings/${section}`,
  confirm: (id: string): HashRoute => `#/confirm/${enc(id)}`,
  needsUser: (adapterId: string): HashRoute => `#/needs-user/${enc(adapterId)}`,
  setup: (step?: SetupStep): HashRoute => (step === undefined ? '#/setup' : `#/setup/${step}`),
  setupReview: (): HashRoute => '#/setup/approve/review',
  setupGrant: (secret: string): HashRoute => `#/setup/grant/${enc(secret)}`,
}

/** The one address for a route: what the control panel shows after following an old link. */
export function canonicalHref(route: Route): HashRoute | null {
  switch (route.page) {
    case 'needs-you':
      return href.needsYou(route.item ?? undefined)
    case 'sites':
      return href.sites()
    case 'site':
      return href.site(route.adapterId, route.tab)
    case 'review':
      return href.review(route.adapterId)
    case 'draft':
      return href.draft(route.draftId)
    case 'grant':
      return href.grant(route.adapterId, route.secret)
    case 'setting':
      return href.setting(route.adapterId, route.setting)
    case 'calls':
      return route.callId === null ? href.calls(route.filters) : href.call(route.callId, route.filters)
    case 'audit':
      return href.audit(route.filters, route.seq ?? undefined)
    case 'connections':
      return href.connections()
    case 'client':
      return href.client(route.clientId)
    case 'remote':
      return href.remote()
    case 'approve-connection':
      return href.approveConnection()
    case 'secrets':
      return href.secrets()
    case 'login':
      return href.login(route.adapterId, route.secret)
    case 'settings':
      return href.settings(route.section)
    default:
      return null
  }
}

/** The six places, for the sidebar, the Go menu and ⌘1–⌘6. */
export type Place = 'needs-you' | 'sites' | 'activity' | 'connections' | 'secrets' | 'settings'

export function placeOf(route: Route): Place | null {
  switch (route.page) {
    case 'needs-you':
      return 'needs-you'
    case 'sites':
    case 'site':
    case 'draft':
    case 'review':
    case 'grant':
    case 'setting':
      return 'sites'
    case 'calls':
    case 'audit':
      return 'activity'
    case 'connections':
    case 'client':
    case 'remote':
    case 'approve-connection':
      return 'connections'
    case 'secrets':
    case 'login':
      return 'secrets'
    case 'settings':
      return 'settings'
    default:
      return null
  }
}
