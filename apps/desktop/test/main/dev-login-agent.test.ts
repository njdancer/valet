import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { devLoginAgentFile, devLoginAgentPlist, setDevLoginAgent } from '../../src/main/core/dev-login-agent'

const paths = (home: string) => ({
  home,
  electron: '/Users/me/Code/valet/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  appPath: '/Users/me/Code/valet/apps/desktop',
  logFile: '/Users/me/Library/Logs/Valet/valet-dev-unpackaged.log',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
})

describe('development login agent', () => {
  it('starts the same Electron on the same app folder once at login, never restarting it', () => {
    const plist = devLoginAgentPlist(paths('/Users/me'))
    expect(plist).toContain(
      `<string>${paths('').electron}</string>\n    <string>/Users/me/Code/valet/apps/desktop</string>`,
    )
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/)
    expect(plist).toContain('<string>/Users/me/Library/Logs/Valet/valet-dev-unpackaged.log</string>')
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>')
  })

  it('escapes paths for XML', () => {
    const plist = devLoginAgentPlist({ ...paths('/Users/me'), appPath: '/Users/me/A & <B>' })
    expect(plist).toContain('/Users/me/A &amp; &lt;B&gt;')
  })

  it('writes the agent when turned on and removes it when turned off', async () => {
    const home = mkdtempSync(join(tmpdir(), 'valet-login-'))
    const file = devLoginAgentFile(home)
    await setDevLoginAgent(true, paths(home))
    expect(readFileSync(file, 'utf8')).toContain('me.dncr.valet.dev.login')
    await setDevLoginAgent(false, paths(home))
    expect(existsSync(file)).toBe(false)
    await setDevLoginAgent(false, paths(home))
  })
})
