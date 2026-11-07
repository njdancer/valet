import { inspect } from 'node:util'
import { CredentialError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { KeychainTokenSource } from '../src/keychain'
import { type FakeChild, ManualTimers, scriptedSpawner } from './fake-process'

const CANARY = 'ops_canary-token-5d2e8b1f'

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

describe('KeychainTokenSource', () => {
  it('reads the token with security find-generic-password -w and strips the newline', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, `${CANARY}\n`))
    const source = new KeychainTokenSource({
      service: 'valet',
      account: 'op-sa',
      spawner,
      timers: new ManualTimers(),
    })
    const token = await source.token()
    expect(token.reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(calls[0]?.command).toBe('/usr/bin/security')
    expect(calls[0]?.args).toEqual(['find-generic-password', '-s', 'valet', '-a', 'op-sa', '-w'])
  })

  it('keeps a token that has no trailing newline intact', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, CANARY))
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    expect((await source.token()).reveal((plaintext) => plaintext)).toBe(CANARY)
  })

  it('strips exactly one newline', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, `${CANARY}\n\n`))
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    expect((await source.token()).reveal((plaintext) => plaintext)).toBe(`${CANARY}\n`)
  })

  it('zeroes the raw output once the token is copied out', async () => {
    const written = Buffer.from(`${CANARY}\n`)
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', written)
        child.emit('close', 0)
      })
    })
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    await source.token()
    expect([...written].every((byte) => byte === 0)).toBe(true)
  })

  it('uses the security path it was given', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(0, 'x'))
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      securityPath: '/opt/security',
      spawner,
      timers: new ManualTimers(),
    })
    await source.token()
    expect(calls[0]?.command).toBe('/opt/security')
  })

  it('reports a hung approval prompt as locked after 30 seconds and kills security', async () => {
    const timers = new ManualTimers()
    let child: FakeChild | undefined
    const { spawner } = scriptedSpawner((c) => {
      child = c
    })
    const source = new KeychainTokenSource({ service: 's', account: 'a', spawner, timers })
    const pending = source.token()
    await Promise.resolve()
    expect([...timers.pending.values()][0]?.ms).toBe(30_000)
    timers.fireAll()
    expect((await failureOf(pending)).failure).toBe('locked')
    expect(child?.kills).toEqual(['SIGKILL'])
  })

  it('honours a custom timeout', async () => {
    const timers = new ManualTimers()
    const { spawner } = scriptedSpawner(() => {})
    const source = new KeychainTokenSource({ service: 's', account: 'a', spawner, timers, timeoutMs: 1_000 })
    const pending = source.token()
    await Promise.resolve()
    expect([...timers.pending.values()][0]?.ms).toBe(1_000)
    timers.fireAll()
    await failureOf(pending)
  })

  it('reports a missing item as not-found', async () => {
    const { spawner } = scriptedSpawner((child) =>
      child.finish(
        44,
        '',
        'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
      ),
    )
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(source.token())).failure).toBe('not-found')
  })

  it('reports not-found from stderr even with an unexpected exit status', async () => {
    const { spawner } = scriptedSpawner((child) =>
      child.finish(1, '', 'The specified item could not be found in the keychain.'),
    )
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(source.token())).failure).toBe('not-found')
  })

  it('reports an empty token as not-found', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, '\n'))
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    expect((await failureOf(source.token())).failure).toBe('not-found')
  })

  it('reports a cancelled or denied prompt as locked', async () => {
    for (const stderr of [
      'security: SecKeychainSearchCopyNext: User canceled the operation.',
      'security: SecKeychainItemCopyContent: User interaction is not allowed.',
      'security: The authorization was denied.',
    ]) {
      const { spawner } = scriptedSpawner((child) => child.finish(128, '', stderr))
      const source = new KeychainTokenSource({
        service: 's',
        account: 'a',
        spawner,
        timers: new ManualTimers(),
      })
      expect([stderr, (await failureOf(source.token())).failure]).toEqual([stderr, 'locked'])
    }
  })

  it('reports anything else, a missing binary and oversized output as unavailable', async () => {
    const scripts: ((child: FakeChild) => void)[] = [
      (child) => child.finish(1, '', 'security: something unexpected'),
      (child) =>
        queueMicrotask(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))),
      (child) => child.finish(0, Buffer.alloc(16 * 1024 + 1, 0x41)),
    ]
    for (const script of scripts) {
      const { spawner } = scriptedSpawner(script)
      const source = new KeychainTokenSource({
        service: 's',
        account: 'a',
        spawner,
        timers: new ManualTimers(),
      })
      expect((await failureOf(source.token())).failure).toBe('unavailable')
    }
  })

  it('keeps the token out of errors and zeroes it when security fails', async () => {
    const written = Buffer.from(CANARY)
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', written)
        child.stderr.emit('data', Buffer.from(`failed reading ${CANARY}`))
        child.emit('close', 1)
      })
    })
    const source = new KeychainTokenSource({
      service: 's',
      account: 'a',
      spawner,
      timers: new ManualTimers(),
    })
    const error = await failureOf(source.token())
    expect(
      [error.message, String(error.stack), inspect(error), JSON.stringify(error)].join('\n'),
    ).not.toContain(CANARY)
    expect([...written].every((byte) => byte === 0)).toBe(true)
  })
})
