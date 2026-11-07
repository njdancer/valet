// One MCP server per client connection, exposing the caller's tools. The server never throws out of
// a tool handler: the SDK would send the exception message to the client, and exception messages
// can carry page text.

import { randomUUID } from 'node:crypto'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { NeedsUserError, type ToolDeclaration, toReportable } from '@valet/core'
import { z } from 'zod'
import { failedResult, toolResult } from './results'
import type { CallOutcome, ClientTransport, ListedTool, ToolCaller } from './tool-caller'
import { type ExposedTool, planTools, type SkippedTool, type ToolPlan } from './tool-names'

export interface ServerInfo {
  readonly name: string
  readonly version: string
}

export interface ServerOptions {
  /** Makes the id the runtime records a call under in the audit log. */
  readonly newCallId?: () => string
  /** How this session's client reached the endpoint, passed on with every call. A label only. */
  readonly transport?: ClientTransport
}

export interface ValetMcpServer {
  readonly server: McpServer
  /**
   * Re-reads the caller's tools and, when connected, tells the client the list changed. Returns the
   * tools that were withheld and why. If the caller throws, the tools are left as they were.
   */
  refresh(): readonly SkippedTool[]
  /** Replaces the tools with an already-made plan, so several sessions can share one listing. */
  apply(plan: ToolPlan): void
}

const MAX_CLIENT_NAME_LENGTH = 100

export function createMcpServer(
  caller: ToolCaller,
  info: ServerInfo,
  options: ServerOptions = {},
): ValetMcpServer {
  const newCallId = options.newCallId ?? randomUUID
  const server = new McpServer(
    { name: info.name, version: info.version },
    {
      // Declared up front so that a server that starts with no tools can still announce some later.
      capabilities: { tools: { listChanged: true } },
      // A refresh removes and re-adds every tool; the client should hear about it once.
      debouncedNotificationMethods: ['notifications/tools/list_changed'],
    },
  )

  const handle = async (listed: ListedTool, args: unknown, signal: AbortSignal): Promise<CallToolResult> => {
    const structured = listed.output instanceof z.ZodObject
    let outcome: CallOutcome
    try {
      outcome = await caller.call({
        adapterId: listed.adapterId,
        tool: listed.declaration.name,
        input: args,
        client: clientLabel(server.server.getClientVersion()?.name),
        callId: newCallId(),
        signal,
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      })
    } catch (error) {
      // A runtime that throws rather than returns needsUser still gets the person asked, not a failure.
      if (error instanceof NeedsUserError)
        return toolResult({ status: 'needsUser', reason: error.reason }, structured)
      const { stage, errorClass } = toReportable(error, 'tool-run')
      return failedResult(stage, errorClass)
    }
    if (outcome.status !== 'ok') return toolResult(outcome, structured)
    const checked = await checkedOutput(listed.output, outcome.output)
    if (!checked.valid) return failedResult('tool-output', 'invalid')
    return toolResult({ status: 'ok', output: checked.output }, structured)
  }

  const register = ({ name, listed }: ExposedTool): RegisteredTool => {
    // planTools only exposes tools whose input is an object schema.
    const input = listed.input as z.ZodObject
    const output = listed.output instanceof z.ZodObject ? listed.output : undefined
    return server.registerTool(
      name,
      {
        title: listed.declaration.title,
        description: toolDescription(listed.declaration),
        inputSchema: input,
        ...(output === undefined ? {} : { outputSchema: output }),
        annotations: annotationsFor(listed.declaration.sideEffect),
      },
      (args: unknown, extra: { signal: AbortSignal }) => handle(listed, args, extra.signal),
    )
  }

  let registered: RegisteredTool[] = []
  const apply = (plan: ToolPlan): void => {
    for (const tool of registered) tool.remove()
    registered = plan.exposed.map(register)
  }
  const refresh = (): readonly SkippedTool[] => {
    // Listing first: if the runtime throws, the session keeps the tools it had.
    const plan = planTools(caller.listTools())
    apply(plan)
    return plan.skipped
  }
  refresh()
  return { server, refresh, apply }
}

/**
 * Appended to an irreversible tool's description. Fixed text, never the adapter's: an adapter could
 * otherwise tell the agent that confirming is its job, or that no confirmation is needed.
 */
export const IRREVERSIBLE_NOTE =
  'The person must confirm this action in the Valet app before it runs. You cannot confirm it for them.'

/** The manifest's description, plus the fixed confirmation note for irreversible tools. */
export function toolDescription(declaration: ToolDeclaration): string {
  if (declaration.sideEffect !== 'irreversible') return declaration.description
  return `${declaration.description}\n\n${IRREVERSIBLE_NOTE}`
}

/**
 * MCP reads destructiveHint: false as "only additive updates". A write can remove things (taking
 * an item out of the cart), and the manifest doesn't say which writes only add, so every tool
 * that isn't a read is marked destructive.
 */
export function annotationsFor(sideEffect: 'read' | 'write' | 'irreversible'): ToolAnnotations {
  return {
    readOnlyHint: sideEffect === 'read',
    destructiveHint: sideEffect !== 'read',
    idempotentHint: sideEffect === 'read',
    openWorldHint: true,
  }
}

/** The client's self-reported name, flattened and bounded for the audit log. */
export function clientLabel(name: string | undefined): string {
  const flat = (name ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, '')
    .trim()
    .slice(0, MAX_CLIENT_NAME_LENGTH)
  return flat.length > 0 ? flat : 'unknown'
}

type CheckedOutput = { readonly valid: true; readonly output: unknown } | { readonly valid: false }

/**
 * The runtime should already have checked; a mismatch here means a bug, never a pass-through. The
 * parsed value is what gets sent, not the runtime's: zod objects drop keys they don't declare, so a
 * session cookie riding along in an extra field never reaches the client.
 */
async function checkedOutput(schema: z.ZodType, output: unknown): Promise<CheckedOutput> {
  try {
    const parsed = await schema.safeParseAsync(output)
    if (!parsed.success) return { valid: false }
    JSON.stringify(parsed.data)
    return { valid: true, output: parsed.data }
  } catch {
    return { valid: false }
  }
}
