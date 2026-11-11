// "Add to Claude Desktop" (D-connect): puts Valet's bridge entry into Claude Desktop's own config
// file, so the person doesn't hand-merge JSON. The entry holds no token (the bridge reads its
// client's 0600 file), so the config stays as un-secret as it was.
//
// What it never does: rewrite a file it can't read as a JSON object (the person's other servers
// would be lost), or change anything but its own one entry. The old file is copied beside it first.

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ValetError } from '@valet/core'
import type { BridgeCommand } from './snippets'

export interface DesktopConfigResult {
  /** Where the old file was copied, or null when there was none. */
  readonly backup: string | null
  /** True when an entry of this name was already there and has been replaced. */
  readonly replaced: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The config with this server's entry set, and every other key as it was. Throws
 * ValetError('config', 'invalid') for text that isn't a JSON object with an object mcpServers.
 */
export function mergeDesktopConfig(
  existing: string | null,
  serverName: string,
  bridge: BridgeCommand,
): { readonly config: Record<string, unknown>; readonly replaced: boolean } {
  let config: unknown = {}
  if (existing !== null && existing.trim() !== '') {
    try {
      config = JSON.parse(existing)
    } catch {
      throw new ValetError('config', 'invalid')
    }
  }
  if (!isPlainObject(config)) throw new ValetError('config', 'invalid')
  const servers = config['mcpServers'] ?? {}
  if (!isPlainObject(servers)) throw new ValetError('config', 'invalid')
  const replaced = Object.hasOwn(servers, serverName)
  return {
    config: {
      ...config,
      mcpServers: { ...servers, [serverName]: { command: bridge.command, args: [...bridge.args] } },
    },
    replaced,
  }
}

/** A file-name-safe stamp, e.g. 20261111T105500Z. */
function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

/** Merges the entry into the file at `path`, backing the old file up beside it first. */
export async function addToDesktopConfig(
  path: string,
  serverName: string,
  bridge: BridgeCommand,
  now: number,
): Promise<DesktopConfigResult> {
  let existing: string | null = null
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ValetError('config', 'unavailable')
  }
  const { config, replaced } = mergeDesktopConfig(existing, serverName, bridge)

  let backup: string | null = null
  let mode = 0o644
  try {
    await mkdir(dirname(path), { recursive: true })
    if (existing !== null) {
      mode = (await stat(path)).mode & 0o777
      backup = `${path}.valet-backup-${stamp(now)}`
      await copyFile(path, backup)
    }
  } catch {
    throw new ValetError('config', 'unavailable')
  }

  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'wx', mode)
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch {
    await rm(temp, { force: true })
    throw new ValetError('config', 'unavailable')
  }
  return { backup, replaced }
}
