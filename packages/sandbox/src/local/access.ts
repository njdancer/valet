// Builds the `ctx.local` a run gets from its adapter's sandbox declaration (docs/sandbox.md):
// - `declared`: each capability limited to what the manifest's exceptions name;
// - `none`: every call refused (a draft's describe, tests and trials: nobody approved them yet);
// - `open`: an unsandboxed adapter, limited only by the hard rules (forbidden paths and programs,
//   public hosts, writable roots). Its card says it can reach anything the person can.

import { type LocalAccess, type SandboxDeclaration, type SandboxException, ValetError } from '@valet/core'
import { localRun } from './command'
import { fileReach, localFiles } from './files'
import { localFetch, localService, type NetOptions } from './net'

export type ExceptionMode = 'declared' | 'none'

export interface LocalAccessOptions {
  readonly home: string
  /** Tests only. */
  readonly net?: Omit<NetOptions, 'hosts'>
  readonly serviceTimeoutMs?: number
  /** Valet's own loopback ports, never reachable as a local service. */
  readonly refusedPorts?: () => readonly number[]
  readonly runTimeoutMs?: number
}

const refused = (): Promise<never> => Promise.reject(new ValetError('tool-run', 'not-granted'))

/** Every call refused as not-granted. */
export const NO_LOCAL_ACCESS: LocalAccess = {
  files: { list: refused, stat: refused, read: refused, write: refused, mkdir: refused },
  fetch: refused,
  service: refused,
  run: refused,
  appleScript: refused,
}

export function createLocalAccess(
  declaration: SandboxDeclaration,
  mode: ExceptionMode,
  options: LocalAccessOptions,
): LocalAccess {
  if (mode === 'none') return NO_LOCAL_ACCESS
  const open = declaration.mode === 'unsandboxed'
  const exceptions: readonly SandboxException[] =
    declaration.mode === 'sandboxed' ? declaration.exceptions : []
  const hosts = exceptions.flatMap((e) => (e.kind === 'network' ? e.hosts : []))
  const ports = exceptions.flatMap((e) => (e.kind === 'local-service' ? [e.port] : []))
  const programs = exceptions.flatMap((e) => (e.kind === 'command' ? [e.path] : []))
  const declaredFiles = exceptions.some((e) => e.kind === 'files')
  return {
    files:
      open || declaredFiles
        ? localFiles(open ? { kind: 'open' } : fileReach(exceptions, options.home), options.home)
        : NO_LOCAL_ACCESS.files,
    fetch: open || hosts.length > 0 ? localFetch({ ...options.net, hosts: open ? 'open' : hosts }) : refused,
    service:
      open || ports.length > 0
        ? localService({
            ports: open ? 'open' : ports,
            ...(options.refusedPorts === undefined ? {} : { refusedPorts: options.refusedPorts }),
            ...(options.serviceTimeoutMs === undefined ? {} : { timeoutMs: options.serviceTimeoutMs }),
          })
        : refused,
    run:
      open || programs.length > 0
        ? localRun({
            programs: open ? 'open' : programs,
            home: options.home,
            ...(options.runTimeoutMs === undefined ? {} : { timeoutMs: options.runTimeoutMs }),
          })
        : refused,
    // Apple Events wait for a typed, per-app helper (docs/sandbox.md#apple-events-deferred).
    appleScript: refused,
  } as LocalAccess
}
