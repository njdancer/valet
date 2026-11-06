// How an adapter is defined in code: its manifest plus one implementation per declared tool.

import type { z } from 'zod'
import type { AdapterManifest } from './manifest'
import type { ToolPage } from './page'

export type EnsureResult =
  | { readonly status: 'ok' }
  | { readonly status: 'needsUser'; readonly reason: string }
  | { readonly status: 'failed'; readonly stage: string; readonly errorClass: string }

/** The capability object tool code receives. It is the whole of what tool code can do. */
export interface ToolContext {
  readonly page: ToolPage
  readonly session: {
    /** Makes sure the session is logged in, running the auth action if needed. */
    ensure(): Promise<EnsureResult>
  }
  /** Asks the person (not the MCP client) to confirm. Resolves false if they decline or time out. */
  confirm(message: string): Promise<boolean>
  readonly signal: AbortSignal
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
