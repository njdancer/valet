// Hash routes for the control panel, without React: the main process checks every route it is asked
// to open against parseRoute too (app.openControlPanel), so this module must stay importable from
// plain Node. router.ts re-exports it with the hook.

import type { HashRoute } from '../../shared/api'

/** First-run setup's steps, in order (AC2, AC3). */
export const SETUP_STEPS = ['welcome', 'onepassword', 'approve', 'grant', 'store', 'clients'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

function isSetupStep(value: string): value is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(value)
}

export type Route =
  | { readonly page: 'adapters' }
  | { readonly page: 'adapter'; readonly adapterId: string }
  | { readonly page: 'review'; readonly adapterId: string }
  | { readonly page: 'grant'; readonly adapterId: string; readonly secret: string }
  | { readonly page: 'activity'; readonly callId: string | null }
  | { readonly page: 'audit' }
  | { readonly page: 'credentials' }
  | { readonly page: 'clients' }
  | { readonly page: 'settings' }
  /** Remote sign-in: consent requests and remote clients. */
  | { readonly page: 'remote' }
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

function decode(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment)
    return value.length > 0 && value.length <= 200 ? value : null
  } catch {
    return null
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '')
  const raw = path.split('/').filter((s) => s.length > 0)
  const parts = raw.map(decode)
  if (parts.some((p) => p === null)) return { page: 'not-found' }
  const [head, a, b, c] = parts as string[]
  switch (head) {
    case undefined:
    case 'adapters':
      if (a === undefined) return { page: 'adapters' }
      if (b === undefined) return { page: 'adapter', adapterId: a }
      if (b === 'review' && c === undefined) return { page: 'review', adapterId: a }
      if (b === 'grant' && c !== undefined && parts.length === 4)
        return { page: 'grant', adapterId: a, secret: c }
      return { page: 'not-found' }
    case 'activity':
      if (b !== undefined) return { page: 'not-found' }
      return { page: 'activity', callId: a ?? null }
    case 'audit':
    case 'credentials':
    case 'clients':
    case 'settings':
    case 'remote':
      return a === undefined ? { page: head } : { page: 'not-found' }
    case 'confirm':
      return a !== undefined && b === undefined
        ? { page: 'confirm', confirmationId: a }
        : { page: 'not-found' }
    case 'needs-user':
      return a !== undefined && b === undefined ? { page: 'needs-user', adapterId: a } : { page: 'not-found' }
    case 'setup':
      return setupRoute(a, b, parts.length)
    default:
      return { page: 'not-found' }
  }
}

function setupRoute(step: string | undefined, sub: string | undefined, length: number): Route {
  const at = (s: SetupStep | null, review = false, secret: string | null = null): Route => ({
    page: 'setup',
    step: s,
    review,
    secret,
  })
  if (step === undefined) return at(null)
  if (!isSetupStep(step) || length > 3) return { page: 'not-found' }
  if (sub === undefined) return at(step)
  if (step === 'approve' && sub === 'review') return at(step, true)
  if (step === 'grant') return at(step, false, sub)
  return { page: 'not-found' }
}

const enc = encodeURIComponent

/** Builders for every route. Each returns a HashRoute, the only kind app.openControlPanel takes. */
export const href = {
  adapters: (): HashRoute => '#/adapters',
  adapter: (id: string): HashRoute => `#/adapters/${enc(id)}`,
  review: (id: string): HashRoute => `#/adapters/${enc(id)}/review`,
  grant: (id: string, secret: string): HashRoute => `#/adapters/${enc(id)}/grant/${enc(secret)}`,
  activity: (callId?: string): HashRoute =>
    callId === undefined ? '#/activity' : `#/activity/${enc(callId)}`,
  audit: (): HashRoute => '#/audit',
  credentials: (): HashRoute => '#/credentials',
  clients: (): HashRoute => '#/clients',
  settings: (): HashRoute => '#/settings',
  remote: (): HashRoute => '#/remote',
  confirm: (id: string): HashRoute => `#/confirm/${enc(id)}`,
  needsUser: (adapterId: string): HashRoute => `#/needs-user/${enc(adapterId)}`,
  setup: (step?: SetupStep): HashRoute => (step === undefined ? '#/setup' : `#/setup/${step}`),
  setupReview: (): HashRoute => '#/setup/approve/review',
  setupGrant: (secret: string): HashRoute => `#/setup/grant/${enc(secret)}`,
}
