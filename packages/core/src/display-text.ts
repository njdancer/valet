// Text a person reads on an approval card or in the app, from fields the Mac fills in. Refused,
// not cleaned, if it holds control, format, or line and paragraph separator characters: whoever
// builds the value cleans it first, so a value that still has them is a bug or an attack.

import { z } from 'zod'

export const DISPLAY_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u

export const displayText = (max: number) =>
  z.string().min(1).max(max).regex(DISPLAY_TEXT, 'no control or format characters')
