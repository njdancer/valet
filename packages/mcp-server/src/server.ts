// One MCP server per client connection, exposing the caller's tools. The server never throws out of
// a tool handler: the SDK would send the exception message to the client, and exception messages
// can carry page text.

import { randomUUID } from 'node:crypto'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { toReportable } from '@siteadapter/core'
import { z } from 'zod'
import { failedResult, toolResult } from './results'
import type { CallOutcome, ListedTool, ToolCaller } from './tool-caller'
import { type ExposedTool, planTools, type SkippedTool } from './tool-names'

export interface ServerInfo {
  readonly name: string
  readonly version: string
}

export interface ServerOptions {
  /** Makes the id the runtime records a call under in the audit log. */
  readonly newCallId?: () => string
}

export interface SiteAdapterMcpServer {
  readonly server: McpServer
  /**
   * Re-reads the caller's tools and, when connected, tells the client the list changed. Returns the
   * tools that were withheld and why.
   */
  refresh(): readonly SkippedTool[]
}

const MAX_CLIENT_NAME_LENGTH = 100

export function createMcpServer(
  caller: ToolCaller,
  info: ServerInfo,
  options: ServerOptions = {},
): SiteAdapterMcpServer {
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
      })
    } catch (error) {
      const { stage, errorClass } = toReportable(error, 'tool-run')
      return failedResult(stage, errorClass)
    }
    if (outcome.status === 'ok' && !(await outputValid(listed.output, outcome.output))) {
      return failedResult('tool-output', 'invalid')
    }
    return toolResult(outcome, structured)
  }

  const register = ({ name, listed }: ExposedTool): RegisteredTool => {
    // planTools only exposes tools whose input is an object schema.
    const input = listed.input as z.ZodObject
    const output = listed.output instanceof z.ZodObject ? listed.output : undefined
    return server.registerTool(
      name,
      {
        title: listed.declaration.title,
        description: listed.declaration.description,
        inputSchema: input,
        ...(output === undefined ? {} : { outputSchema: output }),
        annotations: annotationsFor(listed.declaration.sideEffect),
      },
      (args: unknown, extra: { signal: AbortSignal }) => handle(listed, args, extra.signal),
    )
  }

  let registered: RegisteredTool[] = []
  const refresh = (): readonly SkippedTool[] => {
    // Listing first: if the runtime throws, the session keeps the tools it had.
    const plan = planTools(caller.listTools())
    for (const tool of registered) tool.remove()
    registered = plan.exposed.map(register)
    return plan.skipped
  }
  refresh()
  return { server, refresh }
}

export function annotationsFor(sideEffect: 'read' | 'write' | 'irreversible'): ToolAnnotations {
  return {
    readOnlyHint: sideEffect === 'read',
    destructiveHint: sideEffect === 'irreversible',
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

/** The runtime should already have checked; a mismatch here means a bug, never a pass-through. */
async function outputValid(schema: z.ZodType, output: unknown): Promise<boolean> {
  try {
    if (!(await schema.safeParseAsync(output)).success) return false
    JSON.stringify(output)
    return true
  } catch {
    return false
  }
}
