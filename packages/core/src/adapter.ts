// How an adapter is defined in code: its manifest plus one implementation per declared tool.

import { z } from 'zod'
import type { ErrorClass, NeedsUserReason, Stage } from './errors'
import type { HttpAccess } from './http-access'
import type { ImapAccess } from './imap-access'
import type { LocalAccess } from './local-access'
import type { AdapterManifest } from './manifest'
import type { ToolPage } from './page'
import { REQUEST_METHODS } from './request-surface'

export type EnsureResult =
  | { readonly status: 'ok' }
  | { readonly status: 'needsUser'; readonly reason: NeedsUserReason }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }

/** The longest note an adapter may attach to a confirmation. */
export const MAX_CONFIRM_NOTE = 500

/**
 * What tool code asks the person to confirm (C4). The runtime renders the dialog from this and from
 * what it already knows (the tool, its declared side effect, the calling client); only `note` is
 * the adapter's own words, and the app shows it second, attributed and marked unverified.
 */
export const confirmActionSchema = z
  .object({
    /**
     * The declared requests the tool will make if the person says yes, each with `method` and `path`
     * exactly as written in the manifest's `requests`. The runtime refuses one that isn't declared
     * there, or whose purpose outranks the tool's side effect, and shows each one's declared purpose.
     */
    requests: z
      .array(
        z
          .object({
            method: z.enum(REQUEST_METHODS),
            path: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    /** Optional free text for the person, at most MAX_CONFIRM_NOTE characters. */
    note: z.string().min(1).max(MAX_CONFIRM_NOTE).optional(),
  })
  .strict()
export type ConfirmAction = z.infer<typeof confirmActionSchema>

/** The capability object tool code receives. It is the whole of what tool code can do. */
export interface ToolContext {
  readonly page: ToolPage
  readonly session: {
    /**
     * Makes sure the session is logged in, running the auth action if needed. Tool code that gets
     * needsUser back should throw `new NeedsUserError(result.reason)` so the run ends as needsUser.
     */
    ensure(): Promise<EnsureResult>
  }
  /**
   * Asks the person (not the MCP client) to confirm `action`. Resolves false if they decline or time
   * out. An action the runtime refuses (malformed, undeclared, or beyond the tool's side effect)
   * rejects with `confirm` and fails the call, the way a guard violation does. A yes unlocks nothing:
   * every request is still held to the manifest and the tool's side effect.
   */
  confirm(action: ConfirmAction): Promise<boolean>
  readonly signal: AbortSignal
  /**
   * Local data through the manifest's declared sandbox exceptions (docs/sandbox.md). Every call
   * for a kind the manifest doesn't declare rejects with `tool-run/not-granted`. Optional for the
   * runtime's own contexts and older tests; tool code in the tool process always has it.
   */
  readonly local?: LocalAccess
  /**
   * The egress broker, for an `http` adapter (docs/adapter-kinds.md#ctxhttp). Every call from a
   * browser adapter rejects with `tool-run/not-granted`. Optional for the runtime's own contexts and
   * older tests; tool code in the tool process always has it.
   */
  readonly http?: HttpAccess
  /**
   * Mail, for a `protocol` adapter with protocols.imap (docs/imap.md). Every call from any other
   * adapter rejects with `tool-run/not-granted`. Optional like `http`.
   */
  readonly imap?: ImapAccess
  /**
   * Credentials entrusted to a `raw` adapter (docs/adapter-kinds.md#raw). Every call from any other
   * kind rejects with `tool-run/not-granted`. Optional for the runtime's own contexts and older
   * tests; tool code in the tool process always has it.
   */
  readonly secrets?: SecretsAccess
}

/**
 * An entrusted credential as a `raw` adapter is given it: the secret (a password, token or private
 * key) and the item's username when it has one. Getting one is audited, registers the value and its
 * encodings for redaction from the call's output, and from then on the call's connections may reach
 * only the endpoints that credential is for.
 */
export interface EntrustedCredential {
  readonly value: string
  readonly username: string | null
}

export interface SecretsAccess {
  get(name: string): Promise<EntrustedCredential>
}

export interface ToolImplementation<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  readonly input: Input
  readonly output: Output
  run(ctx: ToolContext, input: z.infer<Input>): Promise<z.infer<Output>>
}

export interface AdapterDefinition {
  readonly manifest: AdapterManifest
  readonly tools: Readonly<Record<string, ToolImplementation>>
}

/** Checks that every declared tool has an implementation and every implementation is declared. */
export function defineAdapter(definition: AdapterDefinition): AdapterDefinition {
  const declared = new Set(definition.manifest.tools.map((t) => t.name))
  const implemented = new Set(Object.keys(definition.tools))
  for (const name of declared) {
    if (!implemented.has(name)) throw new Error(`tool ${name} is declared but not implemented`)
  }
  for (const name of implemented) {
    if (!declared.has(name)) throw new Error(`tool ${name} is implemented but not declared`)
  }
  return definition
}

export function tool<Input extends z.ZodType, Output extends z.ZodType>(
  implementation: ToolImplementation<Input, Output>,
): ToolImplementation<Input, Output> {
  return implementation
}
