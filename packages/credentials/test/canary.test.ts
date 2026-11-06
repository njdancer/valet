// Seeds unique canary secrets through every provider, on success and failure paths, and checks that
// none reaches an error, a log line or stdio. The canaries are also checked to have been resolved, so
// the test can't pass by never touching them.

import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspect } from 'node:util'
import { type Grant, SecretValue } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeCredentialProvider } from '../src/fake'
import { FileGrantStore } from '../src/grant-store'
import { KeychainTokenSource } from '../src/keychain'
import { MessagesOtpReader } from '../src/messages-otp'
import { OnePasswordCliProvider } from '../src/onepassword-cli'
import { OnePasswordServiceAccountProvider } from '../src/onepassword-sdk'
import { CredentialResolver } from '../src/resolver'
import { ManualTimers, scriptedSpawner } from './fake-process'
import { archived } from './typedstream-fixture'

const PASSWORD = 'canary-pw-91e0d7b4'
const TOKEN = 'ops_canary-token-3c55aa10'
const CODE = '730194'
const CANARIES = [PASSWORD, TOKEN, CODE]

let output: string[]
let dir: string

beforeEach(async () => {
  output = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map((arg) => inspect(arg)).join(' '))
    })
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      output.push(String(chunk))
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof stream.write)
  }
  dir = await fs.mkdtemp(join(tmpdir(), 'siteadapter-canary-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

function rendered(error: unknown): string {
  if (!(error instanceof Error)) return inspect(error)
  return [error.message, String(error.stack), String(error), JSON.stringify(error), inspect(error)].join('\n')
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

function expectNoCanary(text: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary)
}

describe('canary secrets', () => {
  it('never appear in errors or output from the op CLI provider', async () => {
    const ok = new OnePasswordCliProvider({
      searchPath: null,
      isExecutable: async () => true,
      spawner: scriptedSpawner((child) => child.finish(0, PASSWORD)).spawner,
      timers: new ManualTimers(),
    })
    const value = await ok.resolve('op://siteadapter/Woolworths', 'password')
    expect(value.reveal((plaintext) => plaintext)).toBe(PASSWORD)
    expectNoCanary([String(value), JSON.stringify({ value }), inspect(value)].join('\n'))

    const failing = new OnePasswordCliProvider({
      searchPath: null,
      isExecutable: async () => true,
      spawner: scriptedSpawner((child) => child.finish(1, PASSWORD, `[ERROR] bad value ${PASSWORD}`)).spawner,
      timers: new ManualTimers(),
    })
    expectNoCanary(rendered(await caught(failing.resolve('op://siteadapter/Woolworths', 'password'))))
    expectNoCanary(output.join('\n'))
  })

  it('never appear in errors or output from the Keychain token source and service account provider', async () => {
    const tokenSource = new KeychainTokenSource({
      service: 'siteadapter',
      account: 'sa',
      spawner: scriptedSpawner((child) => child.finish(0, `${TOKEN}\n`)).spawner,
      timers: new ManualTimers(),
    })
    let seenToken = ''
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource,
      clientFactory: async (token) => {
        seenToken = token.reveal((plaintext) => plaintext)
        return {
          secrets: {
            resolve: async (reference) => {
              if (reference.endsWith('/password')) return PASSWORD
              throw new Error(`error resolving ${reference} with ${TOKEN}: no item matched ${PASSWORD}`)
            },
          },
        }
      },
      timers: new ManualTimers(),
    })
    const value = await provider.resolve('op://siteadapter/Woolworths', 'password')
    expect(value.reveal((plaintext) => plaintext)).toBe(PASSWORD)
    expect(seenToken).toBe(TOKEN)
    expectNoCanary(rendered(await caught(provider.resolve('op://siteadapter/Woolworths', 'username'))))

    const deniedKeychain = new KeychainTokenSource({
      service: 'siteadapter',
      account: 'sa',
      spawner: scriptedSpawner((child) => child.finish(128, TOKEN, `User canceled ${TOKEN}`)).spawner,
      timers: new ManualTimers(),
    })
    expectNoCanary(rendered(await caught(deniedKeychain.token())))
    expectNoCanary(output.join('\n'))
  })

  it('never appear in errors or output from the resolver', async () => {
    const resolver = new CredentialResolver([
      new FakeCredentialProvider({ items: { 'fake://woolworths': { password: PASSWORD } } }),
    ])
    const grant: Grant = {
      adapterId: 'woolworths',
      adapterHash: 'a'.repeat(64),
      secret: 'login',
      provider: 'fake',
      itemRef: 'fake://woolworths',
      origins: ['https://www.woolworths.com.au'],
      grantedAt: '2026-11-07T00:00:00.000Z',
    }
    expect((await resolver.resolve(grant, 'password')).reveal((plaintext) => plaintext)).toBe(PASSWORD)
    expectNoCanary(rendered(await caught(resolver.resolve(grant, 'otp'))))
    expectNoCanary(
      rendered(await caught(resolver.resolve({ ...grant, provider: 'onepassword-cli' }, 'password'))),
    )
    expectNoCanary(output.join('\n'))
  })

  it('never appear in errors or output from the Messages reader', async () => {
    const path = join(dir, 'chat.db')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT NOT NULL);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER, is_from_me INTEGER);
      INSERT INTO handle (ROWID, id, service) VALUES (1, 'Woolworths', 'SMS');
    `)
    const date = BigInt(Date.parse('2026-11-07T00:09:00Z') - Date.UTC(2001, 0, 1)) * 1_000_000n
    db.prepare(
      'INSERT INTO message (text, attributedBody, handle_id, date, is_from_me) VALUES (?, ?, 1, ?, 0)',
    ).run(null, archived(`Your code is ${CODE}`), date)
    db.close()
    const reader = new MessagesOtpReader({ path, now: () => new Date('2026-11-07T00:10:00Z') })
    const query = { sender: 'Woolworths', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 }
    const code = await reader.latest(query, new Date('2026-11-07T00:08:00Z'))
    expect(code.reveal((plaintext) => plaintext)).toBe(CODE)
    expectNoCanary(inspect(code))
    expectNoCanary(rendered(await caught(reader.latest({ ...query, sender: 'Coles' }, new Date(0)))))
    expectNoCanary(rendered(await caught(reader.latest({ ...query, pattern: `(${CODE}` }, new Date(0)))))
    expectNoCanary(output.join('\n'))
  })

  it('never appear in the grant store, which holds item references only', async () => {
    const path = join(dir, 'grants.json')
    const store = new FileGrantStore({ path })
    await store.put({
      adapterId: 'woolworths',
      adapterHash: 'a'.repeat(64),
      secret: 'login',
      provider: 'onepassword-cli',
      itemRef: 'op://siteadapter/Woolworths',
      origins: ['https://www.woolworths.com.au'],
      grantedAt: '2026-11-07T00:00:00.000Z',
    })
    // A rejected grant's contents are never echoed back in the error or written to the file.
    const error = await caught(store.put({ itemRef: PASSWORD } as unknown as Grant))
    expectNoCanary(rendered(error))
    expectNoCanary(await fs.readFile(path, 'utf8'))
    expectNoCanary(output.join('\n'))
  })

  it('the SecretValue wrapper itself does not leak through the helpers that log values', () => {
    const value = SecretValue.fromString(PASSWORD)
    console.log('resolved', value, { value })
    expectNoCanary(output.join('\n'))
    expect(output.join('\n')).toContain('[secret]')
  })
})
