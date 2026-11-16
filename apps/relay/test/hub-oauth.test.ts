// The hub's OAuth server (hub/oauth.ts) in Node, on node:sqlite: what it refuses, which the
// end-to-end test in hub.test.ts doesn't walk through one by one.

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CONSENT_COOKIE, type Db, HubOAuth, OAUTH_CAPS, OAUTH_TIMINGS } from '../src/hub/oauth'

const ORIGIN = 'https://valet.example'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const VERIFIER = 'v'.repeat(50)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

function setup() {
  const sqlite = new DatabaseSync(':memory:')
  const db: Db = {
    all: <T>(q: string, ...b: unknown[]) => sqlite.prepare(q).all(...(b as never[])) as T[],
    one: <T>(q: string, ...b: unknown[]) =>
      (sqlite.prepare(q).get(...(b as never[])) as T | undefined) ?? null,
    run: (q: string, ...b: unknown[]) => {
      if (b.length === 0) sqlite.exec(q)
      else sqlite.prepare(q).run(...(b as never[]))
    },
  }
  let now = Date.parse('2026-11-16T00:00:00.000Z')
  const oauth = new HubOAuth(
    db,
    () => ORIGIN,
    () => now,
  )
  oauth.migrate()
  const call = (path: string, init: RequestInit = {}) => {
    const url = new URL(path, ORIGIN)
    return oauth.fetch(new Request(url, init), url, '203.0.113.9')
  }
  const register = async (body: unknown) =>
    call('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const client = async () =>
    ((await (await register({ redirect_uris: [REDIRECT] })).json()) as { client_id: string }).client_id
  const authorize = (params: Record<string, string>) =>
    call(
      `/authorize?${new URLSearchParams({
        response_type: 'code',
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        ...params,
      })}`,
    )
  const token = (form: Record<string, string>, type = 'application/x-www-form-urlencoded') =>
    call('/token', {
      method: 'POST',
      headers: { 'content-type': type },
      body: new URLSearchParams(form).toString(),
    })
  return { oauth, call, register, client, authorize, token, tick: (ms: number) => (now += ms) }
}

/** Opens a consent and returns its id and the browser's cookie. */
async function open(t: ReturnType<typeof setup>, clientId: string) {
  const page = await t.authorize({ client_id: clientId, state: 's' })
  expect(page.status).toBe(200)
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] as string
  const consent = t.oauth.openConsents()[0]
  if (consent === undefined) throw new Error('no consent')
  return { id: consent.id, cookie }
}

describe('the hub’s OAuth server', () => {
  it('registers only public clients with safe redirects, up to a cap', async () => {
    const t = setup()
    expect((await t.register({ redirect_uris: ['http://localhost:3000/cb'] })).status).toBe(201)
    expect((await t.register({ redirect_uris: ['http://evil.example/cb'] })).status).toBe(400)
    expect((await t.register({ redirect_uris: ['https://x.example/cb#frag'] })).status).toBe(400)
    expect((await t.register({ redirect_uris: ['not a url'] })).status).toBe(400)
    expect(
      (await t.register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }))
        .status,
    ).toBe(400)
    expect((await t.register({})).status).toBe(400)
    const named = (await (await t.register({ redirect_uris: [REDIRECT], client_name: '\u0000‮' })).json()) as {
      client_name: string
    }
    expect(named.client_name).toBe('claude.ai')
    for (let i = 2; i < OAUTH_CAPS.clients; i++) await t.register({ redirect_uris: [REDIRECT] })
    expect((await t.register({ redirect_uris: [REDIRECT] })).status).toBe(400)
  })

  it('refuses a bad authorisation request before or at the redirect', async () => {
    const t = setup()
    const id = await t.client()
    expect((await t.authorize({ client_id: 'hcnope0000000000' })).status).toBe(400)
    expect((await t.authorize({ client_id: id, redirect_uri: 'https://elsewhere.example/cb' })).status).toBe(
      400,
    )
    const error = async (params: Record<string, string>) =>
      new URL(
        (await t.authorize({ client_id: id, ...params })).headers.get('location') ?? '',
      ).searchParams.get('error')
    expect(await error({ response_type: 'token' })).toBe('unsupported_response_type')
    expect(await error({ code_challenge_method: 'plain' })).toBe('invalid_request')
    expect(await error({ resource: 'https://other.example/mcp' })).toBe('invalid_target')
    expect(await error({ state: 'x'.repeat(513) })).toBe('invalid_request')
    for (let i = 0; i < OAUTH_CAPS.openConsents; i++) await t.authorize({ client_id: id })
    expect((await t.authorize({ client_id: id })).status).toBe(429)
  })

  it('hands the code only to the browser that opened the consent, once it is approved', async () => {
    const t = setup()
    const id = await t.client()
    const consent = await open(t, id)
    expect(t.oauth.consent(consent.id)).toMatchObject({
      clientId: id,
      host: 'claude.ai',
      source: '203.0.113.9',
    })
    const status = async (cookie: string) =>
      (await (await t.call(`/authorize/status?id=${consent.id}`, { headers: { cookie } })).json()) as {
        state: string
      }
    expect(await status(consent.cookie)).toEqual({ state: 'pending' })
    expect(await status(`${CONSENT_COOKIE}=${'x'.repeat(43)}`)).toEqual({ state: 'gone' })
    expect(
      (await t.call(`/authorize/done?id=${consent.id}`, { headers: { cookie: consent.cookie } })).status,
    ).toBe(400)

    expect(t.oauth.approve(consent.id, 'g1')).toBe(true)
    expect(t.oauth.approve(consent.id, 'g2')).toBe(false)
    const done = await t.call(`/authorize/done?id=${consent.id}`, { headers: { cookie: consent.cookie } })
    const code = new URL(done.headers.get('location') ?? '').searchParams.get('code') ?? ''
    expect(code).not.toBe('')
    expect(await status(consent.cookie)).toEqual({ state: 'gone' })

    // The token endpoint's refusals.
    expect(
      (await t.token({ client_id: id, grant_type: 'authorization_code' }, 'application/json')).status,
    ).toBe(400)
    expect((await t.token({ client_id: 'hcnope0000000000', grant_type: 'authorization_code' })).status).toBe(
      401,
    )
    expect((await t.token({ client_id: id, grant_type: 'password' })).status).toBe(400)
    expect(
      (await t.token({ client_id: id, grant_type: 'refresh_token', resource: 'https://x.example/mcp' }))
        .status,
    ).toBe(400)
    const form = {
      client_id: id,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }
    expect((await t.token({ ...form, redirect_uri: 'https://claude.ai/other' })).status).toBe(400)
    const issued = (await (await t.token(form)).json()) as { access_token: string; refresh_token: string }

    // The access token, until it expires or its grant goes.
    const bearer = (value: string) =>
      new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${value}` } })
    expect(await t.oauth.authenticate(bearer(issued.access_token))).toEqual({ clientId: id, grantId: 'g1' })
    expect(await t.oauth.authenticate(bearer('x'.repeat(43)))).toBeNull()
    expect(await t.oauth.authenticate(new Request(`${ORIGIN}/mcp`))).toBeNull()
    t.tick(OAUTH_TIMINGS.accessMs + 1)
    expect(await t.oauth.authenticate(bearer(issued.access_token))).toBeNull()
    const again = (await (
      await t.token({ client_id: id, grant_type: 'refresh_token', refresh_token: issued.refresh_token })
    ).json()) as {
      access_token: string
    }
    expect(await t.oauth.authenticate(bearer(again.access_token))).not.toBeNull()
    t.oauth.revokeGrant('g1')
    expect(await t.oauth.authenticate(bearer(again.access_token))).toBeNull()

    const unauthorized = t.oauth.unauthorized()
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toContain(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    )
  })

  it('expires consents and codes, and answers metadata', async () => {
    const t = setup()
    const id = await t.client()
    const consent = await open(t, id)
    t.tick(OAUTH_TIMINGS.consentMs + 1)
    expect(t.oauth.openConsents()).toEqual([])
    expect(t.oauth.approve(consent.id, 'g')).toBe(false)
    expect(t.oauth.handles('/authorize')).toBe(true)
    expect(t.oauth.handles('/mcp')).toBe(false)
    expect((await t.call('/nothing')).status).toBe(404)
    expect(await (await t.call('/.well-known/oauth-protected-resource')).json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
    })
    expect(await (await t.call('/.well-known/oauth-authorization-server')).json()).toMatchObject({
      issuer: ORIGIN,
    })

    // A consent declined sends the browser back with access_denied.
    const declined = await open(t, id)
    t.oauth.decline(declined.id)
    const back = await t.call(`/authorize/done?id=${declined.id}`, { headers: { cookie: declined.cookie } })
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied')

    // A code past its minute is refused.
    const late = await open(t, id)
    t.oauth.approve(late.id, 'g')
    const done = await t.call(`/authorize/done?id=${late.id}`, { headers: { cookie: late.cookie } })
    const code = new URL(done.headers.get('location') ?? '').searchParams.get('code') ?? ''
    t.tick(OAUTH_TIMINGS.codeMs + 1)
    const form = {
      client_id: id,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }
    expect((await t.token(form)).status).toBe(400)
  })
})
