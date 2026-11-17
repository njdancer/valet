// The SFTP policy table (sftp-policy.ts): which paths are in Valet's form, which root decides, and
// what each purpose may send.

import { describe, expect, it } from 'vitest'
import {
  holdsRoot,
  isSftpName,
  isSftpPath,
  joinPath,
  nameOf,
  OPEN_FLAGS,
  openPurpose,
  parentOf,
  pathAllowed,
  rootAllows,
  rootOf,
  type SftpRoot,
  sftpOperationPurpose,
  wireAllows,
} from '../src/sftp-policy'

const ROOTS: SftpRoot[] = [
  { path: '/data', access: 'write' },
  { path: '/data/private', access: 'read' },
  { path: '/scratch', access: 'irreversible' },
]

describe('paths', () => {
  it('takes absolute paths in one form only', () => {
    for (const good of [
      '/',
      '/a',
      '/a/b.txt',
      '/a b/ç',
      '/.hidden',
      '/a/..b',
      '/a/b..',
      `/${'x'.repeat(255)}`,
      '/😀',
    ])
      expect(isSftpPath(good), good).toBe(true)
    for (const bad of [
      '',
      'a',
      'a/b',
      '/a/',
      '//a',
      '/a//b',
      '/.',
      '/..',
      '/a/./b',
      '/a/../b',
      '/a\\b',
      '/a\u0000b',
      '/a\nb',
      '/a\u007fb',
      '/a\u0085b',
      '/\ud800',
      '/\udc00x',
      `/${'x'.repeat(256)}`,
      `/${'é'.repeat(128)}`,
      `/${'a/'.repeat(600)}a`,
    ])
      expect(isSftpPath(bad), JSON.stringify(bad)).toBe(false)
    expect(isSftpPath(42)).toBe(false)
    expect(isSftpName('..')).toBe(false)
  })

  it('splits and joins', () => {
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBeNull()
    expect(nameOf('/a/b')).toBe('b')
    expect(joinPath('/', 'a')).toBe('/a')
    expect(joinPath('/a', 'b')).toBe('/a/b')
  })
})

describe('roots', () => {
  it('lets the deepest root decide', () => {
    expect(rootOf('/data/x', ROOTS)?.path).toBe('/data')
    expect(rootOf('/data/private/x', ROOTS)?.path).toBe('/data/private')
    expect(rootOf('/data-other/x', ROOTS)).toBeNull()
    expect(rootOf('/dat', ROOTS)).toBeNull()
    expect(rootAllows('/data/x', ROOTS, 'write')).toBe(true)
    expect(rootAllows('/data/private/x', ROOTS, 'write')).toBe(false)
    expect(rootAllows('/data/private/x', ROOTS, 'read')).toBe(true)
    expect(rootAllows('/scratch/x', ROOTS, 'irreversible')).toBe(true)
    expect(rootAllows('/data/x', ROOTS, 'irreversible')).toBe(false)
    expect(rootOf('/anything', [{ path: '/', access: 'read' }])?.path).toBe('/')
  })

  it('never changes a root, nor carries one away', () => {
    expect(pathAllowed('list', '/data', 'read', ROOTS)).toBe(true)
    expect(pathAllowed('mkdir', '/data', 'write', ROOTS)).toBe(false)
    expect(pathAllowed('rename', '/scratch', 'write', ROOTS)).toBe(false)
    expect(pathAllowed('removeDir', '/scratch', 'irreversible', ROOTS)).toBe(false)
    // /data holds /data/private: renaming /data would move a read-only root.
    expect(holdsRoot('/data', ROOTS)).toBe(true)
    const nested: SftpRoot[] = [
      { path: '/w', access: 'irreversible' },
      { path: '/w/a/ro', access: 'read' },
    ]
    expect(pathAllowed('rename', '/w/a', 'write', nested)).toBe(false)
    expect(pathAllowed('removeDir', '/w/a', 'irreversible', nested)).toBe(false)
    expect(pathAllowed('rename', '/w/b', 'write', nested)).toBe(true)
    expect(pathAllowed('write', '/w/a/ro/x', 'write', nested)).toBe(false)
  })

  it('holds the wire to both the declared and the resolved roots', () => {
    const resolved: SftpRoot[] = [{ path: '/volume1/data', access: 'write' }]
    const declared: SftpRoot[] = [{ path: '/data', access: 'write' }]
    expect(wireAllows('/volume1/data/x', 'write', declared, resolved)).toBe(true)
    expect(wireAllows('/data/x', 'write', declared, resolved)).toBe(true)
    expect(wireAllows('/etc/passwd', 'read', declared, resolved)).toBe(false)
    // Where a declared read root and a resolved write root both hold a path, read wins.
    expect(
      wireAllows(
        '/a/sub/x',
        'write',
        [{ path: '/a', access: 'read' }],
        [{ path: '/a/sub', access: 'write' }],
      ),
    ).toBe(false)
    expect(wireAllows('/a/../x', 'read', [{ path: '/', access: 'read' }], [])).toBe(false)
  })
})

describe('purposes', () => {
  it('rates each operation, and a replace as irreversible', () => {
    expect(sftpOperationPurpose('read', ['/a'])).toBe('read')
    expect(sftpOperationPurpose('write', ['/a', 'x'])).toBe('write')
    expect(sftpOperationPurpose('write', ['/a', 'x', { mode: 'append' }])).toBe('write')
    expect(sftpOperationPurpose('write', ['/a', 'x', { mode: 'replace' }])).toBe('irreversible')
    expect(sftpOperationPurpose('write', ['/a', 'x', { mode: 'something' }])).toBe('irreversible')
    expect(sftpOperationPurpose('write', ['/a', 'x', ['replace']])).toBe('write')
    expect(sftpOperationPurpose('remove', ['/a'])).toBe('irreversible')
    expect(sftpOperationPurpose('removeDir', ['/a'])).toBe('irreversible')
    expect(sftpOperationPurpose('rename', ['/a', '/b'])).toBe('write')
  })

  it('opens files only in four ways', () => {
    const F = OPEN_FLAGS
    expect(openPurpose(F.READ)).toBe('read')
    expect(openPurpose(F.WRITE | F.CREAT | F.EXCL)).toBe('write')
    expect(openPurpose(F.WRITE | F.APPEND)).toBe('write')
    expect(openPurpose(F.WRITE | F.CREAT | F.TRUNC)).toBe('irreversible')
    for (const flags of [
      0,
      F.WRITE,
      F.READ | F.WRITE,
      F.WRITE | F.CREAT,
      F.WRITE | F.TRUNC,
      F.READ | F.CREAT,
      F.WRITE | F.APPEND | F.CREAT,
      0x40,
      F.READ | 0x100,
    ])
      expect(openPurpose(flags), String(flags)).toBeNull()
  })
})
