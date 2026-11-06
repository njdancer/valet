// Screens an adapter's OTP pattern before it is ever run. The pattern is adapter-supplied and runs in
// the trusted main process's worker, so the classic exponential shapes are refused up front: a
// repeated group that itself repeats or alternates, as in `(a+)+` or `(a|ab)*`, and backreferences.
// This is a fast first line only. Polynomial blow-ups such as `\d*\d*\d*x` pass it, which is why
// matching also runs under a deadline (see pattern-worker.ts).

interface Group {
  /** The group's body has a quantifier or an alternation at any depth. */
  ambiguous: boolean
}

/** True when `pattern` compiles and has none of the shapes above. */
export function isScreenedOtpPattern(pattern: string): boolean {
  try {
    new RegExp(pattern)
  } catch {
    return false
  }
  const stack: Group[] = [{ ambiguous: false }]
  // Whether the atom just closed was a group whose body was ambiguous.
  let lastWasAmbiguousGroup = false
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i] as string
    const top = stack[stack.length - 1] as Group
    if (char === '\\') {
      const next = pattern[i + 1] ?? ''
      // \1-\9 and \k<name> are backreferences; nothing a code needs, and they defeat any bound.
      if (/[1-9k]/.test(next)) return false
      lastWasAmbiguousGroup = false
      i += 2
      continue
    }
    if (char === '[') {
      i = endOfClass(pattern, i)
      lastWasAmbiguousGroup = false
      continue
    }
    if (char === '(') {
      stack.push({ ambiguous: false })
      lastWasAmbiguousGroup = false
      i += groupPrefixLength(pattern, i)
      continue
    }
    if (char === ')') {
      const closed = stack.pop() as Group
      const parent = stack[stack.length - 1] as Group
      parent.ambiguous ||= closed.ambiguous
      lastWasAmbiguousGroup = closed.ambiguous
      i += 1
      continue
    }
    if (char === '|') {
      top.ambiguous = true
      lastWasAmbiguousGroup = false
      i += 1
      continue
    }
    const quantifier = quantifierAt(pattern, i)
    if (quantifier !== null) {
      if (quantifier.repeats && lastWasAmbiguousGroup) return false
      top.ambiguous = true
      lastWasAmbiguousGroup = false
      i += quantifier.length
      // A lazy or possessive-looking suffix belongs to this quantifier, not a new one.
      if (pattern[i] === '?') i += 1
      continue
    }
    lastWasAmbiguousGroup = false
    i += 1
  }
  return true
}

/** The index just past the character class that opens at `start`. The pattern already compiled. */
function endOfClass(pattern: string, start: number): number {
  let i = start + 1
  while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
  return i + 1
}

/** How many characters `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` or `(?<name>` take up. */
function groupPrefixLength(pattern: string, start: number): number {
  if (pattern[start + 1] !== '?') return 1
  const after = pattern[start + 2]
  if (after === '<' && pattern[start + 3] !== '=' && pattern[start + 3] !== '!') {
    return pattern.indexOf('>', start) - start + 1
  }
  return after === '<' ? 4 : 3
}

/** A quantifier at `i`, and whether it can repeat its atom more than once. */
function quantifierAt(pattern: string, i: number): { length: number; repeats: boolean } | null {
  const char = pattern[i]
  if (char === '*' || char === '+') return { length: 1, repeats: true }
  if (char === '?') return { length: 1, repeats: false }
  if (char !== '{') return null
  const braces = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i))
  if (braces === null) return null
  const [whole, min, comma, max] = braces
  const repeats = comma === undefined ? Number(min) > 1 : max === '' || Number(max) > 1
  return { length: whole.length, repeats }
}
