// A stand-in for the 1Password CLI, `op`, signed in through the desktop app: the commands Valet
// runs (`read`, `item list`) and `--version`, with op's exit codes and its error wording, which
// Valet's classifier matches. fakeOpSpawner() answers Valet's spawner with it, and answers the
// codesign check Valet makes before it trusts an op binary, so no process is started.

import { EventEmitter } from 'node:events'
import { findVault, ReferenceFailed, resolveReference } from './references'
import type { FakeOnePassword } from './state'

export const FAKE_OP_VERSION = '2.31.1'
/** Where Valet looks for op first (credentials' DEFAULT_OP_PATHS). */
export const FAKE_OP_PATH = '/opt/homebrew/bin/op'
export const CODESIGN_PATH = '/usr/bin/codesign'

export interface OpResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

const ok = (stdout: string): OpResult => ({ code: 0, stdout: Buffer.from(stdout, 'utf8'), stderr: '' })

function failed(fake: FakeOnePassword, message: string): OpResult {
  const at = new Date(fake.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  return { code: 1, stdout: Buffer.alloc(0), stderr: `[ERROR] ${stamp} ${message}\n` }
}

/** Runs `op <args>` against `fake`. Never throws. */
export async function runOp(fake: FakeOnePassword, args: readonly string[]): Promise<OpResult> {
  const flags = new Map<string, string | true>()
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--no-newline' || arg === '--version' || arg === '-n') flags.set(arg, true)
    else if (arg === '--vault' || arg === '--format' || arg === '--account') {
      const value = args[i + 1]
      if (value === undefined) return failed(fake, `flag needs an argument: ${arg}`)
      flags.set(arg, value)
      i++
    } else if (arg.startsWith('--')) return failed(fake, `unknown flag: ${arg}`)
    else words.push(arg)
  }
  if (flags.has('--version') && words.length === 0) return ok(`${FAKE_OP_VERSION}\n`)
  const [command, sub, ...rest] = words
  if (command === 'read' && sub !== undefined && rest.length === 0) {
    const denied = await authorize(fake, flags)
    if (denied !== null) return denied
    return read(fake, sub, flags.has('--no-newline') || flags.has('-n'))
  }
  if (command === 'item' && sub === 'list' && rest.length === 0) {
    const denied = await authorize(fake, flags)
    if (denied !== null) return denied
    return itemList(fake, flags)
  }
  return failed(fake, `unknown command "${words.join(' ')}" for "op"`)
}

/** The desktop app's approval, as op asks for it: per account, reused while it is up. */
async function authorize(fake: FakeOnePassword, flags: Map<string, string | true>): Promise<OpResult | null> {
  const account = flags.get('--account')
  try {
    await fake.authorizeDesktop(
      typeof account === 'string' ? account : fake.account.name,
      'op',
      FAKE_OP_VERSION,
      'cli',
    )
    fake.useDesktop('op')
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/integration is not enabled/.test(message)) {
      return failed(
        fake,
        'connecting to desktop app: cannot connect to the app. Make sure it is running and that "Integrate with the CLI" is on in its Developer settings',
      )
    }
    if (/denied/.test(message)) return failed(fake, 'authorization prompt dismissed, please try again')
    return failed(fake, `account "${String(account)}" isn't signed in to the desktop app`)
  }
}

function read(fake: FakeOnePassword, reference: string, noNewline: boolean): OpResult {
  fake.record({ via: 'cli', auth: 'desktop', op: 'read', target: reference })
  try {
    const { value } = resolveReference(fake, reference, 'all', ['otp', 'totp'])
    return ok(noNewline ? value : `${value}\n`)
  } catch (error) {
    if (!(error instanceof ReferenceFailed)) throw error
    const prefix = `could not read secret '${reference}':`
    switch (error.reason) {
      case 'not-prefixed':
      case 'invalid-format':
        return failed(fake, `${prefix} invalid secret reference`)
      case 'no-vault':
        return failed(
          fake,
          `${prefix} "${error.vault}" isn't a vault in this account. Specify the vault with its ID or name.`,
        )
      case 'no-item':
      case 'inactive':
        return failed(
          fake,
          `${prefix} "${error.item}" isn't an item in the "${error.vault}" vault. Specify the item with its UUID, name, or domain.`,
        )
      case 'no-field':
        return failed(fake, `${prefix} "${error.field}" isn't a field in the "${error.item}" item`)
      case 'bad-attribute':
        return failed(fake, `${prefix} invalid attribute for this field`)
    }
  }
}

function itemList(fake: FakeOnePassword, flags: Map<string, string | true>): OpResult {
  const vaultName = flags.get('--vault')
  fake.record({
    via: 'cli',
    auth: 'desktop',
    op: 'item list',
    ...(typeof vaultName === 'string' ? { target: vaultName } : {}),
  })
  const vaults =
    typeof vaultName === 'string'
      ? (() => {
          try {
            return [findVault(fake, vaultName, 'all')]
          } catch {
            return null
          }
        })()
      : fake.visibleVaults('all')
  if (vaults === null) {
    return failed(
      fake,
      `"${String(vaultName)}" isn't a vault in this account. Specify the vault with its ID or name.`,
    )
  }
  const ids = new Set(vaults.map((v) => v.id))
  const items = fake.items
    .filter((i) => ids.has(i.vaultId) && !i.archived)
    .map((i) => ({
      id: i.id,
      title: i.title,
      version: 1,
      vault: { id: i.vaultId, name: vaults.find((v) => v.id === i.vaultId)?.title ?? '' },
      category: 'LOGIN',
      last_edited_by: fake.account.uuid,
      created_at: i.createdAt.toISOString(),
      updated_at: i.updatedAt.toISOString(),
      additional_information: i.username ?? '',
      urls: i.websites.map((href, n) => ({ ...(n === 0 ? { primary: true } : {}), href })),
    }))
  if (flags.get('--format') === 'json') return ok(`${JSON.stringify(items, null, 2)}\n`)
  const lines = ['ID                            TITLE                     VAULT            EDITED']
  for (const item of items)
    lines.push(`${item.id.padEnd(30)}${item.title.padEnd(26)}${item.vault.name.padEnd(17)}now`)
  return ok(`${lines.join('\n')}\n`)
}

/** A child process, as Valet's spawner hands one back. */
export class FakeOpChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = {
    end: (_chunk: Buffer) => undefined,
    on: (_event: 'error', _listener: (error: Error) => void) => undefined,
  }
  killed = false

  kill(_signal?: string): boolean {
    if (this.killed) return false
    this.killed = true
    queueMicrotask(() => this.emit('close', null))
    return true
  }

  finish(result: OpResult): void {
    if (this.killed) return
    if (result.stdout.length > 0) this.stdout.emit('data', result.stdout)
    if (result.stderr.length > 0) this.stderr.emit('data', Buffer.from(result.stderr, 'utf8'))
    this.emit('close', result.code)
  }
}

export interface FakeOpSpawnerOptions {
  /** Where the fake op is. */
  readonly opPath?: string
  /** Anything else is handed here; without one it is missing (ENOENT). */
  readonly fallback?: (command: string, args: readonly string[], options?: { input?: boolean }) => unknown
}

/**
 * A spawner (credentials' Spawner) on which `opPath` is the fake op, and codesign passes it as signed
 * by 1Password's team. Every other command is the fallback's, or missing.
 */
export function fakeOpSpawner(fake: FakeOnePassword, options: FakeOpSpawnerOptions = {}) {
  const opPath = options.opPath ?? FAKE_OP_PATH
  return (command: string, args: readonly string[], spawnOptions?: { input?: boolean }) => {
    if (command !== opPath && command !== CODESIGN_PATH && options.fallback !== undefined) {
      return options.fallback(command, args, spawnOptions) as FakeOpChild
    }
    const child = new FakeOpChild()
    queueMicrotask(() => {
      if (command === opPath) {
        void runOp(fake, args).then((result) => child.finish(result))
      } else if (command === CODESIGN_PATH && args.at(-1) === opPath && args.includes('--verify')) {
        child.finish({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
      } else if (command === CODESIGN_PATH) {
        child.finish({
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: `${args.at(-1)}: code object is not signed at all\n`,
        })
      } else {
        child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }))
      }
    })
    return child
  }
}
