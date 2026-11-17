// MCP tool names. Each tool is exposed as "<adapter id with - as _>_<tool>". That mapping is not
// injective ("a-b" + "c" and "a" + "b_c" both give "a_b_c"), so a name that more than one tool maps
// to is withheld entirely: an adapter must never be able to shadow another adapter's tool.

import { plainOutputJsonSchema, strictInputJsonSchema } from '@valet/core'
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
  /** The schemas the server registers for it (clientSchemas). */
  readonly schemas: ClientSchemas
}

/**
 * What the server lists for a tool and checks its arguments with, made from the tool's own
 * schemas through JSON Schema:
 *
 * - `input` takes only the keys the tool declares, at every depth, so a misspelled argument is
 *   refused by name instead of silently dropped. Being rebuilt from JSON Schema, it carries none of
 *   the tool's own refinements or messages, so the SDK's refusal text is zod's own words about the
 *   client's own arguments, never an adapter's; the runtime then checks with the tool's schema.
 * - Both are listed as their JSON Schema without the safe-integer bounds zod gives every integer.
 */
export interface ClientSchemas {
  readonly input: z.ZodObject
  readonly output?: z.ZodObject
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
  const byName = new Map<string, { tool: ListedTool; schemas: ClientSchemas }[]>()
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
    } else {
      const schemas = clientSchemas(tool)
      if (schemas === null) {
        skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'schema-not-json' })
      } else {
        byName.set(name, [...(byName.get(name) ?? []), { tool, schemas }])
      }
    }
  }
  const exposed: ExposedTool[] = []
  for (const [name, tools] of byName) {
    const [only] = tools
    if (only !== undefined && tools.length === 1) {
      exposed.push({ name, listed: only.tool, schemas: only.schemas })
      continue
    }
    for (const { tool } of tools) {
      skipped.push({ adapterId: tool.adapterId, tool: tool.declaration.name, reason: 'name-collision' })
    }
  }
  return { exposed, skipped }
}

/** Lists `schema` as `json`, whatever zod would make of it. */
function listedAs<T extends z.ZodType>(schema: T, json: unknown): T {
  schema._zod.toJSONSchema = () => structuredClone(json)
  return schema
}

/**
 * The tool's schemas as the server registers them, or null when they don't convert to JSON Schema
 * and back: conversion happens on every tools/list, and one schema that can't convert (a z.date(),
 * say) would fail the whole list.
 */
export function clientSchemas(tool: ListedTool): ClientSchemas | null {
  try {
    const inputJson = strictInputJsonSchema(z.toJSONSchema(tool.input, { io: 'input', target: 'draft-7' }))
    const input = z.fromJSONSchema(inputJson as Parameters<typeof z.fromJSONSchema>[0])
    if (!(input instanceof z.ZodObject)) return null
    if (!(tool.output instanceof z.ZodObject)) return { input: listedAs(input, inputJson) }
    const outputJson = plainOutputJsonSchema(z.toJSONSchema(tool.output, { io: 'output', target: 'draft-7' }))
    // The tool's own fields, in an object of its own to list differently. The SDK's check of a result
    // is a second one: the server has already parsed the output with the tool's own schema.
    return { input: listedAs(input, inputJson), output: listedAs(z.object(tool.output.shape), outputJson) }
  } catch {
    return null
  }
}
