// Primitive tokens: the raw palette and scales. Nothing in a component refers to these directly;
// components use the semantic tokens (semantic.ts), which pick a primitive per theme. Colours are
// OKLCH so each scale steps evenly in perceived lightness, on every OS and display.
//
// Aesthetic: "quiet concierge". Graphite neutrals with a faint cool cast, one ink-blue accent,
// and a brass highlight reserved for moments of delight (the logo, a completed setup, a sealed
// approval). Not tied to any one OS's look: the type is bundled (Inter, JetBrains Mono), so it
// renders the same on macOS, Windows and Linux.

export type Scale = Readonly<Record<string, string>>

const scale = (hue: number, chroma: readonly number[], lightness: readonly number[]): Scale => {
  const steps = [
    '25',
    '50',
    '100',
    '150',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '850',
    '900',
    '950',
  ]
  const out: Record<string, string> = {}
  steps.forEach((step, i) => {
    const l = lightness[i] ?? 0
    const c = chroma[i] ?? 0
    out[step] = `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${hue})`
  })
  return out
}

// Lightness ramp shared by the chromatic scales, so "blue-600" and "red-600" sit at the same weight.
const L = [0.985, 0.97, 0.94, 0.905, 0.86, 0.78, 0.7, 0.62, 0.55, 0.48, 0.4, 0.34, 0.28, 0.22]
// Chroma rises toward the middle of the ramp and falls off at the ends, where sRGB can't hold it.
const C = (peak: number) =>
  [0.012, 0.022, 0.045, 0.07, 0.1, 0.14, 0.17, 0.19, 0.19, 0.17, 0.14, 0.11, 0.08, 0.06].map(
    (c) => (c / 0.19) * peak,
  )

export const palette = {
  // Graphite: the neutrals. Faint blue cast (hue 265) so it reads as ink and paper, not mud.
  gray: scale(
    265,
    [0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01, 0.012, 0.012, 0.012, 0.012, 0.011, 0.01, 0.009],
    [0.988, 0.975, 0.955, 0.93, 0.9, 0.84, 0.72, 0.6, 0.52, 0.44, 0.34, 0.285, 0.235, 0.19],
  ),
  // Ink blue: the single accent, for primary actions, focus and selection.
  blue: scale(258, C(0.2), L),
  // Status and risk hues.
  green: scale(152, C(0.16), L),
  amber: scale(
    70,
    C(0.17),
    [0.985, 0.97, 0.95, 0.92, 0.88, 0.82, 0.77, 0.7, 0.62, 0.53, 0.44, 0.37, 0.3, 0.24],
  ),
  red: scale(25, C(0.21), L),
  violet: scale(300, C(0.2), L),
  // Brass: delight only. Warm metallic highlight for the logo, success flourishes and the seal.
  brass: scale(
    80,
    C(0.12),
    [0.985, 0.97, 0.94, 0.91, 0.87, 0.82, 0.76, 0.69, 0.6, 0.51, 0.42, 0.36, 0.3, 0.24],
  ),
} as const

export const white = 'oklch(1 0 0)'
export const black = 'oklch(0 0 0)'

export const font = {
  sans: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
} as const

// Type scale, in px, tuned for a dense desktop window (1180x780): 13 is body.
export const fontSize = {
  '2xs': 10,
  xs: 11,
  sm: 12,
  md: 13,
  lg: 15,
  xl: 18,
  '2xl': 22,
  '3xl': 28,
  '4xl': 36,
} as const

export const lineHeight = { tight: 1.2, snug: 1.35, normal: 1.5 } as const
export const fontWeight = { regular: 420, medium: 520, semibold: 620, bold: 720 } as const
export const letterSpacing = { tight: '-0.018em', snug: '-0.01em', normal: '0', wide: '0.04em' } as const

// A 4 px grid. Every gap, padding and size in the system lands on it.
export const space = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const

export const radius = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, '2xl': 22, full: 9999 } as const

// Motion primitives. Durations in ms; easings as CSS timing functions.
export const duration = { instant: 80, fast: 140, base: 200, moderate: 240, slow: 320, slower: 480, glacial: 900 } as const
export const easing = {
  linear: 'linear',
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  enter: 'cubic-bezier(0, 0, 0, 1)',
  exit: 'cubic-bezier(0.3, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.3, 0, 0, 1.15)',
  // A critically-damped-ish spring with a small overshoot, sampled into linear().
  spring:
    'linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.004 83.8%, 1)',
} as const

export const zIndex = {
  base: 0,
  sticky: 10,
  dropdown: 50,
  overlay: 60,
  modal: 70,
  popover: 80,
  toast: 90,
  tooltip: 100,
} as const

export const breakpoints = { compact: 880, regular: 1180, wide: 1440 } as const
