// MCP tool names. Each tool is exposed as "<adapter id with - as _>_<tool>". That mapping is not
// injective ("a-b" + "c" and "a" + "b_c" both give "a_b_c"), so a name that more than one tool maps
// to is withheld entirely: an adapter must never be able to shadow another adapter's tool.

import { z } from 'zod'
import { ADMIN_PREFIX } from './admin-tools'
import type { ListedTool } from './tool-caller'

/** The longest tool name the MCP specification allows. */
export const MAX_TOOL_NAME_LENGTH = 128

export type SkipReason =
  | 'name-collision'
  | 'name-too-long'
  | 'input-not-object'
  | 'schema-not-json'
  /** The name starts with Valet's own prefix, `valet_`, which only Valet's admin tools may use. */
  | 'reserved-name'

export interface ExposedTool {
  readonly name: string
  readonly listed: ListedTool
}

export interface SkippedTool {
  readonly adapterId: string
  readonly tool: string
  readonly reason: SkipReason
}

export interface ToolPlan {
  readonly exposed: readonly ExposedTool[]
  readonly skipped: readonly SkippedTool[]
}

export function mcpToolName(adapterId: string, tool: string): string {
  return `${adapterId.replaceAll('-', '_')}_${tool}`
}

/** Decides which listed tools are exposed and under what names. */
export function planTools(listed: readonly ListedTool[]): ToolPlan {
  const skipped: SkippedTool[] = []
  const byName = new Map<string, ListedTool[]>()
  for (const tool of listed) {
    const name = mcpToolName(tool.adapterId, tool.declaration.name)
    // MCP tool arguments are always a JSON object.
    if (name.startsWith(ADMIN_PREFIX)) {
      // An adapter must never be able to stand in for, or sit beside, Valet's own tools.
      skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'reserved-name' })
    } else if (!(tool.input instanceof z.ZodObject)) {
      skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'input-not-object' })
    } else if (name.length > MAX_TOOL_NAME_LENGTH) {
      skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'name-too-long' })
    } else if (!representable(tool)) {
      skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'schema-not-json' })
    } else {
      byName.set(name, [...(byName.get(name) ?? []), tool])
    }
  }
  const exposed: ExposedTool[] = []
  for (const [name, tools] of byName) {
    const [only] = tools
    if (only !== undefined && tools.length === 1) {
      exposed.push({ name, listed: only })
      continue
    }
    for (const tool of tools) {
      skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'name-collision' })
    }
  }
  return { exposed, skipped }
}

/**
 * True when the schemas the server lists convert to JSON Schema. Conversion happens on every
 * tools/list, and one schema that can't convert (a z.date(), say) would fail the whole list.
 */
function representable(tool: ListedTool): boolean {
  try {
    z.toJSONSchema(tool.input, { io: 'input', target: 'draft-7' })
    if (tool.output instanceof z.ZodObject) z.toJSONSchema(tool.output, { io: 'output', target: 'draft-7' })
    return true
  } catch {
    return false
  }
}
