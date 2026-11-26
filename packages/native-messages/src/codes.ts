// Which messages look like one-time codes. Valet itself reads codes to sign the person in
// (packages/credentials, messages-otp.ts), so agents reading Messages don't see them: such a message
// comes back with its text hidden, and a search never matches one (docs/messages.md).
//
// Deliberately broad: hiding a message that only mentions a PIN costs little; showing a code costs
// a sign-in.

const CODE_WORDS =
  /\b(codes?|passcode|password|verif\w*|one[- ]?time|otp|pin|2fa|two[- ]?factor|two[- ]?step|authenticat\w*|security|log[- ]?in|sign[- ]?in|confirm\w*)\b/i
/** 4 to 10 characters, at least four of them digits: 123456, 123-456, G-123456, AB12CD. */
const CODE_SHAPE =
  /(?<![\p{L}\p{N}])(?:[A-Z]{1,3}-)?(?=(?:[A-Z]*\d){4})[A-Z0-9]{4,10}(?![\p{L}\p{N}])|\b\d{3}[- ]\d{3}\b/u

/** Whether an incoming message's text looks like it carries a one-time code. */
export function looksLikeCode(text: string | null): boolean {
  if (text === null) return false
  return CODE_WORDS.test(text) && CODE_SHAPE.test(text)
}

export const HIDDEN_CODE_TEXT = '[Hidden by Valet: this looks like a one-time code.]'
