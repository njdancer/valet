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
  if (root === '/volumes' || /^\/volumes\/[^/]+(\/users(\/|$)|$)/.test(root)) return true
  return FORBIDDEN_PATHS.some((forbidden) => {
    const f = fold(forbidden)
    return root === f || root.startsWith(`${f}/`) || f.startsWith(`${root}/`)
  })
}

/**
 * Programs and apps that would give tool code everything unsandboxed mode gives it: shells,
 * interpreters, and anything that runs scripts. Refused as `command` and `app` exceptions.
 */
const FORBIDDEN_COMMAND =
  /\/(?:[a-z]*sh|env|osascript|osacompile|python[0-9.]*|perl[0-9.]*|ruby|node|php|tclsh|expect|awk|sudo|su|open|launchctl|xargs|find|script|login|security|sqlite3|curl|wget|nc|ssh|scp|git)$/i
export const FORBIDDEN_APPS = [
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'com.apple.systemevents',
  'com.apple.scripteditor2',
  'com.apple.finder',
  'com.apple.automator',
  'com.apple.shortcuts',
  'com.apple.systempreferences',
  'com.apple.keychainaccess',
  'com.1password.1password',
] as const

export function isForbiddenCommand(path: string): boolean {
  return FORBIDDEN_COMMAND.test(path.normalize('NFKC'))
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
    .strict(),
  /** Send Apple Events to one app (Calendar, Reminders), by bundle id. */
  z
    .object({
      kind: z.literal('app'),
      bundleId: z
        .string()
        .refine(
          (id) => !(FORBIDDEN_APPS as readonly string[]).includes(id.toLowerCase()),
          'that app can run anything',
        )
        .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
        .max(155),
      purpose,
    })
    .strict(),
  /** Talk to a service on this Mac, on 127.0.0.1 and this port only. */
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
  /** Run one program, by absolute path, with arguments the tool chooses. */
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
        .refine((p) => !isForbiddenCommand(p), 'shells, interpreters and script runners are never allowed'),
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
