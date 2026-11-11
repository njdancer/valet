import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { addToDesktopConfig, mergeDesktopConfig } from '../../src/main/core/claude-desktop'

const BRIDGE = { command: '/Applications/Valet.app/bridge', args: ['--config', '/x/c_1.json'] }
const ENTRY = { command: BRIDGE.command, args: BRIDGE.args }
const NOW = Date.parse('2026-11-11T10:55:00.123Z')

function where(): string {
  return join(mkdtempSync(join(tmpdir(), 'valet-desktop-')), 'Claude', 'claude_desktop_config.json')
}

describe('mergeDesktopConfig', () => {
  it('starts a config from nothing, or from an empty file', () => {
    expect(mergeDesktopConfig(null, 'valet', BRIDGE)).toEqual({
      config: { mcpServers: { valet: ENTRY } },
      replaced: false,
    })
    expect(mergeDesktopConfig('  \n', 'valet', BRIDGE).config).toEqual({ mcpServers: { valet: ENTRY } })
  })

  it('keeps every other key and server, and replaces only its own entry', () => {
    const existing = JSON.stringify({
      globalShortcut: 'Cmd+Space',
      mcpServers: { files: { command: 'npx', args: ['files'] }, valet: { command: 'old', args: [] } },
    })
    expect(mergeDesktopConfig(existing, 'valet', BRIDGE)).toEqual({
      config: {
        globalShortcut: 'Cmd+Space',
        mcpServers: { files: { command: 'npx', args: ['files'] }, valet: ENTRY },
      },
      replaced: true,
    })
  })

  it('refuses a file it can’t read as a JSON object, rather than lose what is in it', () => {
    for (const text of ['{ "mcpServers": ', '[]', '"x"', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      expect(() => mergeDesktopConfig(text, 'valet', BRIDGE)).toThrow(ValetError)
    }
  })
})

describe('addToDesktopConfig', () => {
  it('creates the file and its folder when Claude Desktop has none yet', async () => {
    const path = where()
    expect(await addToDesktopConfig(path, 'valet', BRIDGE, NOW)).toEqual({ backup: null, replaced: false })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { valet: ENTRY } })
  })

  it('copies the old file beside it first, and keeps its mode', async () => {
    const path = where()
    mkdirSync(join(path, '..'), { recursive: true })
    const old = '{"mcpServers":{"files":{"command":"npx","args":[]}}}'
    writeFileSync(path, old, { mode: 0o600 })
    const result = await addToDesktopConfig(path, 'valet', BRIDGE, NOW)
    expect(result).toEqual({ backup: `${path}.valet-backup-20261111T105500Z`, replaced: false })
    expect(readFileSync(result.backup as string, 'utf8')).toBe(old)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers)).toEqual(['files', 'valet'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('leaves an unreadable file exactly as it was, with no backup or stray file', async () => {
    const path = where()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{ broken')
    await expect(addToDesktopConfig(path, 'valet', BRIDGE, NOW)).rejects.toThrow(ValetError)
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
    expect(readdirSync(join(path, '..'))).toEqual(['claude_desktop_config.json'])
  })
})
