// ctx.smtp through the tool host: a protocol adapter's irreversible tool sends mail, the host builds
// GuardedSmtp for the call, the person is asked about the exact message, and only then does the
// backend sign in through the call's CredentialGate. The backend is a fake that records what it was
// given; packages/protocols tests the real one against an SMTP server.

import { join } from 'node:path'
import {
  type CredentialGrant,
  defineAdapter,
  parseManifest,
  SecretValue,
  type ToolContext,
  tool,
} from '@valet/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { SmtpBackend, SmtpCall } from '../src/guarded-smtp'
import { noBrowserDriver } from '../src/no-browser-driver'
import { type CredentialGrantSource, ToolHost, type ToolIsolation } from '../src/tool-host'
import type { AuthRunner, ConfirmationAnswer, ConfirmationPrompt, ConfirmationRequest } from '../src/types'
import { FakeClock, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'
import { inMemory, scriptFor } from './isolation/processes'

const HASH = 'f'.repeat(64)
const PASSWORD = 'abcd-efgh-ijkl-mnop'
const ENDPOINT = 'smtp.mail.me.com:587'

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'icloud-send',
  name: 'iCloud Send',
  version: '0.1.0',
  description: 'A protocol adapter that sends mail',
  runtime: 'protocol',
  protocols: { smtp: { endpoint: ENDPOINT, credential: 'mail', recipients: ['@example.com'] } },
  credentials: {
    mail: {
      description: 'Your iCloud app-specific password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'smtp', endpoint: ENDPOINT },
    },
  },
  tools: [
    { name: 'send_mail', title: 'Send mail', description: 'Sends', sideEffect: 'irreversible' },
    { name: 'draft', title: 'Draft', description: 'Drafts', sideEffect: 'write' },
  ],
  limits: { requestsPerRun: 3, minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 600 },
})

let body: (ctx: ToolContext) => Promise<unknown> = async () => null
const definition = defineAdapter({
  manifest,
  tools: {
    send_mail: tool({
      input: z.object({ do: z.string().optional() }),
      output: z.unknown(),
      run: (ctx) => body(ctx),
    }),
    draft: tool({
      input: z.object({ do: z.string().optional() }),
      output: z.unknown(),
      run: (ctx) => body(ctx),
    }),
  },
})

const grant: CredentialGrant = {
  adapterId: 'icloud-send',
  adapterHash: HASH,
  credential: 'mail',
  kind: 'password',
  custody: 'kept',
  provider: 'keychain-copy',
  itemRef: 'keychain:icloud-send',
  targets: [ENDPOINT],
  grantedAt: '2026-11-17T00:00:00.000Z',
}

/** Answers the tool's own confirmation with `tool`, and each mail-send with `mail`. */
class SplitPrompt implements ConfirmationPrompt {
  tool: ConfirmationAnswer = 'approved'
  mail: ConfirmationAnswer = 'approved'
  readonly requests: ConfirmationRequest[] = []
  async ask(request: ConfirmationRequest): Promise<ConfirmationAnswer> {
    this.requests.push(request)
    return request.kind === 'mail-send' ? this.mail : this.tool
  }
}

const MAIL = { to: ['ann@example.com'], subject: 'Hello', text: 'Hi Ann' }

function backend(answer: (password: string) => number = () => 1) {
  const sent: { message: unknown; messageId: string }[] = []
  const events: string[] = []
  const b: SmtpBackend = {
    endpoint: ENDPOINT,
    recipients: ['@example.com'],
    connect: async (call: SmtpCall) => {
      events.push('connect')
      const values = await call.signIn()
      const password = values.secret.reveal((v) => v)
      return {
        send: async ({ message, messageId }) => {
          events.push('send')
          sent.push({ message, messageId })
          return { accepted: answer(password) }
        },
        end: async () => {
          events.push('end')
        },
      }
    },
  }
  return { b, sent, events }
}

function setup(options: { grants?: null; isolation?: ToolIsolation } = {}) {
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const prompt = new SplitPrompt()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'icloud-send' && hash === HASH },
    audit,
    prompt,
    authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    sleep: clock.sleep,
    pacingSleep: clock.pacingSleep,
  })
  const grants: CredentialGrantSource = {
    findGrant: async (credential) => (credential === 'mail' ? grant : null),
    resolve: async (_grant, field) =>
      SecretValue.fromString(field === 'username' ? 'nick@icloud.test' : PASSWORD),
  }
  const fake = backend((password) => (password === PASSWORD ? 1 : 0))
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    smtp: fake.b,
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    ...(options.grants === null ? {} : { credentialGrants: grants }),
  })
  let n = 0
  const run = (name: 'send_mail' | 'draft' = 'send_mail', input: unknown = {}) =>
    host.call({ adapterId: 'icloud-send', tool: name, input, client: 'claude-code', callId: `c-${++n}` })
  const mailAsks = () => prompt.requests.filter((r) => r.kind === 'mail-send')
  return { run, audit, prompt, mailAsks, ...fake }
}

beforeEach(() => {
  body = async () => null
})

describe('ctx.smtp through the tool host', () => {
  it('asks about the exact message, then signs in and sends once', async () => {
    body = async (ctx) => ctx.smtp?.send({ ...MAIL, bcc: ['bo@example.com'] })
    const t = setup()
    const result = await t.run()
    expect(result).toMatchObject({ status: 'ok', output: { accepted: 1 } })
    expect(t.mailAsks()).toEqual([
      expect.objectContaining({
        kind: 'mail-send',
        adapterId: 'icloud-send',
        tool: 'send_mail',
        mail: {
          endpoint: ENDPOINT,
          to: ['ann@example.com'],
          cc: [],
          bcc: ['bo@example.com'],
          subject: 'Hello',
          text: 'Hi Ann',
          inReplyTo: null,
          references: [],
        },
      }),
    ])
    expect(t.events).toEqual(['connect', 'send', 'end'])
    const messageId = (result as { output: { messageId: string } }).output.messageId
    expect(messageId).toMatch(/^<[0-9a-f-]{36}@smtp\.mail\.me\.com>$/)
    expect(t.sent[0]?.messageId).toBe(messageId)
    expect(t.audit.events.filter((e) => e.type === 'secret-used')).not.toHaveLength(0)
  })

  it('sends nothing on a decline, and the tool fails declined', async () => {
    body = async (ctx) => ctx.smtp?.send(MAIL)
    const t = setup()
    t.prompt.mail = 'declined'
    expect(await t.run()).toMatchObject({ status: 'failed', stage: 'confirm', errorClass: 'declined' })
    expect(t.events).toEqual([])
  })

  it('sends nothing on a time-out', async () => {
    body = async (ctx) => ctx.smtp?.send(MAIL)
    const t = setup()
    t.prompt.mail = 'timed-out'
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'timed-out' })
    expect(t.events).toEqual([])
  })

  it('can’t catch a decline and send anyway', async () => {
    body = async (ctx) => {
      await ctx.smtp?.send(MAIL).catch(() => undefined)
      return ctx.smtp?.send({ ...MAIL, subject: 'Second try' })
    }
    const t = setup()
    t.prompt.mail = 'declined'
    await t.run()
    // Each send asks on its own; neither is sent.
    expect(t.events).toEqual([])
  })

  it('asks again for each send: one approval never covers another message', async () => {
    body = async (ctx) => {
      await ctx.smtp?.send(MAIL)
      return ctx.smtp?.send({ ...MAIL, subject: 'Again' })
    }
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'ok' })
    expect(t.mailAsks().map((r) => (r.kind === 'mail-send' ? r.mail.subject : ''))).toEqual([
      'Hello',
      'Again',
    ])
    expect(t.events).toEqual(['connect', 'send', 'end', 'connect', 'send', 'end'])
  })

  it('refuses a send from a write tool before asking, audited and sticky', async () => {
    body = async (ctx) => {
      await ctx.smtp?.send(MAIL).catch(() => undefined)
      return 'kept going'
    }
    const t = setup()
    expect(await t.run('draft')).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(t.mailAsks()).toEqual([])
    expect(t.events).toEqual([])
    expect(t.audit.events).toContainEqual(
      expect.objectContaining({
        type: 'request-blocked',
        method: 'SMTP',
        target: `smtp://${ENDPOINT}/send`,
        reason: 'command-not-allowed',
      }),
    )
  })

  it('refuses a recipient off the manifest’s list, Bcc included, before asking', async () => {
    body = async (ctx) => ctx.smtp?.send({ ...MAIL, bcc: ['eve@evil.test'] })
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(t.mailAsks()).toEqual([])
    expect(t.events).toEqual([])
  })

  it('refuses a subdomain of an allowed domain', async () => {
    body = async (ctx) => ctx.smtp?.send({ ...MAIL, to: ['ann@mail.example.com'] })
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
  })

  it.each([
    ['a header in the subject', { ...MAIL, subject: 'Hi\r\nBcc: eve@example.com' }],
    ['a second address in one', { ...MAIL, to: ['ann@example.com,eve@example.com'] }],
    ['a display name', { ...MAIL, to: ['Ann <ann@example.com>'] }],
    ['an extra header', { ...MAIL, headers: { Bcc: 'eve@example.com' } }],
    ['a bidi override in the subject', { ...MAIL, subject: 'Invoice ‮fdp.exe' }],
    ['a forged Message-ID reply', { ...MAIL, inReplyTo: '<a@b>\r\nBcc: eve@example.com' }],
  ])('refuses %s as invalid, without asking', async (_name, mail) => {
    body = async (ctx) => ctx.smtp?.send(mail as never)
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'invalid' })
    expect(t.mailAsks()).toEqual([])
    expect(t.events).toEqual([])
  })

  it('counts sends against the run’s request ceiling', async () => {
    body = async (ctx) => {
      for (let i = 0; i < 4; i++) await ctx.smtp?.send({ ...MAIL, subject: `n${i}` })
      return 'all sent'
    }
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'request-ceiling' })
    expect(t.sent).toHaveLength(3)
  })

  it('shows References to the person, as sent', async () => {
    body = async (ctx) => ctx.smtp?.send({ ...MAIL, references: ['<other-thread@example.com>'] })
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'ok' })
    const [ask] = t.mailAsks()
    expect(ask?.kind === 'mail-send' ? ask.mail.references : null).toEqual(['<other-thread@example.com>'])
  })

  it('holds an in-process list to what was checked, whatever its iterator says', async () => {
    body = async (ctx) => {
      const to = ['ann@example.com']
      Object.defineProperty(to, Symbol.iterator, {
        value: function* () {
          yield 'eve@evil.test>\r\nRCPT TO:<x@example.com'
        },
      })
      return ctx.smtp?.send({ ...MAIL, to })
    }
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'invalid' })
    expect(t.mailAsks()).toEqual([])
    expect(t.events).toEqual([])
  })

  it('asks about one send at a time, even when tool code sends two at once', async () => {
    let open = 0
    let most = 0
    body = async (ctx) =>
      Promise.all([ctx.smtp?.send(MAIL), ctx.smtp?.send({ ...MAIL, text: 'Second\n\n\nP.S. more' })])
    const t = setup()
    const ask = t.prompt.ask.bind(t.prompt)
    t.prompt.ask = async (r) => {
      open++
      most = Math.max(most, open)
      await new Promise((done) => setTimeout(done, 10))
      const answer = await ask(r)
      open--
      return answer
    }
    expect(await t.run()).toMatchObject({ status: 'ok' })
    expect(most).toBe(1)
    expect(t.events).toEqual(['connect', 'send', 'end', 'connect', 'send', 'end'])
  })

  it('takes the password back out of anything the server echoes', async () => {
    body = async (ctx) => ctx.smtp?.send(MAIL)
    const t = setup()
    const result = await t.run()
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    expect(JSON.stringify(t.prompt.requests)).not.toContain(PASSWORD)
  })

  it('is not-granted without a grant, after the person said yes, and sends nothing', async () => {
    body = async (ctx) => ctx.smtp?.send(MAIL)
    const t = setup({ grants: null })
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(t.sent).toEqual([])
  })

  it('gives an adapter registered without a backend no SMTP', async () => {
    body = async (ctx) => ctx.smtp?.send(MAIL)
    const clock = new FakeClock()
    const host = new ToolHost({
      approvals: { isApproved: async () => true },
      audit: new MemoryAudit(),
      prompt: new SplitPrompt(),
      authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
      markers: new MemoryMarkers(() => clock.now()),
      breakerStore: new MemoryJsonStore(),
      clock,
      sleep: clock.sleep,
      pacingSleep: clock.pacingSleep,
    })
    host.register({ definition, bundleHash: HASH, driver: noBrowserDriver() })
    const result = await host.call({
      adapterId: 'icloud-send',
      tool: 'send_mail',
      input: {},
      client: 'claude-code',
      callId: 'x',
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
  })
})

describe('ctx.smtp from an isolated tool process', () => {
  const SMTP_TOOLS = join(import.meta.dirname, 'isolation', 'smtp-tools.ts')
  const isolated = async () => {
    const processes = inMemory()
    const world = setup({ isolation: { script: await scriptFor(SMTP_TOOLS), start: processes.start } })
    return {
      ...world,
      call: (what: string, name: 'send_mail' | 'draft' = 'send_mail') => world.run(name, { do: what }),
    }
  }

  it('sends across the channel, after the person’s yes', async () => {
    const w = await isolated()
    expect(await w.call('')).toMatchObject({ status: 'ok', output: { accepted: 1 } })
    expect(w.mailAsks()).toHaveLength(1)
    expect(w.sent).toHaveLength(1)
  })

  it('refuses a send from a write tool on the host side', async () => {
    const w = await isolated()
    expect(await w.call('', 'draft')).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(w.events).toEqual([])
  })

  it('refuses header injection and extra headers on the host side', async () => {
    const w = await isolated()
    expect(await w.call('header')).toMatchObject({ status: 'failed', errorClass: 'invalid' })
    expect(await w.call('extra')).toMatchObject({ status: 'failed', errorClass: 'invalid' })
    expect(w.events).toEqual([])
  })

  it('has no way to write a raw command', async () => {
    const w = await isolated()
    expect(await w.call('raw')).toEqual({ status: 'ok', output: 'no raw op' })
    expect(w.events).toEqual([])
  })
})
