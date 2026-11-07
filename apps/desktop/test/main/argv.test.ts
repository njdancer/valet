// @vitest-environment node
// The packaged app's command-line and environment check, and that it runs before anything else.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWED_ENV, classifyArgv, refusedEnv } from '../../src/main/core/argv'
import { SMOKE_ARGV } from '../../src/main/core/smoke'

const EXE = '/Applications/Valet.app/Contents/MacOS/Valet'
const MAIN = resolve(import.meta.dirname, '../../src/main')

describe('classifyArgv', () => {
  it('takes the executable alone, and macOS’s process-serial argument', () => {
    expect(classifyArgv([EXE])).toEqual({ mode: 'app' })
    expect(classifyArgv([EXE, '-psn_0_1234567'])).toEqual({ mode: 'app' })
  })

  it('takes bridge mode with one absolute path only', () => {
    expect(classifyArgv([EXE, '--mcp-bridge', '/Users/me/bridge.json'])).toEqual({
      mode: 'bridge',
      config: '/Users/me/bridge.json',
    })
  })

  it('refuses every switch in the table, in any spelling', () => {
    for (const rest of [
      ['--remote-debugging-port=9222'],
      ['--remote-debugging-port', '9222'],
      ['-remote-debugging-port=9222'],
      ['--remote-debugging-pipe'],
      ['--host-resolver-rules=MAP * 127.0.0.1'],
      ['--host-rules=MAP * 127.0.0.1', '--ignore-certificate-errors'],
      ['--proxy-server=127.0.0.1:8080'],
      ['--proxy-pac-url=http://127.0.0.1/p.pac'],
      ['--js-flags=--allow-natives-syntax'],
      ['--user-data-dir=/tmp/x'],
      ['--inspect=9229'],
      ['--inspect-brk'],
      ['--REMOTE-DEBUGGING-PORT=9222'],
    ])
      expect(classifyArgv([EXE, ...rest]), rest.join(' ')).toEqual({ mode: 'refuse' })
  })

  it('refuses any other shape of bridge mode', () => {
    for (const rest of [
      ['--mcp-bridge'],
      ['--mcp-bridge=/Users/me/bridge.json'],
      ['--mcp-bridge', 'bridge.json'],
      ['--mcp-bridge', '-/x'],
      ['--mcp-bridge', '--remote-debugging-port=9222'],
      ['--MCP-BRIDGE', '/Users/me/bridge.json'],
      ['--mcp-bridge', '--mcp-bridge', '/Users/me/bridge.json'],
      ['--mcp-bridge', '/Users/me/bridge.json', '--remote-debugging-port=9222'],
      ['--remote-debugging-port=9222', '--mcp-bridge', '/Users/me/bridge.json'],
      ['--mcp-bridge', '/Users/me/bridge\0.json'],
      ['--mcp-bridge', '/Users/me/bridge\n.json'],
      ['--mcp-bridge', ''],
    ])
      expect(classifyArgv([EXE, ...rest]), JSON.stringify(rest)).toEqual({ mode: 'refuse' })
  })

  it('refuses an empty argument, a bare --, a near process-serial argument and an empty argv', () => {
    expect(classifyArgv([EXE, ''])).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, '--'])).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, '-psn_0_123', '-psn_0_123'])).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, '-psn_0_123x'])).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, '--psn_0_123'])).toEqual({ mode: 'refuse' })
    expect(classifyArgv([])).toEqual({ mode: 'refuse' })
  })

  it('takes a smoke build’s own argv exactly, and only when given', () => {
    expect(classifyArgv([EXE, ...SMOKE_ARGV])).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, ...SMOKE_ARGV], SMOKE_ARGV)).toEqual({ mode: 'app' })
    expect(classifyArgv([EXE, ...SMOKE_ARGV.slice(1)], SMOKE_ARGV)).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, ...SMOKE_ARGV, '--proxy-server=x'], SMOKE_ARGV)).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE, ...[...SMOKE_ARGV].reverse()], SMOKE_ARGV)).toEqual({ mode: 'refuse' })
    expect(classifyArgv([EXE], SMOKE_ARGV)).toEqual({ mode: 'app' })
    expect(classifyArgv([EXE, ''], [])).toEqual({ mode: 'refuse' })
  })
})

describe('refusedEnv', () => {
  it('refuses ELECTRON_* and NODE_* names outside the reviewed list', () => {
    expect(
      refusedEnv({
        HOME: '/Users/me',
        PATH: '/usr/bin',
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
        NODE_OPTIONS: '--require x',
        node_tls_reject_unauthorized: '0',
        NODE_USE_SYSTEM_CA: '1',
        NODEJS: 'x',
      }),
    ).toEqual([
      'ELECTRON_ENABLE_LOGGING',
      'ELECTRON_RUN_AS_NODE',
      'NODE_EXTRA_CA_CERTS',
      'NODE_OPTIONS',
      'node_tls_reject_unauthorized',
    ])
    expect(refusedEnv({ HOME: '/Users/me', NODE_USE_SYSTEM_CA: '1' })).toEqual([])
    expect(ALLOWED_ENV).toEqual(['NODE_USE_SYSTEM_CA'])
  })
})

describe('the check comes first', () => {
  it('is main’s first statement, and the app starts nothing in a refused launch', () => {
    const statements = readFileSync(resolve(MAIN, 'index.ts'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('//'))
    expect(statements[0]).toBe("import './electron/guard'")
    const guard = readFileSync(resolve(MAIN, 'electron/guard.ts'), 'utf8')
    expect(guard).toContain('if (launchRefused) process.exit(64)')
    const app = readFileSync(resolve(MAIN, 'electron/app.ts'), 'utf8')
    expect(app).toContain("import { launchRefused } from './guard'")
    expect(app.trimEnd().endsWith('if (!launchRefused) start()')).toBe(true)
    // Nothing in app.ts acts at the top level before that line but pure declarations.
    expect(app).not.toMatch(/^app\./m)
    expect(app).not.toMatch(/^protocol\./m)
    expect(app).not.toMatch(/^hardenProcess/m)
  })
})
