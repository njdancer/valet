// @vitest-environment node
// Credential wiring with injected processes and file facts: no 1Password, Keychain or Messages.

import { EventEmitter } from 'node:events'
import { CredentialError, SecretValue } from '@valet/core'
import {
  type ChildLike,
  type DesktopClientFactory,
  MessagesHelperOtpReader,
  type Spawner,
} from '@valet/credentials'
import { describe, expect, it } from 'vitest'
import { fakeKeychain } from '../../../../packages/credentials/test/fake-keychain'
import {
  ADMIN_GID,
  checkOpBinary,
  disabledOtpReader,
  type FileFacts,
  findOp,
  OP_REQUIREMENT,
  realCredentials,
  SERVICE_ACCOUNT_LISTS_ITEMS,
  serviceAccountReady,
} from '../../src/main/core/credentials'
import { DEMO_ITEM, demoCredentials, outboxOtpReader, savedDemoPorts } from '../../src/main/core/demo'
import { DEFAULT_SETTINGS } from '../../src/main/core/settings'

const UID = 501
/** staff only: the person isn't an admin unless a test says so. */
const GROUPS: readonly number[] = [20]

/** A spawner that answers each command from `answers`, recording what ran. */
function spawner(answers: Record<string, { code: number; stdout?: string }>) {
  const ran: { command: string; args: readonly string[] }[] = []
  const spawn: Spawner = (command, args) => {
    ran.push({ command, args })
    const child = new EventEmitter() as EventEmitter & ChildLike
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    Object.assign(child, { stdout, stderr, kill: () => true })
    const answer = answers[`${command} ${args[0] ?? ''}`] ?? answers[command]
    queueMicrotask(() => {
      if (answer === undefined) {
        child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
        return
      }
      if (answer.stdout !== undefined) stdout.emit('data', Buffer.from(answer.stdout))
      child.emit('close', answer.code)
    })
    return child
  }
  return { spawn, ran }
}

const timers = {
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
}

interface Entry {
  kind: 'file' | 'dir' | 'link'
  mode: number
  uid: number
  /** Defaults to wheel (0) for root's, staff (20) for the person's. */
  gid?: number
  target?: string
}

function files(entries: Record<string, Entry>): FileFacts {
  return {
    async lstat(path) {
      const entry = entries[path]
      if (entry === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      return {
        isFile: () => entry.kind === 'file',
        isDirectory: () => entry.kind === 'dir',
        isSymbolicLink: () => entry.kind === 'link',
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid ?? (entry.uid === 0 ? 0 : 20),
      }
    },
    async realpath(path) {
      const entry = entries[path]
      if (entry === undefined) throw new Error('nope')
      return entry.kind === 'link' ? (entry.target as string) : path
    },
  }
}

const dir = (uid = 0, mode = 0o755, gid?: number): Entry =>
  gid === undefined ? { kind: 'dir', mode, uid } : { kind: 'dir', mode, uid, gid }
const homebrew: Record<string, Entry> = {
  '/': dir(),
  '/opt': dir(),
  '/opt/homebrew': dir(UID),
  '/opt/homebrew/bin': dir(UID),
  '/opt/homebrew/bin/op': {
    kind: 'link',
    mode: 0o755,
    uid: UID,
    target: '/opt/homebrew/Caskroom/op/op',
  },
  '/opt/homebrew/Caskroom': dir(UID),
  '/opt/homebrew/Caskroom/op': dir(UID),
  '/opt/homebrew/Caskroom/op/op': { kind: 'file', mode: 0o755, uid: UID },
}
const signed = { '/usr/bin/codesign --verify': { code: 0 } }

describe('checkOpBinary', () => {
  it('accepts a signed op whose file and directories only root or the person can write', async () => {
    const { spawn, ran } = spawner(signed)
    expect(
      await checkOpBinary('/opt/homebrew/bin/op', {
        files: files(homebrew),
        spawner: spawn,
        timers,
        uid: UID,
        groups: GROUPS,
      }),
    ).toBe('/opt/homebrew/Caskroom/op/op')
    expect(ran).toEqual([
      {
        command: '/usr/bin/codesign',
        args: ['--verify', '--strict', `-R=${OP_REQUIREMENT}`, '/opt/homebrew/Caskroom/op/op'],
      },
    ])
  })

  it('refuses a relative path without looking at anything', async () => {
    const { spawn, ran } = spawner(signed)
    expect(
      await checkOpBinary('op', { files: files(homebrew), spawner: spawn, timers, uid: UID, groups: GROUPS }),
    ).toBeNull()
    expect(ran).toEqual([])
  })

  it.each([
    ['a group-writable binary', { '/opt/homebrew/Caskroom/op/op': { kind: 'file', mode: 0o775, uid: UID } }],
    ['a world-writable directory above it', { '/opt/homebrew/Caskroom': dir(UID, 0o777) }],
    ['a group-writable directory above the link', { '/opt/homebrew/bin': dir(UID, 0o775) }],
    [
      'a binary another account owns',
      { '/opt/homebrew/Caskroom/op/op': { kind: 'file', mode: 0o755, uid: 502 } },
    ],
    [
      'a directory that is a symlink',
      { '/opt/homebrew/Caskroom/op': { kind: 'link', mode: 0o755, uid: UID, target: '/x' } },
    ],
    ['a target that is not a file', { '/opt/homebrew/Caskroom/op/op': dir(UID) }],
  ] as const)('refuses %s', async (_name, change) => {
    const { spawn } = spawner(signed)
    const tree = { ...homebrew, ...change } as Record<string, Entry>
    expect(
      await checkOpBinary('/opt/homebrew/bin/op', {
        files: files(tree),
        spawner: spawn,
        timers,
        uid: UID,
        groups: GROUPS,
      }),
    ).toBeNull()
  })

  /** `brew install 1password-cli` as it really lands: bin and Caskroom drwxrwxr-x, group admin. */
  const realHomebrew: Record<string, Entry> = {
    '/': dir(),
    '/opt': dir(),
    '/opt/homebrew': dir(UID, 0o755, ADMIN_GID),
    '/opt/homebrew/bin': dir(UID, 0o775, ADMIN_GID),
    '/opt/homebrew/bin/op': {
      kind: 'link',
      mode: 0o755,
      uid: UID,
      gid: ADMIN_GID,
      target: '/opt/homebrew/Caskroom/1password-cli/2.30.0/op',
    },
    '/opt/homebrew/Caskroom': dir(UID, 0o775, ADMIN_GID),
    '/opt/homebrew/Caskroom/1password-cli': dir(UID, 0o755, ADMIN_GID),
    '/opt/homebrew/Caskroom/1password-cli/2.30.0': dir(UID, 0o755, ADMIN_GID),
    '/opt/homebrew/Caskroom/1password-cli/2.30.0/op': { kind: 'file', mode: 0o755, uid: UID, gid: ADMIN_GID },
  }

  it('accepts Homebrew’s admin-writable directories when the person is an admin (D44)', async () => {
    const { spawn, ran } = spawner(signed)
    expect(
      await checkOpBinary('/opt/homebrew/bin/op', {
        files: files(realHomebrew),
        spawner: spawn,
        timers,
        uid: UID,
        groups: [20, ADMIN_GID],
      }),
    ).toBe('/opt/homebrew/Caskroom/1password-cli/2.30.0/op')
    expect(ran).toHaveLength(1)
  })

  it('refuses the same tree for a person who is not an admin, before codesign runs', async () => {
    const { spawn, ran } = spawner(signed)
    expect(
      await checkOpBinary('/opt/homebrew/bin/op', {
        files: files(realHomebrew),
        spawner: spawn,
        timers,
        uid: UID,
        groups: [20],
      }),
    ).toBeNull()
    expect(ran).toEqual([])
  })

  it.each([
    ['group-writable by staff', { '/opt/homebrew/bin': dir(UID, 0o775, 20) }],
    ['group-writable by everyone', { '/opt/homebrew/Caskroom': dir(UID, 0o775, 12) }],
    ['admin-group but also world-writable', { '/opt/homebrew/bin': dir(UID, 0o777, ADMIN_GID) }],
    ['world-writable but not group-writable', { '/opt/homebrew/Caskroom': dir(UID, 0o757, ADMIN_GID) }],
    [
      'admin-group but owned by another account',
      { '/opt/homebrew/Caskroom/1password-cli': dir(502, 0o775, ADMIN_GID) },
    ],
    [
      'an admin-writable binary of another account',
      {
        '/opt/homebrew/Caskroom/1password-cli/2.30.0/op': {
          kind: 'file',
          mode: 0o775,
          uid: 502,
          gid: ADMIN_GID,
        },
      },
    ],
  ] as const)('still refuses a directory or binary %s, admin or not', async (_name, change) => {
    const { spawn } = spawner(signed)
    const tree = { ...realHomebrew, ...change } as Record<string, Entry>
    expect(
      await checkOpBinary('/opt/homebrew/bin/op', {
        files: files(tree),
        spawner: spawn,
        timers,
        uid: UID,
        groups: [20, ADMIN_GID],
      }),
    ).toBeNull()
  })

  it('refuses a binary 1Password did not sign, or one codesign can’t check', async () => {
    const answerSets: Record<string, { code: number }>[] = [{ '/usr/bin/codesign --verify': { code: 3 } }, {}]
    for (const answers of answerSets) {
      const { spawn } = spawner(answers)
      expect(
        await checkOpBinary('/opt/homebrew/bin/op', {
          files: files(homebrew),
          spawner: spawn,
          timers,
          uid: UID,
          groups: GROUPS,
        }),
      ).toBeNull()
    }
  })

  it('finds the chosen path, or the first usual place that passes, never a PATH lookup', async () => {
    const { spawn, ran } = spawner(signed)
    const deps = { files: files(homebrew), spawner: spawn, timers, uid: UID, groups: GROUPS }
    expect(await findOp(DEFAULT_SETTINGS, deps)).toBe('/opt/homebrew/Caskroom/op/op')
    expect(await findOp({ ...DEFAULT_SETTINGS, opPath: '/usr/local/bin/op' }, deps)).toBeNull()
    expect(ran.every((r) => r.command === '/usr/bin/codesign')).toBe(true)
  })
})

describe('realCredentials', () => {
  it('reports what is set up, and offers no fake provider', async () => {
    const { spawn, ran } = spawner({
      ...signed,
      '/usr/bin/security find-generic-password': { code: 0, stdout: 'keychain: x' },
    })
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountReady: async () => true,
    })
    await credentials.configure(DEFAULT_SETTINGS)
    expect(await credentials.status()).toEqual([
      { kind: 'onepassword-service-account', available: true, unavailableReason: null },
      { kind: 'onepassword-cli', available: true, unavailableReason: null },
      { kind: 'messages', available: false, unavailableReason: 'disabled' },
      { kind: 'keychain-copy', available: false, unavailableReason: 'not-installed' },
    ])
    expect(Object.keys(credentials.providers()).sort()).toEqual([
      'onepassword-cli',
      'onepassword-service-account',
    ])
    // The Keychain is asked whether the item exists, never for its value.
    const security = ran.find((r) => r.command === '/usr/bin/security')
    expect(security?.args).not.toContain('-w')
    expect(credentials.otpReader()).toBe(disabledOtpReader)
  })

  it('lists vault items through the checked op, ids and titles only', async () => {
    const items = JSON.stringify([
      { id: 'abc123', title: 'Woolworths', fields: [{ value: 'pw' }], urls: [{ href: 'https://x' }] },
      { id: '../x', title: 'Bad id' },
    ])
    const { spawn, ran } = spawner({
      ...signed,
      '/opt/homebrew/Caskroom/op/op item': { code: 0, stdout: items },
    })
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
    })
    await credentials.configure(DEFAULT_SETTINGS)
    expect(await credentials.vaultItems('onepassword-cli')).toEqual([{ id: 'abc123', title: 'Woolworths' }])
    expect(ran.at(-1)).toEqual({
      command: '/opt/homebrew/Caskroom/op/op',
      args: ['item', 'list', '--vault', 'Valet', '--format', 'json'],
    })
    expect(await credentials.vaultItems('fake')).toEqual([])
    expect(await credentials.vaultItems('messages')).toEqual([])
  })

  it('lists the service account’s vault through its own SDK client, which gets the Keychain token', async () => {
    const { spawn, ran } = spawner({
      ...signed,
      '/usr/bin/security find-generic-password': { code: 0, stdout: 'sa-token' },
    })
    const tokens: string[] = []
    const listed: { vault: string; filters: unknown[] }[] = []
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountReady: async () => true,
      serviceAccountClient: async (token) => {
        token.reveal((plaintext) => tokens.push(plaintext))
        return {
          secrets: { resolve: async () => 'never' },
          vaults: {
            list: async () => [
              { id: 'v1', title: 'Personal' },
              { id: 'v2', title: 'Valet' },
            ],
          },
          items: {
            list: async (vault, ...filters) => {
              listed.push({ vault, filters })
              return [{ id: 'item1', title: 'Woolworths\u202e', category: 'Login' } as never]
            },
          },
        }
      },
    })
    await credentials.configure(DEFAULT_SETTINGS)
    expect(await credentials.vaultItems('onepassword-service-account')).toEqual([
      { id: 'item1', title: 'Woolworths' },
    ])
    // The vault by its exact title, active items only; the token read with -w, for the SDK alone.
    expect(listed).toEqual([
      { vault: 'v2', filters: [{ type: 'ByState', content: { active: true, archived: false } }] },
    ])
    expect(tokens).toEqual(['sa-token'])
    expect(ran.find((r) => r.command === '/usr/bin/security')?.args).toContain('-w')
  })

  it('fails a service-account listing when the vault isn’t there or 1Password refuses', async () => {
    const { spawn } = spawner({
      ...signed,
      '/usr/bin/security find-generic-password': { code: 0, stdout: 'sa-token' },
    })
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountClient: async () => ({
        secrets: { resolve: async () => 'never' },
        vaults: { list: async () => [{ id: 'v1', title: 'Personal' }] },
        items: { list: async () => [] },
      }),
    })
    await credentials.configure(DEFAULT_SETTINGS)
    await expect(credentials.vaultItems('onepassword-service-account')).rejects.toEqual(
      new CredentialError('not-found'),
    )
    const noToken = realCredentials({
      files: files(homebrew),
      spawner: spawner({ ...signed, '/usr/bin/security find-generic-password': { code: 44 } }).spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountClient: async () => {
        throw new Error('never reached')
      },
    })
    await noToken.configure(DEFAULT_SETTINGS)
    await expect(noToken.vaultItems('onepassword-service-account')).rejects.toBeInstanceOf(CredentialError)
  })

  it('has no CLI provider when op fails the checks, and fails a listing op refuses', async () => {
    const { spawn } = spawner({
      '/usr/bin/codesign --verify': { code: 1 },
      '/usr/bin/security find-generic-password': { code: 44 },
    })
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountReady: async () => true,
    })
    await credentials.configure({ ...DEFAULT_SETTINGS, messagesOtpEnabled: true })
    const status = await credentials.status()
    expect(status.find((s) => s.kind === 'onepassword-cli')).toEqual({
      kind: 'onepassword-cli',
      available: false,
      unavailableReason: 'not-installed',
    })
    expect(status.find((s) => s.kind === 'onepassword-service-account')?.unavailableReason).toBe(
      'not-configured',
    )
    expect(status.find((s) => s.kind === 'messages')?.available).toBe(true)
    expect(credentials.providers()['onepassword-cli']).toBeUndefined()
    expect(await credentials.vaultItems('onepassword-cli')).toEqual([])

    const listing = spawner({ ...signed, '/opt/homebrew/Caskroom/op/op item': { code: 1, stdout: '' } })
    const failing = realCredentials({
      files: files(homebrew),
      spawner: listing.spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      messagesReader: () => disabledOtpReader,
    })
    await failing.configure(DEFAULT_SETTINGS)
    await expect(failing.vaultItems('onepassword-cli')).rejects.toBeInstanceOf(CredentialError)
  })

  it('reports the service account not installed, without asking the Keychain, when its SDK is missing', async () => {
    const { spawn, ran } = spawner({
      ...signed,
      '/usr/bin/security find-generic-password': { code: 0, stdout: 'keychain: x' },
    })
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountReady: async () => false,
    })
    await credentials.configure(DEFAULT_SETTINGS)
    expect((await credentials.status())[0]).toEqual({
      kind: 'onepassword-service-account',
      available: false,
      unavailableReason: 'not-installed',
    })
    expect(ran.some((r) => r.command === '/usr/bin/security')).toBe(false)
  })

  it('serviceAccountReady needs the SDK to resolve, and it does here', async () => {
    expect(SERVICE_ACCOUNT_LISTS_ITEMS).toBe(true)
    const asked: string[] = []
    expect(
      await serviceAccountReady((specifier) => {
        asked.push(specifier)
        return true
      }),
    ).toBe(true)
    expect(asked).toEqual(['@1password/sdk'])
    expect(await serviceAccountReady(() => false)).toBe(false)
    // The default resolver: @1password/sdk is a dependency of this package.
    expect(await serviceAccountReady()).toBe(true)
  })

  it('a disabled Messages reader reads nothing', async () => {
    await expect(
      disabledOtpReader.latest({ sender: 'x', pattern: '(\\d+)', maxAgeSeconds: 60 }, new Date()),
    ).rejects.toEqual(new CredentialError('unavailable'))
  })
})

describe('realCredentials with the native helpers', () => {
  const HELPER = '/Applications/Valet.app/Contents/MacOS/valet-keychain'
  const VAULT_ID = 'abcdefghijklmnopqrstuvwxyz'
  const ITEM_ID = 'zyxwvutsrqponmlkjihgfedcba'
  const CANARY = 'canary-pw-desktop-4e9a'

  function desktopClient(creates: string[]): DesktopClientFactory {
    return async (account) => {
      creates.push(account)
      return {
        secrets: {
          resolve: async (reference) => (reference.endsWith('/password') ? CANARY : 'nick@example.com'),
        },
        vaults: { list: async () => [{ id: VAULT_ID, title: 'Personal' }] },
        items: {
          list: async () => [
            { id: ITEM_ID, title: 'Woolworths', updatedAt: new Date('2026-11-01T00:00:00Z') },
          ],
        },
      }
    }
  }

  function setup() {
    const keychain = fakeKeychain()
    const creates: string[] = []
    const credentials = realCredentials({
      files: files({}),
      spawner: keychain.spawner,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountReady: async () => true,
      keychainHelper: HELPER,
      copyService: 'valet.dev.copy',
      messagesHelper: {
        binary: '/Applications/Valet.app/Contents/MacOS/valet-messages-helper',
        socketPath: '/Users/nick/Library/Application Support/me.dncr.valet.messages-helper/helper.sock',
      },
      desktopClient: desktopClient(creates),
    })
    return { keychain, creates, credentials }
  }

  it('offers the Keychain copy only once a 1Password account is set', async () => {
    const { credentials, creates } = setup()
    await credentials.configure(DEFAULT_SETTINGS)
    expect((await credentials.status()).find((s) => s.kind === 'keychain-copy')).toEqual({
      kind: 'keychain-copy',
      available: false,
      unavailableReason: 'not-configured',
    })
    expect(await credentials.vaultItems('keychain-copy')).toEqual([])
    await expect(credentials.copyItem(`op://${VAULT_ID}/${ITEM_ID}`, ['password'])).rejects.toEqual(
      new CredentialError('unavailable'),
    )
    await credentials.configure({ ...DEFAULT_SETTINGS, onePasswordAccount: 'my.1password.com' })
    expect((await credentials.status()).find((s) => s.kind === 'keychain-copy')?.available).toBe(true)
    expect(Object.keys(credentials.providers())).toContain('keychain-copy')
    expect(creates).toEqual([])
  })

  it('lists every vault’s items through the desktop app, as <vault>-<item>', async () => {
    const { credentials, creates } = setup()
    await credentials.configure({ ...DEFAULT_SETTINGS, onePasswordAccount: 'my.1password.com' })
    expect(await credentials.vaultItems('keychain-copy')).toEqual([
      { id: `${VAULT_ID}-${ITEM_ID}`, title: 'Woolworths (Personal)' },
    ])
    expect(creates).toEqual(['my.1password.com'])
  })

  it('copies an item into the Keychain through the helper, then resolves it from the copy', async () => {
    const { credentials, keychain } = setup()
    await credentials.configure({ ...DEFAULT_SETTINGS, onePasswordAccount: 'my.1password.com' })
    const itemRef = `op://${VAULT_ID}/${ITEM_ID}`
    await credentials.copyItem(itemRef, ['username', 'password'])
    expect(keychain.get('valet.dev.copy', `${itemRef}#password`)?.secret.toString()).toBe(CANARY)
    expect(keychain.calls.every((call) => call.command === HELPER)).toBe(true)
    const secret = await credentials.providers()['keychain-copy']?.resolve(itemRef, 'password')
    expect(secret?.reveal((plaintext) => plaintext)).toBe(CANARY)
    // An approval is up now, and the source hasn't changed: nothing is written again.
    const writes = keychain.calls.filter((call) => call.args[0] === 'write').length
    await credentials.refreshCopies([{ itemRef, fields: ['username', 'password'] }])
    expect(keychain.calls.filter((call) => call.args[0] === 'write').length).toBe(writes)
    await credentials.forgetCopy(itemRef)
    expect(keychain.items.size).toBe(0)
  })

  it('keeps the approval when the account is unchanged, and starts over when it changes', async () => {
    const { credentials, creates } = setup()
    const settings = { ...DEFAULT_SETTINGS, onePasswordAccount: 'my.1password.com' }
    await credentials.configure(settings)
    await credentials.vaultItems('keychain-copy')
    await credentials.configure(settings)
    await credentials.vaultItems('keychain-copy')
    expect(creates).toHaveLength(1)
    await credentials.configure({ ...settings, onePasswordAccount: 'other.1password.com' })
    await credentials.vaultItems('keychain-copy')
    expect(creates).toEqual(['my.1password.com', 'other.1password.com'])
  })

  it('reads the service-account token’s presence through the helper, never security', async () => {
    const { credentials, keychain } = setup()
    await credentials.configure(DEFAULT_SETTINGS)
    expect((await credentials.status())[0]?.unavailableReason).toBe('not-configured')
    expect(keychain.calls.map((call) => call.args[0])).toEqual(['info'])
    keychain.items.set('valet\u0000onepassword-service-account', { secret: Buffer.from('sa'), comment: '' })
    expect((await credentials.status())[0]?.available).toBe(true)
  })

  it('reads Messages codes through the helper when the app ships it, registering its agent once', async () => {
    const { credentials, keychain } = setup()
    await credentials.configure(DEFAULT_SETTINGS)
    const registers = () =>
      keychain.calls.filter(
        (call) => call.command.endsWith('/valet-messages-helper') && call.args[0] === 'register',
      )
    expect(registers()).toHaveLength(0)
    await credentials.configure({ ...DEFAULT_SETTINGS, messagesOtpEnabled: true })
    expect(credentials.otpReader()).toBeInstanceOf(MessagesHelperOtpReader)
    await credentials.configure({ ...DEFAULT_SETTINGS, messagesOtpEnabled: true })
    expect(registers()).toHaveLength(1)
  })
})

describe('erasing for a reset or an uninstall', () => {
  const HELPER = '/Applications/Valet.app/Contents/MacOS/valet-keychain'
  const MESSAGES_HELPER = '/Applications/Valet.app/Contents/MacOS/valet-messages-helper'
  const TOKEN_KEY = 'valet\u0000onepassword-service-account'

  function setup(
    options: {
      ownsToken?: boolean
      status?: { code: number; stdout?: string }
      unregister?: number
      keychainExit?: (args: readonly string[]) => number | undefined
    } = {},
  ) {
    const keychain = fakeKeychain(
      options.keychainExit === undefined ? {} : { exitCode: options.keychainExit },
    )
    // The Messages helper answers here; everything else is the fake Keychain.
    const helper = spawner({
      [`${MESSAGES_HELPER} status`]: options.status ?? { code: 0, stdout: 'enabled\n' },
      [`${MESSAGES_HELPER} unregister`]: { code: options.unregister ?? 0 },
    })
    const spawn: Spawner = (command, args, spawnOptions) =>
      command === MESSAGES_HELPER
        ? helper.spawn(command, args, spawnOptions)
        : keychain.spawner(command, args, spawnOptions)
    const credentials = realCredentials({
      files: files({}),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
      serviceAccountReady: async () => true,
      keychainHelper: HELPER,
      copyService: 'valet.dev.copy',
      ...(options.ownsToken === undefined ? {} : { ownsToken: options.ownsToken }),
      messagesHelper: { binary: MESSAGES_HELPER, socketPath: '/tmp/helper.sock' },
    })
    for (const name of ['valet.dev.copy\u0000a#password', 'valet.dev.copy\u0000orphan#username']) {
      keychain.items.set(name, { secret: Buffer.from('pw'), comment: '' })
    }
    keychain.items.set('valet.copy\u0000release#password', { secret: Buffer.from('pw'), comment: '' })
    keychain.items.set(TOKEN_KEY, { secret: Buffer.from('sa'), comment: '' })
    return { keychain, credentials, helperRan: helper.ran }
  }

  it('removes every copy of this build’s, known to a grant or not, and unregisters the Messages agent', async () => {
    const { keychain, credentials, helperRan } = setup()
    expect(await credentials.erase()).toEqual([])
    // The release build's copies and the shared token are another build's: a dev erase leaves them.
    expect([...keychain.items.keys()].sort()).toEqual([TOKEN_KEY, 'valet.copy\u0000release#password'].sort())
    expect(helperRan.map((r) => r.args[0])).toEqual(['status', 'unregister'])
    // Nothing was read to do it: no Keychain prompt for a secret.
    expect(keychain.calls.map((c) => c.args[0])).toEqual(['purge'])
    expect(credentials.otpReader()).toBe(disabledOtpReader)
  })

  it('removes the service-account token too when this build owns it', async () => {
    const { keychain, credentials } = setup({ ownsToken: true })
    expect(await credentials.erase()).toEqual([])
    expect(keychain.items.has(TOKEN_KEY)).toBe(false)
    expect(keychain.calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['purge', 'valet.dev.copy'],
      ['delete', 'valet', 'onepassword-service-account'],
    ])
  })

  it('leaves an agent that was never registered alone', async () => {
    const { credentials, helperRan } = setup({ status: { code: 0, stdout: 'not-registered\n' } })
    expect(await credentials.erase()).toEqual([])
    expect(helperRan.map((r) => r.args[0])).toEqual(['status'])
  })

  it('tries every part, and names the ones that failed', async () => {
    const { keychain, credentials } = setup({ ownsToken: true, unregister: 1, keychainExit: () => 1 })
    expect(await credentials.erase()).toEqual(['keychain-copies', 'keychain-token', 'messages-helper'])
    expect(keychain.calls.map((c) => c.args[0])).toEqual(['purge', 'delete'])
    const unknown = setup({ status: { code: 1 } })
    expect(await unknown.credentials.erase()).toEqual(['messages-helper'])
    expect(unknown.helperRan.map((r) => r.args[0])).toEqual(['status'])
  })

  it('deletes the token with security when the build has no helper, and a missing item is fine', async () => {
    const run = (code: number) => {
      const s = spawner({ '/usr/bin/security delete-generic-password': { code } })
      const credentials = realCredentials({
        files: files({}),
        spawner: s.spawn,
        timers,
        uid: UID,
        groups: GROUPS,
        serviceAccountReady: async () => true,
        ownsToken: true,
      })
      return { erased: credentials.erase(), ran: s.ran }
    }
    const done = run(0)
    expect(await done.erased).toEqual([])
    expect(done.ran).toEqual([
      {
        command: '/usr/bin/security',
        args: ['delete-generic-password', '-s', 'valet', '-a', 'onepassword-service-account'],
      },
    ])
    expect(await run(44).erased).toEqual([])
    expect(await run(1).erased).toEqual(['keychain-token'])
  })

  it('the demo has nothing in the Keychain or launchd to remove', async () => {
    expect(await demoCredentials(disabledOtpReader).erase()).toEqual([])
  })
})

describe('the demo site’s saved ports', () => {
  it('reads two distinct unprivileged ports back', () => {
    expect(savedDemoPorts('{"port":50123,"authPort":50124}')).toEqual({ port: 50123, authPort: 50124 })
    expect(savedDemoPorts('{"port":1024,"authPort":65535}')).toEqual({ port: 1024, authPort: 65535 })
  })

  it('takes nothing else: missing, torn, wrong types, privileged, out of range or equal ports', () => {
    for (const text of [
      null,
      '',
      '{',
      'null',
      '[]',
      '"50123"',
      '{"port":50123}',
      '{"port":"50123","authPort":50124}',
      '{"port":50123.5,"authPort":50124}',
      '{"port":443,"authPort":50124}',
      '{"port":50123,"authPort":65536}',
      '{"port":-1,"authPort":50124}',
      '{"port":50123,"authPort":50123}',
    ])
      expect(savedDemoPorts(text), String(text)).toBeNull()
  })
})

describe('demo credentials', () => {
  it('offer the test item and the outbox, and switch real 1Password off', async () => {
    const credentials = demoCredentials(disabledOtpReader)
    expect((await credentials.status()).filter((s) => s.available).map((s) => s.kind)).toEqual([
      'fake',
      'messages',
    ])
    expect(await credentials.vaultItems('fake')).toEqual([DEMO_ITEM])
    expect(await credentials.vaultItems('onepassword-cli')).toEqual([])
    const secret = await credentials.providers().fake?.resolve(DEMO_ITEM.id, 'password')
    expect(secret).toBeInstanceOf(SecretValue)
    expect(String(secret)).toBe('[secret]')
    secret?.dispose()
    await credentials.configure(DEFAULT_SETTINGS)
  })

  it('read the newest matching SMS from the declared sender, newer than the login', async () => {
    const now = 1_000_000
    const outbox = [
      { channel: 'sms' as const, text: 'Your code is 111111', at: now - 400_000 },
      { channel: 'email' as const, text: 'Your code is 222222', at: now - 1000 },
      { channel: 'sms' as const, text: 'Your code is 333333', at: now - 2000 },
    ]
    const reader = outboxOtpReader(
      () => outbox,
      'Woolworths',
      () => now,
    )
    const query = { sender: 'Woolworths', pattern: '\\b(\\d{6})\\b', maxAgeSeconds: 300 }
    const code = await reader.latest(query, new Date(now - 10_000))
    expect(code.occursIn('333333')).toBe(true)
    await expect(reader.latest(query, new Date(now - 1000))).rejects.toEqual(new CredentialError('not-found'))
    await expect(reader.latest({ ...query, sender: 'woolworths' }, new Date(0))).rejects.toEqual(
      new CredentialError('not-found'),
    )
    await expect(reader.latest({ ...query, pattern: '(a+)+' }, new Date(0))).rejects.toEqual(
      new CredentialError('not-found'),
    )
    await expect(reader.latest({ ...query, pattern: '(code)' }, new Date(0))).rejects.toEqual(
      new CredentialError('not-found'),
    )
  })
})
