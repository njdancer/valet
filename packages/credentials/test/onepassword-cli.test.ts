import { inspect } from 'node:util'
import { CredentialError } from '@siteadapter/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyOpFailure, DEFAULT_OP_PATHS, OnePasswordCliProvider } from '../src/onepassword-cli'
import { type FakeChild, ManualTimers, scriptedSpawner } from './fake-process'

const CANARY = 'canary-pw-7f3a91c2'
const ITEM = 'op://siteadapter/Woolworths'
const OP_PATH = '/opt/homebrew/bin/op'
// op is "installed" at OP_PATH only. Lookup is injected, so no test looks at the disk.
const FOUND = { searchPath: null, isExecutable: async (path: string) => path === OP_PATH }

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    const secret = await provider.resolve(ITEM, 'password')
    expect(secret.reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(OP_PATH)
    expect(calls[0]?.args).toEqual(['read', '--no-newline', 'op://siteadapter/Woolworths/password'])
    expect(provider.kind).toBe('onepassword-cli')
  })

  it('maps username and otp to their op fields', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    await provider.resolve(ITEM, 'username')
    await provider.resolve(ITEM, 'otp')
    expect(calls.map((call) => call.args[2])).toEqual([
      'op://siteadapter/Woolworths/username',
      'op://siteadapter/Woolworths/one-time password?attribute=otp',
    ])
  })

  it('looks for op at Homebrew on Apple silicon, then on Intel, by default', () => {
    expect(DEFAULT_OP_PATHS).toEqual(['/opt/homebrew/bin/op', '/usr/local/bin/op'])
  })

  it('runs the first of its op paths that is executable, before looking at PATH', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const checked: string[] = []
    const provider = new OnePasswordCliProvider({
      searchPath: '/usr/bin',
      isExecutable: async (path) => {
        checked.push(path)
        return path === '/usr/local/bin/op' || path === '/usr/bin/op'
      },
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    expect(checked).toEqual(['/opt/homebrew/bin/op', '/usr/local/bin/op'])
    expect(calls[0]?.command).toBe('/usr/local/bin/op')
  })

  it('uses the op paths it was given instead of the defaults', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const checked: string[] = []
    const provider = new OnePasswordCliProvider({
      opPaths: ['/Applications/Tools/op'],
      searchPath: null,
      isExecutable: async (path) => {
        checked.push(path)
        return true
      },
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    expect(checked).toEqual(['/Applications/Tools/op'])
    expect(calls[0]?.command).toBe('/Applications/Tools/op')
  })

  it('falls back to PATH, and only to its absolute directories', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const checked: string[] = []
    const provider = new OnePasswordCliProvider({
      searchPath: '.::bin:./tools:/Users/someone/bin:/usr/bin',
      isExecutable: async (path) => {
        checked.push(path)
        return path === '/usr/bin/op'
      },
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    expect(checked).toEqual([...DEFAULT_OP_PATHS, '/Users/someone/bin/op', '/usr/bin/op'])
    expect(calls[0]?.command).toBe('/usr/bin/op')
  })

  it('never runs a relative op path, even one it was given or one that is executable', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const checked: string[] = []
    const provider = new OnePasswordCliProvider({
      opPaths: ['op', './op', 'bin/op'],
      searchPath: '.:bin',
      isExecutable: async (path) => {
        checked.push(path)
        return true
      },
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    expect(checked).toEqual([])
    expect(calls).toEqual([])
  })

  it('searches this process PATH by default', async () => {
    vi.stubEnv('PATH', '/stub/bin')
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const provider = new OnePasswordCliProvider({
      opPaths: [],
      isExecutable: async (path) => path === '/stub/bin/op',
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    expect(calls[0]?.command).toBe('/stub/bin/op')
  })

  it('reports unavailable without spawning when op is nowhere', async () => {
    vi.stubEnv('PATH', undefined)
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, CANARY))
    const provider = new OnePasswordCliProvider({
      isExecutable: async () => false,
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    expect(calls).toEqual([])
  })

  it('looks op up once and keeps using what it found', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    let checks = 0
    const provider = new OnePasswordCliProvider({
      ...FOUND,
      isExecutable: async (path) => {
        checks++
        return path === OP_PATH
      },
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    await provider.resolve(ITEM, 'username')
    expect(checks).toBe(1)
    expect(calls.map((call) => call.command)).toEqual([OP_PATH, OP_PATH])
  })

  it('looks again once the op it found has gone', async () => {
    let installed = OP_PATH
    const { spawner, calls } = scriptedSpawner((child, call) => {
      if (call.command === installed) child.finish(0, 'x')
      else
        queueMicrotask(() =>
          child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
        )
    })
    const provider = new OnePasswordCliProvider({
      searchPath: null,
      isExecutable: async (path) => path === installed,
      spawner,
      timers: new ManualTimers(),
    })
    await provider.resolve(ITEM, 'password')
    installed = '/usr/local/bin/op'
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
    await provider.resolve(ITEM, 'password')
    expect(calls.map((call) => call.command)).toEqual([OP_PATH, OP_PATH, '/usr/local/bin/op'])
  })

  it('wraps the bytes op wrote without copying them into a string', async () => {
    const written = Buffer.from(CANARY)
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', written)
        child.emit('close', 0)
      })
    })
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    const secret = await provider.resolve(ITEM, 'password')
    // The chunk op wrote is wiped once copied into the secret's own buffer.
    expect([...written].every((byte) => byte === 0)).toBe(true)
    secret.dispose()
    expect(secret.disposed).toBe(true)
  })

  it('rejects a malformed item reference as not-found without spawning', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, CANARY))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
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
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
  })

  it('reports an unanswered Touch ID prompt as locked after 60 seconds and kills op', async () => {
    const timers = new ManualTimers()
    let child: FakeChild | undefined
    const { spawner } = scriptedSpawner((c) => {
      child = c
    })
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers })
    const pending = provider.resolve(ITEM, 'password')
    // The op lookup comes first, so let it and the spawn happen.
    await new Promise((resolve) => setImmediate(resolve))
    expect([...timers.pending.values()][0]?.ms).toBe(60_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('locked')
    expect(child?.kills).toEqual(['SIGKILL'])
  })

  it('honours a custom timeout', async () => {
    const timers = new ManualTimers()
    const { spawner } = scriptedSpawner(() => {})
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers, timeoutMs: 5_000 })
    const pending = provider.resolve(ITEM, 'password')
    // The op lookup comes first, so let it and the spawn happen.
    await new Promise((resolve) => setImmediate(resolve))
    expect([...timers.pending.values()][0]?.ms).toBe(5_000)
    timers.fireAll()
    await failureOf(pending)
  })

  it('reports oversized output as unavailable', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, Buffer.alloc(64 * 1024 + 1, 0x41)))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    expect((await failureOf(provider.resolve(ITEM, 'password'))).failure).toBe('unavailable')
  })

  it('reports an empty value as field-missing', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, ''))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
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
      const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
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
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
    await failureOf(provider.resolve(ITEM, 'password'))
    expect([...written].every((byte) => byte === 0)).toBe(true)
  })

  it('keeps the secret, stderr and item names out of every error', async () => {
    const stderr = `[ERROR] could not read secret: "${CANARY}" isn't an item in the "PrivateVault" vault`
    const { spawner } = scriptedSpawner((child) => child.finish(1, CANARY, stderr))
    const provider = new OnePasswordCliProvider({ ...FOUND, spawner, timers: new ManualTimers() })
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
