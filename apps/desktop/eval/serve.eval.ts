// The authoring evals (docs/authoring-tools.md#evals): the built app, held open for a model to
// drive. Not part of any suite; run it by hand (eval/README.md):
//
//   npx electron-vite build --mode demo
//   xvfb-run -a npx playwright test -c eval/playwright.config.ts --trace off
//
// It launches the demo build on a fresh userData, adds an MCP client for the agent and opens two
// loopback doors:
//
// - the agent's (EVAL_AGENT_PORT, default 47110): POST /list and POST /call {name, arguments}, a
//   real MCP client over Streamable HTTP to the app's endpoint. eval/agent.mjs is its command line.
//   The agent under test gets this and nothing else.
// - the person's (EVAL_PERSON_PORT, default 47111), with a bearer token from the state file: what
//   the person sees and does on the Mac and the phone. GET /pending, POST /approve and /decline
//   {requestId} or {adapterId, hash}, GET /adapters, GET /repairs, POST /screenshot {path}, and POST
//   /stop.
//
// The state file (EVAL_STATE, default out/eval/state.json) has both ports and the person's token.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Page, test } from '@playwright/test'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import {
  appDir,
  approveInKeyhold,
  CONTROL,
  callToolOnce,
  connectFakeOnePassword,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  tempDir,
  windowWithTitle,
} from '../e2e/harness'
import { LIBRARY_HOST, startLibrarySite } from './library-site'

const AGENT_PORT = Number(process.env['EVAL_AGENT_PORT'] ?? 47110)
const PERSON_PORT = Number(process.env['EVAL_PERSON_PORT'] ?? 47111)
const STATE = process.env['EVAL_STATE'] ?? join(appDir, 'out/eval/state.json')

type Handler = (body: Record<string, unknown>, url: URL) => Promise<unknown>

function door(port: number, token: string | null, routes: Record<string, Handler>): Promise<Server> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      }
      if (token !== null && request.headers.authorization !== `Bearer ${token}`) {
        reply(401, { error: 'unauthorized' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const route = routes[`${request.method} ${url.pathname}`]
      if (route === undefined) {
        reply(404, { error: 'no such route', routes: Object.keys(routes) })
        return
      }
      let body: Record<string, unknown> = {}
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text !== '') body = JSON.parse(text) as Record<string, unknown>
      } catch {
        reply(400, { error: 'body is not JSON' })
        return
      }
      route(body, url).then(
        (value) => reply(200, value),
        (error: unknown) => reply(500, { error: error instanceof Error ? error.message : String(error) }),
      )
    })
  })
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => done(server))
  })
}

interface E2eRequests {
  list(): readonly { requestId: string; kind: string; text: string }[]
  approve(requestId: string): Promise<boolean>
  decline(requestId: string): Promise<boolean>
}

test('hold the app open for an eval', async () => {
  test.setTimeout(0)
  const userData = tempDir('eval')
  // The library: its certificate trusted for this user's Chromium (NSS) while the eval runs.
  const tls = await generateTestCertificate([LIBRARY_HOST])
  const library = await startLibrarySite(tls)
  const certFile = join(userData, 'library-cert.pem')
  writeFileSync(certFile, tls.cert)
  const nss = `sql:${join(homedir(), '.pki/nssdb')}`
  const NICK = 'valet-eval-library'
  try {
    execFileSync('certutil', ['-D', '-n', NICK, '-d', nss], { stdio: 'ignore' })
  } catch {
    // Not there from an earlier run.
  }
  execFileSync('certutil', ['-A', '-n', NICK, '-t', 'P,,', '-i', certFile, '-d', nss])
  const proxy = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? ''
  const launched: Launched = await launch(userData, appDir, {
    env: {
      VALET_E2E_SITES: `${LIBRARY_HOST}=127.0.0.1:${library.port}`,
      ...(proxy === '' ? {} : { VALET_E2E_UPSTREAM_PROXY: proxy }),
    },
  })
  const control: Page = await windowWithTitle(launched.app, CONTROL)
  await connectFakeOnePassword(launched, control)
  const client: McpClient = await connectMcp(control, userData, 'Eval agent')
  const token = randomBytes(24).toString('base64url')
  const calls: { at: string; name: string; isError: boolean }[] = []
  let stop: () => void = () => undefined
  const stopped = new Promise<void>((done) => {
    stop = done
  })
  const requests = () =>
    launched.app.evaluate(() => {
      const hook = (globalThis as unknown as { __valetE2eRequests: E2eRequests }).__valetE2eRequests
      return hook.list().map((r) => ({ ...r }))
    })

  const agent = await door(AGENT_PORT, null, {
    'POST /list': async () => (await client.listTools()).tools,
    'POST /call': async (body) => {
      const name = String(body['name'] ?? '')
      const args = (body['arguments'] ?? {}) as Record<string, unknown>
      const result = await callToolOnce(client, name, args, 300_000)
      calls.push({ at: new Date().toISOString(), name, isError: result.isError })
      return { isError: result.isError, text: result.text, structured: result.structured }
    },
  })
  const person = await door(PERSON_PORT, token, {
    'GET /pending': async () => ({
      reviews: await control.evaluate(() => window.valet?.approvals.pending()),
      requests: await requests(),
    }),
    'POST /approve': async (body) => {
      if (typeof body['requestId'] === 'string') {
        const id = body['requestId']
        return launched.app.evaluate(
          (_electron, requestId) =>
            (globalThis as unknown as { __valetE2eRequests: E2eRequests }).__valetE2eRequests.approve(
              requestId,
            ),
          id,
        )
      }
      const pair = [String(body['adapterId']), String(body['hash'])] as const
      await control.evaluate(([a, h]) => window.valet?.approvals.approve(a, h), pair)
      return true
    },
    'POST /decline': async (body) => {
      if (typeof body['requestId'] === 'string') {
        const id = body['requestId']
        return launched.app.evaluate(
          (_electron, requestId) =>
            (globalThis as unknown as { __valetE2eRequests: E2eRequests }).__valetE2eRequests.decline(
              requestId,
            ),
          id,
        )
      }
      const pair = [String(body['adapterId']), String(body['hash'])] as const
      await control.evaluate(([a, h]) => window.valet?.approvals.reject(a, h), pair)
      return true
    },
    'GET /adapters': async () => control.evaluate(() => window.valet?.adapters.list()),
    'GET /calls': async () => calls,
    'GET /logs': async () => launched.logs.join('').slice(-200_000),
    'POST /hash': async (body) => {
      await control.evaluate(
        (hash) => {
          window.location.hash = hash
        },
        String(body['hash'] ?? '#/'),
      )
      return true
    },
    'POST /screenshot': async (body) => {
      const path = String(body['path'])
      mkdirSync(dirname(path), { recursive: true })
      await control.screenshot({ path })
      return path
    },
    // A grant of a fake 1Password item to an installed adapter, approved in the fake 1Password.
    'POST /grant': async (body) => {
      const request = {
        adapterId: String(body['adapterId']),
        adapterHash: String(body['adapterHash']),
        secret: String(body['secret']),
        provider: String(body['provider'] ?? 'keychain-copy'),
        itemRef: String(body['itemRef']),
        origins: (body['origins'] ?? []) as string[],
      }
      const made = control.evaluate(
        (r) =>
          window.valet?.grants.make(r as Parameters<NonNullable<typeof window.valet>['grants']['make']>[0]),
        request,
      )
      if (request.provider === 'keychain-copy') await approveInKeyhold(launched)
      await made
      return true
    },
    'GET /vault-items': async () => control.evaluate(() => window.valet?.grants.vaultItems('keychain-copy')),
    'GET /grants': async () => control.evaluate(() => window.valet?.grants.list()),
    'POST /site/redesign': async (body) => {
      library.redesign(body['on'] === true)
      return true
    },
    'GET /site/requests': async () => library.requests,
    'POST /stop': async () => {
      stop()
      return true
    },
  })

  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(
    STATE,
    `${JSON.stringify({ agentPort: AGENT_PORT, personPort: PERSON_PORT, personToken: token, userData }, null, 2)}\n`,
    { mode: 0o600 },
  )
  console.log(`eval: agent door on ${AGENT_PORT}, person door on ${PERSON_PORT}, state in ${STATE}`)
  await stopped
  agent.close()
  person.close()
  await client.close().catch(() => undefined)
  await launched.close()
  await library.close()
  execFileSync('certutil', ['-D', '-n', NICK, '-d', nss], { stdio: 'ignore' })
  rmSync(userData, { recursive: true, force: true })
})
