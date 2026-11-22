// Adds a Claude.ai-style connector to a Mac from outside, as far as it can go without a person:
// the MCP request Claude sends first, sign-in discovery, client registration, and the sign-in
// endpoints' answers to a client and code they don't know. Run from the public internet (a GitHub
// runner), never from the Mac. Exits non-zero on the first round that fails.
//
//   node connector-check.mjs <mac host> [rounds] [--register]
//
// Registration makes a real (ungranted) client on the Mac that expires within the hour, so it is
// opt-in; the rest leaves nothing behind and asks the person for nothing.

const [host, roundsArg, ...flags] = process.argv.slice(2)
if (!/^([0-9a-f]{32}|[0-9a-f]{24})\.valet\.dncr\.me$/.test(host ?? '')) {
  console.error('usage: connector-check.mjs <macid or alias>.valet.dncr.me [rounds] [--register]')
  process.exit(2)
}
const rounds = Number(roundsArg ?? 5)
const register = flags.includes('--register')
const base = `https://${host}`
const resource = `${base}/mcp`
// What claude.ai's backend sends (seen in the Mac's sign-in log).
const AGENT = 'python-httpx/0.28.1'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

const failures = []
const check = (round, step, ok, detail) => {
  const line = `${new Date().toISOString().slice(11, 19)} round ${round} ${ok ? 'ok  ' : 'FAIL'} ${step}${detail ? ` (${detail})` : ''}`
  console.log(line)
  if (!ok) failures.push(line)
  return ok
}

async function request(path, init = {}) {
  const started = Date.now()
  try {
    const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      ...init,
      headers: { 'user-agent': AGENT, ...(init.headers ?? {}) },
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, headers: res.headers, text, json, ms: Date.now() - started }
  } catch (error) {
    return {
      status: 0,
      headers: new Headers(),
      text: String(error?.cause?.code ?? error?.message ?? error),
      json: null,
      ms: Date.now() - started,
    }
  }
}

const describe = (r) => `${r.status} ${r.ms}ms${r.status === 0 ? ` ${r.text}` : ''}`

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude-ai', version: '0.1.0' },
  },
})

async function round(n) {
  // 1. Claude's first request: an MCP initialize with no token. Valet must ask for sign-in.
  const mcp = await request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: initialize,
  })
  const challenge = mcp.headers.get('www-authenticate') ?? ''
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  if (
    !check(
      n,
      'POST /mcp asks for sign-in',
      mcp.status === 401 && metadataUrl !== undefined,
      `${describe(mcp)} ${challenge.slice(0, 120)}`,
    )
  )
    return
  const get = await request('/mcp', { headers: { accept: 'text/event-stream' } })
  check(n, 'GET /mcp asks for sign-in', get.status === 401, describe(get))

  // 2. Discovery: protected resource, then the authorisation server's metadata.
  const prm = await request(metadataUrl)
  const issuer = prm.json?.authorization_servers?.[0]
  if (
    !check(
      n,
      'resource metadata',
      prm.status === 200 && prm.json?.resource === resource && typeof issuer === 'string',
      describe(prm),
    )
  )
    return
  const asUrl = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
  const as = await request(asUrl)
  const meta = as.json ?? {}
  if (
    !check(
      n,
      'authorisation server metadata',
      as.status === 200 &&
        typeof meta.registration_endpoint === 'string' &&
        typeof meta.authorization_endpoint === 'string' &&
        typeof meta.token_endpoint === 'string' &&
        (meta.code_challenge_methods_supported ?? []).includes('S256'),
      describe(as),
    )
  )
    return

  // 3. Registration, like Claude's (opt-in: it leaves a client behind for an hour).
  // Once a run: the Mac rate-limits these, and every caller through the relay shares one budget.
  if (n > 1) return
  if (register) {
    const reg = await request(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Valet connector check',
        redirect_uris: [CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    })
    check(
      n,
      'register a client',
      reg.status === 201 && typeof reg.json?.client_id === 'string',
      `${describe(reg)} ${reg.json?.error ?? ''}`,
    )
  }

  // 4. The sign-in endpoints answer (without asking the person): an unknown client, a bad code.
  const authorize = new URL(meta.authorization_endpoint)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'not-a-client',
    redirect_uri: CALLBACK,
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    state: 'check',
    resource,
  }).toString()
  const auth = await request(authorize.toString())
  check(n, 'authorize refuses an unknown client', auth.status === 400, describe(auth))
  const token = await request(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'not-a-code',
      redirect_uri: CALLBACK,
      client_id: 'not-a-client',
      client_secret: 'not-a-secret',
      code_verifier: 'x'.repeat(43),
      resource,
    }).toString(),
  })
  check(
    n,
    'token endpoint refuses a bad code',
    token.status === 400 || token.status === 401,
    `${describe(token)} ${token.json?.error ?? ''}`,
  )
}

for (let n = 1; n <= rounds; n++) {
  await round(n)
  if (n < rounds) await new Promise((r) => setTimeout(r, 2000))
}
console.log(
  failures.length === 0
    ? `PASS: ${rounds} rounds`
    : `FAILED: ${failures.length} checks\n${failures.join('\n')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
