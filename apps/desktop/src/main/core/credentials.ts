// Which credential providers this launch has, chosen by grant.provider, and the facts the grant
// sheet shows about them. Every helper process runs by absolute path, with credentials' minimal
// environment and a bounded wait; tests inject the spawner, so none touches 1Password, the
// Keychain or Messages.
//
// - onepassword-service-account: the token from the Keychain (KeychainTokenSource), vault VAULT.
//   Offered when its SDK resolves from the app (serviceAccountReady) and the token is stored. Its
//   items are listed through the provider's own SDK client, so the token goes only to
//   sdkClientFactory.
// - onepassword-cli: `op`, only at a path that passed checkOpBinary: the one the person chose, or
//   the first of the usual places that passes. Never a PATH lookup.
// - messages: MessagesOtpReader, only while the setting is on (it needs Full Disk Access).
// - fake: demo mode only (demo.ts); a normal launch never has it.

import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import {
  CredentialError,
  type CredentialProvider,
  type OtpReader,
  type ProviderKind,
  type SecretValue,
} from '@valet/core'
import {
  DEFAULT_OP_PATHS,
  KeychainTokenSource,
  MessagesOtpReader,
  nodeSpawner,
  nodeTimers,
  OnePasswordCliProvider,
  OnePasswordServiceAccountProvider,
  runProcess,
  type SecretsClientFactory,
  type Spawner,
  type Timers,
} from '@valet/credentials'
import type { ProviderStatus, Settings, VaultItem } from '../../shared/api'
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, ONEPASSWORD_TEAM_ID, VAULT } from './constants'

export interface Credentials {
  /** The providers runAuthFlow may resolve through, by kind. */
  providers(): Partial<Record<ProviderKind, CredentialProvider>>
  otpReader(): OtpReader
  /** Each provider this launch offers, with grant counts filled in by the caller. */
  status(): Promise<readonly Omit<ProviderStatus, 'grantCount'>[]>
  /** Items in the vault, title only. Empty for providers without a vault. */
  vaultItems(provider: ProviderKind): Promise<readonly VaultItem[]>
  /** Rebuilds the providers after a settings change. */
  configure(settings: Settings): Promise<void>
}

/** A reader that never reads: Messages codes are off. */
export const disabledOtpReader: OtpReader = {
  latest(): Promise<SecretValue> {
    return Promise.reject(new CredentialError('unavailable'))
  },
}

export interface FileFacts {
  lstat(path: string): Promise<{
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
    mode: number
    uid: number
    gid: number
  }>
  realpath(path: string): Promise<string>
}

export const nodeFileFacts: FileFacts = { lstat, realpath }

export interface OpCheckDeps {
  readonly files: FileFacts
  readonly spawner: Spawner
  readonly timers: Timers
  readonly uid: number
  /** The person's groups (process.getgroups()), for the admin-group rule below. */
  readonly groups: readonly number[]
}

const CODESIGN = '/usr/bin/codesign'
const SECURITY = '/usr/bin/security'
/** 1Password's own signature: Apple's chain, and the leaf issued to its Team ID. */
export const OP_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${ONEPASSWORD_TEAM_ID}"`

/** macOS's admin group. */
export const ADMIN_GID = 80

/**
 * Whether `path` may be run as the 1Password CLI: absolute; the file (after symlinks, as Homebrew
 * installs it) is a regular file; it and every directory above it, and above the link, are owned
 * by root or this user and writable by no one else (see safeOwner); and its code signature
 * satisfies OP_REQUIREMENT. Returns the resolved path to run, or null.
 */
export async function checkOpBinary(path: string, deps: OpCheckDeps): Promise<string | null> {
  if (!isAbsolute(path) || path.includes('\0')) return null
  let real: string
  try {
    real = await deps.files.realpath(path)
    const file = await deps.files.lstat(real)
    if (!file.isFile() || !safeOwner(file, deps)) return null
    for (const dir of [...ancestors(real), ...ancestors(path)]) {
      const info = await deps.files.lstat(dir)
      // A symlinked directory above the link would be resolved in `real`; refuse it here.
      if (!info.isDirectory() || !safeOwner(info, deps)) return null
    }
  } catch {
    return null
  }
  const signed = await runProcess(
    deps.spawner,
    CODESIGN,
    ['--verify', '--strict', `-R=${OP_REQUIREMENT}`, real],
    {
      timeoutMs: 10_000,
      maxStdoutBytes: 64 * 1024,
      timers: deps.timers,
    },
  )
  return signed.kind === 'exited' && signed.code === 0 ? real : null
}

/**
 * D44: owned by root or the person, never writable by others, and writable by its group only when
 * that group is admin and the person is in it. Homebrew makes /opt/homebrew/bin and Caskroom
 * drwxrwxr-x, group admin, so without the exception `brew install 1password-cli` could never pass.
 * Admin-writable adds no one who couldn't already write a root-owned file: every member of admin can
 * become root with sudo, and on a one-person Mac admin is the person. Any other group is refused.
 */
function safeOwner(info: { mode: number; uid: number; gid: number }, deps: OpCheckDeps): boolean {
  if (info.uid !== 0 && info.uid !== deps.uid) return false
  if ((info.mode & 0o002) !== 0) return false
  if ((info.mode & 0o020) === 0) return true
  return info.gid === ADMIN_GID && deps.groups.includes(ADMIN_GID)
}

function ancestors(path: string): string[] {
  const dirs: string[] = []
  let dir = dirname(path)
  for (;;) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) return dirs
    dir = parent
  }
}

/** The CLI to use for these settings: the chosen path if it passes, else the first usual place that does. */
export async function findOp(settings: Settings, deps: OpCheckDeps): Promise<string | null> {
  const candidates = settings.opPath === null ? DEFAULT_OP_PATHS : [settings.opPath]
  for (const candidate of candidates) {
    const checked = await checkOpBinary(candidate, deps)
    if (checked !== null) return checked
  }
  return null
}

export interface RealCredentialsDeps extends OpCheckDeps {
  /** Builds the Messages reader (tests pass a fake). */
  readonly messagesReader?: () => OtpReader
  /** Whether the service account can be offered at all; serviceAccountReady by default. */
  readonly serviceAccountReady?: () => Promise<boolean>
  /** The service account's SDK client, for tests; the real SDK by default. */
  readonly serviceAccountClient?: SecretsClientFactory
}

/**
 * Whether the service-account provider can list the vault's items, so that a grant can be made for
 * it. It lists through its own SDK client (credentials' listItems), so this is only a switch for
 * builds that must not offer it.
 */
export const SERVICE_ACCOUNT_LISTS_ITEMS = true

/** Whether the service-account provider could work in this build: its SDK resolves from the app. */
export async function serviceAccountReady(
  resolves: (specifier: string) => boolean = (specifier) => {
    try {
      import.meta.resolve(specifier)
      return true
    } catch {
      return false
    }
  },
): Promise<boolean> {
  return resolves('@1password/sdk') && SERVICE_ACCOUNT_LISTS_ITEMS
}

/** The providers of a normal launch. The fake provider is never among them. */
export function realCredentials(deps: RealCredentialsDeps): Credentials {
  const serviceAccount = new OnePasswordServiceAccountProvider({
    tokenSource: new KeychainTokenSource({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
      spawner: deps.spawner,
      timers: deps.timers,
    }),
    timers: deps.timers,
    ...(deps.serviceAccountClient === undefined ? {} : { clientFactory: deps.serviceAccountClient }),
  })
  let opPath: string | null = null
  let cli: OnePasswordCliProvider | null = null
  let messagesEnabled = false
  let reader: OtpReader = disabledOtpReader
  const run = (command: string, args: readonly string[], maxStdoutBytes: number, timeoutMs: number) =>
    runProcess(deps.spawner, command, args, { timeoutMs, maxStdoutBytes, timers: deps.timers })
  const ready = deps.serviceAccountReady ?? (() => serviceAccountReady())
  const serviceAccountStatus = async (): Promise<Omit<ProviderStatus, 'grantCount'>> => {
    const kind = 'onepassword-service-account'
    if (!(await ready())) return { kind, available: false, unavailableReason: 'not-installed' }
    // Asks whether the item exists, never for its value (-w), so no Keychain prompt appears.
    const keychain = await run(
      SECURITY,
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      64 * 1024,
      5_000,
    )
    if (keychain.kind === 'exited') keychain.stdout.fill(0)
    const tokenStored = keychain.kind === 'exited' && keychain.code === 0
    return { kind, available: tokenStored, unavailableReason: tokenStored ? null : 'not-configured' }
  }

  return {
    providers() {
      return {
        'onepassword-service-account': serviceAccount,
        ...(cli === null ? {} : { 'onepassword-cli': cli }),
      }
    },
    otpReader: () => reader,
    async status() {
      return [
        await serviceAccountStatus(),
        {
          kind: 'onepassword-cli',
          available: opPath !== null,
          unavailableReason: opPath !== null ? null : 'not-installed',
        },
        {
          kind: 'messages',
          available: messagesEnabled,
          unavailableReason: messagesEnabled ? null : 'disabled',
        },
      ]
    },
    async vaultItems(provider) {
      // Both providers list the vault themselves: ids and titles only, never a field.
      if (provider === 'onepassword-cli') return cli === null ? [] : cli.listItems(VAULT)
      if (provider === 'onepassword-service-account') return serviceAccount.listItems(VAULT)
      return []
    },
    async configure(settings) {
      opPath = await findOp(settings, deps)
      cli =
        opPath === null
          ? null
          : new OnePasswordCliProvider({
              opPaths: [opPath],
              searchPath: null,
              // The path just passed checkOpBinary; a file gone since is reported when op runs.
              isExecutable: async (path) => path === opPath,
              spawner: deps.spawner,
              timers: deps.timers,
            })
      messagesEnabled = settings.messagesOtpEnabled
      reader = messagesEnabled
        ? (deps.messagesReader ?? (() => new MessagesOtpReader()))()
        : disabledOtpReader
    },
  }
}

export const defaultOpCheckDeps = (): OpCheckDeps => ({
  files: nodeFileFacts,
  spawner: nodeSpawner,
  timers: nodeTimers,
  uid: process.getuid?.() ?? -1,
  groups: process.getgroups?.() ?? [],
})
