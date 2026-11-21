// "My Cloudflare account" end to end (docs/cloudflare-tunnel.md): the built app, a stand-in
// Cloudflare API (zones, tunnels, DNS behind a token) and a stand-in cloudflared that does what the
// real one does for a request: takes the tunnel's configuration with its token and sends the name to
// the service it names, with the name as Host and the caller's address in Cf-Connecting-Ip.
//
//   1. The person pastes a token and a name on Remote access; Valet turns remote access on, makes
//      the tunnel and its DNS record, and cloudflared connects. A request for the name at the
//      stand-in edge reaches the Mac's remote listener and its OAuth metadata names that address.
//   2. A restart runs the tunnel again from the Keychain copy, with nothing asked.
//   3. Disconnecting removes the record and the tunnel, and the name stops reaching the Mac.

import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type FakeCloudflare, fakeCloudflare, TOKEN } from '../test/fixtures/fake-cloudflare'
import { appDir, CONTROL, type Launched, launch, tempDir, windowWithTitle } from './harness'

test.describe.configure({ mode: 'serial' })

const NAME = 'valet.example.test'

let cf: FakeCloudflare
let api: { readonly url: string; close(): Promise<void> }
let edgePort = 0
let userData: string
let cloudflared: string
let launched: Launched
let control: Page

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** The stand-in cloudflared, with the stand-in API and its edge port written in. */
function standIn(path: string): void {
  writeFileSync(
    path,
    `import { request, createServer } from 'node:http'
const token = process.env.TUNNEL_TOKEN ?? ''
const res = await fetch(${JSON.stringify(api.url)} + '/__edge/config?token=' + encodeURIComponent(token))
if (!res.ok) { process.stderr.write('ERR tunnel token refused\\n'); process.exit(1) }
const { ingress } = (await res.json()).result
const edge = createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]
  const rule = ingress.find((r) => r.hostname === undefined || r.hostname === host)
  if (rule === undefined || rule.service.startsWith('http_status:')) { res.writeHead(404); res.end(); return }
  const target = new URL(req.url ?? '/', rule.service)
  const out = request(target, { method: req.method, headers: { ...req.headers, host, 'cf-connecting-ip': '198.51.100.7' } }, (back) => {
    res.writeHead(back.statusCode ?? 502, back.headers)
    back.pipe(res)
  })
  out.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(out)
})
edge.listen(${edgePort}, '127.0.0.1', () => process.stderr.write('INF Registered tunnel connection connIndex=0\\n'))
// Like the real one under Valet: gone when Valet is.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 500)
process.on('SIGTERM', () => process.exit(0))
`,
  )
}

/** A request for the name at the stand-in edge, as a cloud agent's would arrive at Cloudflare. */
function atEdge(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: edgePort, path, headers: { host: NAME } }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function start(): Promise<void> {
  launched = await launch(userData, appDir, {
    env: { VALET_CLOUDFLARED: cloudflared, VALET_CLOUDFLARE_API: api.url },
  })
  control = await windowWithTitle(launched.app, CONTROL)
  await control.evaluate(() => {
    window.location.hash = '#/connections/remote'
  })
}

test.beforeAll(async () => {
  cf = fakeCloudflare('example.test')
  api = await cf.serve()
  edgePort = await freePort()
  userData = tempDir('cloudflare')
  cloudflared = join(userData, '..', `cloudflared-stand-in-${process.pid}.mjs`)
  standIn(cloudflared)
  await start()
})

test.afterAll(async () => {
  await launched?.close()
  await api?.close()
})

test('connects the person’s own Cloudflare account and serves the Mac at their name', async () => {
  const card = control.getByRole('region', { name: 'Your own Cloudflare account' })
  await expect(card.getByText(/Cloudflare can read what agents send this Mac/)).toBeVisible()
  await card.getByLabel('API token').fill('not the token')
  await card.getByRole('textbox', { name: 'Public name' }).fill(NAME)
  await card.getByRole('button', { name: 'Connect' }).click()
  await expect(card.getByText(/didn’t accept that token/)).toBeVisible()
  await card.getByLabel('API token').fill(TOKEN)
  await card.getByRole('button', { name: 'Connect' }).click()
  await expect(card.getByText(`https://${NAME}/mcp`)).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId('remote-cloudflare-state')).toHaveText('Connected to Cloudflare.', {
    timeout: 30_000,
  })
  await expect(control.getByTestId('remote-state')).toContainText('On.')

  // In the account: one tunnel sending only this name to the Mac's listener, one proxied record.
  const tunnels = [...cf.tunnels.values()].filter((t) => !t.deleted)
  expect(tunnels).toHaveLength(1)
  const setup = await control.evaluate(() => window.valet?.remote.setup())
  const origin = (setup?.url ?? '').replace(/\/mcp$/, '')
  expect(tunnels[0]?.config).toEqual({
    ingress: [{ hostname: NAME, service: origin, originRequest: {} }, { service: 'http_status:404' }],
  })
  expect([...cf.records.values()]).toEqual([
    expect.objectContaining({ name: NAME, type: 'CNAME', proxied: true }),
  ])

  // A request for the name reaches the Mac, which answers as that address.
  const metadata = await atEdge('/.well-known/oauth-protected-resource/mcp')
  expect(metadata.status).toBe(200)
  expect(JSON.parse(metadata.body).resource).toBe(`https://${NAME}/mcp`)
  // The token isn't in anything the page shows.
  expect(await control.locator('body').innerText()).not.toContain(TOKEN)
})

test('a restart runs the tunnel again from the kept copy, asking nothing', async () => {
  await launched.close()
  await start()
  const card = control.getByRole('region', { name: 'Your own Cloudflare account' })
  await expect(card.getByTestId('remote-cloudflare-state')).toHaveText('Connected to Cloudflare.', {
    timeout: 30_000,
  })
  await expect.poll(async () => (await atEdge('/.well-known/oauth-protected-resource/mcp')).status).toBe(200)
  expect([...cf.tunnels.values()].filter((t) => !t.deleted)).toHaveLength(1)
})

test('disconnecting removes the tunnel and record, and the name stops reaching the Mac', async () => {
  const card = control.getByRole('region', { name: 'Your own Cloudflare account' })
  await card.getByRole('button', { name: 'Disconnect…' }).click()
  await control.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(card.getByLabel('API token')).toBeVisible()
  // The card clears at once; the account is tidied just after.
  await expect.poll(() => cf.records.size).toBe(0)
  await expect.poll(() => [...cf.tunnels.values()].every((t) => t.deleted)).toBe(true)
  await expect
    .poll(() =>
      atEdge('/').then(
        () => 'answered',
        () => 'closed',
      ),
    )
    .toBe('closed')
  const setup = await control.evaluate(() => window.valet?.remote.setup())
  expect(setup?.hosts).toEqual([])
})
