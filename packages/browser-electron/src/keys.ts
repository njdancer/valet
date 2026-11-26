// Key names as Playwright MCP's browser_press_key takes them ("Enter", "ArrowLeft", "Control+A",
// "Shift+Tab"), turned into what Electron's sendInputEvent sends: an accelerator key code and the
// modifiers held while it is pressed.

export type Modifier = 'control' | 'shift' | 'alt' | 'meta'

export interface KeyPress {
  /** Electron's key code for the key (an accelerator name such as Enter, Left or a). */
  readonly keyCode: string
  readonly modifiers: readonly Modifier[]
  /** The character the key types, if any, sent as a char event between keyDown and keyUp. */
  readonly char: string | null
}

const MODIFIERS: Record<string, Modifier> = {
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  command: 'meta',
  cmd: 'meta',
  // Playwright's portable name: Command on a Mac, where Valet runs.
  controlormeta: 'meta',
}

const NAMED: Record<string, { readonly code: string; readonly char: string | null }> = {
  enter: { code: 'Enter', char: '\r' },
  tab: { code: 'Tab', char: '\t' },
  escape: { code: 'Escape', char: null },
  esc: { code: 'Escape', char: null },
  backspace: { code: 'Backspace', char: null },
  delete: { code: 'Delete', char: null },
  insert: { code: 'Insert', char: null },
  space: { code: 'Space', char: ' ' },
  arrowup: { code: 'Up', char: null },
  arrowdown: { code: 'Down', char: null },
  arrowleft: { code: 'Left', char: null },
  arrowright: { code: 'Right', char: null },
  up: { code: 'Up', char: null },
  down: { code: 'Down', char: null },
  left: { code: 'Left', char: null },
  right: { code: 'Right', char: null },
  home: { code: 'Home', char: null },
  end: { code: 'End', char: null },
  pageup: { code: 'PageUp', char: null },
  pagedown: { code: 'PageDown', char: null },
}

/** Parses a key or combination; null for one Valet doesn't know, so the agent hears why. */
export function parseKey(spec: string): KeyPress | null {
  if (spec.length === 0 || spec.length > 60) return null
  // "Control++" is Control and the plus key: split on + only where it joins two parts.
  const parts = spec === '+' ? ['+'] : spec.split(/\+(?!$)/)
  const keyPart = parts.pop()
  if (keyPart === undefined || keyPart === '') return null
  const modifiers: Modifier[] = []
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (modifier === undefined || modifiers.includes(modifier)) return null
    modifiers.push(modifier)
  }
  const named = NAMED[keyPart.toLowerCase()]
  if (named !== undefined)
    return { keyCode: named.code, modifiers, char: modifiers.length > 0 ? null : named.char }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(keyPart)) return { keyCode: keyPart, modifiers, char: null }
  // One printable character, as Playwright takes "a" or "A".
  if ([...keyPart].length === 1 && keyPart >= ' ') {
    // With Control, Alt or Command held a key is a shortcut and types nothing.
    const typing = modifiers.every((m) => m === 'shift')
    return { keyCode: keyPart, modifiers, char: typing ? keyPart : null }
  }
  return null
}
