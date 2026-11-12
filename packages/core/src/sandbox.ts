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
 * other credential stores, and the system. Matched after resolving symlinks, case-insensitively
 * (APFS is case-insensitive by default). Messages' database is reached only through the OTP
 * provider, never as a file.
 */
export const FORBIDDEN_PATHS = [
  '~/Library/Application Support/Valet',
  '~/Library/Application Support/Valet Dev',
  '~/Library/Keychains',
  '~/Library/Messages',
  '~/Library/Group Containers/2BUA8C4S2C.com.1password',
  '~/Library/Containers/com.1password.1password',
  '~/Library/Cookies',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Safari',
  '~/Library/Mail',
  '~/Library/LaunchAgents',
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/op',
  '/System',
  '/Library',
  '/private',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/Applications',
] as const

/** The fixed folder a path pattern starts from, before any wildcard. */
export function patternRoot(pattern: string): string {
  return pattern.replace(/\/\*\*?$/, '')
}

/** True if a path pattern (or a resolved path) is inside or above a forbidden place. */
export function touchesForbiddenPath(path: string): boolean {
  const root = patternRoot(path).toLowerCase()
  return FORBIDDEN_PATHS.some((forbidden) => {
    const f = forbidden.toLowerCase()
    return root === f || root.startsWith(`${f}/`) || f.startsWith(`${root}/`)
  })
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
        .refine((p) => !p.includes('/../') && !p.endsWith('/..')),
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
      return `files:${exception.access}:${[...exception.paths].sort().join(',')}`
    case 'app':
      return `app:${exception.bundleId}`
    case 'local-service':
      return `local-service:${exception.port}`
    case 'network':
      return `network:${[...exception.hosts].sort().join(',')}`
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
