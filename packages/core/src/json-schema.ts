// What a tool's JSON Schema says to an MCP client, made plain and strict. zod's conversion leaves an
// object open to keys it doesn't declare (zod then drops them without a word, so a misspelled
// "qty" became a quantity of 1), and gives every integer without a bound of its own the bounds of a
// safe integer, which only crowds the schema. Both the adapter store (the schemas the main process
// checks with) and the MCP server (the schemas it lists and checks with) apply these.

/** Keywords whose value is one schema, or for `items`, one or a list. */
const ONE = ['additionalProperties', 'items', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']
/** Keywords whose value is a list of schemas. */
const LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
/** Keywords whose value maps names to schemas. */
const MAPS = ['properties', 'patternProperties', '$defs', 'definitions']

type Json = Record<string, unknown>

function isNode(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An `additionalProperties` that allows anything: absent, true, or the empty schema. */
function allowsAnything(value: unknown): boolean {
  return value === undefined || value === true || (isNode(value) && Object.keys(value).length === 0)
}

function rewrite(node: unknown, strict: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => rewrite(item, strict))
  if (!isNode(node)) return node
  const out: Json = {}
  for (const [keyword, value] of Object.entries(node)) {
    if (ONE.includes(keyword)) out[keyword] = rewrite(value, strict)
    else if (LISTS.includes(keyword))
      out[keyword] = Array.isArray(value) ? value.map((v) => rewrite(v, strict)) : value
    else if (MAPS.includes(keyword) && isNode(value)) {
      const map: Json = {}
      for (const [name, sub] of Object.entries(value)) map[name] = rewrite(sub, strict)
      out[keyword] = map
    } else out[keyword] = value
  }
  if (out['type'] === 'integer' || out['type'] === 'number') {
    if (out['minimum'] === -Number.MAX_SAFE_INTEGER) delete out['minimum']
    if (out['maximum'] === Number.MAX_SAFE_INTEGER) delete out['maximum']
  }
  // An object with declared properties takes only those. One without (a record) is left as it is.
  if (strict && isNode(out['properties']) && allowsAnything(out['additionalProperties'])) {
    out['additionalProperties'] = false
  }
  return out
}

/**
 * A copy of a tool's input JSON Schema in which every object that declares properties refuses any
 * other key, at every depth, and integers carry only the bounds the tool gave them.
 */
export function strictInputJsonSchema(schema: unknown): unknown {
  return rewrite(schema, true)
}

/** A copy of an output JSON Schema without the safe-integer bounds zod adds to every integer. */
export function plainOutputJsonSchema(schema: unknown): unknown {
  return rewrite(schema, false)
}
