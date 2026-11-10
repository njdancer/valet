// @vitest-environment node
// The diagnostics log: what reaches the disk, and what never does.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPaths } from '../../src/main/core/constants'
import {
  afterCrash,
  createDiagnosticsLog,
  describeError,
  flatten,
  type LogFiles,
  MAX_FRAMES,
  MAX_LINE_LENGTH,
  MIN_UPTIME_TO_RELAUNCH_MS,
  processGoneLine,
} from '../../src/main/core/diagnostics-log'

const NOW = Date.UTC(2026, 10, 10, 9, 30, 0)

/** An in-memory file system that records what the log did. */
function memoryFiles(): LogFiles & { files: Map<string, string>; dirs: string[] } {
  const files = new Map<string, string>()
  const dirs: string[] = []
  return {
    files,
    dirs,
    mkdir: (dir) => {
      dirs.push(dir)
    },
    size: (path) => {
      const text = files.get(path)
      return text === undefined ? null : Buffer.byteLength(text)
    },
    rename: (from, to) => {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    append: (path, text) => {
      files.set(path, (files.get(path) ?? '') + text)
    },
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('the diagnostics log', () => {
  it('lives in its own folder under the data directory', () => {
    expect(dataPaths('/data').diagnosticsLog).toBe('/data/logs/valet.log')
  })

  it('writes one timestamped line per entry, making its folder once', () => {
    const files = memoryFiles()
    const log = createDiagnosticsLog({ path: '/data/logs/valet.log', now: () => NOW, files })
    log.write('started: version 0.1.0')
    log.write('stopping')

    expect(files.files.get('/data/logs/valet.log')).toBe(
      '2026-11-10T09:30:00.000Z started: version 0.1.0\n2026-11-10T09:30:00.000Z stopping\n',
    )
    expect(files.dirs).toEqual(['/data/logs'])
  })

  it('keeps an entry on one line, so text with a newline cannot forge another entry', () => {
    const files = memoryFiles()
    const log = createDiagnosticsLog({ path: '/l/valet.log', now: () => NOW, files })
    log.write('diagnostic: x\n2026-11-10T00:00:00.000Z uncaught exception again‮')

    const text = files.files.get('/l/valet.log') ?? ''
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toBe(
      '2026-11-10T09:30:00.000Z diagnostic: x 2026-11-10T00:00:00.000Z uncaught exception again\n',
    )
  })

  it('cuts a long line', () => {
    expect(flatten('x'.repeat(MAX_LINE_LENGTH + 50))).toHaveLength(MAX_LINE_LENGTH)
  })

  it('moves a full file aside and starts again, keeping only one old file', () => {
    const files = memoryFiles()
    const log = createDiagnosticsLog({ path: '/l/valet.log', now: () => NOW, files, maxBytes: 60 })
    log.write('first')
    log.write('second')
    expect(files.files.has('/l/valet.log.1')).toBe(false)
    log.write('third')
    expect(files.files.get('/l/valet.log.1')).toContain('second')
    expect(files.files.get('/l/valet.log')).toBe('2026-11-10T09:30:00.000Z third\n')
    log.write('fourth')
    log.write('fifth')
    expect(files.files.get('/l/valet.log.1')).toContain('fourth')
    expect(files.files.get('/l/valet.log.1')).not.toContain('second')
    expect([...files.files.keys()].sort()).toEqual(['/l/valet.log', '/l/valet.log.1'])
  })

  it('never throws when the disk refuses, and tries again next time', () => {
    const files = memoryFiles()
    let failing = true
    const log = createDiagnosticsLog({
      path: '/l/valet.log',
      now: () => NOW,
      files: {
        ...files,
        mkdir: (dir) => {
          if (failing) throw new Error('EACCES')
          files.mkdir(dir)
        },
      },
    })
    expect(() => log.write('lost')).not.toThrow()
    expect(() => log.writeError('lost', new Error('x'))).not.toThrow()
    failing = false
    log.write('kept')
    expect(files.files.get('/l/valet.log')).toBe('2026-11-10T09:30:00.000Z kept\n')
  })

  it('writes owner-only files on the real disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'valet-log-'))
    dirs.push(dir)
    const path = join(dir, 'logs', 'valet.log')
    const log = createDiagnosticsLog({ path, now: () => NOW, maxBytes: 40 })
    log.write('one')
    log.write('two')
    log.write('three')

    expect(await readFile(path, 'utf8')).toBe('2026-11-10T09:30:00.000Z three\n')
    expect(await readFile(`${path}.1`, 'utf8')).toContain('two')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'logs'))).mode & 0o777).toBe(0o700)
  })
})

describe('an error in the log', () => {
  const CANARY = 'hunter2-canary-password'

  it('is its name and stack frames, never its message', () => {
    const error = new TypeError(`could not read ${CANARY}\nat fake (evil.js:1:1)`)
    const files = memoryFiles()
    const log = createDiagnosticsLog({ path: '/l/valet.log', now: () => NOW, files })
    log.writeError('uncaught exception', error)

    const text = files.files.get('/l/valet.log') ?? ''
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain('could not read')
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toBe('2026-11-10T09:30:00.000Z uncaught exception')
    expect(lines[1]).toBe('2026-11-10T09:30:00.000Z TypeError')
    expect(lines[2]).toMatch(/^2026-11-10T09:30:00\.000Z at .+diagnostics-log\.test\.ts:\d+:\d+\)?$/)
  })

  it('keeps a code that looks like one, and drops one that could be text', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'ENOSPC' }))[0]).toBe('  Error (ENOSPC)')
    expect(describeError(Object.assign(new Error('x'), { code: `no space: ${CANARY}` }))[0]).toBe('  Error')
    expect(describeError(Object.assign(new Error('x'), { code: 28 }))[0]).toBe('  Error')
  })

  it('replaces a name that could be text', () => {
    const error = new Error('x')
    error.name = `Oops ${CANARY}`
    expect(describeError(error).join('\n')).not.toContain(CANARY)
    expect(describeError(error)[0]).toBe('  Error')
  })

  it('keeps only lines shaped like frames from what follows the message, and only so many', () => {
    const error = new Error(`first line\n    at leak ${CANARY} (evil.js:1:1)`)
    error.stack = [
      `Error: ${error.message}`,
      `    at the password ${CANARY}`,
      ...Array.from({ length: MAX_FRAMES + 5 }, (_, i) => `    at run (file:///app/main.js:${i + 1}:5)`),
    ].join('\n')
    const lines = describeError(error)
    expect(lines).toHaveLength(1 + MAX_FRAMES)
    expect(lines.join('\n')).not.toContain(CANARY)
    expect(lines[1]).toBe('    at run (file:///app/main.js:1:5)')
  })

  it('gives no frames when the stack does not hold the message', () => {
    const error = new Error('the message')
    error.stack = `Error: something else\n    at ${CANARY} (evil.js:1:1)`
    expect(describeError(error)).toEqual(['  Error'])
  })

  it('copes with an error that has no stack, and with something that is not an error', () => {
    const bare = new Error('x')
    Object.defineProperty(bare, 'stack', { value: undefined })
    expect(describeError(bare)).toEqual(['  Error'])
    const odd = new Error('x')
    Object.defineProperty(odd, 'message', { value: 7 })
    expect(describeError(odd)).toEqual(['  Error'])
    expect(describeError(CANARY)).toEqual(['  thrown: string'])
    expect(describeError(undefined)).toEqual(['  thrown: undefined'])
  })
})

describe('a process that died', () => {
  it('is recorded by Electron’s own words', () => {
    expect(processGoneLine('renderer', 'crashed', 11)).toBe('process gone: renderer (crashed, exit 11)')
    expect(processGoneLine('Utility', 'oom', -1)).toBe('process gone: Utility (oom, exit -1)')
    expect(processGoneLine('GPU', 'launch-failed', 1)).toBe('process gone: GPU (launch-failed, exit 1)')
  })

  it('replaces anything that is not a plain word', () => {
    expect(processGoneLine('renderer\nforged', '<script>', Number.NaN)).toBe(
      'process gone: unknown (unknown, exit unknown)',
    )
  })
})

describe('after a crash', () => {
  it('a packaged app that had been running starts again', () => {
    expect(afterCrash({ packaged: true, uptimeMs: MIN_UPTIME_TO_RELAUNCH_MS })).toBe('relaunch')
  })

  it('a crash soon after start stays down, so it cannot loop', () => {
    expect(afterCrash({ packaged: true, uptimeMs: MIN_UPTIME_TO_RELAUNCH_MS - 1 })).toBe('exit')
  })

  it('a development run never restarts itself', () => {
    expect(afterCrash({ packaged: false, uptimeMs: 10 * MIN_UPTIME_TO_RELAUNCH_MS })).toBe('exit')
  })
})
