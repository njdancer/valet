// What a one-time code is, in one place. Valet itself reads codes to sign the person in (otp.ts),
// so agents reading Messages don't see them: such a message comes back with its text hidden, and a
// search never matches one (docs/messages.md). The sign-in lookup only takes a code from a message
// looksLikeCode() calls a code, and only a capture isCodeShaped() accepts, so a code Valet types for
// the person is always one the Messages tools hide.
//
// Deliberately broad: hiding a message that only mentions a PIN costs little; showing a code costs
// a sign-in.

const CODE_WORDS =
  /\b(codes?|passcode|password|verif\w*|one[- ]?time|otp|pin|2fa|two[- ]?factor|two[- ]?step|authenticat\w*|security|log[- ]?in|sign[- ]?in|confirm\w*)\b/i
/** 4 to 10 characters, at least four of them digits: 123456, 123-456, G-123456, AB12CD. */
const CODE_IN_TEXT =
  /(?<![\p{L}\p{N}])(?:[A-Z]{1,3}-)?(?=(?:[A-Z]*\d){4})[A-Z0-9]{4,10}(?![\p{L}\p{N}])|\b\d{3}[- ]\d{3}\b/u
/**
 * What a captured code must look like before it is typed anywhere: a capture of anything else, such
 * as a whole message caught by a catch-all pattern, is never handed to the filler.
 */
const CAPTURED_CODE = /^[A-Za-z0-9]{4,10}$/

/** Whether an incoming message's text looks like it carries a one-time code. */
export function looksLikeCode(text: string | null): boolean {
  if (text === null) return false
  return CODE_WORDS.test(text) && CODE_IN_TEXT.test(text)
}

/** Whether a pattern's capture is shaped like a one-time code: 4 to 10 ASCII letters or digits. */
export function isCodeShaped(value: string): boolean {
  return CAPTURED_CODE.test(value)
}

export const HIDDEN_CODE_TEXT = '[Hidden by Valet: this looks like a one-time code.]'
