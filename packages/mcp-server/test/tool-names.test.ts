import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ListedTool } from '../src/tool-caller'
import { MAX_TOOL_NAME_LENGTH, mcpToolName, planTools } from '../src/tool-names'

const searchProducts: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: {
    name: 'search_products',
    title: 'Search products',
    description: 'Searches the catalogue.',
    sideEffect: 'read',
  },
  input: z.object({ query: z.string() }),
  output: z.object({ products: z.array(z.string()) }),
}

describe('mcpToolName', () => {
  it('joins the adapter id and tool name with an underscore', () => {
    expect(mcpToolName('woolworths', 'search_products')).toBe('woolworths_search_products')
  })

  it('replaces every hyphen in the adapter id', () => {
    expect(mcpToolName('my-big-shop', 'cart')).toBe('my_big_shop_cart')
  })
})

describe('planTools', () => {
  it('exposes a tool under its MCP name', () => {
    const plan = planTools([searchProducts])
    expect(plan.exposed).toEqual([{ name: 'woolworths_search_products', listed: searchProducts }])
    expect(plan.skipped).toEqual([])
  })

  it('withholds both tools when two map to one name', () => {
    const victim = {
      ...searchProducts,
      adapterId: 'a-b',
      declaration: { ...searchProducts.declaration, name: 'c' },
    }
    const shadow = {
      ...searchProducts,
      adapterId: 'a',
      declaration: { ...searchProducts.declaration, name: 'b_c' },
    }
    const plan = planTools([victim, shadow])
    expect(plan.exposed).toEqual([])
    expect(plan.skipped).toEqual([
      { adapterId: 'a-b', tool: 'c', reason: 'name-collision' },
      { adapterId: 'a', tool: 'b_c', reason: 'name-collision' },
    ])
  })

  it('withholds a tool listed twice by the same adapter', () => {
    const plan = planTools([searchProducts, searchProducts])
    expect(plan.exposed).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(['name-collision', 'name-collision'])
  })

  it('withholds a tool whose input is not an object', () => {
    const plan = planTools([{ ...searchProducts, input: z.array(z.string()) }])
    expect(plan.exposed).toEqual([])
    expect(plan.skipped).toEqual([
      { adapterId: 'woolworths', tool: 'search_products', reason: 'input-not-object' },
    ])
  })

  it('withholds a tool whose name is longer than MCP allows', () => {
    const adapterId = `a${'b'.repeat(64)}`
    const tool = 'c'.repeat(MAX_TOOL_NAME_LENGTH - adapterId.length)
    const plan = planTools([
      { ...searchProducts, adapterId, declaration: { ...searchProducts.declaration, name: tool } },
    ])
    expect(plan.skipped).toEqual([{ adapterId, tool, reason: 'name-too-long' }])
  })

  it('exposes a tool whose name is exactly the longest allowed', () => {
    const adapterId = `a${'b'.repeat(63)}`
    const tool = 'c'.repeat(MAX_TOOL_NAME_LENGTH - adapterId.length - 1)
    const plan = planTools([
      { ...searchProducts, adapterId, declaration: { ...searchProducts.declaration, name: tool } },
    ])
    expect(plan.exposed[0]?.name).toHaveLength(MAX_TOOL_NAME_LENGTH)
  })

  it('withholds a tool whose input schema has no JSON Schema form', () => {
    const plan = planTools([{ ...searchProducts, input: z.object({ since: z.date() }) }])
    expect(plan.skipped).toEqual([
      { adapterId: 'woolworths', tool: 'search_products', reason: 'schema-not-json' },
    ])
  })

  it('withholds a tool whose object output schema has no JSON Schema form', () => {
    const plan = planTools([{ ...searchProducts, output: z.object({ at: z.date() }) }])
    expect(plan.skipped).toEqual([
      { adapterId: 'woolworths', tool: 'search_products', reason: 'schema-not-json' },
    ])
  })

  it('does not convert a non-object output, which is never listed', () => {
    const plan = planTools([{ ...searchProducts, output: z.array(z.date()) }])
    expect(plan.exposed).toHaveLength(1)
  })

  it('lets a tool through when the only tool sharing its name was withheld for another reason', () => {
    const victim = {
      ...searchProducts,
      adapterId: 'a-b',
      declaration: { ...searchProducts.declaration, name: 'c' },
    }
    const broken = {
      ...searchProducts,
      adapterId: 'a',
      declaration: { ...searchProducts.declaration, name: 'b_c' },
      input: z.string(),
    }
    const plan = planTools([victim, broken])
    expect(plan.exposed.map((t) => t.listed)).toEqual([victim])
  })
})
