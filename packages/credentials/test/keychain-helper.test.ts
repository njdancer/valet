import { inspect } from 'node:util'
import { CredentialError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  HelperKeychainTokenSource,
  isKeychainService,
  KEYCHAIN_EXIT,
  KeychainHelper,
} from '../src/keychain-helper'
import { fakeKeychain } from './fake-keychain'
import { ManualTimers, scriptedSpawner } from './fake-process'

const HELPER = '/Applications/Valet.app/Contents/MacOS/valet-keychain'
const CANARY = 'canary-pw-3c71a9e4'

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

function helperWith(spawner: ReturnType<typeof fakeKeychain>['spawner'], timers = new ManualTimers()) {
  return new KeychainHelper({ helperPath: HELPER, spawner, timers })
}

describe('KeychainHelper', () => {
  it('writes the secret on stdin, never in argv, and reads it back exactly', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    await helper.write('valet.copy', 'op://v/i#password', Buffer.from(CANARY), '{"v":1}')
    const write = keychain.calls[0]
    expect(write?.command).toBe(HELPER)
    expect(write?.args).toEqual(['write', 'valet.copy', 'op://v/i#password', '{"v":1}'])
    expect(write?.input).toBe(true)
    expect(write?.args.join(' ')).not.toContain(CANARY)
    const secret = await helper.read('valet.copy', 'op://v/i#password')
    expect(secret.reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(keychain.calls[1]?.input).toBe(false)
  })

  it('zeroes the buffer it was given once the write is done, and when it is refused', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    const given = Buffer.from(CANARY)
    await helper.write('valet.copy', 'a', given, '')
    expect(given.every((byte) => byte === 0)).toBe(true)
    expect(keychain.get('valet.copy', 'a')?.secret.toString()).toBe(CANARY)

    const refused = Buffer.from(CANARY)
    expect((await failureOf(helper.write('login', 'a', refused, ''))).failure).toBe('not-found')
    expect(refused.every((byte) => byte === 0)).toBe(true)
  })

  it('refuses an empty or oversized secret, and a comment with control characters, before running', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    await failureOf(helper.write('valet', 'a', Buffer.alloc(0), ''))
    await failureOf(helper.write('valet', 'a', Buffer.alloc(16 * 1024 + 1, 1), ''))
    await failureOf(helper.write('valet', 'a', Buffer.from('x'), 'line\nbreak'))
    expect(keychain.calls).toHaveLength(0)
  })

  it('only reaches valet services and printable accounts', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    for (const [service, account] of [
      ['login', 'a'],
      ['valetx', 'a'],
      ['valet.', 'a'],
      ['valet', ''],
      ['valet', 'a\u0000b'],
      ['valet', 'x'.repeat(513)],
    ] as const) {
      expect((await failureOf(helper.read(service, account))).failure).toBe('not-found')
    }
    expect(keychain.calls).toHaveLength(0)
    expect(isKeychainService('valet.copy.dev')).toBe(true)
  })

  it('maps the exit codes: not found, the Keychain wanting the person, refused callers', async () => {
    const codes: Record<string, number> = {
      a: KEYCHAIN_EXIT.notFound,
      b: KEYCHAIN_EXIT.interaction,
      c: KEYCHAIN_EXIT.refused,
      d: 1,
    }
    const keychain = fakeKeychain({ exitCode: (args) => codes[args[2] ?? ''] })
    const helper = helperWith(keychain.spawner)
    expect((await failureOf(helper.read('valet', 'a'))).failure).toBe('not-found')
    expect((await failureOf(helper.read('valet', 'b'))).failure).toBe('locked')
    expect((await failureOf(helper.read('valet', 'c'))).failure).toBe('unavailable')
    expect((await failureOf(helper.read('valet', 'd'))).failure).toBe('unavailable')
  })

  it('treats an empty read as no item', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(0, ''))
    expect((await failureOf(helperWith(spawner).read('valet', 'a'))).failure).toBe('not-found')
  })

  it('reports an unanswered Keychain prompt as locked, and kills the helper', async () => {
    const timers = new ManualTimers()
    const { spawner, calls } = scriptedSpawner(() => {})
    const pending = failureOf(helperWith(spawner, timers).read('valet', 'a'))
    await Promise.resolve()
    timers.fireAll()
    expect((await pending).failure).toBe('locked')
    expect(calls[0]?.child.kills).toEqual(['SIGKILL'])
  })

  it('reports a missing helper as unavailable', async () => {
    const spawner = () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    expect((await failureOf(helperWith(spawner).read('valet', 'a'))).failure).toBe('unavailable')
  })

  it('reads comments without the secret, and says null for no item', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    expect(await helper.info('valet.copy', 'a')).toBeNull()
    await helper.write('valet.copy', 'a', Buffer.from(CANARY), 'the comment')
    expect(await helper.info('valet.copy', 'a')).toBe('the comment')
    expect(keychain.calls.at(-1)?.args[0]).toBe('info')
  })

  it('deletes, and a missing item is not an error', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    await helper.write('valet.copy', 'a', Buffer.from(CANARY), '')
    await helper.delete('valet.copy', 'a')
    await helper.delete('valet.copy', 'a')
    expect(keychain.get('valet.copy', 'a')).toBeUndefined()
    const broken = fakeKeychain({ exitCode: () => 1 })
    expect((await failureOf(helperWith(broken.spawner).delete('valet', 'a'))).failure).toBe('unavailable')
  })

  it('purges one service and leaves the others', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    await helper.write('valet.copy', 'a#password', Buffer.from(CANARY), '')
    await helper.write('valet.copy', 'b#username', Buffer.from(CANARY), '')
    await helper.write('valet.dev.copy', 'a#password', Buffer.from(CANARY), '')
    await helper.purge('valet.copy')
    expect(keychain.calls.at(-1)?.args).toEqual(['purge', 'valet.copy'])
    expect([...keychain.items.keys()]).toEqual(['valet.dev.copy\u0000a#password'])
    // Nothing left is not an error; a service outside Valet's own never reaches the helper.
    await helper.purge('valet.copy')
    const before = keychain.calls.length
    expect((await failureOf(helper.purge('login'))).failure).toBe('not-found')
    expect(keychain.calls.length).toBe(before)
    const broken = fakeKeychain({ exitCode: () => 1 })
    expect((await failureOf(helperWith(broken.spawner).purge('valet.copy'))).failure).toBe('unavailable')
  })

  it('never puts the secret in an error', async () => {
    const { spawner } = scriptedSpawner((child) => child.finish(1, CANARY, CANARY))
    const error = await failureOf(helperWith(spawner).read('valet', 'a'))
    expect(inspect(error)).not.toContain(CANARY)
  })
})

describe('HelperKeychainTokenSource', () => {
  it('reads the service-account token through the helper', async () => {
    const keychain = fakeKeychain()
    const helper = helperWith(keychain.spawner)
    await helper.write('valet', 'onepassword-service-account', Buffer.from(CANARY), '')
    const token = await new HelperKeychainTokenSource(helper, 'valet', 'onepassword-service-account').token()
    expect(token.reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(keychain.calls.map((call) => call.command)).toEqual([HELPER, HELPER])
  })
})
