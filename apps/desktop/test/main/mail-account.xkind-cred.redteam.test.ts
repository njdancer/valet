// @vitest-environment node
// Red team, cross-kind credentials (workstream I): sign-in mail's "no adapter that may write INBOX
// holds the same item" check (service.ts mailAccountOf) only asks core's mayWriteInbox, which looks
// at protocols.imap alone. An adapter of another kind (raw, entrusted the same app password for the
// same IMAP server) can APPEND to INBOX with a forged Authentication-Results, yet the account keeps
// serving sign-in mail. Each `it` states what SHOULD hold; a failing test is a demonstrated hole.
// Harness trimmed from service.test.ts.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRecord } from '@valet/adapter-store'
import {
  type MailReader,
  type ManifestInput,
  type PackageFiles,
  packageOf,
  parseManifest,
  SecretValue,
} from '@valet/core'
import { loadDependencies, memoryTarballStore, nodeRuntimeProcess } from '@valet/node-runtime'
import { inMemoryToolProcess } from '@valet/runtime/in-context'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAnchor, SoftwareSigner, softwareKeysAt } from '../../src/main/core/approvals'
import { dataPaths } from '../../src/main/core/constants'
import { type Credentials, disabledOtpReader } from '../../src/main/core/credentials'
import { builtinAdapter } from '../../src/main/core/registry'
import { AppService, type ServiceDeps } from '../../src/main/core/service'
import { disabledUpdates } from '../../src/main/core/updates'
import { FakeDriver, SHOP, SHOP_FILES, shopDefinition } from './fixtures'
import { testCredentials } from './test-credentials'

const ENDPOINT = 'imap.mail.me.com:993'
const dirs: string[] = []
const services: AppService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One iCloud app password, reachable through 1Password (by `op://Valet/<id>`) and as a Keychain copy. */
function mailCredentials(): Credentials {
  const base = testCredentials(disabledOtpReader)
  const resolve = async (_ref: string, field: string) =>
    SecretValue.fromString(field === 'username' ? 'nick@icloud.test' : 'abcd-efgh-ijkl-mnop')
  return {
    ...base,
    providers: () => ({
      ...base.providers(),
      'onepassword-service-account': { kind: 'onepassword-service-account', resolve },
      'keychain-copy': { kind: 'keychain-copy', resolve },
    }),
    async status() {
      return [
        ...(await base.status()).filter(
          (s) => s.kind !== 'onepassword-service-account' && s.kind !== 'keychain-copy',
        ),
        { kind: 'onepassword-service-account', available: true, unavailableReason: null },
        { kind: 'keychain-copy', available: true, unavailableReason: null },
      ]
    },
    async vaultItems(provider) {
      if (provider === 'onepassword-service-account')
        return [{ id: 'icloudmail', title: 'iCloud app password' }]
      // The same item, in the same vault, as the desktop app lists it: `<vault id>-<item id>`.
      if (provider === 'keychain-copy')
        return [{ id: 'valetvault1-icloudmail', title: 'iCloud app password (Valet)' }]
      return base.vaultItems(provider)
    },
    copyItem: async () => {},
  } as Credentials
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xkind-mail-'))
  dirs.push(dir)
  const paths = dataPaths(join(dir, 'data'))
  const signer = new SoftwareSigner(() => true, await softwareKeysAt(join(dir, 'approval-keys.json')))
  const start = inMemoryToolProcess()
  const prelude = await buildToolLibrary()
  const picked = { next: null as PackageFiles | null }
  const rawProcess = (
    endpoints: readonly string[],
    openTunnels: Parameters<NonNullable<ServiceDeps['raw']>['start']>[1],
  ) =>
    nodeRuntimeProcess({
      nodeBinary: process.execPath,
      endpoints,
      openTunnels,
      home: homedir(),
      withoutSeatbelt: true,
    })
  let account: ((ref: string) => Promise<unknown>) | null = null
  const service = new AppService({
    paths,
    version: '0.1.0',
    demo: true,
    now: () => Date.parse('2026-11-07T00:00:00.000Z'),
    timers: {
      setTimeout: (r, ms) => setTimeout(r, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    timeZone: 'UTC',
    sleep: async () => {},
    adapters: [builtinAdapter(shopDefinition(), SHOP_FILES)],
    packages: {
      builtins: [
        packageOf(parseManifest(SHOP), {
          'src/tools.ts':
            "import { z } from 'zod'\nexport const tools = { echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }), run: async (_c, a) => ({ text: a.text }) }, add: { input: z.object({ item: z.string() }), output: z.object({ added: z.boolean() }), run: async () => ({ added: false }) } }",
        }),
      ],
      runtime: {
        prelude,
        start,
        raw: {
          dependencies: (lock) => loadDependencies(lock, memoryTarballStore()),
          start: rawProcess([], async () => ({
            ports: new Map(),
            close: () => undefined,
            restrict: () => undefined,
          })),
        },
      },
      build: buildRecord('0.1.0', prelude),
      folders: { pick: async () => picked.next },
    },
    toolProcess: start,
    raw: { start: (manifest, openTunnels) => rawProcess(manifest.endpoints ?? [], openTunnels) },
    mailReader: (a) => {
      account = a as (ref: string) => Promise<unknown>
      return {
        find: async () => Promise.reject(new Error('unused')),
        close: () => {},
      } as unknown as MailReader & { close(): void }
    },
    createDriver: async () => new FakeDriver(),
    credentials: mailCredentials(),
    approvalKeys: {
      signer,
      anchor: new FileAnchor(join(dir, 'anchor.json')),
      kind: 'software',
      forget: async () => {},
    },
    startEndpoint: async () => ({
      url: 'http://127.0.0.1:47000/mcp',
      port: 47000,
      refresh: () => [],
      addClient: async () => {},
      resetClient: async () => {},
      removeClient: async () => {},
      refuseClient: () => {},
      clientIds: () => [],
      close: async () => {},
      sessions: () => ({ total: 0, bridge: 0, http: 0, sessions: [] }),
    }),
    ui: new Proxy({}, { get: () => () => undefined }) as ServiceDeps['ui'],
    emit: () => {},
    bridge: (configPath) => ({ command: '/repo/tsx', args: ['/repo/bridge-cli.ts', configPath] }),
    claudeDesktopConfig: join(dir, 'claude_desktop_config.json'),
    checkOp: async () => null,
    updates: async () => disabledUpdates('0.1.0', 'development', false),
    pacingSleep: async () => {},
  } as ServiceDeps)
  services.push(service)
  await service.start()
  const api = service.api
  const install = async (files: PackageFiles) => {
    picked.next = files
    const installed = await api.adapters.installFromFolder()
    expect(installed).toMatchObject({ ok: true })
    const id = (installed as { adapterId: string }).adapterId
    const hash = (await api.approvals.pending()).find((r) => r.adapterId === id)?.to.hash ?? ''
    await api.approvals.approve(id, hash)
    return hash
  }
  return { service, api, install, account: (ref: string) => (account as NonNullable<typeof account>)(ref) }
}

const mailbox: ManifestInput = {
  schemaVersion: 1,
  id: 'mailbox',
  name: 'Mailbox',
  version: '1.0.0',
  description: 'Reads mail over IMAP.',
  runtime: 'protocol',
  protocols: { imap: { endpoint: ENDPOINT, credential: 'mail', folders: ['INBOX'] } },
  credentials: {
    mail: {
      description: 'Your iCloud app-specific password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: ENDPOINT },
    },
  },
  tools: [{ name: 'count', title: 'Count', description: 'Counts INBOX.', sideEffect: 'read' }],
}
const mailboxTools =
  "import { z } from 'zod'\nexport const tools = { count: { input: z.object({}), output: z.unknown(), run: async (ctx) => ({ n: (await ctx.imap.status('INBOX')).messages }) } }"

// A raw adapter entrusted the same app password for the same IMAP server. Its tool is declared
// `read`, but raw side effects are claims (docs/adapter-kinds.md, accepted residual): over its own
// TLS connection it can LOGIN and APPEND a message to INBOX with any Authentication-Results.
const rawSync: ManifestInput = {
  schemaVersion: 1,
  id: 'mailsync',
  name: 'Mail Sync',
  version: '1.0.0',
  description: 'Syncs mail over its own IMAP connection.',
  runtime: 'raw',
  endpoints: [ENDPOINT],
  credentials: {
    mail: {
      description: 'Your iCloud app-specific password',
      kind: 'password',
      custody: 'entrusted',
      use: { entrusted: { endpoints: [ENDPOINT] } },
    },
  },
  tools: [{ name: 'sync', title: 'Sync', description: 'Syncs.', sideEffect: 'read' }],
}
const rawTools =
  "import { z } from 'zod'\nexport const tools = { sync: { input: z.object({}), output: z.object({}), run: async () => ({}) } }"

// A protocol adapter that may write INBOX: the case the check was written for.
const filer: ManifestInput = {
  ...mailbox,
  id: 'filer',
  name: 'Mail Filer',
  tools: [{ name: 'count', title: 'Count', description: 'Files INBOX.', sideEffect: 'write' }],
}

describe('XK-1 sign-in mail account vs. an INBOX writer of another kind holding the same item', () => {
  it('stops serving sign-in mail once a raw adapter is entrusted the same app password', async () => {
    const s = await setup()
    const mbHash = await s.install(packageOf(parseManifest(mailbox), { 'src/tools.ts': mailboxTools }))
    await s.api.credentials.make({
      adapterId: 'mailbox',
      adapterHash: mbHash,
      credential: 'mail',
      provider: 'onepassword-service-account',
      itemId: 'icloudmail',
    })
    expect(await s.api.grants.vaultItems('mail')).toEqual({
      status: 'ok',
      items: [{ id: 'mailbox/mail', title: 'Mailbox' }],
    })
    const rawHash = await s.install(packageOf(parseManifest(rawSync), { 'src/tools.ts': rawTools }))
    await s.api.credentials.make({
      adapterId: 'mailsync',
      adapterHash: rawHash,
      credential: 'mail',
      provider: 'onepassword-service-account',
      itemId: 'icloudmail',
    })
    // Same item (op://Valet/icloudmail) now held by an adapter whose code has the password and an
    // open path to imap.mail.me.com:993: it can plant a forged sign-in mail in INBOX.
    // SHOULD: the account is no longer offered, and a lookup gets no account.
    // TODAY: still offered, and mailAccount('mailbox/mail') still answers.
    expect(await s.api.grants.vaultItems('mail')).toEqual({ status: 'ok', items: [] })
    expect(await s.account('mailbox/mail')).toBeNull()
  }, 60_000)

  it('treats the same 1Password item granted as a Keychain copy as the same item', async () => {
    const s = await setup()
    const mbHash = await s.install(packageOf(parseManifest(mailbox), { 'src/tools.ts': mailboxTools }))
    await s.api.credentials.make({
      adapterId: 'mailbox',
      adapterHash: mbHash,
      credential: 'mail',
      provider: 'onepassword-service-account',
      itemId: 'icloudmail',
    })
    const filerHash = await s.install(packageOf(parseManifest(filer), { 'src/tools.ts': mailboxTools }))
    // Granted through the Keychain-copy provider: itemRef op://valetvault1/icloudmail, while the
    // mail account's is op://Valet/icloudmail. Same 1Password item, compared as different strings.
    await s.api.credentials.make({
      adapterId: 'filer',
      adapterHash: filerHash,
      credential: 'mail',
      provider: 'keychain-copy',
      itemId: 'valetvault1-icloudmail',
    })
    expect(await s.api.grants.vaultItems('mail')).toEqual({ status: 'ok', items: [] })
  }, 60_000)
})
