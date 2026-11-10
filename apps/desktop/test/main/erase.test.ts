// @vitest-environment node
// Reset and uninstall against throwaway folders: what is removed, what a reset keeps, and what is
// refused. Nothing here touches the Keychain, launchd or the real home folder.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appBundlePath,
  type EraseDeps,
  eraseDialog,
  eraseEverything,
  eraseFailedDetail,
  leftoverPaths,
  safeToRemove,
  sweepCommand,
} from '../../src/main/core/erase'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'valet-erase-'))
  dirs.push(root)
  const home = join(root, 'home')
  const dataDir = join(home, 'Library', 'Application Support', 'Valet')
  mkdirSync(join(dataDir, 'traces', 'run-1'), { recursive: true })
  mkdirSync(join(dataDir, 'Partitions', 'auth'), { recursive: true })
  for (const name of [
    'grants.json',
    'audit.jsonl',
    'versions.json',
    'traces/run-1/shot.png',
    'Partitions/auth/Cookies',
  ]) {
    writeFileSync(join(dataDir, name), 'x')
  }
  const helperDir = join(home, 'Library', 'Application Support', 'me.dncr.valet.messages-helper')
  mkdirSync(helperDir, { recursive: true })
  writeFileSync(join(helperDir, 'helper.sock'), '')
  const cache = join(home, 'Library', 'Caches', 'me.dncr.valet')
  mkdirSync(cache, { recursive: true })
  const other = join(home, 'Library', 'Application Support', 'Other App')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'keep.txt'), 'x')
  return { home, dataDir, helperDir, cache, other }
}

function deps(l: ReturnType<typeof layout>, over: Partial<EraseDeps> = {}) {
  const order: string[] = []
  const d: EraseDeps = {
    kind: 'uninstall',
    dataDir: l.dataDir,
    leftovers: [l.helperDir, l.cache],
    stop: async () => {
      order.push('stop')
    },
    eraseCredentials: async () => {
      order.push('credentials')
      // The Keychain goes while the data is still there to try again from.
      expect(existsSync(join(l.dataDir, 'grants.json'))).toBe(true)
      return []
    },
    setLaunchAtLogin: (enabled) => {
      order.push(`login-item ${enabled}`)
    },
    clearBrowserData: async () => {
      order.push('browser-data')
    },
    home: l.home,
    ...over,
  }
  return { d, order }
}

describe('eraseEverything', () => {
  it('uninstall: stops, then removes the Keychain items, the login item, the data folder and the leftovers', async () => {
    const l = layout()
    const { d, order } = deps(l)
    expect(await eraseEverything(d)).toEqual({ kind: 'uninstall', failed: [] })
    expect(order).toEqual(['stop', 'credentials', 'login-item false', 'browser-data'])
    expect(existsSync(l.dataDir)).toBe(false)
    expect(existsSync(l.helperDir)).toBe(false)
    expect(existsSync(l.cache)).toBe(false)
    // Nothing beside Valet's own folders is touched.
    expect(readdirSync(l.other)).toEqual(['keep.txt'])
  })

  it('reset: empties the data folder but keeps the version floor', async () => {
    const l = layout()
    const { d } = deps(l, { kind: 'reset' })
    expect(await eraseEverything(d)).toEqual({ kind: 'reset', failed: [] })
    expect(readdirSync(l.dataDir)).toEqual(['versions.json'])
  })

  it('a data folder that is already gone is not a failure', async () => {
    const l = layout()
    rmSync(l.dataDir, { recursive: true })
    for (const kind of ['reset', 'uninstall'] as const) {
      const report = await eraseEverything(deps(l, { kind, eraseCredentials: async () => [] }).d)
      expect(report.failed).toEqual([])
    }
  })

  it('tries every step whatever failed before it, and reports the failures by name', async () => {
    const l = layout()
    const { d, order } = deps(l, {
      stop: async () => {
        throw new Error('still busy')
      },
      eraseCredentials: async () => ['keychain-copies', 'messages-helper'],
      setLaunchAtLogin: () => {
        throw new Error('no')
      },
      clearBrowserData: async () => {
        throw new Error('no')
      },
    })
    const report = await eraseEverything(d)
    expect([...report.failed].sort()).toEqual(
      ['browser-data', 'keychain-copies', 'login-item', 'messages-helper', 'stop'].sort(),
    )
    expect(order).toEqual([])
    expect(existsSync(l.dataDir)).toBe(false)
    const thrown = await eraseEverything(
      deps(layout(), {
        eraseCredentials: async () => {
          throw new Error('helper gone')
        },
      }).d,
    )
    expect(thrown.failed).toEqual(['keychain-copies'])
  })

  it('refuses to remove a folder that isn’t safely Valet’s, and says so', async () => {
    const l = layout()
    for (const dataDir of [
      l.home,
      join(l.home, '..'),
      '/',
      '/tmp',
      'relative/dir',
      `${l.dataDir}/../Other App`,
    ]) {
      const report = await eraseEverything(deps(l, { dataDir, leftovers: [] }).d)
      expect(report.failed).toEqual(['data'])
    }
    const report = await eraseEverything(deps(l, { leftovers: [l.home, l.cache] }).d)
    expect(report.failed).toEqual(['leftovers'])
    expect(existsSync(l.cache)).toBe(false)
    expect(readdirSync(l.other)).toEqual(['keep.txt'])
  })
})

describe('safeToRemove', () => {
  it('takes only an absolute, normalised path at least three folders deep that isn’t home or above it', () => {
    const home = '/Users/nick'
    expect(safeToRemove('/Users/nick/Library/Application Support/Valet', home)).toBe(true)
    expect(safeToRemove('/tmp/valet-e2e/data', home)).toBe(true)
    for (const path of [
      '/',
      '/Users',
      '/Users/nick',
      '/Users/nick/',
      '/Users/nick/Library',
      '/Users/nick/Library/Caches',
      '/Users/nick/Documents/Work',
      '/tmp/x',
      'Library/Application Support/Valet',
      '/Users/nick/Library/Application Support/Valet/../..',
      '/Users/nick/Library/./Valet/x',
      '/Users/nick/Library/Valet\0/x',
      '',
    ]) {
      expect(safeToRemove(path, home)).toBe(false)
    }
    // Home itself deep enough to pass the depth rule is still refused, as is anything above it.
    expect(safeToRemove('/Volumes/Data/Users/nick', '/Volumes/Data/Users/nick')).toBe(false)
    expect(safeToRemove('/Volumes/Data/Users', '/Volumes/Data/Users/nick')).toBe(false)
  })
})

describe('leftoverPaths', () => {
  it('lists macOS’s folders for Valet’s own bundle ids, and nothing for any other', () => {
    const release = leftoverPaths('me.dncr.valet', '/Users/nick')
    expect(release).toContain('/Users/nick/Library/Caches/me.dncr.valet')
    expect(release).toContain('/Users/nick/Library/Caches/me.dncr.valet.ShipIt')
    expect(release).toContain('/Users/nick/Library/Preferences/me.dncr.valet.plist')
    expect(release.every((p) => safeToRemove(p, '/Users/nick'))).toBe(true)
    expect(
      leftoverPaths('me.dncr.valet.dev', '/Users/nick').every((p) => p.includes('me.dncr.valet.dev')),
    ).toBe(true)
    for (const other of [null, 'com.github.Electron', 'me.dncr.valet.evil/../..', 'me.dncr.valetx', '']) {
      expect(leftoverPaths(other, '/Users/nick')).toEqual([])
    }
  })
})

describe('the last steps', () => {
  it('finds the app bundle of a packaged main process only', () => {
    expect(appBundlePath('/Applications/Valet.app/Contents/MacOS/Valet')).toBe('/Applications/Valet.app')
    expect(appBundlePath('/Users/nick/Applications/Valet Dev.app/Contents/MacOS/Valet Dev')).toBe(
      '/Users/nick/Applications/Valet Dev.app',
    )
    for (const path of [
      '/repo/node_modules/electron/dist/electron',
      '/Applications/Valet.app/Contents/Frameworks/Helper',
      'Valet.app/Contents/MacOS/Valet',
      '/usr/bin/node',
    ]) {
      expect(appBundlePath(path)).toBeNull()
    }
  })

  it('sweeps the data folder after exit with the paths as arguments, never in the script', () => {
    const sweep = sweepCommand(4242, '/Users/nick/Library/Application Support/Valet $(x)', '/Users/nick')
    expect(sweep?.command).toBe('/bin/sh')
    expect(sweep?.args.slice(2)).toEqual([
      'valet-sweep',
      '4242',
      '/Users/nick/Library/Application Support/Valet $(x)',
    ])
    expect(sweep?.args[1]).not.toContain('Valet')
    expect(sweep?.args[1]).toContain('rm -rf -- "$2"')
    expect(sweepCommand(4242, '/Users/nick', '/Users/nick')).toBeNull()
    expect(sweepCommand(1, '/Users/nick/Library/Application Support/Valet', '/Users/nick')).toBeNull()
    expect(
      sweepCommand(Number.NaN, '/Users/nick/Library/Application Support/Valet', '/Users/nick'),
    ).toBeNull()
  })

  it('the sweep script waits for the process, then removes the folder', async () => {
    const l = layout()
    const sweep = sweepCommand(process.pid, l.dataDir, l.home)
    if (sweep === null) throw new Error('no sweep')
    const { spawnSync } = await import('node:child_process')
    // A pid that isn't running stands in for the app having exited.
    const child = spawnSync(process.execPath, ['-e', ''])
    const done = spawnSync(sweep.command, [...sweep.args.slice(0, 3), String(child.pid), l.dataDir])
    expect(done.status).toBe(0)
    expect(existsSync(l.dataDir)).toBe(false)
    expect(readdirSync(l.other)).toEqual(['keep.txt'])
  })

  it('words the dialog for each kind: what goes, that it can’t be undone, and what is left to the person', () => {
    const reset = eraseDialog('reset', { demo: false, serverName: 'valet' })
    expect(reset.message).toBe('Reset Valet?')
    expect(reset.confirm).toBe('Erase and Restart')
    expect(reset.detail).toContain('can’t be undone')
    expect(reset.detail).toContain('claude mcp remove valet')
    const uninstall = eraseDialog('uninstall', { demo: true, serverName: 'valet-demo' })
    expect(uninstall.confirm).toBe('Erase and Uninstall')
    expect(uninstall.detail).toContain('moves itself to the Trash')
    expect(uninstall.detail).toContain('claude mcp remove valet-demo')
    expect(uninstall.detail).toContain('Full Disk Access')
    expect(eraseDialog('reset', { demo: true, serverName: 'valet-demo' }).message).toBe(
      'Reset the Valet demo?',
    )
  })

  it('says what couldn’t be removed, or nothing when all of it was', () => {
    expect(eraseFailedDetail({ kind: 'reset', failed: [] })).toBeNull()
    const detail = eraseFailedDetail({ kind: 'uninstall', failed: ['keychain-copies', 'data'] })
    expect(detail).toContain('Keychain Access')
    expect(detail).toContain('data folder')
    expect(detail).not.toContain('Login Items')
  })
})
