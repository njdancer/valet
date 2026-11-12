// Text a person reads on an approval card or in the app, from fields the Mac fills in. Refused,
// not cleaned, if it holds control, format, or line and paragraph separator characters: whoever
// builds the value cleans it first, so a value that still has them is a bug or an attack.

import { z } from 'zod'

export const DISPLAY_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u
/**
 * Characters that render as nothing or draw over their neighbours: Hangul fillers, the braille
 * blank, variation selectors, enclosing marks, and the very wide ligatures.
 */
const INVISIBLE =
  /[\u115F\u1160\u3164\uFFA0\u2800\u180E\u17B4\u17B5\uFE00-\uFE0F\u{E0100}-\u{E01EF}\uFDFD\uFDFA\uFDFB\u2E3B\p{Me}]/u
/** Variation selectors, which render as nothing on their own. */
const VARIATION = /\p{Variation_Selector}/u
/** More than two combining marks in a row stack into a smear that hides other text. */
const MARK_PILE = /\p{M}{3,}/u
/** Long runs of spaces push the rest of a line out of view. */
const SPACE_RUN = /\p{Zs}{4,}/u

export function isDisplayText(value: string): boolean {
  if (
    !DISPLAY_TEXT.test(value) ||
    INVISIBLE.test(value) ||
    VARIATION.test(value) ||
    MARK_PILE.test(value) ||
    SPACE_RUN.test(value)
  )
    return false
  // Something visible must remain once marks and spaces are gone.
  return value.replace(/[\p{M}\p{Z}]/gu, '') !== ''
}

export const displayText = (max: number) =>
  z.string().min(1).max(max).refine(isDisplayText, 'no control, format or invisible characters')
