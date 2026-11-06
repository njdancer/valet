import { inspect } from 'node:util'
import { CredentialError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { classifyOpFailure, OnePasswordCliProvider } from '../src/onepassword-cli'
import { type FakeChild, ManualTimers, scriptedSpawner } from './fake-process'

const CANARY = 'canary-pw-7f3a91c2'
const ITEM = 'op://siteadapter/Woolworths'

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

describe('OnePasswordCliProvider', () => {
  it('runs op read with the reference as a single argument and wraps stdout', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, CANARY))
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    const secret = await provider.resolve(ITEM, 'password')
    expect(secret.reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('op')
    expect(calls[0]?.args).toEqual(['read', '--no-newline', 'op://siteadapter/Woolworths/password'])
    expect(provider.kind).toBe('onepassword-cli')
  })

  it('maps username and otp to their op fields', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    await provider.resolve(ITEM, 'username')
    await provider.resolve(ITEM, 'otp')
    expect(calls.map((call) => call.args[2])).toEqual([
      'op://siteadapter/Woolworths/username',
      'op://siteadapter/Woolworths/one-time password?attribute=otp',
    ])
  })

  it('uses the op path it was given', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const provider = new OnePasswordCliProvider({
      opPath: '/opt/homebrew/bin/op',
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    expect(calls[0]?.command).toBe('/opt/homebrew/bin/op')
  })

  it('wraps the bytes op wrote without copying them into a string', async () => {
    const written = Buffer.from(CANARY)
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', written)
        child.emit('close', 0)
      })
    })
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    const secret = await provider.resolve(ITEM, 'password')
    // The chunk op wrote is wiped once copied into the secret's own buffer.
    expect([...written].every((byte) => byte === 0)).toBe(true)
    secret.dispose()
    expect(secret.disposed).toBe(true)
  })

  it('rejects a malformed item reference as not-found without spawning', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, CANARY))
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    for (const bad of [
      'op://siteadapter/Woolworths/password',
      'op://siteadapter/Woolworths?attribute=otp',
      'op://siteadapter',
      'siteadapter/Woolworths',
      'op://siteadapter/Woolworths\n--account=evil',
      '',
    ]) {
      expect((await failureOf(provider.resolve(bad, 'password'))).failure).toBe('not-found')
    }
    expect(calls).toHaveLength(0)
  })

  it('reports a missing op binary as unavailable', async () => {
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })),
      )
    })
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
  })

  it('reports an unanswered Touch ID prompt as locked after 60 seconds and kills op', async () => {
    const timers = new ManualTimers()
    let child: FakeChild | undefined
    const { spawner } = scriptedSpawner((c) => {
      child = c
    })
    const provider = new OnePasswordCliProvider({ spawner, timers })
    const pending = provider.resolve(ITEM, 'password')
    await Promise.resolve()
    expect([...timers.pending.values()][0]?.ms).toBe(60_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('locked')
    expect(child?.kills).toEqual(['SIGKILL'])
  })

  it('honours a custom timeout', async () => {
    const timers = new ManualTimers()
    const { spawner } = scriptedSpawner(() => {})
    const provider = new OnePasswordCliProvider({ spawner, timers, timeoutMs: 5_000 })
    const pending = provider.resolve(ITEM, 'password')
    await Promise.resolve()
    expect([...timers.pending.values()][0]?.ms).toBe(5_000)
    timers.fireAll()
    await failureOf(pending)
  })

  it('reports oversized output as unavailable', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, Buffer.alloc(64 * 1024 + 1, 0x41)))
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
  })

  it('reports an empty value as field-missing', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, ''))
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.resolve(ITEM, 'otp'))).failure).toBe('field-missing')
  })

  it('classifies op failures from stderr', async () => {
    const cases: [string, CredentialError['failure']][] = [
      [
        '[ERROR] 2026/11/07 00:00:00 You are not currently signed in. Please run `op signin --help` for instructions',
        'locked',
      ],
      ['[ERROR] 2026/11/07 00:00:00 authorization prompt dismissed, please try again', 'locked'],
      [
        '[ERROR] 2026/11/07 00:00:00 error initializing client: connecting to desktop app: read: timeout',
        'locked',
      ],
      ['[ERROR] 2026/11/07 00:00:00 1Password is locked', 'locked'],
      [
        `[ERROR] 2026/11/07 00:00:00 could not read secret '${ITEM}/password': could not get item: "Woolworths" isn't an item in the "siteadapter" vault. Specify the item with its UUID, name, or domain.`,
        'not-found',
      ],
      [
        `[ERROR] 2026/11/07 00:00:00 could not read secret '${ITEM}/password': "siteadapter" isn't a vault in this account. Specify the vault with its ID or name.`,
        'not-found',
      ],
      [
        `[ERROR] 2026/11/07 00:00:00 could not read secret '${ITEM}/one-time password?attribute=otp': item 'siteadapter/Woolworths' does not have a field 'one-time password'`,
        'field-missing',
      ],
      ['[ERROR] 2026/11/07 00:00:00 no field matched the secret reference', 'field-missing'],
      ['[ERROR] 2026/11/07 00:00:00 something new and unexpected', 'unavailable'],
      ['', 'unavailable'],
    ]
    for (const [stderr, expected] of cases) {
      const { spawner } = scriptedSpawner((child) => child.finish(1, '', stderr))
      const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
      const field = stderr.includes('one-time') ? 'otp' : 'password'
      expect([stderr, (await failureOf(provider.resolve(ITEM, field))).failure]).toEqual([stderr, expected])
    }
  })

  it('zeroes stdout from a failed run', async () => {
    const written = Buffer.from(CANARY)
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', written)
        child.emit('close', 1)
      })
    })
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    await failureOf(provider.resolve(ITEM, 'password'))
    expect([...written].every((byte) => byte === 0)).toBe(true)
  })

  it('keeps the secret, stderr and item names out of every error', async () => {
    const stderr = `[ERROR] could not read secret: "${CANARY}" isn't an item in the "PrivateVault" vault`
    const { spawner } = scriptedSpawner((child) => child.finish(1, CANARY, stderr))
    const provider = new OnePasswordCliProvider({ spawner, timers: new ManualTimers() })
    const error = await failureOf(provider.resolve('op://PrivateVault/Woolworths', 'password'))
    const rendered = [
      error.message,
      String(error.stack),
      String(error),
      JSON.stringify(error),
      inspect(error),
    ].join('\n')
    expect(rendered).not.toContain(CANARY)
    expect(rendered).not.toContain('Woolworths')
    expect(rendered).not.toContain('PrivateVault')
  })
})

describe('classifyOpFailure', () => {
  it('ignores what the person named their vault, item or field', () => {
    // An item called "not signed in" must not turn a missing item into a lock prompt.
    expect(
      classifyOpFailure(
        `"not signed in" isn't an item in the "locked" vault`,
        'op://locked/not signed in/password',
      ),
    ).toBe('not-found')
    expect(classifyOpFailure(`could not read secret 'op://v/locked/password': no field matched`, 'x')).toBe(
      'field-missing',
    )
  })

  it('strips the reference itself even when unquoted', () => {
    const reference = 'op://dismissed/timeout/password'
    expect(classifyOpFailure(`could not read ${reference}: no item matched`, reference)).toBe('not-found')
  })

  it('treats a word that merely contains a keyword as no match', () => {
    expect(classifyOpFailure('unknown failure', 'x')).toBe('unavailable')
    expect(classifyOpFailure('casino field', 'x')).toBe('unavailable')
  })
})
