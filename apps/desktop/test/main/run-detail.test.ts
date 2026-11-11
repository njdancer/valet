import { describe, expect, it } from 'vitest'
import { detailOf, subjectOf } from '../../src/main/core/run-detail'
import { RunMemory } from '../../src/main/core/run-memory'

const cart = {
  items: [
    { stockcode: 88436, name: 'Dairy Farmers Milk 2L', quantity: 2 },
    { stockcode: 888137, name: 'Wonder White Sandwich Bread 700g', quantity: 1 },
  ],
}

describe('what a call was about', () => {
  it('quotes a search', () => {
    expect(detailOf(subjectOf({ query: '  full cream\nmilk ', specialsOnly: true }), {})).toBe(
      '“full cream milk”',
    )
  })

  it('names the product a write touched, with its quantity, from the cart the site sent back', () => {
    const subject = subjectOf({ stockcode: 88436, quantity: 2 })
    expect(detailOf(subject, { stockcode: 88436, cart })).toBe('Dairy Farmers Milk 2L × 2')
    expect(detailOf(subjectOf({ stockcode: 888137, quantity: 1 }), { cart })).toBe(
      'Wonder White Sandwich Bread 700g',
    )
  })

  it('falls back to the stockcode before the output arrives, or when the output never names it', () => {
    expect(detailOf(subjectOf({ stockcode: 88436 }), undefined)).toBe('product 88436')
  })

  it('names two lines of a batch and counts the rest', () => {
    const items = [{ stockcode: 88436, quantity: 2 }, { stockcode: 888137 }]
    expect(detailOf(subjectOf({ items }), { items: cart.items })).toBe(
      'Dairy Farmers Milk 2L × 2 and Wonder White Sandwich Bread 700g',
    )
    const more = [...items, { stockcode: 1 }, { stockcode: 2 }]
    expect(detailOf(subjectOf({ items: more }), { items: cart.items })).toBe(
      'Dairy Farmers Milk 2L × 2, Wonder White Sandwich Bread 700g and 2 more',
    )
  })

  it('says nothing for a call with no search or product, and cleans and clips site text', () => {
    expect(detailOf(subjectOf({}), cart)).toBeNull()
    expect(detailOf(subjectOf('x'), cart)).toBeNull()
    const long = `A‮${'b'.repeat(100)}`
    const detail = detailOf(subjectOf({ stockcode: 5 }), { stockcode: 5, name: long }) ?? ''
    expect(detail).not.toContain('‮')
    expect([...detail].length).toBe(60)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('is kept in RunMemory, filled in again when the output arrives', () => {
    const memory = new RunMemory()
    memory.started('c1', 'add_to_cart', 'claude-code', { stockcode: 88436, quantity: 2 })
    expect(memory.get('c1')?.detail).toBe('product 88436 × 2')
    memory.finished('c1', { stockcode: 88436, cart })
    expect(memory.get('c1')?.detail).toBe('Dairy Farmers Milk 2L × 2')
  })
})
