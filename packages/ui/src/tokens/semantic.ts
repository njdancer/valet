// Semantic tokens: what a colour is FOR, per theme. Components use only these.
//
// A value names a primitive as "scale.step" ("gray.50"), "white" or "black", with an optional
// alpha percentage after a slash ("gray.950/6"). The generator (scripts/build-tokens.ts) turns them
// into CSS custom properties; the contrast test resolves them to sRGB and checks every text pair.

export type ColorRef = string
export type Themed = { readonly light: ColorRef; readonly dark: ColorRef }

export const color = {
  // Surfaces, from the back of the window to the front.
  'bg-canvas': { light: 'gray.50', dark: 'gray.950' },
  'bg-sidebar': { light: 'gray.100', dark: 'gray.900' },
  'bg-surface': { light: 'white', dark: 'gray.900' },
  'bg-raised': { light: 'white', dark: 'gray.850' },
  'bg-sunken': { light: 'gray.100', dark: 'black/24' },
  'bg-inset': { light: 'gray.950/4', dark: 'white/4' },
  // Interaction overlays, laid over any surface.
  'bg-hover': { light: 'gray.950/5', dark: 'white/6' },
  'bg-pressed': { light: 'gray.950/9', dark: 'white/10' },
  'bg-selected': { light: 'blue.500/12', dark: 'blue.400/22' },
  'bg-selected-strong': { light: 'blue.600', dark: 'blue.600' },
  'bg-backdrop': { light: 'gray.950/28', dark: 'black/55' },

  // Text and icons.
  'fg-default': { light: 'gray.950', dark: 'gray.25' },
  'fg-muted': { light: 'gray.600', dark: 'gray.300' },
  'fg-subtle': { light: 'gray.500', dark: 'gray.400' },
  'fg-disabled': { light: 'gray.400', dark: 'gray.600' },
  'fg-on-accent': { light: 'white', dark: 'white' },
  'fg-on-selected': { light: 'white', dark: 'white' },
  'fg-link': { light: 'blue.600', dark: 'blue.300' },

  // Lines.
  'border-subtle': { light: 'gray.950/7', dark: 'white/7' },
  'border-default': { light: 'gray.950/12', dark: 'white/12' },
  'border-strong': { light: 'gray.950/22', dark: 'white/22' },
  'border-control': { light: 'gray.950/18', dark: 'white/16' },
  'border-focus': { light: 'blue.500', dark: 'blue.400' },

  // The accent.
  'accent-solid': { light: 'blue.600', dark: 'blue.600' },
  'accent-solid-hover': { light: 'blue.700', dark: 'blue.700' },
  'accent-soft': { light: 'blue.500/12', dark: 'blue.400/18' },
  'accent-fg': { light: 'blue.700', dark: 'blue.200' },

  // Status. Each has a solid (fills), soft (tinted backgrounds), fg (text on soft or surface) and border.
  'success-solid': { light: 'green.600', dark: 'green.500' },
  'success-soft': { light: 'green.500/13', dark: 'green.400/16' },
  'success-fg': { light: 'green.800', dark: 'green.200' },
  'success-border': { light: 'green.600/35', dark: 'green.400/35' },
  'warning-solid': { light: 'amber.500', dark: 'amber.400' },
  'warning-soft': { light: 'amber.400/20', dark: 'amber.400/16' },
  'warning-fg': { light: 'amber.800', dark: 'amber.200' },
  'warning-border': { light: 'amber.600/40', dark: 'amber.400/35' },
  'danger-solid': { light: 'red.600', dark: 'red.600' },
  'danger-solid-hover': { light: 'red.700', dark: 'red.700' },
  'danger-soft': { light: 'red.500/12', dark: 'red.400/17' },
  'danger-fg': { light: 'red.700', dark: 'red.200' },
  'danger-border': { light: 'red.600/35', dark: 'red.400/38' },
  'info-solid': { light: 'blue.600', dark: 'blue.600' },
  'info-soft': { light: 'blue.500/11', dark: 'blue.400/16' },
  'info-fg': { light: 'blue.700', dark: 'blue.200' },
  'info-border': { light: 'blue.600/30', dark: 'blue.400/35' },

  // Risk: what a tool does to the outside world. Read is calm, write asks for attention,
  // irreversible is danger, secret marks anything that touches a credential.
  'risk-read-fg': { light: 'green.800', dark: 'green.200' },
  'risk-read-soft': { light: 'green.500/13', dark: 'green.400/16' },
  'risk-write-fg': { light: 'amber.800', dark: 'amber.200' },
  'risk-write-soft': { light: 'amber.400/20', dark: 'amber.400/16' },
  'risk-irreversible-fg': { light: 'red.700', dark: 'red.200' },
  'risk-irreversible-soft': { light: 'red.500/12', dark: 'red.400/17' },
  'risk-secret-fg': { light: 'violet.700', dark: 'violet.200' },
  'risk-secret-soft': { light: 'violet.500/12', dark: 'violet.400/18' },

  // Diffs, in the update review.
  'diff-add-bg': { light: 'green.500/12', dark: 'green.400/14' },
  'diff-add-fg': { light: 'green.800', dark: 'green.200' },
  'diff-del-bg': { light: 'red.500/10', dark: 'red.400/14' },
  'diff-del-fg': { light: 'red.700', dark: 'red.200' },

  // Delight.
  'brass-solid': { light: 'brass.500', dark: 'brass.400' },
  'brass-soft': { light: 'brass.400/18', dark: 'brass.400/16' },
  'brass-fg': { light: 'brass.800', dark: 'brass.200' },

  // Code, logs and hashes.
  'code-bg': { light: 'gray.100', dark: 'black/28' },
  'code-fg': { light: 'gray.850', dark: 'gray.100' },
} as const satisfies Record<string, Themed>

export type ColorToken = keyof typeof color

/**
 * Text-on-background pairs the contrast test checks (WCAG 2.2: 4.5:1 for text, 3:1 for large text
 * and non-text UI). The background is composited over `over` when it has alpha.
 */
export const contrastPairs: readonly {
  readonly fg: ColorToken
  readonly bg: ColorToken
  readonly over?: ColorToken
  readonly min: number
}[] = [
  { fg: 'fg-default', bg: 'bg-canvas', min: 7 },
  { fg: 'fg-default', bg: 'bg-surface', min: 7 },
  { fg: 'fg-default', bg: 'bg-sidebar', min: 7 },
  { fg: 'fg-muted', bg: 'bg-canvas', min: 4.5 },
  { fg: 'fg-muted', bg: 'bg-surface', min: 4.5 },
  { fg: 'fg-muted', bg: 'bg-sidebar', min: 4.5 },
  { fg: 'fg-subtle', bg: 'bg-surface', min: 3 },
  { fg: 'fg-link', bg: 'bg-surface', min: 4.5 },
  { fg: 'fg-on-accent', bg: 'accent-solid', min: 4.5 },
  { fg: 'fg-on-selected', bg: 'bg-selected-strong', min: 4.5 },
  { fg: 'fg-on-accent', bg: 'danger-solid', min: 4.5 },
  { fg: 'accent-fg', bg: 'accent-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'success-fg', bg: 'success-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'warning-fg', bg: 'warning-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'danger-fg', bg: 'danger-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'info-fg', bg: 'info-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'risk-read-fg', bg: 'risk-read-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'risk-write-fg', bg: 'risk-write-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'risk-irreversible-fg', bg: 'risk-irreversible-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'risk-secret-fg', bg: 'risk-secret-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'diff-add-fg', bg: 'diff-add-bg', over: 'bg-surface', min: 4.5 },
  { fg: 'diff-del-fg', bg: 'diff-del-bg', over: 'bg-surface', min: 4.5 },
  { fg: 'brass-fg', bg: 'brass-soft', over: 'bg-surface', min: 4.5 },
  { fg: 'code-fg', bg: 'code-bg', over: 'bg-surface', min: 7 },
  { fg: 'fg-default', bg: 'bg-selected', over: 'bg-sidebar', min: 4.5 },
  // Non-text: controls and focus must stand off their surface at 3:1 (WCAG 1.4.11).
  { fg: 'border-focus', bg: 'bg-surface', min: 3 },
  { fg: 'border-focus', bg: 'bg-canvas', min: 3 },
  { fg: 'accent-solid', bg: 'bg-surface', min: 3 },
  { fg: 'success-solid', bg: 'bg-surface', min: 3 },
  { fg: 'danger-solid', bg: 'bg-surface', min: 3 },
]

// Elevation: shadows for each layer. Dark mode relies on a lighter surface and an inner hairline
// more than on shadow, which barely shows on a dark canvas.
export const shadow = {
  '0': { light: 'none', dark: 'none' },
  '1': {
    light: '0 1px 2px oklch(0.2 0.01 265 / 0.06), 0 0 0 0.5px oklch(0.2 0.01 265 / 0.06)',
    dark: '0 1px 2px oklch(0 0 0 / 0.4), inset 0 0.5px 0 oklch(1 0 0 / 0.06)',
  },
  '2': {
    light: '0 2px 6px -1px oklch(0.2 0.01 265 / 0.08), 0 1px 2px oklch(0.2 0.01 265 / 0.06)',
    dark: '0 4px 10px -2px oklch(0 0 0 / 0.5), inset 0 0.5px 0 oklch(1 0 0 / 0.07)',
  },
  '3': {
    light: '0 12px 28px -6px oklch(0.2 0.01 265 / 0.18), 0 2px 6px oklch(0.2 0.01 265 / 0.08)',
    dark: '0 14px 32px -6px oklch(0 0 0 / 0.65), inset 0 0.5px 0 oklch(1 0 0 / 0.08)',
  },
  '4': {
    light: '0 28px 64px -12px oklch(0.2 0.01 265 / 0.3), 0 4px 12px oklch(0.2 0.01 265 / 0.1)',
    dark: '0 28px 70px -10px oklch(0 0 0 / 0.75), inset 0 0.5px 0 oklch(1 0 0 / 0.1)',
  },
} as const satisfies Record<string, Themed>

/**
 * Materials for floating layers (popovers, menus, toasts, the tray). "solid" works everywhere.
 * "glass" is the Liquid Glass treatment for macOS: translucent, blurred and saturated, with a
 * specular rim, and a refraction filter where the engine supports one. "frost" is the same idea
 * dialled down for Windows and Linux, where heavy translucency reads as foreign.
 * The platform is chosen with data-platform on <html> (see platform.ts).
 */
export const material = {
  'glass-bg': { light: 'oklch(0.99 0.003 265 / 0.62)', dark: 'oklch(0.26 0.01 265 / 0.55)' },
  'glass-rim': { light: 'oklch(1 0 0 / 0.75)', dark: 'oklch(1 0 0 / 0.16)' },
  'glass-edge': { light: 'oklch(0.2 0.01 265 / 0.12)', dark: 'oklch(0 0 0 / 0.5)' },
  'glass-sheen': {
    light: 'linear-gradient(180deg, oklch(1 0 0 / 0.55) 0%, oklch(1 0 0 / 0) 42%)',
    dark: 'linear-gradient(180deg, oklch(1 0 0 / 0.1) 0%, oklch(1 0 0 / 0) 40%)',
  },
  'frost-bg': { light: 'oklch(0.985 0.003 265 / 0.9)', dark: 'oklch(0.25 0.01 265 / 0.9)' },
  'solid-bg': { light: 'white', dark: 'gray.850' },
} as const satisfies Record<string, Themed>
