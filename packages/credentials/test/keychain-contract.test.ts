// The real valet-keychain helper (swift-bridge/Sources/valet-keychain) against a throwaway keychain
// file, never the person's: CI builds the helper in debug, where VALET_KEYCHAIN_PATH points it at
// another keychain, and sets VALET_SWIFT_KEYCHAIN to its path. Skipped everywhere else.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialError } from '@valet/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KeychainCopyProvider } from '../src/keychain-copy'
import { KEYCHAIN_EXIT, KeychainHelper } from '../src/keychain-helper'
import { helperEnv, nodeTimers, type Spawner } from '../src/process'

const HELPER = process.env['VALET_SWIFT_KEYCHAIN']
const CANARY = 'canary-pw-contract-61d0'
const ITEM = 'op://abcdefghijklmnopqrstuvwxyz/zyxwvutsrqponmlkjihgfedcba'

describe.skipIf(HELPER === undefined || HELPER === '')('valet-keychain against a throwaway keychain', () => {
  let dir: string
  let keychainPath: string
  let helper: KeychainHelper
  let spawner: Spawner

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'valet-keychain-'))
    keychainPath = join(dir, 'contract.keychain-db')
    const security = (...args: string[]) => {
      const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`security ${args[0]} failed: ${result.stderr}`)
    }
    security('create-keychain', '-p', 'contract', keychainPath)
    security('unlock-keychain', '-p', 'contract', keychainPath)
    // No auto-lock while the suite runs.
    security('set-keychain-settings', keychainPath)
    spawner = (command, args, options) =>
      spawn(command, [...args], {
        stdio: [options?.input === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: { ...helperEnv(), VALET_KEYCHAIN_PATH: keychainPath },
      })
    helper = new KeychainHelper({
      helperPath: HELPER as string,
      spawner,
      timers: nodeTimers,
      timeoutMs: 20_000,
    })
  })

  afterAll(() => {
    spawnSync('/usr/bin/security', ['delete-keychain', keychainPath])
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes, reads back exactly, reads the comment alone, and deletes', async () => {
    const secret = `${CANARY} with spaces, "quotes" and ünïcode`
    await helper.write('valet.copy', 'contract#password', Buffer.from(secret), '{"v":1}')
    expect((await helper.read('valet.copy', 'contract#password')).reveal((plaintext) => plaintext)).toBe(
      secret,
    )
    expect(await helper.info('valet.copy', 'contract#password')).toBe('{"v":1}')
    await helper.write('valet.copy', 'contract#password', Buffer.from('replaced'), '{"v":2}')
    expect((await helper.read('valet.copy', 'contract#password')).reveal((plaintext) => plaintext)).toBe(
      'replaced',
    )
    expect(await helper.info('valet.copy', 'contract#password')).toBe('{"v":2}')
    await helper.delete('valet.copy', 'contract#password')
    expect(await helper.info('valet.copy', 'contract#password')).toBeNull()
  })

  it('reports a missing item as not-found', async () => {
    await expect(helper.read('valet.copy', 'never-written')).rejects.toEqual(new CredentialError('not-found'))
    await helper.delete('valet.copy', 'never-written')
  })

  it('backs the Keychain copy provider', async () => {
    const copies = new KeychainCopyProvider({ keychain: helper })
    await copies.store(ITEM, Buffer.from(CANARY), {
      account: 'my.1password.com',
      vaultId: 'abcdefghijklmnopqrstuvwxyz',
      itemId: 'zyxwvutsrqponmlkjihgfedcba',
      field: 'password',
      sourceUpdatedAt: '2026-11-01T00:00:00.000Z',
      copiedAt: '2026-11-07T00:00:00.000Z',
    })
    expect((await copies.resolve(ITEM, 'password')).reveal((plaintext) => plaintext)).toBe(CANARY)
    expect((await copies.source(ITEM, 'password'))?.account).toBe('my.1password.com')
    await copies.forget(ITEM)
    expect(await copies.source(ITEM, 'password')).toBeNull()
  })

  it('purges every item of one service and no other', async () => {
    for (const account of ['one#username', 'one#password', 'two#password']) {
      await helper.write('valet.copy', account, Buffer.from(CANARY), '')
    }
    await helper.write('valet.dev.copy', 'kept#password', Buffer.from(CANARY), 'kept')
    await helper.purge('valet.copy')
    for (const account of ['one#username', 'one#password', 'two#password']) {
      expect(await helper.info('valet.copy', account)).toBeNull()
    }
    expect(await helper.info('valet.dev.copy', 'kept#password')).toBe('kept')
    // Nothing left to remove is not an error.
    await helper.purge('valet.copy')
    await new KeychainCopyProvider({ keychain: helper, service: 'valet.dev.copy' }).forgetAll()
    expect(await helper.info('valet.dev.copy', 'kept#password')).toBeNull()
  })

  it('refuses, by itself, anything outside Valet’s own services and a secret in argv', () => {
    const run = (args: string[]) =>
      spawnSync(HELPER as string, args, { env: { ...helperEnv(), VALET_KEYCHAIN_PATH: keychainPath } })
    expect(run(['read', 'login', 'a']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['read', 'com.apple.x', 'a']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['read', 'valet', 'a\nb']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['write', 'valet', 'a']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['write', 'valet', 'a', 'comment', CANARY]).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['dump']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['purge', 'login']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['purge', 'valet.copy', 'extra']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(['purge']).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run([]).status).toBe(KEYCHAIN_EXIT.usage)
  })

  it('refuses an empty or oversized secret', () => {
    const run = (input: Buffer) =>
      spawnSync(HELPER as string, ['write', 'valet', 'a', ''], {
        input,
        env: { ...helperEnv(), VALET_KEYCHAIN_PATH: keychainPath },
      })
    expect(run(Buffer.alloc(0)).status).toBe(KEYCHAIN_EXIT.usage)
    expect(run(Buffer.alloc(16 * 1024 + 1, 0x61)).status).toBe(KEYCHAIN_EXIT.usage)
  })
})
