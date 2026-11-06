import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { partitionName } from '../src/partitions'
import { sleep } from '../src/platform'
import { CHROMIUM_SWITCHES, hardenProcess } from '../src/process-hardening'
import { withTimeout } from '../src/timeout'
import { cleanChromeUserAgent } from '../src/user-agent'
import { ManualTimers } from './fake-browser'

describe('partitionName', () => {
  it('names one persistent partition per role and adapter', () => {
    expect(partitionName('auth', 'woolworths')).toBe('persist:auth:woolworths')
    expect(partitionName('tool', 'woolworths')).toBe('persist:tool:woolworths')
  })

  it('refuses an id that could reach another partition or path', () => {
    for (const id of ['woolworths:x', '../woolworths', 'Woolworths', 'w', '', 'a b', 'tool:woolworths']) {
      expect(() => partitionName('auth', id), id).toThrow(SiteAdapterError)
    }
  })
})

describe('cleanChromeUserAgent', () => {
  it('names the real Chrome major version with the reduced form', () => {
    expect(cleanChromeUserAgent('142.0.7444.59', 'darwin')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    )
  })

  it('never mentions Electron', () => {
    expect(cleanChromeUserAgent('142.0.7444.59', 'darwin')).not.toMatch(/electron/i)
  })

  it('uses the platform token for Windows and Linux, and Linux for anything else', () => {
    expect(cleanChromeUserAgent('142.0.1.2', 'win32')).toContain('(Windows NT 10.0; Win64; x64)')
    expect(cleanChromeUserAgent('142.0.1.2', 'linux')).toContain('(X11; Linux x86_64)')
    expect(cleanChromeUserAgent('142.0.1.2', 'freebsd')).toContain('(X11; Linux x86_64)')
  })

  it('refuses a version it cannot read', () => {
    expect(() => cleanChromeUserAgent('', 'darwin')).toThrow()
    expect(() => cleanChromeUserAgent('latest', 'darwin')).toThrow()
  })
})

describe('hardenProcess', () => {
  it('switches DNS prefetching off in Blink', () => {
    const appended: [string, string | undefined][] = []
    hardenProcess({ commandLine: { appendSwitch: (name, value) => appended.push([name, value]) } })
    expect(appended).toEqual([['blink-settings', 'dnsPrefetchingEnabled=false']])
    expect(CHROMIUM_SWITCHES).toHaveLength(1)
  })
})

describe('withTimeout', () => {
  it('resolves with the work and clears its timer', async () => {
    const timers = new ManualTimers()
    await expect(withTimeout(timers, 1000, async () => 'done')).resolves.toBe('done')
    expect(timers.pending).toBe(0)
  })

  it('passes the work’s own error through and clears its timer', async () => {
    const timers = new ManualTimers()
    const failing = withTimeout(timers, 1000, async () => {
      throw new SiteAdapterError('navigate', 'unavailable')
    })
    await expect(failing).rejects.toMatchObject({ stage: 'navigate', errorClass: 'unavailable' })
    expect(timers.pending).toBe(0)
  })

  it('catches work that throws synchronously', async () => {
    const timers = new ManualTimers()
    const work = (() => {
      throw new Error('sync')
    }) as unknown as () => Promise<void>
    await expect(withTimeout(timers, 1000, work)).rejects.toThrow('sync')
  })

  it('rejects with timeout/timed-out and aborts the signal when time runs out', async () => {
    const timers = new ManualTimers()
    let signal: AbortSignal | null = null
    const hanging = withTimeout(timers, 1000, (s) => {
      signal = s
      return new Promise<void>(() => {})
    })
    const outcome = hanging.catch((error: unknown) => error)
    await timers.advance(999)
    expect(signal!.aborted).toBe(false)
    await timers.advance(1)
    expect(await outcome).toMatchObject({ stage: 'timeout', errorClass: 'timed-out' })
    expect(signal!.aborted).toBe(true)
  })
})

describe('sleep', () => {
  it('waits on the injected timers', async () => {
    const timers = new ManualTimers()
    let woke = false
    void sleep(timers, 50).then(() => (woke = true))
    await timers.advance(49)
    expect(woke).toBe(false)
    await timers.advance(1)
    expect(woke).toBe(true)
    expect(timers.requested).toEqual([50])
  })
})
