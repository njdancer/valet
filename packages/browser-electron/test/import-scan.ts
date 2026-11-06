// Finds the modules a JavaScript or TypeScript source imports, without a parser: a small lexer
// that skips comments, regular expressions and template expressions, and reports each string
// literal that sits where a module specifier goes. Good enough for a boundary test, which only has
// to be right about real code in this repo, not about every possible program.

const IMPORT_POSITION = /(?:^|[^\w$.])(?:from|import|require)\s*\(?\s*$/
// After these, a "/" starts a regular expression rather than a division.
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^'])
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/

export function importedModules(source: string): string[] {
  const found: string[] = []
  let code = '' // everything outside comments and literals, for looking back from a literal
  let i = 0
  const n = source.length

  const readQuoted = (quote: string): string => {
    let value = ''
    i++
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') {
        value += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (source[i] === '\n') break
      value += source[i]
      i++
    }
    i++
    return value
  }

  // Returns the template's text when it has no ${} expressions, otherwise null. Expressions are
  // lexed as code, so imports inside them are still found.
  const readTemplate = (): string | null => {
    let value = ''
    let isStatic = true
    i++
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') {
        value += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (source[i] === '$' && source[i + 1] === '{') {
        isStatic = false
        i += 2
        lexCode('}')
        i++
        continue
      }
      value += source[i]
      i++
    }
    i++
    return isStatic ? value : null
  }

  const skipRegex = (): void => {
    let inClass = false
    i++
    while (i < n && source[i] !== '\n') {
      const c = source[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      i++
    }
    i++
    while (i < n && /[a-z]/i.test(source[i] ?? '')) i++
  }

  const record = (value: string): void => {
    if (IMPORT_POSITION.test(code.slice(-40))) found.push(value)
    code += ' "" '
  }

  function lexCode(until: string | null): void {
    let depth = 0
    while (i < n) {
      const c = source[i] ?? ''
      const next = source[i + 1]
      if (until !== null && c === until && depth === 0) return
      if (c === '{') depth++
      if (c === '}') depth--
      if (c === '/' && next === '/') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end === -1 ? n : end + 2
        code += ' '
        continue
      }
      if (c === "'" || c === '"') {
        record(readQuoted(c))
        continue
      }
      if (c === '`') {
        const value = readTemplate()
        if (value === null) code += ' `` '
        else record(value)
        continue
      }
      if (c === '/') {
        const before = code.slice(-40).trimEnd()
        const last = before.at(-1)
        if (last === undefined || REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.test(before.slice(-12))) {
          skipRegex()
          code += ' /re/ '
          continue
        }
      }
      code += c
      i++
    }
  }

  lexCode(null)
  return found
}

export function importsElectron(source: string): boolean {
  return importedModules(source).some(
    (specifier) => specifier === 'electron' || specifier.startsWith('electron/'),
  )
}
