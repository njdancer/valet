import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkShape, describeShape, mergeReports } from '../src/drift'

const CANARY = 'canary-value-5c1e'

const tile = z.object({
  Stockcode: z.number().int(),
  Name: z.string().nullish(),
  Price: z.number().nullish(),
})
const envelope = z.object({
  Count: z.number().int().nullish(),
  Products: z.array(z.object({ Products: z.array(tile).nullish() })).nullish(),
})

describe('checkShape', () => {
  it('passes a body that parses and carries every declared field', () => {
    const body = {
      Count: 1,
      Products: [{ Products: [{ Stockcode: 1, Name: CANARY, Price: null }] }],
      Extra: 1,
    }
    expect(checkShape(envelope, body)).toEqual({ ok: true, issues: [], absent: [] })
  })

  it('reports a changed type by path, with array indices collapsed, and once per path', () => {
    const body = {
      Count: 2,
      Products: [
        {
          Products: [
            { Stockcode: CANARY, Name: 'a', Price: 1 },
            { Stockcode: 'x', Name: 'b', Price: 2 },
          ],
        },
      ],
    }
    const report = checkShape(envelope, body)
    expect(report.ok).toBe(false)
    expect(report.issues).toEqual([
      {
        path: 'Products[].Products[].Stockcode',
        code: 'invalid_type',
        expected: 'number',
        received: 'string',
      },
    ])
  })

  it('reports a required field that went missing as an issue, received missing', () => {
    const report = checkShape(tile, { Name: 'a', Price: 1 })
    expect(report.issues).toEqual([
      { path: 'Stockcode', code: 'invalid_type', expected: 'number', received: 'missing' },
    ])
    expect(report.absent).toEqual(['Stockcode'])
  })

  it('reports a renamed nullish field as absent, though the body still parses', () => {
    // The site renaming Price to CurrentPrice parses fine (Price is nullish) and would show no price.
    const body = { Count: 1, Products: [{ Products: [{ Stockcode: 1, Name: 'a', CurrentPrice: 2 }] }] }
    expect(envelope.safeParse(body).success).toBe(true)
    expect(checkShape(envelope, body)).toEqual({
      ok: false,
      issues: [],
      absent: ['Products[].Products[].Price'],
    })
  })

  it('does not count a field sent as null as absent', () => {
    expect(checkShape(envelope, { Count: null, Products: null }).absent).toEqual([])
  })

  it('reports a non-object root without throwing', () => {
    expect(checkShape(envelope, 'not json').issues).toEqual([
      { path: '(root)', code: 'invalid_type', expected: 'object', received: 'string' },
    ])
  })

  it('never copies a value into the report, nor a key that could carry text', () => {
    const record = z.object({ Values: z.record(z.string(), z.number()) })
    const body = { Values: { [`${CANARY} with spaces`]: CANARY } }
    const report = checkShape(record, body)
    expect(report.ok).toBe(false)
    expect(JSON.stringify(report)).not.toContain(CANARY)
    expect(report.issues[0]?.path).toBe('Values.?')
  })

  it('caps the number of issues', () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`F${i}`, z.number()])))
    expect(checkShape(wide, {}).issues).toHaveLength(50)
  })
})

describe('mergeReports', () => {
  it('prefixes each part and is ok only when every part is', () => {
    const good = checkShape(tile, { Stockcode: 1, Name: 'a', Price: 1 })
    const bad = checkShape(tile, { Stockcode: 'x', Name: 'a' })
    expect(mergeReports([{ at: '', report: good }]).ok).toBe(true)
    expect(
      mergeReports([
        { at: '', report: good },
        { at: 'Bucket[]', report: bad },
      ]),
    ).toEqual({
      ok: false,
      issues: [{ path: 'Bucket[].Stockcode', code: 'invalid_type', expected: 'number', received: 'string' }],
      absent: ['Bucket[].Price'],
    })
  })
})

describe('describeShape', () => {
  it('keeps keys and types, merges array elements, and drops every value', () => {
    const body = {
      Name: CANARY,
      Price: 3.5,
      Flags: [true, false],
      Empty: [],
      Items: [
        { A: 1, B: CANARY },
        { A: null, C: true },
      ],
    }
    const shape = describeShape(body)
    expect(shape).toEqual({
      Name: 'string',
      Price: 'number',
      Flags: ['boolean'],
      Empty: [],
      Items: [{ A: 'null|number', B: 'missing|string', C: 'boolean|missing' }],
    })
    expect(JSON.stringify(shape)).not.toContain(CANARY)
  })

  it('masks keys that are not plain identifiers', () => {
    expect(describeShape({ [`${CANARY} x`]: 1 })).toEqual({ '?': 'number' })
  })

  it('stops at a depth limit', () => {
    let deep: unknown = 1
    for (let i = 0; i < 30; i++) deep = { d: deep }
    expect(JSON.stringify(describeShape(deep))).toContain('"object"')
  })
})
