// Reset and uninstall: removing what Valet keeps on this Mac. Both erase the same things; a reset
// then starts the app again as new, and an uninstall also moves the app to the Trash.
//
// What goes: Valet's Keychain items, the Messages helper's launch agent and its socket folder, the
// login item, the browser sessions, and the data folder with its grants, approvals, client tokens,
// audit log, traces and diagnostics. What Valet can't remove, the person is told about before they
// agree (eraseDetail): the entries in Claude's own config, and the rows macOS keeps in System
// Settings.
//
// Only the main process starts this, after its own native dialog: a renderer can ask for the dialog
// but can't answer it. Every step is attempted even when an earlier one fails, and the report names
// the steps that failed by fixed names, never by path or message.

import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export type EraseKind = 'reset' | 'uninstall'

export type EraseStep =
  | 'stop'
  | 'keychain-copies'
  | 'keychain-token'
  | 'messages-helper'
  | 'approvals-anchor'
  | 'login-item'
  | 'browser-data'
  | 'data'
  | 'leftovers'

export interface EraseReport {
  readonly kind: EraseKind
  readonly failed: readonly EraseStep[]
}

/**
 * Kept across a reset, never across an uninstall: the highest version this install has run. It is
 * the floor an update may not go below, and a reset shouldn't reopen a downgrade.
 */
export const KEPT_ON_RESET: readonly string[] = ['versions.json']

/**
 * Whether `path` may be removed whole: absolute and already normalised, at least three folders
 * deep, not the home folder or anything above it, and inside the home folder at least three below
 * it (~/Library/Application Support/Valet, never ~/Library or ~/Library/Caches). The data folder
 * comes from the launch (it can be overridden for tests), so this is the last check before a
 * recursive delete.
 */
export function safeToRemove(path: string, home: string = homedir()): boolean {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) return false
  const depth = (p: string): number => p.split(sep).filter((part) => part.length > 0).length
  if (depth(path) < 3) return false
  const top = resolve(home)
  if (top === path || top.startsWith(`${path}${sep}`)) return false
  return !path.startsWith(`${top}${sep}`) || depth(path) - depth(top) >= 3
}

/**
 * What macOS keeps for a packaged app outside its data folder, by bundle id. Empty for anything
 * that isn't one of Valet's own ids: an unpackaged run is "Electron" to macOS, and its caches
 * belong to every Electron app in development.
 */
export function leftoverPaths(bundleId: string | null, home: string = homedir()): string[] {
  if (bundleId === null || !/^me\.dncr\.valet(\.dev)?$/.test(bundleId)) return []
  const library = join(home, 'Library')
  return [
    join(library, 'Caches', bundleId),
    join(library, 'Caches', `${bundleId}.ShipIt`),
    join(library, 'HTTPStorages', bundleId),
    join(library, 'HTTPStorages', `${bundleId}.binarycookies`),
    join(library, 'Preferences', `${bundleId}.plist`),
    join(library, 'Saved Application State', `${bundleId}.savedState`),
    join(library, 'WebKit', bundleId),
  ]
}

export interface EraseDeps {
  readonly kind: EraseKind
  readonly dataDir: string
  /** Other folders and files of Valet's to remove: the Messages helper's folder, macOS's caches. */
  readonly leftovers: readonly string[]
  /** Stops the service: calls cancelled, the endpoint and the drivers closed. */
  readonly stop: () => Promise<void>
  /** Removes the Keychain items and the launch agent; the steps that failed. */
  readonly eraseCredentials: () => Promise<readonly EraseStep[]>
  readonly setLaunchAtLogin: (enabled: boolean) => void
  /** Clears the sessions Chromium holds open, so nothing is written back after the folder is gone. */
  readonly clearBrowserData: () => Promise<void>
  readonly home?: string
}

/** Removes everything. Never throws: what couldn't be done is in the report. */
export async function eraseEverything(deps: EraseDeps): Promise<EraseReport> {
  const failed = new Set<EraseStep>()
  const attempt = async (step: EraseStep, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run()
    } catch {
      failed.add(step)
    }
  }
  await attempt('stop', deps.stop)
  // The Keychain before the files: grants.json is no longer what says which items exist, but if this
  // is interrupted the app still opens on its data and the erase can be run again.
  try {
    for (const step of await deps.eraseCredentials()) failed.add(step)
  } catch {
    failed.add('keychain-copies')
  }
  await attempt('login-item', () => deps.setLaunchAtLogin(false))
  await attempt('browser-data', deps.clearBrowserData)
  await attempt('data', () => removeData(deps.dataDir, deps.kind, deps.home))
  await attempt('leftovers', async () => {
    let missed = false
    for (const path of deps.leftovers) {
      if (!safeToRemove(path, deps.home)) missed = true
      else await rm(path, { recursive: true, force: true }).catch(() => (missed = true))
    }
    if (missed) throw new Error('leftovers')
  })
  return { kind: deps.kind, failed: [...failed] }
}

async function removeData(dir: string, kind: EraseKind, home?: string): Promise<void> {
  if (!safeToRemove(dir, home)) throw new Error('unsafe')
  if (kind === 'uninstall') {
    await rm(dir, { recursive: true, force: true })
    return
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let missed = false
  for (const name of names) {
    if (KEPT_ON_RESET.includes(name)) continue
    await rm(join(dir, name), { recursive: true, force: true }).catch(() => (missed = true))
  }
  if (missed) throw new Error('data')
}

/** The native dialog's wording: what goes, and what the person has to remove themselves. */
export function eraseDialog(
  kind: EraseKind,
  options: { readonly demo: boolean; readonly serverName: string },
): { readonly message: string; readonly detail: string; readonly confirm: string } {
  const gone = [
    'This removes everything Valet keeps on this Mac: its Keychain items (the copies of your 1Password logins), your grants and approvals, every client’s access, the site sessions, the audit log, traces and settings.',
    'It can’t be undone. Export the audit log first if you want to keep it. Nothing in 1Password changes.',
  ]
  const yours = `Valet can’t edit Claude’s own config. Remove the “${options.serverName}” server there yourself: run “claude mcp remove ${options.serverName}” for Claude Code, and delete its entry from Claude Desktop’s config file.`
  if (kind === 'reset') {
    return {
      message: options.demo ? 'Reset the Valet demo?' : 'Reset Valet?',
      detail: [...gone, 'Valet then restarts as if newly installed.', yours].join('\n\n'),
      confirm: 'Erase and Restart',
    }
  }
  return {
    message: 'Uninstall Valet?',
    detail: [
      ...gone,
      'Valet then moves itself to the Trash and quits.',
      `${yours} macOS may still list Valet under Login Items and Full Disk Access in System Settings; those rows can be removed there.`,
    ].join('\n\n'),
    confirm: 'Erase and Uninstall',
  }
}

const FAILED_WORDING: Readonly<Record<EraseStep, string>> = {
  stop: 'Valet couldn’t stop everything it was doing first.',
  'keychain-copies':
    'The Keychain copies of your logins. In Keychain Access, search for “valet” and delete what it finds.',
  'keychain-token':
    'The 1Password service-account token. In Keychain Access, delete the “valet” item named “onepassword-service-account”.',
  'messages-helper': 'The Messages helper. Turn it off under System Settings > General > Login Items.',
  'approvals-anchor':
    'The record that vouches for your approvals. Valet will open locked down; unlock it with Touch ID.',
  'login-item': 'Opening Valet at login. Remove it under System Settings > General > Login Items.',
  'browser-data': 'The site sessions held in memory. They go when Valet quits.',
  data: 'Some files in Valet’s data folder in ~/Library/Application Support.',
  leftovers: 'Some of Valet’s caches in ~/Library.',
}

/** What to tell the person when part of an erase failed; null when all of it worked. */
export function eraseFailedDetail(report: EraseReport): string | null {
  if (report.failed.length === 0) return null
  return ['These couldn’t be removed:', ...report.failed.map((step) => `• ${FAILED_WORDING[step]}`)].join(
    '\n\n',
  )
}

/**
 * The app bundle a packaged main process runs from (…/Valet.app/Contents/MacOS/Valet), for moving it
 * to the Trash; null for anything that doesn't look like one.
 */
export function appBundlePath(execPath: string): string | null {
  const match = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match?.[1] === undefined || match[1].includes('\0') ? null : match[1]
}

/**
 * A detached shell that waits for this process to exit (ten seconds at most) and removes the data
 * folder once more: Chromium writes a few of its own files back as it shuts down, after the app's
 * own delete. Null when the folder isn't one that may be removed. The paths are arguments, never
 * part of the script.
 */
export function sweepCommand(
  pid: number,
  dir: string,
  home?: string,
): { readonly command: string; readonly args: readonly string[] } | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !safeToRemove(dir, home)) return null
  const script =
    'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done; rm -rf -- "$2"'
  return { command: '/bin/sh', args: ['-c', script, 'valet-sweep', String(pid), dir] }
}
