// @vitest-environment node
// Credential wiring with injected processes and file facts: no 1Password, Keychain or Messages.

import { EventEmitter } from 'node:events'
import { CredentialError, SecretValue } from '@siteadapter/core'
import type { ChildLike, Spawner } from '@siteadapter/credentials'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_GID,
  checkOpBinary,
  disabledOtpReader,
  type FileFacts,
  findOp,
  OP_REQUIREMENT,
  parseItemList,
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

describe('parseItemList', () => {
  it('keeps ids and titles only, cleaned', () => {
    const stdout = JSON.stringify([
      {
        id: 'abc123',
        title: 'Woolworths',
        category: 'LOGIN',
        urls: [{ href: 'https://x' }],
        fields: [{ value: 'pw' }],
      },
      { id: '../x', title: 'Bad id' },
      { id: 'def456', title: 'Wool‮worths\u0000' },
      'junk',
      null,
    ])
    expect(parseItemList(stdout)).toEqual([
      { id: 'abc123', title: 'Woolworths' },
      { id: 'def456', title: 'Woolworths' },
    ])
    expect(parseItemList('not json')).toEqual([])
    expect(parseItemList('{"id":"a"}')).toEqual([])
  })
})

describe('realCredentials', () => {
  it('reports what is set up, and offers no fake provider', async () => {
    const { spawn, ran } = spawner({
      ...signed,
      '/usr/bin/security find-generic-password': { code: 0, stdout: 'keychain: x' },
    })
    // As it will be once the SDK ships with the app and can list items.
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

  it('lists vault items through the checked op only, and never for the service account', async () => {
    const items = JSON.stringify([{ id: 'abc123', title: 'Woolworths' }])
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
      args: ['item', 'list', '--vault', 'siteadapter', '--format', 'json'],
    })
    expect(await credentials.vaultItems('onepassword-service-account')).toEqual([])
    expect(await credentials.vaultItems('fake')).toEqual([])
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

  it('reports the service account not installed, without asking the Keychain, until it can work', async () => {
    const { spawn, ran } = spawner({
      ...signed,
      '/usr/bin/security find-generic-password': { code: 0, stdout: 'keychain: x' },
    })
    // The default: this build can't list the vault through the SDK, so no grant could be made.
    const credentials = realCredentials({
      files: files(homebrew),
      spawner: spawn,
      timers,
      uid: UID,
      groups: GROUPS,
    })
    await credentials.configure(DEFAULT_SETTINGS)
    expect((await credentials.status())[0]).toEqual({
      kind: 'onepassword-service-account',
      available: false,
      unavailableReason: 'not-installed',
    })
    expect(ran.some((r) => r.command === '/usr/bin/security')).toBe(false)
  })

  it('serviceAccountReady needs the SDK to resolve and the vault to be listable', async () => {
    expect(SERVICE_ACCOUNT_LISTS_ITEMS).toBe(false)
    const asked: string[] = []
    expect(
      await serviceAccountReady((specifier) => {
        asked.push(specifier)
        return true
      }),
    ).toBe(false)
    expect(asked).toEqual(['@1password/sdk'])
    expect(await serviceAccountReady(() => false)).toBe(false)
    // The default resolver: the SDK isn't a dependency of this package, so it can't resolve here.
    expect(await serviceAccountReady()).toBe(false)
  })

  it('a disabled Messages reader reads nothing', async () => {
    await expect(
      disabledOtpReader.latest({ sender: 'x', pattern: '(\\d+)', maxAgeSeconds: 60 }, new Date()),
    ).rejects.toEqual(new CredentialError('unavailable'))
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
