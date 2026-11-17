// ctx.sftp for one call (docs/sftp.md): the checks every operation passes before the protocol host
// is asked to do anything. The host checks the same things again on its own, against the paths the
// server resolves, and its client checks every request on the wire (packages/protocols), so each
// rule holds at three layers.
//
// In order, for each operation:
// 1. the call is still live (not aborted, blocked, or past a guard violation);
// 2. the operation's purpose (sftp-policy.ts) is within the tool's declared side effect;
// 3. every path it names is in Valet's form and under a root that allows that purpose, and a change
//    never names a root itself, nor renames or removes a folder holding one;
// 4. it counts against the run's request ceiling, and waits for the site's pace and breaker;
// 5. the first one opens the call's connection: the host process, signed in just in time with the
//    kept key, through the broker's tunnel to the one declared endpoint, the host key pinned.
// A refusal at 2 to 4 is sticky, recorded as `request-blocked`, and sent nowhere.

import {
  type AuditEvent,
  type ErrorClass,
  isSftpOperation,
  isSftpPath,
  type Purpose,
  pathAllowed,
  type SecretValue,
  SFTP_PATH_ARGS,
  SFTP_PURPOSE_RANK,
  type SftpAccess,
  type SftpOperation,
  type SftpPurpose,
  type SftpRoot,
  type Stage,
  sftpOperationPurpose,
  ValetError,
} from '@valet/core'
import type { RunContext } from '@valet/egress'
import { CallGate, type CallGateOptions } from './call-gate'

/** One call's connection to the SFTP host. */
export interface SftpConnection {
  operation(op: SftpOperation, args: readonly unknown[]): Promise<unknown>
  /** Signs out and ends the host. Never throws. */
  end(): Promise<void>
}

export interface SftpCall {
  readonly purpose: SftpPurpose
  readonly run: RunContext
  /** One pacing slot per connection the host opens through its tunnel. */
  readonly admit: () => Promise<void>
  /** The kept key, asked for only once the host is up. The caller disposes the values. */
  readonly signIn: () => Promise<{ readonly username: SecretValue | null; readonly secret: SecretValue }>
  readonly signal: AbortSignal
}

/** What runs the SFTP host for an adapter (packages/protocols' sftpBackend). */
export interface SftpBackend {
  /** `host:port`, for the audit log. */
  readonly endpoint: string
  readonly roots: readonly SftpRoot[]
  connect(call: SftpCall): Promise<SftpConnection>
}

export interface GuardedSftpOptions extends CallGateOptions {
  readonly backend: SftpBackend
  readonly run: RunContext
  readonly signIn: SftpCall['signIn']
}

export class GuardedSftp implements SftpAccess {
  private readonly gate: CallGate
  private connection: Promise<SftpConnection> | null = null

  constructor(private readonly options: GuardedSftpOptions) {
    this.gate = new CallGate(options)
    // The connection dies with the call.
    options.state.signal.addEventListener(
      'abort',
      () => {
        void this.connection?.then(
          (c) => c.end(),
          () => undefined,
        )
      },
      { once: true },
    )
  }

  list: SftpAccess['list'] = (path, options) =>
    this.op('list', [path, options]) as ReturnType<SftpAccess['list']>
  stat: SftpAccess['stat'] = (path) => this.op('stat', [path]) as ReturnType<SftpAccess['stat']>
  read: SftpAccess['read'] = (path, options) =>
    this.op('read', [path, options]) as ReturnType<SftpAccess['read']>
  write: SftpAccess['write'] = (path, data, options) =>
    this.op('write', [path, data, options]) as ReturnType<SftpAccess['write']>
  mkdir: SftpAccess['mkdir'] = (path) => this.op('mkdir', [path]) as ReturnType<SftpAccess['mkdir']>
  rename: SftpAccess['rename'] = (from, to) =>
    this.op('rename', [from, to]) as ReturnType<SftpAccess['rename']>
  remove: SftpAccess['remove'] = (path) => this.op('remove', [path]) as ReturnType<SftpAccess['remove']>
  removeDir: SftpAccess['removeDir'] = (path) =>
    this.op('removeDir', [path]) as ReturnType<SftpAccess['removeDir']>

  /** Runs one operation by name, as the isolation channel delivers it. */
  async op(name: unknown, args: readonly unknown[]): Promise<unknown> {
    const { state } = this.options
    state.assertLive()
    if (!isSftpOperation(name) || !Array.isArray(args) || args.length > 3)
      throw new ValetError('tool-run', 'invalid')
    // Trailing undefined arguments are dropped, as the tool process drops them.
    const list = [...args]
    while (list.length > 0 && list[list.length - 1] === undefined) list.pop()
    const needed: Purpose = sftpOperationPurpose(name, list)
    if (SFTP_PURPOSE_RANK[needed] > SFTP_PURPOSE_RANK[this.options.sideEffect]) {
      return this.deny('request-surface', 'command-not-allowed', name, null)
    }
    for (const index of SFTP_PATH_ARGS[name]) {
      const path = list[index]
      if (!isSftpPath(path)) throw new ValetError('tool-run', 'invalid')
      if (!pathAllowed(name, path, needed, this.options.backend.roots)) {
        return this.deny('request-surface', 'command-not-allowed', name, path)
      }
    }
    state.requests++
    if (state.requests > this.options.manifest.limits.requestsPerRun) {
      return this.deny('request-surface', 'request-ceiling', name, null)
    }
    await this.gate.pace()
    const connection = await state.track(this.connect())
    state.assertLive()
    try {
      return await state.track(connection.operation(name, list))
    } catch (error) {
      if (error instanceof ValetError && error.errorClass === 'command-not-allowed') {
        // The host refused what these checks let through: the server resolved a path somewhere
        // the roots don't reach (a link), or a bug here. Either way it ends the call.
        state.violation ??= error
      }
      throw error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
    }
  }

  private connect(): Promise<SftpConnection> {
    if (this.connection === null) {
      const { backend, run, state, signIn, sideEffect } = this.options
      this.connection = backend.connect({
        purpose: sideEffect,
        run,
        admit: async () => {
          await this.gate.pace()
        },
        signIn,
        signal: state.signal,
      })
      // A failed start isn't retried within the call: the next call starts fresh.
      this.connection.catch(() => undefined)
    }
    return this.connection
  }

  private async deny(
    stage: Stage,
    errorClass: ErrorClass,
    operation: SftpOperation,
    path: string | null,
  ): Promise<never> {
    const { state, adapterId, audit } = this.options
    const error = new ValetError(stage, errorClass)
    state.violation ??= error
    // The path the tool named, percent-encoded, so the log line stays one line whatever it holds.
    const where = path === null ? '' : `:${encodeURI(path.slice(0, 200))}`
    const event: AuditEvent = {
      type: 'request-blocked',
      adapterId,
      method: 'SFTP',
      target: `sftp://${this.options.backend.endpoint}/${operation}${where}`,
      reason: errorClass,
      initiator: 'tool',
      partition: 'tool',
      callId: state.callId,
    }
    await audit(event)
    throw error
  }
}

/** ctx.sftp for an adapter that has no SFTP: every call is not-granted. */
export const NO_SFTP_ACCESS: SftpAccess = Object.freeze(
  Object.fromEntries(
    (['list', 'stat', 'read', 'write', 'mkdir', 'rename', 'remove', 'removeDir'] as const).map((name) => [
      name,
      () => Promise.reject(new ValetError('tool-run', 'not-granted')),
    ]),
  ) as unknown as SftpAccess,
)
