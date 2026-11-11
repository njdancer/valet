// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { converter, wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { color, contrastPairs, material, type Themed } from '../src/tokens'
import { refToCss, resolveRef, tailwindName, themeCss, tokensCss } from '../src/tokens/css'

const rgb = converter('rgb')

type Rgb = { r: number; g: number; b: number }

function solid(ref: string): { c: Rgb; a: number } {
  const { color: value, alpha } = resolveRef(ref)
  const c = rgb(value)
  if (c === undefined) throw new Error(`Can't parse ${value}`)
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  return { c: { r: clamp(c.r), g: clamp(c.g), b: clamp(c.b) }, a: alpha }
}

const over = (top: { c: Rgb; a: number }, under: Rgb): Rgb => ({
  r: top.c.r * top.a + under.r * (1 - top.a),
  g: top.c.g * top.a + under.g * (1 - top.a),
  b: top.c.b * top.a + under.b * (1 - top.a),
})

function flatten(token: keyof typeof color, theme: 'light' | 'dark', base?: keyof typeof color): Rgb {
  const layer = solid((color[token] as Themed)[theme])
  if (layer.a === 1) return layer.c
  const under = base === undefined ? flatten('bg-surface', theme) : flatten(base, theme)
  return over(layer, under)
}

function contrast(theme: 'light' | 'dark', pair: (typeof contrastPairs)[number]): number {
  const bg = flatten(pair.bg, theme, pair.over)
  const fg = over(solid((color[pair.fg] as Themed)[theme]), bg)
  return wcagContrast({ mode: 'rgb', ...fg }, { mode: 'rgb', ...bg })
}

describe('semantic colour contrast', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const pair of contrastPairs) {
      it(`${theme}: ${pair.fg} on ${pair.bg} is at least ${pair.min}:1`, () => {
        expect(contrast(theme, pair)).toBeGreaterThanOrEqual(pair.min)
      })
    }
  }
})

describe('token CSS', () => {
  it('the committed CSS is what the tokens generate (run scripts/build-tokens.ts)', () => {
    const styles = resolve(import.meta.dirname, '../src/styles')
    expect(readFileSync(resolve(styles, 'tokens.css'), 'utf8')).toBe(tokensCss())
    expect(readFileSync(resolve(styles, 'theme.css'), 'utf8')).toBe(themeCss())
  })

  it('every semantic colour has a light and a dark value, and every reference resolves', () => {
    for (const [name, value] of Object.entries(color) as [string, Themed][]) {
      expect(() => resolveRef(value.light), name).not.toThrow()
      expect(() => resolveRef(value.dark), name).not.toThrow()
    }
  })

  it('writes alpha references as color-mix and plain ones as variables', () => {
    expect(refToCss('gray.950/6')).toBe('color-mix(in oklab, var(--v-gray-950) 6%, transparent)')
    expect(refToCss('white')).toBe('var(--v-white)')
    expect(refToCss('none')).toBe('none')
    expect(() => resolveRef('nope.50')).toThrow(/Unknown/)
  })

  it('maps semantic names to short Tailwind names', () => {
    expect(tailwindName('bg-surface')).toBe('surface')
    expect(tailwindName('fg-default')).toBe('fg')
    expect(tailwindName('fg-muted')).toBe('fg-muted')
    expect(tailwindName('border-default')).toBe('line')
    expect(tailwindName('border-focus')).toBe('line-focus')
    expect(tailwindName('accent-solid')).toBe('accent-solid')
  })

  it('reduced motion stops entrances travelling', () => {
    expect(tokensCss()).toMatch(/prefers-reduced-motion: reduce[\s\S]*--v-motion-distance: 0/)
  })
})

describe('text on glass', () => {
  // The worst cases behind a floating layer: pure white and pure black, ignoring the blur. Dark glass
  // runs its backdrop through brightness(0.72) first (glass-filter), so white arrives dimmed.
  for (const theme of ['light', 'dark'] as const) {
    const glass = rgb(material['glass-bg'][theme])
    if (glass === undefined) throw new Error('glass-bg')
    const alpha = glass.alpha ?? 1
    const dim = theme === 'dark' ? 0.72 : 1
    for (const [name, backdrop] of [
      ['white', { r: dim, g: dim, b: dim }],
      ['black', { r: 0, g: 0, b: 0 }],
    ] as const) {
      const surface = over({ c: { r: glass.r, g: glass.g, b: glass.b }, a: alpha }, backdrop)
      for (const [fgName, min] of [
        ['fg-default', 7],
        ['fg-muted-on-glass', 4.5],
        ['fg-subtle-on-glass', 3],
      ] as const) {
        it(`${theme}: ${fgName} on glass over ${name} is at least ${min}:1`, () => {
          const fg = over(solid((color[fgName] as Themed)[theme]), surface)
          expect(wcagContrast({ mode: 'rgb', ...fg }, { mode: 'rgb', ...surface })).toBeGreaterThanOrEqual(min)
        })
      }
    }
  }
})
