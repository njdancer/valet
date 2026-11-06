import { NEEDS_USER_REASONS, SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { needsUserTitle } from '../src/needs-user'
import { partitionName } from '../src/partitions'
import { sleep } from '../src/platform'
import { CHROMIUM_SWITCHES, hardenProcess } from '../src/process-hardening'
import { withTimeout } from '../src/timeout'
import { chromeUserAgentOverride, cleanChromeUserAgent, LANGUAGES } from '../src/user-agent'
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

describe('LANGUAGES', () => {
  it('is en-AU then en, codes only: Chromium adds the weights itself', () => {
    expect(LANGUAGES).toBe('en-AU,en')
    expect(LANGUAGES).not.toContain(';q=')
  })
})

const MAC_ARM = { chromeVersion: '152.0.7977.169', os: 'darwin', systemVersion: '27.2.0', arch: 'arm64' }

describe('chromeUserAgentOverride', () => {
  it('restates exactly what Electron 44’s Chromium 152 reports by default, with the clean UA and en-AU', () => {
    // The engine's own answer, as the e2e suite read it from a page with no override at all.
    expect(chromeUserAgentOverride(MAC_ARM, 'engine')).toEqual({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      acceptLanguage: 'en-AU,en',
      platform: 'MacIntel',
      userAgentMetadata: {
        brands: [
          { brand: 'Not?A_Brand', version: '24' },
          { brand: 'Chromium', version: '152' },
        ],
        fullVersionList: [
          { brand: 'Not?A_Brand', version: '24.0.0.0' },
          { brand: 'Chromium', version: '152.0.7977.169' },
        ],
        platform: 'macOS',
        platformVersion: '27.2.0',
        architecture: 'arm',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
        formFactors: ['Desktop'],
      },
    })
  })

  it('never names Google Chrome unless asked', () => {
    for (const version of ['140.0.1.1', '141.0.1.1', '152.0.1.1', '153.0.1.1']) {
      const override = chromeUserAgentOverride({ ...MAC_ARM, chromeVersion: version }, 'engine')
      expect(JSON.stringify(override.userAgentMetadata), version).not.toContain('Google Chrome')
    }
  })

  it('names Google Chrome and Chromium at the real version, beside a GREASE brand, when asked', () => {
    const override = chromeUserAgentOverride(MAC_ARM, 'chrome')
    expect(override.userAgent).toBe(cleanChromeUserAgent('152.0.7977.169', 'darwin'))
    expect(override.acceptLanguage).toBe(LANGUAGES)
    const brands = override.userAgentMetadata.brands
    expect(brands).toHaveLength(3)
    expect(brands).toEqual(
      expect.arrayContaining([
        { brand: 'Google Chrome', version: '152' },
        { brand: 'Chromium', version: '152' },
        { brand: 'Not?A_Brand', version: '24' },
      ]),
    )
    expect(override.userAgentMetadata.fullVersionList).toEqual(
      expect.arrayContaining([{ brand: 'Google Chrome', version: '152.0.7977.169' }]),
    )
  })

  it('describes the machine as it is on other architectures and platforms', () => {
    expect(
      chromeUserAgentOverride({ ...MAC_ARM, arch: 'x64' }, 'engine').userAgentMetadata.architecture,
    ).toBe('x86')
    expect(chromeUserAgentOverride({ ...MAC_ARM, arch: 'ia32' }, 'engine').userAgentMetadata.bitness).toBe(
      '32',
    )
    expect(chromeUserAgentOverride({ ...MAC_ARM, os: 'win32' }, 'engine')).toMatchObject({
      platform: 'Win32',
      userAgentMetadata: { platform: 'Windows' },
    })
    expect(chromeUserAgentOverride({ ...MAC_ARM, os: 'freebsd' }, 'engine')).toMatchObject({
      platform: 'Linux x86_64',
      userAgentMetadata: { platform: 'Linux' },
    })
  })

  it('moves the GREASE brand with the major version, as Chromium does', () => {
    for (const brands of ['engine', 'chrome'] as const) {
      const position = (version: string) =>
        chromeUserAgentOverride(
          { ...MAC_ARM, chromeVersion: version },
          brands,
        ).userAgentMetadata.brands.findIndex((b) => b.brand.startsWith('Not'))
      const positions = new Set(['140.0.1.1', '141.0.1.1', '142.0.1.1', '143.0.1.1'].map(position))
      expect(positions.size, brands).toBeGreaterThan(1)
    }
  })

  it('refuses a version it cannot read', () => {
    expect(() => chromeUserAgentOverride({ ...MAC_ARM, chromeVersion: 'latest' }, 'engine')).toThrow(
      SiteAdapterError,
    )
  })
})

describe('needsUserTitle', () => {
  it('words every reason in the app’s own voice, naming the site', () => {
    for (const reason of NEEDS_USER_REASONS) {
      const title = needsUserTitle(reason, 'Woolworths')
      expect(title, reason).toMatch(/Woolworths/)
      expect(title, reason).toMatch(/Close this window when you’re done\.$/)
    }
    expect(needsUserTitle('captcha', 'Woolworths')).toBe(
      'Woolworths showed a verification check that siteadapter won’t solve for you. Close this window when you’re done.',
    )
  })

  it('gives every reason its own wording', () => {
    const titles = new Set(NEEDS_USER_REASONS.map((reason) => needsUserTitle(reason, 'Site')))
    expect(titles.size).toBe(NEEDS_USER_REASONS.length)
  })

  it('never echoes a reason outside the vocabulary', () => {
    const title = needsUserTitle('Click here: evil.test' as never, 'Woolworths')
    expect(title).toBe(needsUserTitle('other', 'Woolworths'))
    expect(title).not.toContain('evil')
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
