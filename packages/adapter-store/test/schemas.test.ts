import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkSchema, SCHEMA_LIMITS, SchemaError, toolSchemas, withoutPatterns } from '../src/schemas'

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties })
const OUTPUT = { type: 'string' }

function problem(schema: unknown): string {
  try {
    checkSchema(schema)
  } catch (error) {
    if (error instanceof SchemaError) return error.problem
    throw error
  }
  return 'none'
}

describe('checkSchema', () => {
  it('accepts what zod emits for an ordinary tool', () => {
    const input = z.object({ q: z.string().min(1).max(20).regex(/^a/), n: z.number().int().default(2) })
    expect(problem(z.toJSONSchema(input, { io: 'input', target: 'draft-7' }))).toBe('none')
  })

  it.each([
    ['$ref', { $ref: '#/definitions/x' }],
    ['$defs', { $defs: {} }],
    ['definitions', { definitions: {} }],
    ['if', { if: true }],
    ['patternProperties', { patternProperties: { '^a': {} } }],
    ['propertyNames', { propertyNames: { pattern: '^a' } }],
    ['an unknown keyword', { 'x-run': 1 }],
  ])('refuses %s', (_name, schema) => {
    expect(problem(schema)).toBe('keyword')
  })

  it.each([['__proto__'], ['constructor'], ['prototype'], ['x'.repeat(201)]])(
    'refuses the property name %s',
    (name) => {
      expect(problem(JSON.parse(`{"type":"object","properties":{${JSON.stringify(name)}:{}}}`))).toBe('shape')
    },
  )

  it('refuses keyword values of the wrong type', () => {
    expect(problem({ type: 'string', maxLength: '3' })).toBe('value')
    expect(problem({ type: 'string', pattern: 1 })).toBe('value')
    expect(problem({ type: 'object', required: ['__proto__'] })).toBe('value')
    expect(problem({ type: 'object', required: 'a' })).toBe('value')
    expect(problem({ title: 3 })).toBe('value')
  })

  it('reads data keywords as data', () => {
    expect(problem({ type: 'object', default: { $ref: 'x', __proto__: 1 }, enum: [{ if: 1 }] })).toBe('none')
  })

  it('enforces the bounds', () => {
    expect(problem({ description: 'x'.repeat(SCHEMA_LIMITS.bytes) })).toBe('too-large')
    let deep: unknown = { type: 'string' }
    for (let i = 0; i <= SCHEMA_LIMITS.depth; i++) deep = { type: 'array', items: deep }
    expect(problem(deep)).toBe('too-deep')
    const wide: Record<string, unknown> = {}
    for (let i = 0; i <= SCHEMA_LIMITS.nodes; i++) wide[`p${i}`] = true
    expect(problem(object(wide))).toBe('too-many-nodes')
    expect(problem([])).toBe('shape')
    expect(problem({ anyOf: {} })).toBe('shape')
  })
})

describe('toolSchemas', () => {
  it('converts both schemas and requires an object input', () => {
    const schemas = toolSchemas({ input: object({ a: { type: 'string' } }), output: OUTPUT })
    expect(schemas.input.safeParse({ a: 'x' }).success).toBe(true)
    expect(schemas.output.safeParse(1).success).toBe(false)
    expect(() => toolSchemas({ input: OUTPUT, output: OUTPUT })).toThrow(SchemaError)
    expect(() => toolSchemas({ input: null, output: OUTPUT })).toThrow(SchemaError)
    expect(() => toolSchemas(null)).toThrow(SchemaError)
  })

  it('runs no adapter regex: a catastrophic pattern costs nothing in this process', () => {
    const schemas = toolSchemas({
      input: object({ a: { type: 'string', pattern: '^(\\d*)*\\d*\\d*x$' } }),
      output: OUTPUT,
    })
    const started = Date.now()
    expect(schemas.input.safeParse({ a: '1'.repeat(5_000) }).success).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('strips patterns only where they are keywords', () => {
    const stripped = withoutPatterns({
      type: 'object',
      properties: { pattern: { type: 'string', pattern: 'x' } },
      default: { pattern: 'kept' },
      anyOf: [{ pattern: 'y' }],
      items: [{ pattern: 'z' }],
    })
    expect(stripped).toEqual({
      type: 'object',
      properties: { pattern: { type: 'string' } },
      default: { pattern: 'kept' },
      anyOf: [{}],
      items: [{}],
    })
  })
})
