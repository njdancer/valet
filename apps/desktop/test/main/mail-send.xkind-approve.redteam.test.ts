// @vitest-environment node
// Red team (cross-kind approvals): the second confirmation of an SMTP send is the one that binds
// the person's yes to the message itself (docs/adapter-kinds.md, workstream G decision 2). On the
// phone, the signed request's `preview` is all the person sees (CardModel.swift: "Sends" rows), and
// the request may be approved there (approvableOn: mac and phone). These tests check that the
// signed preview carries every recipient the message will be sent to.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfirmationRequest } from '@valet/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ApprovalBroker,
  FileAnchor,
  SoftwareSigner,
  softwareKeysAt,
} from '../../src/main/core/approvals'
import type { ConfirmationBroker } from '../../src/main/core/confirmations'
import { dataPaths } from '../../src/main/core/constants'
import { disabledOtpReader } from '../../src/main/core/credentials'
import { builtinAdapter } from '../../src/main/core/registry'
import { AppService } from '../../src/main/core/service'
import { disabledUpdates } from '../../src/main/core/updates'
import { FakeDriver, SHOP_FILES, shopDefinition } from './fixtures'
import { testCredentials } from './test-credentials'

const dirs: string[] = []
const services: AppService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function approvedShop() {
  const dir = mkdtempSync(join(tmpdir(), 'xkind-mail-'))
  dirs.push(dir)
  const signer = new SoftwareSigner(() => true, await softwareKeysAt(join(dir, 'approval-keys.json')))
  const driver = new FakeDriver()
  const adapter = builtinAdapter(shopDefinition(), SHOP_FILES)
  const noop = () => {}
  const service = new AppService({
    paths: dataPaths(join(dir, 'data')),
    version: '0.1.0',
    demo: true,
    now: () => Date.parse('2026-11-07T00:00:00.000Z'),
    timers: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    timeZone: 'UTC',
    sleep: async () => {},
    adapters: [adapter],
    createDriver: async () => driver,
    credentials: testCredentials(disabledOtpReader),
    approvalKeys: {
      signer,
      anchor: new FileAnchor(join(dir, 'anchor.json')),
      kind: 'software',
      forget: async () => {},
    },
    startEndpoint: async (_caller, clients) => {
      for (const client of clients)
        writeFileSync(
          client.configPath,
          JSON.stringify({ url: 'http://127.0.0.1:47000/mcp', token: 't'.repeat(43) }),
        )
      return {
        url: 'http://127.0.0.1:47000/mcp',
        port: 47000,
        refresh: () => [],
        addClient: async () => {},
        resetClient: async () => {},
        removeClient: async () => {},
        refuseClient: noop,
        clientIds: () => [],
        close: async () => {},
        sessions: () => ({ total: 0, bridge: 0, http: 0, sessions: [] }),
      }
    },
    ui: {
      writeClipboard: noop,
      openExternal: noop,
      showFolder: noop,
      chooseSaveFile: async () => null,
      chooseOpFile: async () => null,
      openControlPanel: noop,
      showConfirmation: noop,
      focusConfirmation: noop,
      closeConfirmation: noop,
      showNeedsUser: noop,
      closeNeedsUser: noop,
      setLaunchAtLogin: noop,
      quit: noop,
      relaunch: noop,
      notify: noop,
      closeNotification: noop,
      confirmErase: async () => false,
      clearBrowserData: async () => {},
      finishErase: noop,
    },
    emit: noop,
    bridge: (configPath) => ({ command: '/repo/tsx', args: ['/repo/bridge-cli.ts', configPath] }),
    claudeDesktopConfig: join(dir, 'Claude', 'claude_desktop_config.json'),
    checkOp: async () => null,
    updates: async () => disabledUpdates('0.1.0', 'development', false),
    pacingSleep: async () => {},
  })
  services.push(service)
  await service.start()
  await service.api.approvals.approve('shop', adapter.hash)
  const internals = service as unknown as { broker: ConfirmationBroker; approvalBroker: ApprovalBroker }
  return internals
}

/** Raises the `mail-send` confirmation the runtime raises for each message, and returns the signed preview. */
async function signedPreview(mail: Extract<ConfirmationRequest, { kind: 'mail-send' }>['mail']) {
  const s = await approvedShop()
  const controller = new AbortController()
  void s.broker.ask(
    {
      adapterId: 'shop',
      adapterName: 'Shop',
      tool: 'add',
      toolTitle: 'Add',
      callId: 'call_mail_1',
      client: 'Claude Code',
      kind: 'mail-send',
      mail,
    } as ConfirmationRequest,
    controller.signal,
  )
  const find = () =>
    s.approvalBroker.list().find((p) => p.request.kind === 'irreversible-call')?.request.subject as
      | { preview: string[] }
      | undefined
  await expect.poll(() => find()?.preview.length ?? 0).toBeGreaterThan(0)
  const preview = find()?.preview ?? []
  controller.abort()
  return preview
}

// 188 characters: within MAIL_LIMITS.address (190 since this fix), and longer than the old line could carry twice.
const long = (c: string) => `${c.repeat(64)}@${'d'.repeat(55)}.${'e'.repeat(55)}.example.com`

describe('mail-send: the phone’s signed preview binds every recipient', () => {
  it('shows a Bcc recipient that follows a long address', async () => {
    const preview = await signedPreview({
      endpoint: 'smtp.mail.me.com:587',
      to: ['ann@example.com'],
      cc: [],
      // Each address passes isMailAddress; the second is the attacker's.
      bcc: [long('a'), 'eve@evil.test'],
      subject: 'Lunch',
      text: 'See you at noon.',
      inReplyTo: null,
      references: [],
    })
    // What a phone approver reads: every recipient the envelope will carry should be on it.
    expect(preview.join('\n')).toContain('eve@evil.test')
  })

  it('shows every To recipient, not the first 200 characters of the line', async () => {
    const preview = await signedPreview({
      endpoint: 'smtp.mail.me.com:587',
      to: [long('b'), long('c'), 'boss@rival.test'],
      cc: [],
      bcc: [],
      subject: 'Q3 numbers',
      text: 'Attached below.',
      inReplyTo: null,
      references: [],
    })
    expect(preview.join('\n')).toContain('boss@rival.test')
  })

  it('declines a send whose recipients can’t all be shown, rather than show some', async () => {
    const s = await approvedShop()
    const controller = new AbortController()
    const answer = s.broker.ask(
      {
        adapterId: 'shop',
        adapterName: 'Shop',
        tool: 'add',
        toolTitle: 'Add',
        callId: 'call_mail_2',
        client: 'Claude Code',
        kind: 'mail-send',
        mail: {
          endpoint: 'smtp.mail.me.com:587',
          // 30 recipients and a subject: more lines than a signed preview holds.
          to: Array.from({ length: 29 }, (_, i) => `person${i}@example.com`),
          cc: [],
          bcc: ['eve@evil.test'],
          subject: 'Hello',
          text: 'Hi.',
          inReplyTo: null,
          references: [],
        },
      } as ConfirmationRequest,
      controller.signal,
    )
    await expect(answer).resolves.toBe('declined')
    expect(s.approvalBroker.list().some((p) => p.request.kind === 'irreversible-call')).toBe(false)
  })
})
