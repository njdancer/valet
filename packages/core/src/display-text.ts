// Text a person reads on an approval card or in the app, from fields the Mac fills in. Refused,
// not cleaned, if it holds control, format, or line and paragraph separator characters: whoever
// builds the value cleans it first, so a value that still has them is a bug or an attack.

import { z } from 'zod'

export const DISPLAY_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u
/** Letters that render as nothing (Hangul fillers, the braille blank, and similar). */
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0\u2800\u180E\u17B4\u17B5]/u
/** More than two combining marks in a row stack into a smear that hides other text. */
const MARK_PILE = /\p{M}{3,}/u

export function isDisplayText(value: string): boolean {
  return DISPLAY_TEXT.test(value) && !INVISIBLE.test(value) && !MARK_PILE.test(value) && value.trim() !== ''
}

export const displayText = (max: number) =>
  z.string().min(1).max(max).refine(isDisplayText, 'no control, format or invisible characters')
