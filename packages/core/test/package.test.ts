import { describe, expect, it } from 'vitest'
import { bundleHash, canonicalJson } from '../src/hash'
import { parseManifest } from '../src/manifest'
import {
  adapterHashOf,
  checkPackage,
  checkPackagePath,
  PACKAGE_LIMITS,
  PackageError,
  type PackageFiles,
  packageOf,
} from '../src/package'

const MANIFEST = parseManifest({
  schemaVersion: 1,
  id: 'example-site',
  name: 'Example',
  version: '0.1.0',
  description: 'An example.',
  home: 'https://www.example.com/',
  navigation: ['https://www.example.com'],
  egress: ['www.example.com'],
  tools: [{ name: 'get_page', title: 'Get page', description: 'Gets a page.', sideEffect: 'read' }],
})

const SOURCES = {
  'src/tools.ts': "import { page } from './page'\nexport const tools = { get_page: page }\n",
  'src/page.ts': 'export const page = {}\n',
}

function valid(extra: Record<string, string> = {}): Record<string, string> {
  return { ...packageOf(MANIFEST, SOURCES), ...extra }
}

function refusal(files: unknown): PackageError {
  try {
    checkPackage(files as PackageFiles)
  } catch (error) {
    if (error instanceof PackageError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('checkPackage', () => {
  it('parses the manifest and hashes the package', () => {
    const checked = checkPackage(
      valid({ 'test/page.test.ts': 'x', 'fixtures/a.json': '{}', 'README.md': '# hi' }),
    )
    expect(checked.manifest).toEqual(MANIFEST)
    expect(checked.adapterHash).toMatch(/^[0-9a-f]{64}$/)
    expect(checked.packageHash).not.toBe(checked.adapterHash)
  })

  it('keeps the formula the built-ins were hashed with: src files plus the canonical parsed manifest', () => {
    const checked = checkPackage(valid())
    expect(checked.adapterHash).toBe(bundleHash({ ...SOURCES, ':manifest.json': canonicalJson(MANIFEST) }))
  })

  it('leaves tests, fixtures and the readme out of the adapter hash but not the package hash', () => {
    const plain = checkPackage(valid())
    const extra = checkPackage(valid({ 'test/a.test.ts': 'x', 'fixtures/a.json': '{}', 'README.md': 'r' }))
    expect(extra.adapterHash).toBe(plain.adapterHash)
    expect(extra.packageHash).not.toBe(plain.packageHash)
  })

  it('covers every source and the manifest', () => {
    const plain = checkPackage(valid()).adapterHash
    expect(checkPackage(valid({ 'src/page.ts': 'export const page = { x: 1 }\n' })).adapterHash).not.toBe(
      plain,
    )
    const renamed = parseManifest({ ...MANIFEST, name: 'Other' })
    expect(adapterHashOf(valid(), renamed)).not.toBe(plain)
  })

  it('ignores how manifest.json is formatted', () => {
    const compact = valid({ 'manifest.json': JSON.stringify(MANIFEST) })
    expect(checkPackage(compact).adapterHash).toBe(checkPackage(valid()).adapterHash)
  })

  it('copies what it checked', () => {
    const files = valid()
    const checked = checkPackage(files)
    files['src/page.ts'] = 'changed'
    expect(checked.files['src/page.ts']).toBe(SOURCES['src/page.ts'])
    expect(Object.isFrozen(checked.files)).toBe(true)
  })

  it.each([
    ['../src/x.ts'],
    ['/src/x.ts'],
    ['src/../x.ts'],
    ['src/./x.ts'],
    ['src//x.ts'],
    ['src\\x.ts'],
    ['src/X.ts'],
    ['src/é.ts'],
    ['src/.hidden.ts'],
    ['x.ts'],
    ['src'],
    [':manifest.json'],
    ['__proto__'],
    ['package.json'],
    ['src/.ts'],
    [`src/${'a/'.repeat(8)}x.ts`],
    [`src/${'a'.repeat(200)}.ts`],
  ])('refuses the path %s', (path) => {
    expect(() => checkPackagePath(path)).toThrow(PackageError)
    expect(refusal(valid({ [path]: 'x' })).rule).toMatch(/^(path|placement)$/)
  })

  it.each([['src/a.js'], ['src/a.json'], ['src/a.node'], ['test/a.html'], ['fixtures/a.ts'], ['lib/a.ts']])(
    'refuses %s where it is',
    (path) => {
      expect(refusal(valid({ [path]: 'x' })).rule).toBe('placement')
    },
  )

  it('refuses a package without its manifest or entry', () => {
    const noManifest: Record<string, string> = { ...valid() }
    delete noManifest['manifest.json']
    expect(refusal(noManifest).rule).toBe('manifest-missing')
    const noEntry: Record<string, string> = { ...valid() }
    delete noEntry['src/tools.ts']
    expect(refusal(noEntry).rule).toBe('entry-missing')
  })

  it('refuses a manifest that is not JSON or not valid', () => {
    expect(refusal(valid({ 'manifest.json': '{' })).rule).toBe('manifest-invalid')
    const bad = refusal(valid({ 'manifest.json': JSON.stringify({ ...MANIFEST, id: 'Bad Id' }) }))
    expect(bad.rule).toBe('manifest-invalid')
    expect(bad.detail).toContain('id')
  })

  it('refuses content that is not text', () => {
    expect(refusal(valid({ 'src/a.ts': 'a\0b' })).rule).toBe('not-text')
    expect(refusal(valid({ 'src/a.ts': '\ud800' })).rule).toBe('not-text')
    expect(refusal({ ...valid(), 'src/a.ts': 1 }).rule).toBe('not-text')
    expect(refusal(null).rule).toBe('manifest-missing')
  })

  it('enforces the size limits', () => {
    const many: Record<string, string> = valid()
    for (let i = 0; i < PACKAGE_LIMITS.files; i++) many[`src/f${i}.ts`] = ''
    expect(refusal(many).rule).toBe('too-many-files')
    expect(refusal(valid({ 'src/big.ts': 'x'.repeat(PACKAGE_LIMITS.fileBytes + 1) })).rule).toBe(
      'file-too-large',
    )
    const large: Record<string, string> = valid()
    for (let i = 0; i < 9; i++) large[`src/f${i}.ts`] = 'x'.repeat(PACKAGE_LIMITS.fileBytes)
    expect(refusal(large).rule).toBe('too-large')
  })
})
