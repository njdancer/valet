// The hub's host (relay-hub.md): its pages and JSON API, behind the same per-source limits as the
// rest of the relay. Device sockets on this host still go to the relay's own front door.

import { type RateLimiter, sourceKey } from '../front'

const SIGN_IN = new Set([
  '/api/sign-in/options',
  '/api/sign-in/verify',
  '/api/sign-in/app',
  '/api/sign-up/options',
  // Agents signing in (oauth.ts): anyone can reach these, so they share the sign-in limit.
  '/register',
  '/authorize',
  '/token',
  // Phones on the account (hub-phone.ts): a challenge each time the app opens.
  '/phone/challenge',
])
const MAX_BODY = 64 * 1024

export interface HubDoor {
  readonly hub: () => { fetch(request: Request): Promise<Response> }
  readonly limits: { readonly forward: RateLimiter; readonly signIn: RateLimiter }
}

export async function hubFront(request: Request, door: HubDoor): Promise<Response> {
  const url = new URL(request.url)
  const source = sourceKey(request.headers.get('cf-connecting-ip') ?? '')
  if (request.method !== 'GET' && request.method !== 'POST')
    return new Response('Not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search.length > 2048) return new Response('Too long', { status: 414 })
  if (!(await allowed(door.limits.forward, `hub:${source}`))) return tooMany()
  if (SIGN_IN.has(url.pathname) && !(await allowed(door.limits.signIn, `hub-sign-in:${source}`)))
    return tooMany()
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY)
    return Response.json({ error: 'too_large' }, { status: 413 })
  return door.hub().fetch(request)
}

async function allowed(limiter: RateLimiter, key: string): Promise<boolean> {
  try {
    return (await limiter.limit({ key })).success
  } catch {
    return false
  }
}

function tooMany(): Response {
  return Response.json(
    { error: 'too_many', message: 'Too many requests. Wait a minute.' },
    { status: 429, headers: { 'retry-after': '60' } },
  )
}
