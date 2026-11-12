// The tools' input and output schemas as the main process sees them: JSON Schema the tool process
// derived from the adapter's own zod (describe, in @valet/runtime), bounded and checked here, then
// turned back into zod with z.fromJSONSchema for the tool host and the MCP server. No adapter code
// runs in the main process to validate a call (docs/adapter-packages.md, G6).
//
// What came back is untrusted. Before z.fromJSONSchema sees it, each schema must be within the size,
// depth and node bounds, use only the keywords zod's toJSONSchema emits (so fromJSONSchema stays on
// a known path), with values of the right type, and have no references.
//
// No adapter regex runs in the main process. `pattern` is removed before conversion, and
// `patternProperties` and `propertyNames` are refused: a polynomial pattern passes any screen and
// a regex can't be interrupted, so one adapter could freeze the app on a client's input (adversarial
// review of C, finding 1). Patterns are still enforced, exactly as written with their flags, by the
// adapter's own zod in the tool process, which is killable and runs under the call's deadline.

import { z } from 'zod'

export const SCHEMA_LIMITS = { bytes: 64 * 1024, depth: 32, nodes: 2_000 } as const

/** Keywords whose value is one schema. */
const SCHEMA_VALUED = new Set(['additionalProperties', 'items', 'additionalItems', 'not'])
/** Keywords whose value is an array of schemas. */
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf'])
/** Keywords whose value is a map from name (or pattern) to schema. */
const SCHEMA_MAPS = new Set(['properties'])
/** Keywords whose value must be a number. */
const NUMERIC = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
])
/** Keywords whose value must be a string. */
const TEXTUAL = new Set(['$schema', 'description', 'title', 'format', 'contentEncoding', 'contentMediaType'])
/** Keywords whose value is plain data, never read as a schema. */
const DATA_VALUED = new Set([
  '$schema',
  'type',
  'required',
  'enum',
  'const',
  'default',
  'description',
  'title',
  'examples',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'contentEncoding',
  'contentMediaType',
  'readOnly',
  'writeOnly',
  'deprecated',
])
/** Property names refused outright: they mean something to JavaScript objects. */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export type SchemaProblem =
  | 'too-large'
  | 'too-deep'
  | 'too-many-nodes'
  | 'keyword'
  | 'value'
  | 'shape'
  | 'convert'

export class SchemaError extends Error {
  constructor(
    readonly problem: SchemaProblem,
    readonly detail: string,
  ) {
    super(`schema refused (${problem}): ${detail}`)
    this.name = 'SchemaError'
  }
}

/** Throws SchemaError unless `schema` is within every bound and rule above. */
export function checkSchema(schema: unknown): void {
  let text: string
  try {
    text = JSON.stringify(schema)
  } catch {
    throw new SchemaError('shape', 'not JSON')
  }
  if (typeof text !== 'string') throw new SchemaError('shape', 'not JSON')
  if (text.length > SCHEMA_LIMITS.bytes) throw new SchemaError('too-large', String(text.length))
  let nodes = 0
  const walk = (node: unknown, depth: number): void => {
    if (++nodes > SCHEMA_LIMITS.nodes) throw new SchemaError('too-many-nodes', String(nodes))
    if (depth > SCHEMA_LIMITS.depth) throw new SchemaError('too-deep', String(depth))
    if (typeof node === 'boolean') return
    if (node === null || typeof node !== 'object' || Array.isArray(node))
      throw new SchemaError('shape', 'not a schema')
    for (const [keyword, value] of Object.entries(node)) {
      if (SCHEMA_VALUED.has(keyword)) {
        if (Array.isArray(value)) for (const item of value) walk(item, depth + 1)
        else walk(value, depth + 1)
      } else if (SCHEMA_LISTS.has(keyword)) {
        if (!Array.isArray(value)) throw new SchemaError('shape', keyword)
        for (const item of value) walk(item, depth + 1)
      } else if (SCHEMA_MAPS.has(keyword)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          throw new SchemaError('shape', keyword)
        for (const [name, sub] of Object.entries(value)) {
          if (RESERVED_NAMES.has(name) || name.length > 200) throw new SchemaError('shape', clip(name))
          walk(sub, depth + 1)
        }
      } else if (DATA_VALUED.has(keyword)) {
        if (NUMERIC.has(keyword) && (typeof value !== 'number' || !Number.isFinite(value)))
          throw new SchemaError('value', keyword)
        if ((TEXTUAL.has(keyword) || keyword === 'pattern') && typeof value !== 'string')
          throw new SchemaError('value', keyword)
        if (keyword === 'required') {
          if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || RESERVED_NAMES.has(n)))
            throw new SchemaError('value', 'required')
        }
      } else {
        throw new SchemaError('keyword', clip(keyword))
      }
    }
  }
  walk(schema, 0)
}

export interface ToolSchemas {
  readonly input: z.ZodType
  readonly output: z.ZodType
}

/**
 * One tool's schemas from what describe said for it. Throws SchemaError if either fails a check or
 * doesn't convert, or the input isn't an object schema (MCP arguments are always an object).
 */
export function toolSchemas(described: unknown): ToolSchemas {
  if (described === null || typeof described !== 'object') throw new SchemaError('shape', 'missing')
  const { input, output } = described as { input?: unknown; output?: unknown }
  if (input === null || input === undefined || output === null || output === undefined)
    throw new SchemaError('convert', 'not representable')
  checkSchema(input)
  checkSchema(output)
  const inputSchema = convert(input)
  if (!(inputSchema instanceof z.ZodObject)) throw new SchemaError('shape', 'input is not an object')
  return { input: inputSchema, output: convert(output) }
}

/** A copy without `pattern` anywhere it is a keyword (not inside data such as a default). */
export function withoutPatterns(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema
  const out: Record<string, unknown> = {}
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === 'pattern') continue
    if (SCHEMA_VALUED.has(keyword))
      out[keyword] = Array.isArray(value) ? value.map(withoutPatterns) : withoutPatterns(value)
    else if (SCHEMA_LISTS.has(keyword)) out[keyword] = (value as unknown[]).map(withoutPatterns)
    else if (SCHEMA_MAPS.has(keyword)) {
      const map: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(value as object)) map[name] = withoutPatterns(sub)
      out[keyword] = map
    } else out[keyword] = value
  }
  return out
}

function convert(schema: unknown): z.ZodType {
  try {
    return z.fromJSONSchema(withoutPatterns(schema) as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    throw new SchemaError('convert', 'fromJSONSchema refused it')
  }
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
