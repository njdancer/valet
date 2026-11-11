// The fake desktop app's windows, served on loopback: the main window (locked, or the account's
// vaults and items, with Settings > Developer and its "Integrate with other apps" switch) and the
// prompt an integration raises (unlock first if locked, then allow or deny). Demo mode shows these
// in windows of their own; the page's script talks to the JSON routes below, which act on the same
// FakeOnePassword the fake SDK and CLI use.
//
// The look is the fake's own ("Keyhold"), not 1Password's. No field value is ever sent to a page.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appPage } from './app-page'
import type { FakeOnePassword } from './state'

export interface KeyholdApp {
  /** The main window's URL. */
  readonly url: string
  readonly port: number
  /** The page for one prompt. */
  promptUrl(id: string): string
  close(): Promise<void>
}

export interface KeyholdAppOptions {
  readonly port?: number
}

export async function startKeyholdApp(
  fake: FakeOnePassword,
  options: KeyholdAppOptions = {},
): Promise<KeyholdApp> {
  const server = createServer((request, response) => {
    handle(fake, request, response).catch(() => send(response, 500, { error: 'internal' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}/`
  return {
    url,
    port,
    promptUrl: (id) => `${url}prompt/${encodeURIComponent(id)}`,
    close: () => closeServer(server),
  }
}

/** What a page may know: no password, no code, no secret. */
export function publicState(fake: FakeOnePassword) {
  return {
    brand: 'Keyhold',
    locked: fake.locked,
    integrationEnabled: fake.integrationEnabled,
    account: fake.locked
      ? { name: fake.account.name }
      : { name: fake.account.name, email: fake.account.email, uuid: fake.account.uuid },
    vaults: fake.locked
      ? []
      : fake.vaults.map((vault) => ({
          id: vault.id,
          title: vault.title,
          items: fake.items
            .filter((i) => i.vaultId === vault.id && !i.archived)
            .map((i) => ({
              id: i.id,
              title: i.title,
              username: i.username ?? null,
              websites: [...i.websites],
              hasPassword: i.password !== undefined,
              hasOneTimePassword: i.totpSecret !== undefined,
              updatedAt: i.updatedAt.toISOString(),
            })),
        })),
    approvals: ['valet', 'op'].filter((integration) => fake.approved(integration)),
    prompts: fake.prompts.map((p) => ({
      id: p.id,
      kind: p.kind,
      integration: p.integration,
      integrationVersion: p.integrationVersion,
      account: p.account,
      state: p.state,
    })),
  }
}

async function handle(
  fake: FakeOnePassword,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  if (request.method === 'GET') {
    if (path === '/' || path === '/settings' || /^\/prompt\/[A-Za-z0-9-]+$/.test(path)) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      })
      response.end(appPage())
      return
    }
    if (path === '/api/state') return send(response, 200, publicState(fake))
    return send(response, 404, { error: 'not-found' })
  }
  if (request.method !== 'POST') return send(response, 405, { error: 'method' })
  // JSON only, so another origin's page can't post here without a preflight this server never answers.
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    return send(response, 415, { error: 'json-only' })
  }
  const body = await readJson(request)
  if (path === '/api/unlock') {
    const password = typeof body?.['password'] === 'string' ? body['password'] : ''
    return send(response, 200, { ok: fake.unlock(password) })
  }
  if (path === '/api/lock') {
    fake.lock()
    return send(response, 200, { ok: true })
  }
  if (path === '/api/integration') {
    fake.setIntegration(body?.['enabled'] === true)
    return send(response, 200, { ok: true })
  }
  const prompt = /^\/api\/prompts\/([A-Za-z0-9-]+)\/(allow|deny)$/.exec(path)
  if (prompt !== null) {
    const [, id, decision] = prompt as unknown as [string, string, string]
    return send(response, 200, { ok: decision === 'allow' ? fake.allow(id) : fake.deny(id) })
  }
  return send(response, 404, { error: 'not-found' })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 16 * 1024) return null
    chunks.push(chunk as Buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
