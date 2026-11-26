// The agents' downloads shelf (src/main/core/browser-downloads.ts): in memory, by an unguessable id,
// for a few minutes, per session, and never more than a few files or bytes in all.

import { describe, expect, it } from 'vitest'
import { DOWNLOAD_LIMITS, DownloadShelf } from '../../src/main/core/browser-downloads'

const file = (name: string, bytes = 1) => ({ name, mimeType: 'text/plain', data: Buffer.alloc(bytes) })

describe('the downloads shelf', () => {
  it('gives each file a fresh unguessable id that finds it until it expires', () => {
    let now = 0
    const shelf = new DownloadShelf(() => now)
    const a = shelf.put('s1', file('a'))
    const b = shelf.put('s1', file('b'))
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.expiresAt).toBe(DOWNLOAD_LIMITS.keepMs)
    expect(shelf.get(a.id)?.name).toBe('a')
    expect(shelf.get('nope')).toBeNull()
    now = DOWNLOAD_LIMITS.keepMs
    expect(shelf.get(a.id)).toBeNull()
  })

  it('lets go of a session’s files, and of the oldest past its limits', () => {
    let n = 0
    const shelf = new DownloadShelf(
      () => 0,
      () => `id${++n}`,
    )
    shelf.put('s1', file('a'))
    shelf.put('s2', file('b'))
    shelf.drop('s1')
    expect(shelf.get('id1')).toBeNull()
    expect(shelf.get('id2')).not.toBeNull()
    for (let i = 0; i < DOWNLOAD_LIMITS.files; i++) shelf.put('s2', file(`f${i}`))
    expect(shelf.get('id2')).toBeNull()
    expect(shelf.get(`id${DOWNLOAD_LIMITS.files + 2}`)).not.toBeNull()
    // One file bigger than the rest together pushes them all out, but is kept itself.
    const big = shelf.put('s3', file('big', DOWNLOAD_LIMITS.bytes - 10))
    shelf.put('s3', file('more', 20))
    expect(shelf.get(big.id)).toBeNull()
    expect(shelf.get(`id${DOWNLOAD_LIMITS.files + 4}`)?.name).toBe('more')
  })
})
