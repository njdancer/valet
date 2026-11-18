// @vitest-environment node
// The IMAP, SMTP and SFTP starters (valet_create_draft with a protocol) as installed, end to end
// against fake servers only: each starts as a draft, passes its check, and then runs through
// ToolHost with the real protocol host (in its own Node process, under Seatbelt on macOS), the real
// egress broker's tunnel, and the real credential gate over a test grant. So the code an agent
// starts from works against a real server implementation, not just against its cases' scripts, and
// does only what its tools say.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore, buildRecord } from '@valet/adapter-store'
import { type AuditSink, type CredentialGrant, type PackageFiles, SecretValue, ValetError } from '@valet/core'
import { DEFAULT_USER, startFakeImap } from '@valet/fake-imap'
import { type FakeSftp, startFakeSftp } from '@valet/fake-sftp'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import type { ClientIdentity } from '@valet/mcp-server'
import { imapBackend, type ProtocolHostOptions, sftpBackend, smtpBackend } from '@valet/protocols'
import { writeProtocolHost, writeSftpHost } from '@valet/protocols/build'
import {
  type ConfirmationAnswer,
  type ConfirmationPrompt,
  type ConfirmationRequest,
  type ImapBackend,
  noBrowserDriver,
  type SftpBackend,
  type SmtpBackend,
  ToolHost,
} from '@valet/runtime'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { inProcessQuickJS, nodeQuickJS } from '@valet/sandbox'
import { SMTPServer } from 'smtp-server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FakeClock,
  MemoryAudit,
  MemoryJsonStore,
  MemoryMarkers,
} from '../../../../packages/runtime/test/fakes'
import { DraftAuthoring } from '../../src/main/core/drafts/authoring'
import { DraftStore } from '../../src/main/core/drafts/store'
import { PackageManager } from '../../src/main/core/packages'

const AGENT: ClientIdentity = { origin: 'local', clientId: 'claude-code' }
const mac = process.platform === 'darwin'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

let prelude: string
let sandbox: () => ReturnType<ReturnType<typeof inProcessQuickJS>>
let protocolHost: string
let sftpHost: string
beforeAll(async () => {
  prelude = await buildToolLibrary()
  const factory = inProcessQuickJS(await nodeQuickJS())
  sandbox = () => factory()
  const dir = mkdtempSync(join(tmpdir(), 'valet-protocol-hosts-'))
  protocolHost = await writeProtocolHost(join(dir, 'protocol-host.cjs'))
  sftpHost = await writeSftpHost(join(dir, 'sftp-host.cjs'))
}, 120_000)

/** The person: answers the tool's own confirmation with `tool`, and each mail-send with `mail`. */
class Person implements ConfirmationPrompt {
  tool: ConfirmationAnswer = 'approved'
  mail: ConfirmationAnswer = 'approved'
  readonly requests: ConfirmationRequest[] = []
  async ask(request: ConfirmationRequest): Promise<ConfirmationAnswer> {
    this.requests.push(request)
    return request.kind === 'mail-send' ? this.mail : this.tool
  }
}

/** Broker options that send the endpoint to a fake on loopback. */
const brokerTo = (port: number) => ({
  lookup: (_name: string, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: '127.0.0.1', family: 4 }]),
  testing: { allowAddresses: ['127.0.0.1'], route: () => ({ address: '127.0.0.1', port }) },
})

function hostOptions(script: string, testCa?: string): ProtocolHostOptions {
  return {
    nodeBinary: process.execPath,
    hostScript: script,
    home: tempDir('valet-home-'),
    withoutSeatbelt: !mac,
    ...(testCa === undefined ? {} : { testCa }),
    operationTimeoutMs: 15_000,
  } as ProtocolHostOptions
}

/**
 * A blank protocol draft, edited by `edit`, checked (every case must pass), then installed: compiled,
 * registered with a ToolHost whose ctx.imap, ctx.smtp or ctx.sftp is `backend`, signed in through the
 * real credential gate from a test grant whose fields are `fields`.
 */
async function installed(
  protocol: 'imap' | 'smtp' | 'sftp',
  edit: (files: PackageFiles) => PackageFiles,
  backend: (manifest: ReturnType<typeof parse>) => {
    imap?: ImapBackend
    smtp?: SmtpBackend
    sftp?: SftpBackend
  },
  fields: Record<string, string>,
) {
  const dir = tempDir('valet-protocol-e2e-')
  const packages = new PackageManager({
    store: new AdapterStore(join(dir, 'adapters')),
    runtime: { prelude, start: sandbox },
    build: buildRecord('0.1.0', prelude),
    audit: { append: async () => undefined } as unknown as AuditSink,
    now: () => new Date(),
    keep: async () => new Set(),
  })
  const store = new DraftStore(join(dir, 'drafts'))
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
  })
  const { draft } = await authoring.createDraft(AGENT, {
    adapterId: `my-${protocol}`,
    from: 'blank',
    protocol,
  })
  for (const [path, text] of Object.entries(edit({ ...(await store.files(draft.draftId)) })))
    await authoring.writeFile(AGENT, draft.draftId, path, text)
  // The check still passes after the edit: the starter's cases hold for the real server's names.
  const report = await authoring.check(AGENT, draft.draftId)
  expect(report.cases.filter((c) => !c.passed)).toEqual([])
  expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
  const loaded = (await packages.prepare(await store.files(draft.draftId), 'draft')).loaded
  const manifest = loaded.manifest
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const person = new Person()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === manifest.id && hash === loaded.adapterHash },
    audit,
    prompt: person,
    authRunner: vi.fn(async () => ({ status: 'ok' as const })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    pacingSleep: clock.pacingSleep,
  })
  host.register({
    definition: loaded.definition,
    bundleHash: loaded.adapterHash,
    driver: noBrowserDriver(),
    isolation: { script: loaded.script, start: sandbox },
    ...backend(manifest),
    credentialGrants: {
      findGrant: async (credential) => {
        const declared = manifest.credentials?.[credential]
        if (declared === undefined || !('protocol' in declared.use)) return null
        return {
          adapterId: manifest.id,
          adapterHash: loaded.adapterHash,
          credential,
          kind: declared.kind,
          custody: declared.custody,
          provider: 'keychain-copy',
          itemRef: `test:${credential}`,
          targets: [declared.use.endpoint],
          grantedAt: '2026-11-18T00:00:00.000Z',
        } as CredentialGrant
      },
      resolve: async (_grant, field) => {
        const value = fields[field]
        if (value === undefined) throw new ValetError('credential', 'field-missing')
        return SecretValue.fromString(value)
      },
    },
  })
  let n = 0
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    host.call({ adapterId: manifest.id, tool, input, client: 'claude-code', callId: `c-${++n}` })
  return { call, audit, person, manifest }
}
const parse = (m: unknown) => m as import('@valet/core').AdapterManifest

/** Rewrites one file of a package. */
const rewrite =
  (path: string, change: (text: string) => string) =>
  (files: PackageFiles): PackageFiles => ({ ...files, [path]: change(files[path] ?? '') })

/** An RFC 5322 message for the fake IMAP server. */
const mail = (from: string, subject: string, day: number, flags: string[] = []) => ({
  raw: [
    `From: ${from}`,
    'To: alex@example.com',
    `Subject: ${subject}`,
    `Date: ${day} Nov 2026 08:00:00 +0000`,
    `Message-ID: <m${day}@example.test>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The body, which no tool reads.',
    '',
  ].join('\r\n'),
  flags,
  internalDate: new Date(Date.UTC(2026, 10, day, 8)),
})

describe('the IMAP starter, installed', () => {
  it('finds unread mail from one sender without marking it read, and flags one message', async () => {
    const server = await startFakeImap({
      hosts: ['imap.example.com'],
      mailboxes: {
        INBOX: [
          mail('Shop <receipts@shop.example>', 'Your receipt', 14, ['\\Seen']),
          mail('Shop <receipts@shop.example>', 'Your order has shipped', 15),
          mail('Ann <ann@example.com>', 'Lunch?', 16),
          mail('Shop <receipts@shop.example>', 'Rate your order', 17),
        ],
        Receipts: [],
        Private: [mail('Someone <x@example.com>', 'Not for this adapter', 17)],
      },
    })
    cleanups.push(() => server.close())
    const { call, audit } = await installed(
      'imap',
      (f) => f,
      (manifest) => ({
        imap: imapBackend({
          protocol: manifest.protocols?.imap as never,
          host: hostOptions(protocolHost, server.cert ?? undefined),
          broker: brokerTo(server.port),
        }),
      }),
      { username: DEFAULT_USER.username, password: DEFAULT_USER.password },
    )
    const found = await call('find_mail', { from: 'receipts@shop.example', unreadOnly: true })
    expect(found).toMatchObject({
      status: 'ok',
      output: {
        total: 2,
        messages: [
          { from: 'receipts@shop.example', subject: 'Rate your order', read: false },
          { from: 'receipts@shop.example', subject: 'Your order has shipped', read: false },
        ],
      },
    })
    // Nothing was marked read, and nothing but INBOX was touched.
    const inbox = server.mailboxes.get('INBOX')?.messages ?? []
    expect(inbox.map((m) => [...m.flags])).toEqual([['\\Seen'], [], [], []])
    expect(server.commands.some((c) => c.line.includes('Private'))).toBe(false)
    expect(server.commands.some((c) => /BODY\[\]|RFC822(?!\.SIZE)|BODY\[TEXT\]/i.test(c.line))).toBe(false)

    const id = (found as { output: { messages: { id: number }[] } }).output.messages[0]?.id as number
    expect(await call('flag_message', { id })).toMatchObject({ status: 'ok', output: { id, flagged: true } })
    expect([...(inbox.at(-1)?.flags ?? [])]).toEqual(['\\Flagged'])
    expect(await call('flag_message', { id, flagged: false })).toMatchObject({ status: 'ok' })
    expect([...(inbox.at(-1)?.flags ?? [])]).toEqual([])
    // A message that isn't there.
    expect(await call('flag_message', { id: 999 })).toMatchObject({
      status: 'failed',
      stage: 'tool-run',
      errorClass: 'not-found',
    })
    // Signed in by Valet; the password is in no output or audit event.
    expect(server.logins.every((l) => l.ok && l.username === DEFAULT_USER.username)).toBe(true)
    expect(JSON.stringify(audit.events)).not.toContain(DEFAULT_USER.password)
  }, 120_000)
})

describe('the SMTP starter, installed', () => {
  let cert: { key: string; cert: string }
  beforeAll(async () => {
    cert = await generateTestCertificate(['smtp.example.com'])
  }, 30_000)

  async function fakeSmtp() {
    const received: { from: string; to: string[]; data: string }[] = []
    const auths: string[] = []
    const server = new SMTPServer({
      key: cert.key,
      cert: cert.cert,
      authMethods: ['PLAIN', 'LOGIN'],
      logger: false,
      disableReverseLookup: true,
      onAuth: (auth, _session, cb) => {
        auths.push(auth.username ?? '')
        if (auth.username === 'alex@example.com' && auth.password === 'app-password-1')
          cb(null, { user: 'alex' })
        else cb(new Error('Invalid username or password'))
      },
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = []
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((r) => r.address),
            data: Buffer.concat(chunks).toString('latin1'),
          })
          cb()
        })
      },
    })
    server.on('error', () => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const port = ((server as unknown as { server: Server }).server.address() as AddressInfo).port
    return { port, received, auths }
  }

  it('sends a confirmed note From the account, over STARTTLS, and nothing it wasn’t told to', async () => {
    const smtp = await fakeSmtp()
    const { call, person, audit } = await installed(
      'smtp',
      (f) => f,
      (manifest) => ({
        smtp: smtpBackend({
          protocol: manifest.protocols?.smtp as never,
          host: hostOptions(protocolHost, cert.cert),
          broker: brokerTo(smtp.port),
        }),
      }),
      { username: 'alex@example.com', password: 'app-password-1' },
    )
    const sent = await call('send_note', { to: 'ann@example.com', subject: 'Hello', text: 'See you at ten.' })
    expect(sent).toMatchObject({ status: 'ok', output: { accepted: 1 } })
    expect((sent as { output: { messageId: string } }).output.messageId).toMatch(
      /^<[0-9a-f-]+@smtp\.example\.com>$/,
    )
    expect(smtp.received).toHaveLength(1)
    expect(smtp.received[0]).toMatchObject({ from: 'alex@example.com', to: ['ann@example.com'] })
    expect(smtp.received[0]?.data).toMatch(/^From: alex@example\.com\r\n/m)
    // The person was asked about the tool, then about this exact message.
    expect(person.requests.map((r) => r.kind)).toEqual(['irreversible-tool', 'mail-send'])
    expect(person.requests.at(-1)).toMatchObject({
      kind: 'mail-send',
      mail: { to: ['ann@example.com'], subject: 'Hello' },
    })

    // A no sends nothing.
    person.mail = 'declined'
    expect(await call('send_note', { to: 'ann@example.com', subject: 'Again', text: 'x' })).toMatchObject({
      status: 'failed',
      stage: 'confirm',
      errorClass: 'declined',
    })
    // An address off the recipients list is refused before the person is asked.
    person.mail = 'approved'
    const asked = person.requests.filter((r) => r.kind === 'mail-send').length
    expect(await call('send_note', { to: 'eve@elsewhere.example', subject: 'Hi', text: 'x' })).toMatchObject({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'command-not-allowed',
    })
    expect(person.requests.filter((r) => r.kind === 'mail-send').length).toBe(asked)
    expect(smtp.received).toHaveLength(1)
    expect(JSON.stringify(audit.events)).not.toContain('app-password-1')
  }, 120_000)
})

describe('the SFTP starter, installed', () => {
  it('lists and reads reports, saves a new note, and changes nothing else on the server', async () => {
    const server: FakeSftp = await startFakeSftp({
      username: 'valet',
      files: {
        '/srv/reports/2026-10.txt': 'Total: 42.\n',
        '/srv/reports/archive/': '',
        '/srv/drop/': '',
        '/srv/drop/taken.txt': 'already here',
        '/srv/private/secret.txt': 'not for tools',
      },
    })
    cleanups.push(() => server.close())
    const { call, audit } = await installed(
      'sftp',
      rewrite('manifest.json', (text) =>
        text.replace(/"hostKeySha256": "[^"]+"/, `"hostKeySha256": "${server.hostKeySha256}"`),
      ),
      (manifest) => ({
        sftp: sftpBackend({
          protocol: manifest.protocols?.sftp as never,
          host: hostOptions(sftpHost),
          broker: brokerTo(server.port),
        }),
      }),
      // A key Valet made: the item has no username, so the manifest's "valet" is used.
      { 'ssh-key': server.clientKey.private },
    )
    expect(await call('list_reports')).toMatchObject({
      status: 'ok',
      output: { reports: [{ name: '2026-10.txt', size: 11 }], more: false },
    })
    expect(await call('read_report', { name: '2026-10.txt' })).toMatchObject({
      status: 'ok',
      output: { name: '2026-10.txt', text: 'Total: 42.\n', truncated: false },
    })
    expect(await call('read_report', { name: 'missing.txt' })).toMatchObject({
      status: 'failed',
      errorClass: 'not-found',
    })
    expect(await call('save_note', { name: 'note.txt', text: 'Call the plumber.' })).toMatchObject({
      status: 'ok',
      output: { path: '/srv/drop/note.txt', bytes: 17 },
    })
    expect(readFileSync(server.at('/srv/drop/note.txt'), 'utf8')).toBe('Call the plumber.')
    // create never overwrites.
    expect(await call('save_note', { name: 'taken.txt', text: 'replaced?' })).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    expect(readFileSync(server.at('/srv/drop/taken.txt'), 'utf8')).toBe('already here')
    // Nothing outside the roots was asked about, and nothing was removed or renamed.
    const seen = JSON.stringify(server.requests)
    expect(seen).not.toContain('/srv/private')
    expect(server.requests.some((r) => /REMOVE|RMDIR|RENAME|SETSTAT|SYMLINK/i.test(String(r.type)))).toBe(
      false,
    )
    expect(server.logins.filter((l) => l.ok).every((l) => l.username === 'valet')).toBe(true)
    expect(JSON.stringify(audit.events)).not.toContain('PRIVATE KEY')
  }, 120_000)

  it('refuses a server whose host key isn’t the pinned one, before signing in', async () => {
    const server: FakeSftp = await startFakeSftp({ username: 'valet', files: { '/srv/reports/': '' } })
    cleanups.push(() => server.close())
    // The starter's placeholder pin, which no server has.
    const { call } = await installed(
      'sftp',
      (f) => f,
      (manifest) => ({
        sftp: sftpBackend({
          protocol: manifest.protocols?.sftp as never,
          host: hostOptions(sftpHost),
          broker: brokerTo(server.port),
        }),
      }),
      { 'ssh-key': server.clientKey.private },
    )
    expect(await call('list_reports')).toMatchObject({ status: 'failed', errorClass: 'host-key-mismatch' })
    expect(server.logins).toEqual([])
  }, 120_000)
})
