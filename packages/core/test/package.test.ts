import { describe, expect, it } from 'vitest'
import { EMPTY_LOCK } from '../src/dependencies'
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

  it('says where bad JSON is, as JSON.parse does', () => {
    const bad = refusal(valid({ 'manifest.json': '{ "id": "x", }' }))
    expect(bad.rule).toBe('manifest-invalid')
    expect(bad.detail).toMatch(/^not JSON: .*position \d+/)
  })

  it('lists several manifest problems, names the top level, and suggests the key it has', () => {
    const { requests: _requests, ...rest } = JSON.parse(valid()['manifest.json'] ?? '{}')
    const bad = refusal(
      valid({
        'manifest.json': JSON.stringify({
          ...rest,
          request: [{ method: 'GET', path: '/x', purpose: 'read' }],
          egres: ['www.example.com'],
          name: '',
          tools: [{ ...MANIFEST.tools[0], sideEffects: 'read' }],
        }),
      }),
    )
    expect(bad.rule).toBe('manifest-invalid')
    expect(bad.detail).toContain('(top level): Unrecognized keys: "request", "egres"')
    expect(bad.detail).toContain('did you mean "requests" for "request", "egress" for "egres"?')
    expect(bad.detail).toContain('name: ')
    expect(bad.detail).toContain('tools[0]: Unrecognized key: "sideEffects" (did you mean "sideEffect"')
    expect(bad.detail).not.toMatch(/^: /)
    expect(bad.detail.split('; ').length).toBeGreaterThan(2)
  })

  it('lists at most five manifest problems and counts the rest', () => {
    const bad = refusal(valid({ 'manifest.json': JSON.stringify({ a: 1, b: 2, c: 3 }) }))
    expect(bad.detail.split('; ').length).toBeLessThanOrEqual(6)
    expect(bad.detail).toMatch(/and \d+ more$/)
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

describe('a dependency lockfile (docs/node-runtime.md#dependencies)', () => {
  const lock = {
    lockfileVersion: 1,
    dependencies: { a: { range: '^1.0.0', resolved: 'a@1.0.0' } },
    packages: {
      'a@1.0.0': {
        integrity: `sha512-${'A'.repeat(86)}==`,
        tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        dependencies: {},
      },
    },
  }

  it('may sit at the top of a package, but only a raw adapter may carry one', () => {
    expect(() => checkPackagePath('valet-lock.json')).not.toThrow()
    expect(checkPackage(valid()).dependencies).toBeNull()
    expect(refusal(valid({ 'valet-lock.json': JSON.stringify(EMPTY_LOCK) })).rule).toBe('lock-invalid')
  })

  it('is covered by the adapter hash, whitespace aside; without one the hash is unchanged', () => {
    const files = valid()
    const plain = adapterHashOf(files, MANIFEST)
    const covered: Record<string, string> = { ...SOURCES, ':manifest.json': canonicalJson(MANIFEST) }
    expect(plain).toBe(bundleHash(covered))
    const withLock = adapterHashOf({ ...files, 'valet-lock.json': JSON.stringify(lock) }, MANIFEST)
    expect(withLock).not.toBe(plain)
    expect(adapterHashOf({ ...files, 'valet-lock.json': JSON.stringify(lock, null, 2) }, MANIFEST)).toBe(
      withLock,
    )
    const other = { ...lock, dependencies: { a: { range: '1.0.0', resolved: 'a@1.0.0' } } }
    expect(adapterHashOf({ ...files, 'valet-lock.json': JSON.stringify(other) }, MANIFEST)).not.toBe(withLock)
    // Text that isn't JSON still hashes (checkPackage refuses it before it matters).
    expect(adapterHashOf({ ...files, 'valet-lock.json': '{' }, MANIFEST)).not.toBe(plain)
  })
})
