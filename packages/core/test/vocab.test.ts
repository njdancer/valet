import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOCK_REASONS, ERROR_CLASSES, MESSAGES_SECRET, NEEDS_USER_REASONS, STAGES } from '../src/vocab'

describe('vocab entry point', () => {
  it('re-exports the vocabularies a browser bundle needs', () => {
    expect(STAGES).toContain('secret-fill')
    expect(ERROR_CLASSES).toContain('origin-mismatch')
    expect(NEEDS_USER_REASONS).toContain('captcha')
    expect(MESSAGES_SECRET).toBe('messages')
    expect(BLOCK_REASONS).toContain('purpose-exceeded')
  })

  it('pulls in no Node built-ins, directly or through what it re-exports', () => {
    for (const file of ['vocab.ts', 'errors.ts', 'credentials.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8')
      const valueImports = source.match(/^import (?!type )[^\n]*from '[^']+'/gm) ?? []
      expect(
        valueImports.filter((line) => /'node:|'(fs|path|crypto|util)'/.test(line)),
        file,
      ).toEqual([])
      expect(source, file).not.toMatch(/^import (?!type )[^\n]*from '\.\/(secret|hash)'/m)
    }
  })
})
