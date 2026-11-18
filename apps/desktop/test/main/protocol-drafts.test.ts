// @vitest-environment node
// Protocol drafts (docs/adapter-kinds.md#authoring): valet_create_draft's IMAP, SMTP and SFTP starters,
// the cases that script ctx.imap, ctx.smtp and ctx.sftp through the runtime's own guards, and what
// an agent can't do with them: fake a person's yes to a recipient off the list, send from a tool
// that isn't irreversible, write outside a root, or try one live with the person's credential.
// protocol-drafts.e2e.test.ts runs the same starters as installed, against fake servers.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore, buildRecord } from '@valet/adapter-store'
import { type AuditSink, parseManifest } from '@valet/core'
import { AUTHORING_GUIDE, AUTHORING_TOOLS, type ClientIdentity } from '@valet/mcp-server'
import type { SiteGuards } from '@valet/runtime'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { inProcessQuickJS, nodeQuickJS } from '@valet/sandbox'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type AuthoringDeps, DraftAuthoring } from '../../src/main/core/drafts/authoring'
import { PLACEHOLDER_HOST_KEY } from '../../src/main/core/drafts/checks'
import { DraftStore } from '../../src/main/core/drafts/store'
import { blankProtocolDraft, DRAFT_PROTOCOLS } from '../../src/main/core/drafts/template'
import { PackageManager } from '../../src/main/core/packages'

const AGENT: ClientIdentity = { origin: 'local', clientId: 'claude-code' }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let prelude: string
let sandbox: () => ReturnType<ReturnType<typeof inProcessQuickJS>>
beforeAll(async () => {
  prelude = await buildToolLibrary()
  const factory = inProcessQuickJS(await nodeQuickJS())
  sandbox = () => factory()
}, 60_000)

const site = () =>
  ({
    budget: { acquire: async () => undefined, spentForMs: () => 0 },
    breaker: {
      isOpen: () => false,
      admit: () => 0,
      recordSuccess: () => undefined,
      trip: () => undefined,
      status: () => ({ retryAfterMs: 0 }),
    },
  }) as unknown as SiteGuards

async function harness(overrides: Partial<AuthoringDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'valet-protocol-drafts-'))
  dirs.push(dir)
  const store = new DraftStore(join(dir, 'drafts'))
  const packages = new PackageManager({
    store: new AdapterStore(join(dir, 'adapters')),
    runtime: { prelude, start: sandbox },
    build: buildRecord('0.1.0', prelude),
    audit: { append: async () => undefined } as unknown as AuditSink,
    now: () => new Date(),
    keep: async () => new Set(),
  })
  const trialsRun: string[] = []
  const authoring = new DraftAuthoring({
    store,
    prepare: async (files) => (await packages.prepare(files, 'draft')).loaded,
    caseProcess: sandbox,
    installed: async () => null,
    approved: async () => null,
    sites: () => [],
    permissionLines: () => [],
    submit: async () => ({ ok: false, sentence: 'unused' }),
    withdraw: async () => undefined,
    requestState: () => ({ state: 'unknown', note: null }),
    clientName: () => 'Claude Code',
    audit: async () => undefined,
    notify: () => undefined,
    now: () => Date.now(),
    trials: {
      start: sandbox,
      driver: async () => {
        trialsRun.push('driver')
        throw new Error('no browser')
      },
      guards: () => {
        trialsRun.push('guards')
        return site()
      },
      signedIn: async () => new Map(),
    },
    ...overrides,
  })
  return { authoring, trialsRun }
}

async function draftOf(protocol: 'imap' | 'smtp' | 'sftp', adapterId = `my-${protocol}`) {
  const h = await harness()
  const { draft } = await h.authoring.createDraft(AGENT, {
    adapterId,
    from: 'blank',
    name: `My ${protocol}`,
    protocol,
  })
  const read = async (path: string) => (await h.authoring.readFile(AGENT, false, draft.draftId, path)).content
  const write = (path: string, text: string) => h.authoring.writeFile(AGENT, draft.draftId, path, text)
  const check = () => h.authoring.check(AGENT, draft.draftId)
  /** Replaces the case file with these cases and checks. */
  const withCases = async (cases: readonly Record<string, unknown>[]) => {
    await write('test/example.json', JSON.stringify({ cases }))
    return check()
  }
  return { ...h, draftId: draft.draftId, read, write, check, withCases }
}

const failed = (report: { cases: readonly { passed: boolean; name: string; reason: string | null }[] }) =>
  report.cases.filter((c) => !c.passed).map((c) => ({ name: c.name, reason: c.reason }))

describe('valet_create_draft with a protocol', () => {
  for (const protocol of DRAFT_PROTOCOLS) {
    it(`starts a ${protocol} draft that passes its own check, every case run through the guards`, async () => {
      const h = await draftOf(protocol)
      const manifest = parseManifest(JSON.parse(await h.read('manifest.json')))
      expect(manifest.runtime).toBe('protocol')
      expect(Object.keys(manifest.protocols ?? {})).toEqual([protocol])
      expect(manifest.id).toBe(`my-${protocol}`)
      expect(manifest.name).toBe(`My ${protocol}`)
      // The credential is kept: Valet signs in, the code never sees it.
      for (const c of Object.values(manifest.credentials ?? {})) expect(c.custody).toBe('kept')
      const report = await h.check()
      expect(failed(report)).toEqual([])
      expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
      expect(report.cases.length).toBeGreaterThanOrEqual(3)
      // Every tool has a case.
      for (const tool of manifest.tools) expect(report.cases.some((c) => c.tool === tool.name)).toBe(true)
      expect(report.ok).toBe(true)
      // The placeholders are cautions until the agent replaces them.
      const cautions = report.findings.filter((f) => f.level === 'caution').map((f) => f.text)
      expect(cautions.some((t) => t.includes('description is still the starter’s placeholder'))).toBe(true)
      expect(cautions.some((t) => t.includes('hostKeySha256 is still the starter’s placeholder'))).toBe(
        protocol === 'sftp',
      )
    }, 60_000)
  }

  it('takes runtime "protocol" with the protocol, and protocol alone', async () => {
    const h = await harness()
    const a = await h.authoring.createDraft(AGENT, {
      adapterId: 'aa',
      from: 'blank',
      runtime: 'protocol',
      protocol: 'smtp',
    })
    expect(
      JSON.parse((await h.authoring.readFile(AGENT, false, a.draft.draftId, 'manifest.json')).content),
    ).toMatchObject({ runtime: 'protocol', protocols: { smtp: { endpoint: 'smtp.example.com:587' } } })
  })

  it('refuses a protocol draft without its protocol, and a protocol with another kind or source', async () => {
    const h = await harness()
    await expect(
      h.authoring.createDraft(AGENT, { adapterId: 'aa', from: 'blank', runtime: 'protocol' }),
    ).rejects.toThrow(/needs protocol "imap".*"smtp".*"sftp"/)
    await expect(
      h.authoring.createDraft(AGENT, { adapterId: 'bb', from: 'blank', runtime: 'http', protocol: 'imap' }),
    ).rejects.toThrow(/protocol is only for a blank draft/)
    await expect(
      h.authoring.createDraft(AGENT, {
        adapterId: 'cc',
        from: 'example',
        example: 'icloud-mail-read',
        protocol: 'imap',
      }),
    ).rejects.toThrow(/protocol is only for a blank draft/)
    // Nothing was started by a refusal.
    expect((await h.authoring.listDrafts(AGENT, false)).drafts).toEqual([])
  })

  it('has no live trial: the person’s credential is never lent to a draft, and nothing is opened', async () => {
    for (const protocol of DRAFT_PROTOCOLS) {
      const h = await draftOf(protocol)
      const manifest = parseManifest(JSON.parse(await h.read('manifest.json')))
      const read = manifest.tools.find((t) => t.sideEffect === 'read')
      if (read === undefined) continue
      await expect(h.authoring.liveTrial(AGENT, h.draftId, read.name, {})).rejects.toThrow(
        /a protocol adapter .* has no live trials/,
      )
      expect(h.trialsRun).toEqual([])
    }
  }, 60_000)

  it('makes the same files each time, with the draft’s own id and name', () => {
    for (const protocol of DRAFT_PROTOCOLS) {
      const a = blankProtocolDraft('one', 'One', protocol)
      expect(blankProtocolDraft('one', 'One', protocol)).toEqual(a)
      expect(Object.keys(a).sort()).toEqual(['manifest.json', 'src/tools.ts', 'test/example.json'])
      expect(JSON.parse(a['manifest.json'] ?? '')).toMatchObject({ id: 'one', name: 'One' })
    }
    expect(blankProtocolDraft('x', 'X', 'sftp')['manifest.json']).toContain(PLACEHOLDER_HOST_KEY)
  })
})

describe('SMTP cases', () => {
  const SEND = { to: 'ann@example.com', subject: 'Hello', text: 'See you at ten.' }
  const base = { name: 'a send', tool: 'send_note', input: SEND }

  it('match the message as Valet checked it, and say where it differs', async () => {
    const h = await draftOf('smtp')
    const report = await h.withCases([
      { ...base, smtp: [{ message: { subject: 'Goodbye' } }], expect: { output: { accepted: 1 } } },
    ])
    expect(failed(report)).toEqual([
      {
        name: 'a send',
        reason: expect.stringContaining(
          'message differs at message.subject: expected "Goodbye", got "Hello"',
        ),
      },
    ])
  }, 60_000)

  it('fail a send the case doesn’t list, and a listed send the tool never made', async () => {
    const h = await draftOf('smtp')
    const none = await h.withCases([{ ...base, expect: { output: { accepted: 1 } } }])
    expect(failed(none)[0]?.reason).toContain('sent a message the case doesn')
    const tools = await h.read('src/tools.ts')
    await h.write(
      'src/tools.ts',
      tools.replace(
        'return await smtp(ctx).send(',
        "if (input.subject === 'skip') return { messageId: 'none', accepted: 0 }\n      return await smtp(ctx).send(",
      ),
    )
    const skipped = await h.withCases([
      { ...base, input: { ...SEND, subject: 'skip' }, smtp: [{}], expect: { output: { accepted: 0 } } },
    ])
    expect(failed(skipped)[0]?.reason).toContain('sent 0 of the case')
  }, 60_000)

  it('answer the person’s no and a time-out as the runtime does, and a server error as given', async () => {
    const h = await draftOf('smtp')
    const report = await h.withCases([
      {
        ...base,
        name: 'declined',
        smtp: [{ confirm: 'declined' }],
        expect: { error: { stage: 'confirm', errorClass: 'declined' } },
      },
      {
        ...base,
        name: 'timed out',
        smtp: [{ confirm: 'timed-out' }],
        expect: { error: { stage: 'confirm', errorClass: 'timed-out' } },
      },
      {
        ...base,
        name: 'refused by the server',
        smtp: [{ error: { stage: 'egress', errorClass: 'blocked-by-site' } }],
        expect: { error: { stage: 'egress', errorClass: 'blocked-by-site' } },
      },
      {
        ...base,
        name: 'some accepted',
        smtp: [{ answer: { accepted: 0 } }],
        expect: { output: { messageId: '<case-1@smtp.example.com>', accepted: 0 } },
      },
    ])
    expect(failed(report)).toEqual([])
  }, 60_000)

  it('can’t approve a recipient off the list: the guard refuses before the script is asked', async () => {
    const h = await draftOf('smtp')
    const report = await h.withCases([
      {
        ...base,
        name: 'approved off the list',
        input: { ...SEND, to: 'eve@elsewhere.example' },
        smtp: [{ confirm: 'approved' }],
        expect: { output: { accepted: 1 } },
      },
    ])
    // The send never reached the script, so the case can't pass by approving it.
    expect(failed(report)[0]?.reason).toMatch(/request-surface\/command-not-allowed|sent 0 of/)
  }, 60_000)

  it('can’t send from a write or read tool, whatever the case approves', async () => {
    for (const sideEffect of ['write', 'read']) {
      const h = await draftOf('smtp')
      const manifest = JSON.parse(await h.read('manifest.json'))
      manifest.tools[0].sideEffect = sideEffect
      await h.write('manifest.json', JSON.stringify(manifest))
      const passes = await h.withCases([
        {
          ...base,
          smtp: [],
          expect: { error: { stage: 'request-surface', errorClass: 'command-not-allowed' } },
        },
      ])
      expect(failed(passes)).toEqual([])
      const tries = await h.withCases([{ ...base, smtp: [{}], expect: { output: { accepted: 1 } } }])
      expect(failed(tries)).toHaveLength(1)
    }
  }, 60_000)

  it('refuse a message with hidden characters or a header of its own, as a live send does', async () => {
    const h = await draftOf('smtp')
    const tools = await h.read('src/tools.ts')
    await h.write(
      'src/tools.ts',
      tools.replace(
        'subject: input.subject,',
        "subject: input.subject === 'zwsp' ? 'Hi\\u200bthere' : input.subject, ...(input.subject === 'hdr' ? { headers: { 'x-a': '1' } } : {}),",
      ),
    )
    const report = await h.withCases([
      {
        ...base,
        name: 'zero-width',
        input: { ...SEND, subject: 'zwsp' },
        expect: { error: { stage: 'tool-run', errorClass: 'invalid' } },
      },
      {
        ...base,
        name: 'extra header',
        input: { ...SEND, subject: 'hdr' },
        expect: { error: { stage: 'tool-run', errorClass: 'invalid' } },
      },
    ])
    expect(failed(report)).toEqual([])
  }, 60_000)

  it('count each send against requestsPerRun', async () => {
    const h = await draftOf('smtp')
    const tools = await h.read('src/tools.ts')
    await h.write(
      'src/tools.ts',
      tools.replace(
        'return await smtp(ctx).send(',
        'await smtp(ctx).send({ to: [input.to], subject: input.subject, text: input.text })\n      return await smtp(ctx).send(',
      ),
    )
    // The starter allows one send a call: the second is refused before anyone is asked.
    const report = await h.withCases([
      { ...base, smtp: [{}], expect: { error: { stage: 'request-surface', errorClass: 'request-ceiling' } } },
    ])
    expect(failed(report)).toEqual([])
  }, 60_000)

  it('refuse a step that answers a send the person declined', async () => {
    const h = await draftOf('smtp')
    const report = await h.withCases([
      { ...base, smtp: [{ confirm: 'declined', answer: { accepted: 1 } }], expect: { output: {} } },
    ])
    expect(report.ok).toBe(false)
    expect(report.cases).toEqual([])
    expect(JSON.stringify(report)).toContain('never reaches the server')
  }, 60_000)
})

describe('protocol cases', () => {
  it('have no pages, fetch or sockets, and script only the protocols the manifest declares', async () => {
    const h = await draftOf('imap')
    const one = { name: 'x', tool: 'find_mail', input: {}, expect: { output: {} } }
    const report = await h.withCases([
      { ...one, name: 'fetch', fetch: [{ url: 'https://imap.example.com/', body: { inline: {} } }] },
      { ...one, name: 'sftp steps', sftp: [{ op: 'list' }] },
      { ...one, name: 'smtp steps', smtp: [{}] },
    ])
    expect(failed(report)).toEqual([
      { name: 'fetch', reason: expect.stringContaining('no "pages", "fetch" or "sockets"') },
      { name: 'sftp steps', reason: expect.stringContaining('no protocols.sftp') },
      { name: 'smtp steps', reason: expect.stringContaining('no protocols.smtp') },
    ])
  }, 60_000)

  it('are refused in an adapter that isn’t a protocol adapter', async () => {
    const h = await harness()
    const { draft } = await h.authoring.createDraft(AGENT, {
      adapterId: 'api',
      from: 'blank',
      runtime: 'http',
    })
    await h.authoring.writeFile(
      AGENT,
      draft.draftId,
      'test/example.json',
      JSON.stringify({
        cases: [
          {
            name: 'imap',
            tool: 'get_item',
            input: { id: 'a' },
            imap: [{ op: 'status' }],
            expect: { output: {} },
          },
        ],
      }),
    )
    const report = await h.authoring.check(AGENT, draft.draftId)
    expect(failed(report)).toEqual([
      { name: 'imap', reason: expect.stringContaining('only a protocol adapter') },
    ])
  }, 60_000)

  it('IMAP: a read tool that changes flags, or names a folder off the list, is refused', async () => {
    const h = await draftOf('imap')
    const tools = await h.read('src/tools.ts')
    await h.write(
      'src/tools.ts',
      tools.replace(
        'const found = await imap(ctx).search(input.folder, criteria, { limit: input.count })',
        "if (input.count === 3) await imap(ctx).setFlags('INBOX', [1], { add: ['\\\\Seen'] })\n      if (input.count === 4) await imap(ctx).status('Private')\n      const found = await imap(ctx).search(input.folder, criteria, { limit: input.count })",
      ),
    )
    const refused = { error: { stage: 'request-surface', errorClass: 'command-not-allowed' } }
    const report = await h.withCases([
      { name: 'marks read', tool: 'find_mail', input: { count: 3 }, expect: refused },
      { name: 'another folder', tool: 'find_mail', input: { count: 4 }, expect: refused },
    ])
    expect(failed(report)).toEqual([])
    // And a case can't pass them by scripting the server's answer.
    const scripted = await h.withCases([
      {
        name: 'marks read',
        tool: 'find_mail',
        input: { count: 3 },
        imap: [
          { op: 'setFlags', answer: { folder: 'INBOX', uids: 1 } },
          { op: 'search', answer: { uids: [], total: 0 } },
        ],
        expect: { output: { total: 0 } },
      },
    ])
    expect(failed(scripted)).toHaveLength(1)
  }, 60_000)

  it('IMAP: \\Deleted from the write tool is irreversible, so it is refused', async () => {
    const h = await draftOf('imap')
    const tools = await h.read('src/tools.ts')
    await h.write('src/tools.ts', tools.replace("{ add: ['\\\\Flagged'] }", "{ add: ['\\\\Deleted'] }"))
    const report = await h.withCases([
      {
        name: 'deletes',
        tool: 'flag_message',
        input: { id: 1 },
        imap: [{ op: 'fetch', answer: { folder: 'INBOX', messages: [{ uid: 1, flags: [] }] } }],
        expect: { error: { stage: 'request-surface', errorClass: 'command-not-allowed' } },
      },
    ])
    expect(failed(report)).toEqual([])
  }, 60_000)

  it('SFTP: a write into the read-only root, a replace, and a path outside the roots are refused', async () => {
    const h = await draftOf('sftp')
    const tools = await h.read('src/tools.ts')
    await h.write(
      'src/tools.ts',
      tools.replace(
        'const written = await sftp(ctx).write(`${DROP}/${input.name}`, input.text)',
        [
          "if (input.name === 'a') await sftp(ctx).write(`${REPORTS}/a`, input.text)",
          "      if (input.name === 'b') await sftp(ctx).write(`${DROP}/b`, input.text, { mode: 'replace' })",
          "      if (input.name === 'c') await sftp(ctx).write('/etc/c', input.text)",
          "      if (input.name === 'd') await sftp(ctx).remove(`${DROP}/d`)",
          '      const written = await sftp(ctx).write(`${DROP}/${input.name}`, input.text)',
        ].join('\n'),
      ),
    )
    const refused = { error: { stage: 'request-surface', errorClass: 'command-not-allowed' } }
    const report = await h.withCases(
      ['a', 'b', 'c', 'd'].map((name) => ({
        name,
        tool: 'save_note',
        input: { name, text: 'x' },
        // Each is refused before the script: these steps are never asked.
        sftp: [{ op: 'write', answer: { path: '/x', bytes: 1, mode: 'create' } }],
        expect: refused,
      })),
    )
    expect(failed(report)).toEqual([])
  }, 60_000)

  it('SFTP: the starter’s file names can’t climb out of their folder', async () => {
    const h = await draftOf('sftp')
    const bad = ['../etc/passwd', '.ssh', 'a/b', '', 'x\u0000y']
    const report = await h.withCases(
      bad.map((name, i) => ({
        name: `bad ${i}`,
        tool: 'read_report',
        input: { name },
        expect: { output: {} },
      })),
    )
    for (const c of report.cases) expect(c.reason).toContain('input schema')
  }, 60_000)
})

describe('the guide and the tool', () => {
  it('describe ctx.imap, ctx.smtp, ctx.sftp and their cases', () => {
    for (const text of [
      '## Adapters that speak a protocol (runtime "protocol")',
      '### ctx.imap (protocols.imap)',
      '### ctx.smtp (protocols.smtp)',
      '### ctx.sftp (protocols.sftp)',
      '### Cases for a protocol adapter',
      'no live trials',
      '`\\Deleted`',
      '`<case-1@host>`',
    ])
      expect(AUTHORING_GUIDE).toContain(text)
  })

  it('valet_create_draft takes protocol, and passes it on', async () => {
    const tool = AUTHORING_TOOLS.find((t) => t.name === 'valet_create_draft')
    expect(tool).toBeDefined()
    const input = tool?.input.parse({ adapterId: 'mail', protocol: 'sftp' }) as Record<string, unknown>
    expect(input['protocol']).toBe('sftp')
    expect(() => tool?.input.parse({ adapterId: 'mail', protocol: 'pop3' })).toThrow()
    const seen: unknown[] = []
    await tool?.run(
      {
        createDraft: async (_v: unknown, request: unknown) => {
          seen.push(request)
          return {} as never
        },
      } as never,
      { ...input, runtime: 'protocol' },
      { viewer: AGENT, all: false } as never,
    )
    expect(seen).toEqual([{ adapterId: 'mail', from: 'blank', runtime: 'protocol', protocol: 'sftp' }])
  })
})
