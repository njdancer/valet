// What an adapter declares about the sandbox (D73; docs/agent-run-security.md#sandbox-exceptions).
//
// The sandbox is on unless the manifest says otherwise. An exception is not a hole in the
// sandbox: it is one more capability the runtime injects (a file reader limited to these paths,
// say), enforced in the main process, listed on the approval card and in the permission diff.
// Running unsandboxed is possible but loud: it gives tool code everything Valet itself can reach,
// other adapters' secrets included, so it is critical on the card and approvable only at the Mac.

import { z } from 'zod'
import { displayText } from './display-text'
import { isHostPattern } from './origins'
import type { Risk } from './permission-change'

const purpose = displayText(200)

/**
 * A path an exception may name: absolute or under `~/`, no `.` or `..` segments, no doubled
 * slashes, at most one trailing `*` (direct children) or `**` (everything below) segment.
 */
export function isPathPattern(value: string): boolean {
  if (value.length > 300 || /[\p{Cc}\p{Cf}\\]/u.test(value)) return false
  if (value.normalize('NFC') !== value) return false
  const body = value.startsWith('~/') ? value.slice(2) : value.startsWith('/') ? value.slice(1) : null
  if (body === null || body === '') return false
  const segments = body.split('/')
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (segment === '' || segment === '.' || segment === '..') return false
    if (segment.includes('*') && !(last && (segment === '*' || segment === '**'))) return false
  }
  // At least one real folder before a wildcard: `~/*` and `/**` are the whole disk or home.
  return !(segments.length === 1 && segments[0]?.includes('*'))
}

/**
 * Places no exception may reach, whatever the person approves: Valet's own data and Keychain,
 * other credential stores and browser profiles, things that run code at login or in a shell, and
 * the system. Messages' database is reached only through the OTP provider, never as a file.
 * Compared after expanding `~`, resolving symlinks (the runtime does that), NFKC and case folding.
 */
export const FORBIDDEN_PATHS = [
  '~/Library/Application Support/Valet',
  '~/Library/Application Support/Valet Dev',
  '~/Library/Application Support/Valet Demo',
  '~/Library/Keychains',
  '~/Library/Messages',
  '~/Library/Group Containers/2BUA8C4S2C.com.1password',
  '~/Library/Containers/com.1password.1password',
  '~/Library/Cookies',
  '~/Library/HTTPStorages',
  '~/Library/Application Support/Google',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/Arc',
  '~/Library/Application Support/Firefox',
  '~/Library/Safari',
  '~/Library/Containers/com.apple.Safari',
  '~/Library/Mail',
  '~/Library/Containers/com.apple.mail',
  '~/Library/LaunchAgents',
  '~/Library/Preferences',
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config',
  '~/.zshrc',
  '~/.zprofile',
  '~/.zshenv',
  '~/.zlogin',
  '~/.bashrc',
  '~/.bash_profile',
  '~/.profile',
  '~/.local/bin',
  '~/bin',
  '~/Applications',
  '~/Library/Services',
  '~/Library/Application Support/Claude',
  '~/Library/Application Support/Code',
  '~/Library/Application Support/Cursor',
  '~/.claude',
  '~/.codex',
  '~/.cursor',
  '~/.vscode',
  '~/.netrc',
  '~/.docker',
  '~/.kube',
  '~/.git-credentials',
  '~/.gitconfig',
  '~/.npmrc',
  '~/.pypirc',
  '~/.gem',
  '/System',
  '/Library',
  '/private',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/opt',
  '/Applications',
] as const

/** The fixed folder a path pattern starts from, before any wildcard. */
export function patternRoot(pattern: string): string {
  return pattern.replace(/\/\*\*?$/, '')
}

/** Folds a path for comparison the way APFS would see it as the same: NFKC, then case. */
function fold(path: string): string {
  return path.normalize('NFKC').toLowerCase()
}

/**
 * True if a path pattern (or a resolved path) is inside or above a forbidden place, or names
 * another person's home or a whole volume. `home` is the person's home folder: `~/x` and
 * `<home>/x` are the same place. A pattern must name the person's own home as `~/`, never as
 * `/Users/<name>`, so an absolute path under /Users (or a volume's Users folder) is refused.
 */
export function touchesForbiddenPath(path: string, home?: string): boolean {
  const homeFolded = home === undefined ? null : fold(home.replace(/\/+$/, ''))
  let root = fold(patternRoot(path))
  if (homeFolded !== null && (root === homeFolded || root.startsWith(`${homeFolded}/`))) {
    root = `~${root.slice(homeFolded.length)}`
  }
  if (root === '~') return true
  if (root === '/users' || root.startsWith('/users/')) return true
  // A volume is another disk's root: refuse it whole, and the system folders on it.
  if (
    root === '/volumes' ||
    /^\/volumes\/[^/]+(\/(users|library|system|private|applications|etc|usr)(\/|$)|$)/.test(root)
  ) {
    return true
  }
  return FORBIDDEN_PATHS.some((forbidden) => {
    const f = fold(forbidden)
    return root === f || root.startsWith(`${f}/`) || f.startsWith(`${root}/`)
  })
}

/**
 * Programs and apps that would give tool code everything unsandboxed mode gives it: shells,
 * interpreters, and anything that runs scripts. Refused as `command` and `app` exceptions.
 */
// Belt and braces: a command is critical and Mac only whatever this says; this catches the obvious.
const FORBIDDEN_COMMAND =
  /\/(?:[a-z]*sh|env|osascript|osacompile|python|perl|ruby|node|bun|deno|php|tclsh|wish|expect|awk|sudo|su|open|launchctl|xargs|find|script|login|security|sqlite3|curl|wget|nc|ssh|scp|git|swift|swiftc|arch|nohup|time|caffeinate|sandbox-exec|xcrun|xcodebuild|make|vim?|nvim|emacs|lldb|gdb|java|jshell|automator|shortcuts|defaults|plutil|tccutil|codesign|spctl|dscl|crontab|at|batch|screen|tmux)[0-9.]*$/i

/**
 * The apps an `app` exception may send Apple Events to. Empty, so every `app` exception is refused
 * at install (I's review): no app was safe to send raw Apple Events to. AppleScript's `run
 * script` and scripting additions run inside the caller, reading any file and the clipboard, and
 * each data app could still exfiltrate or run code (Calendar alarms that mail or open files;
 * Notes, Numbers and Photos save and export anywhere). Access to an app's data comes back as a
 * typed set of operations per app (likely EventKit and Contacts through a Swift helper), never
 * as Apple Events. Adding to this list is a contract change and needs a security review.
 */
export const ALLOWED_APPS: readonly string[] = []

/** Folders a program may not be in, because anything running as the person could replace it. */
const USER_WRITABLE_PROGRAM = /^\/(users|volumes|tmp|private|var|opt\/homebrew)\//

export function isForbiddenCommand(path: string): boolean {
  return FORBIDDEN_COMMAND.test(path.normalize('NFKC'))
}

/**
 * Where a read-write exception may point: the person's own document folders and other disks. A
 * deny list can't name every file that runs code (a shell config, an editor's settings, an MCP
 * client's config), so writing is allowed only here.
 */
export const WRITABLE_ROOTS = [
  '~/Documents',
  '~/Downloads',
  '~/Desktop',
  '~/Pictures',
  '~/Movies',
  '~/Music',
] as const

export function isWritablePath(path: string): boolean {
  const root = fold(patternRoot(path))
  if (/^\/volumes\/[^/]+\/.+/.test(root)) return !touchesForbiddenPath(path)
  return WRITABLE_ROOTS.some((r) => root.startsWith(`${fold(r)}/`)) && !touchesForbiddenPath(path)
}

const pathPattern = z
  .string()
  .refine(isPathPattern, 'must be an absolute or ~/ path, optionally ending in /* or /**')
  .refine((p) => !touchesForbiddenPath(p), 'reaches a place no adapter may')

export const sandboxExceptionSchema = z.discriminatedUnion('kind', [
  /** Read, or read and write, files under these paths. */
  z
    .object({
      kind: z.literal('files'),
      access: z.enum(['read', 'read-write']),
      paths: z.array(pathPattern).min(1).max(10),
      purpose,
    })
    .strict()
    .refine(
      (e) => e.access === 'read' || e.paths.every(isWritablePath),
      'read-write only under Documents, Downloads, Desktop, Pictures, Movies, Music or another disk',
    ),
  /** Send Apple Events to one app (Calendar, Reminders), by bundle id. */
  z
    .object({
      kind: z.literal('app'),
      bundleId: z
        .string()
        .refine(
          (id) => (ALLOWED_APPS as readonly string[]).includes(id.toLowerCase()),
          'only apps that hold the person’s own data and can’t run code or send anything',
        )
        .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
        .max(155),
      purpose,
    })
    .strict(),
  /**
   * Talk to a service on this Mac, on 127.0.0.1 and this port only. Never one of Valet's own: the
   * runtime refuses, at connect time, any port Valet itself listens on (the MCP endpoint, the
   * egress proxy, the helpers, any debugging port). Those ports are chosen at run time, so the
   * check can't live in this schema (I's review).
   */
  z
    .object({ kind: z.literal('local-service'), port: z.number().int().min(1024).max(65535), purpose })
    .strict(),
  /** HTTPS requests from tool code itself, outside the browser, to these hosts (an API). */
  z
    .object({
      kind: z.literal('network'),
      hosts: z.array(z.string().refine(isHostPattern, 'must be a hostname, optionally "*."')).min(1).max(10),
      purpose,
    })
    .strict(),
  /**
   * Run one program, by absolute path, with arguments the tool chooses. It is a grant as broad as
   * the program: `/bin/cp` can read `~/.ssh`. So it runs under Seatbelt (no network; nothing in
   * FORBIDDEN_PATHS or Valet's data; writes only in a fresh temporary folder; exec of this program
   * only), is refused off macOS, and its card says it can read your files (I's review).
   */
  z
    .object({
      kind: z.literal('command'),
      path: z
        .string()
        .regex(/^\/[^\p{Cc}\p{Cf}*]+$/u)
        .max(300)
        .refine(
          (p) =>
            p
              .split('/')
              .slice(1)
              .every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
          'no empty, . or .. segments',
        )
        .refine((p) => !isForbiddenCommand(p), 'shells, interpreters and script runners are never allowed')
        .refine(
          (p) => !USER_WRITABLE_PROGRAM.test(fold(p)),
          'a program in a folder the person can write to could be swapped',
        ),
      purpose,
    })
    .strict(),
])
export type SandboxException = z.infer<typeof sandboxExceptionSchema>

export const sandboxDeclarationSchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('sandboxed'), exceptions: z.array(sandboxExceptionSchema).max(20).default([]) })
    .strict(),
  /** Why it can't run sandboxed, in the author's words; shown to the person as a claim. */
  z.object({ mode: z.literal('unsandboxed'), reason: purpose }).strict(),
])
export type SandboxDeclaration = z.infer<typeof sandboxDeclarationSchema>

/** What a manifest without a `sandbox` field means. */
export const DEFAULT_SANDBOX: SandboxDeclaration = { mode: 'sandboxed', exceptions: [] }

/** How the card and the permission diff rate an exception. */
export function exceptionRisk(exception: SandboxException): Risk {
  switch (exception.kind) {
    case 'files':
      return exception.access === 'read-write' || exception.paths.some((p) => p.endsWith('/**'))
        ? 'high'
        : 'medium'
    case 'app':
      return 'high'
    case 'local-service':
      return 'medium'
    case 'network':
      return 'high'
    case 'command':
      return 'critical'
  }
}

export function sandboxRisk(declaration: SandboxDeclaration): Risk {
  if (declaration.mode === 'unsandboxed') return 'critical'
  const order: readonly Risk[] = ['low', 'medium', 'high', 'critical']
  return declaration.exceptions.reduce<Risk>((worst, e) => {
    const risk = exceptionRisk(e)
    return order.indexOf(risk) > order.indexOf(worst) ? risk : worst
  }, 'low')
}

/** A stable key for an exception, so a diff can tell an unchanged one from a new one. */
export function exceptionKey(exception: SandboxException): string {
  switch (exception.kind) {
    case 'files':
      return `files:${exception.access}:${JSON.stringify([...exception.paths].sort())}`
    case 'app':
      return `app:${exception.bundleId}`
    case 'local-service':
      return `local-service:${exception.port}`
    case 'network':
      return `network:${JSON.stringify([...exception.hosts].sort())}`
    case 'command':
      return `command:${exception.path}`
  }
}

/** Exceptions in `next` that `previous` didn't have, and whether the mode loosened. */
export function sandboxWidening(
  previous: SandboxDeclaration | null,
  next: SandboxDeclaration,
): { readonly becameUnsandboxed: boolean; readonly added: readonly SandboxException[] } {
  const before = previous ?? DEFAULT_SANDBOX
  if (next.mode === 'unsandboxed') return { becameUnsandboxed: before.mode !== 'unsandboxed', added: [] }
  const had = new Set(before.mode === 'sandboxed' ? before.exceptions.map(exceptionKey) : [])
  return { becameUnsandboxed: false, added: next.exceptions.filter((e) => !had.has(exceptionKey(e))) }
}
