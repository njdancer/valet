// The authoring tools' MCP side (docs/authoring-tools.md): who gets them, the capability gates,
// refusals in words, and the last scan. The app's side is apps/desktop/test/main/drafts.test.ts.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { ADMIN_LOCKED_DOWN_RESULT, ADMIN_WITHHELD_RESULT, type AdminReader } from '../src/admin-tools'
import type { ClientIdentity } from '../src/auth'
import {
  AUTHORING_TOOL_NAMES,
  AUTHORING_TOOLS,
  type Authoring,
  AuthoringRefusal,
  type DraftDetail,
  runAuthoringTool,
} from '../src/authoring-tools'
import { createMcpServer } from '../src/server'
import { FakeCaller } from './fake-caller'

const LOCAL: ClientIdentity = { origin: 'local', clientId: 'c1' }
const DRAFT = 'dr-abcdefghij'

const DETAIL: DraftDetail = {
  draft: {
    draftId: DRAFT,
    adapterId: 'shop',
    status: 'editing',
    createdBy: 'Claude Code',
    updatedAt: '2026-11-12T01:00:00.000Z',
    lastCheck: null,
    basedOn: null,
    repairId: null,
    files: [],
    submission: null,
  },
}

const VIEW = {
  url: { fromSite: 'https://finance.example.com/' },
  title: { fromSite: 'Quotes' },
  nodes: [],
  cut: false,
}

function reader(overrides: Partial<AdminReader> = {}): AdminReader {
  return {
    access: () => ({ seeValet: true, allActivity: false, askForChanges: true, name: 'Claude Code' }),
    lockedDown: () => false,
    sensitive: () => false,
    status: async () => {
      throw new Error('unused')
    },
    adapters: async () => ({ adapters: [] }),
    adapter: async () => ({ adapter: null }),
    health: async () => ({ sites: [] }),
    needsYou: async () => ({ items: [] }),
    calls: async () => ({ calls: [] }),
    call: async () => ({ call: null, matches: [] }) as never,
    audit: async () => ({ records: [], total: 0, nextBeforeSeq: null, chain: null }) as never,
    ...overrides,
  }
}

function authoring(overrides: Partial<Authoring> = {}): Authoring & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    createDraft: async () => DETAIL,
    listDrafts: async () => ({ drafts: [DETAIL.draft] }),
    listRepairs: async () => ({ repairs: [] }),
    getRepair: async () => {
      throw new AuthoringRefusal('No repair ticket has that id.')
    },
    getDraft: async () => DETAIL,
    readFile: async (_v, _a, _d, path) => ({ path, content: 'export const tools = {}' }),
    writeFile: async (_v, _d, path, content) => {
      writes.push(path)
      return { path, bytes: content.length, draftStatus: 'editing' }
    },
    deleteFile: async (_v, _d, path) => ({ path, removed: true }),
    check: async () => ({
      ok: true,
      packageHash: null,
      adapterHash: null,
      steps: [],
      findings: [],
      cases: [],
      changes: [],
    }),
    diff: async () => ({ against: 'nothing', changes: [], files: [] }),
    submit: async () => ({
      ref: '7B3F',
      requestId: 'r'.repeat(22),
      expiresAt: '2026-11-13T00:00:00.000Z',
      adapterHash: 'a'.repeat(64),
      tellThePerson: 'Waiting for the person in Valet.',
    }),
    deleteDraft: async () => ({ draftId: DRAFT, deleted: true }),
    browserOpen: async () => VIEW,
    browserClick: async () => VIEW,
    browserType: async () => VIEW,
    browserSnapshot: async () => VIEW,
    browserQuery: async () => ({ count: 0, matches: [] }),
    networkLog: async () => ({ entries: [] }),
    networkBody: async () => ({
      seq: 1,
      url: { fromSite: 'https://x.test/' },
      mimeType: null,
      fromSite: null,
      truncated: false,
    }),
    captureFixture: async (_v, _d, _s, path) => ({ path, bytes: 1, recordedByValet: true }),
    liveTrial: async (_v, _d, tool) => ({
      tool,
      packageHash: 'a'.repeat(64),
      ok: true,
      output: { fromSite: { price: 1 } },
      problem: null,
      blocked: [],
      ms: 5,
    }),
    ...overrides,
  }
}

function tool(name: string) {
  const found = AUTHORING_TOOLS.find((t) => t.name === name)
  if (found === undefined) throw new Error(name)
  return found
}

function text(result: CallToolResult): string {
  const [first] = result.content
  return first?.type === 'text' ? first.text : ''
}

describe('authoring tools', () => {
  it('are all under valet_ and none of them approves or installs', () => {
    for (const name of AUTHORING_TOOL_NAMES) expect(name.startsWith('valet_')).toBe(true)
    expect([...AUTHORING_TOOL_NAMES].some((n) => /approve|install|grant|enable/.test(n))).toBe(false)
  })

  it('needs Ask for changes to change anything, but only See Valet to read', async () => {
    const r = reader({
      access: () => ({ seeValet: true, allActivity: false, askForChanges: false, name: 'Claude Desktop' }),
    })
    const a = authoring()
    const write = await runAuthoringTool(
      tool('valet_write_draft_file'),
      r,
      a,
      { draftId: DRAFT, path: 'README.md', content: 'x' },
      LOCAL,
    )
    expect(write.isError).toBe(true)
    expect(text(write)).toBe(
      "Claude Desktop isn't allowed to ask for changes. The person can allow it in Valet, Connections, Claude Desktop.",
    )
    expect(a.writes).toEqual([])
    const read = await runAuthoringTool(tool('valet_get_draft'), r, a, { draftId: DRAFT }, LOCAL)
    expect(read.isError).toBeUndefined()
  })

  it('tries a read tool live only with Ask for changes, and hands the output back as the site’s', async () => {
    const off = reader({
      access: () => ({ seeValet: true, allActivity: false, askForChanges: false, name: 'Claude Desktop' }),
    })
    const args = { draftId: DRAFT, tool: 'get_quote', input: { symbol: 'AAPL' } }
    expect((await runAuthoringTool(tool('valet_live_trial'), off, authoring(), args, LOCAL)).isError).toBe(
      true,
    )
    const on = await runAuthoringTool(tool('valet_live_trial'), reader(), authoring(), args, LOCAL)
    expect(JSON.parse(text(on))).toMatchObject({
      tool: 'get_quote',
      ok: true,
      output: { fromSite: { price: 1 } },
    })
    expect(tool('valet_live_trial').input.parse({ draftId: DRAFT, tool: 'get_quote' })).toMatchObject({
      input: {},
    })
  })

  it('treats a missing Ask for changes as off', async () => {
    const r = reader({ access: () => ({ seeValet: true, allActivity: false, name: 'Old' }) })
    const result = await runAuthoringTool(
      tool('valet_submit_draft'),
      r,
      authoring(),
      { draftId: DRAFT },
      LOCAL,
    )
    expect(text(result)).toMatch(/isn't allowed to ask for changes/)
  })

  it('refuses everything while locked down', async () => {
    const result = await runAuthoringTool(
      tool('valet_list_drafts'),
      reader({ lockedDown: () => true }),
      authoring(),
      {},
      LOCAL,
    )
    expect(text(result)).toBe(ADMIN_LOCKED_DOWN_RESULT)
  })

  it('passes the app’s refusals on in words, and hides anything else it throws', async () => {
    const refusing = authoring({
      submit: async () => {
        throw new AuthoringRefusal('Not submitted: 2 of 14 cases fail.')
      },
      check: async () => {
        throw new Error('/Users/nick/secret path')
      },
    })
    const submit = await runAuthoringTool(
      tool('valet_submit_draft'),
      reader(),
      refusing,
      { draftId: DRAFT },
      LOCAL,
    )
    expect(text(submit)).toBe('Not submitted: 2 of 14 cases fail.')
    const check = await runAuthoringTool(
      tool('valet_check_draft'),
      reader(),
      refusing,
      { draftId: DRAFT },
      LOCAL,
    )
    expect(text(check)).not.toMatch(/nick/)
  })

  it('withholds a file that holds a secret the app knows of', async () => {
    const r = reader({ sensitive: (texts) => texts.some((t) => t.includes('hunter2-session')) })
    const a = authoring({
      readFile: async (_v, _a, _d, path) => ({ path, content: 'cookie=hunter2-session' }),
    })
    const result = await runAuthoringTool(
      tool('valet_read_draft_file'),
      r,
      a,
      { draftId: DRAFT, path: 'fixtures/x.json' },
      LOCAL,
    )
    expect(text(result)).toBe(ADMIN_WITHHELD_RESULT)
  })

  it('are listed for a local client only, and only when the app gives both ports', async () => {
    const list = async (identity: ClientIdentity | undefined, withAuthoring: boolean) => {
      const endpoint = createMcpServer(
        new FakeCaller([]),
        { name: 'valet', version: '0.1.0' },
        {
          admin: reader(),
          ...(withAuthoring ? { authoring: authoring() } : {}),
          ...(identity === undefined ? {} : { identity }),
        },
      )
      const [a, b] = InMemoryTransport.createLinkedPair()
      await endpoint.server.connect(b)
      const client = new Client({ name: 't', version: '1' })
      await client.connect(a)
      const names = (await client.listTools()).tools.map((t) => t.name)
      await client.close()
      await endpoint.server.close()
      return names.filter((n) => AUTHORING_TOOL_NAMES.has(n))
    }
    expect(await list(LOCAL, true)).toHaveLength(AUTHORING_TOOLS.length)
    expect(await list(LOCAL, false)).toEqual([])
    expect(await list({ origin: 'remote', clientId: 'r1' }, true)).toEqual([])
    expect(await list(undefined, true)).toEqual([])
  })
})
