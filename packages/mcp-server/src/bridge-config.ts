// The file the app writes for the stdio bridge: where the endpoint is and its token. The bridge
// sends the token to whatever URL the file names, so only a loopback /mcp URL is accepted.

import { SiteAdapterError } from '@siteadapter/core'
import { z } from 'zod'
import { MCP_PATH } from './http'
import { readPrivateFile, writePrivateFile } from './private-file'
import { isWellFormedToken } from './token'

export interface BridgeConfig {
  readonly url: string
  readonly token: string
}

const configSchema = z
  .object({
    url: z.string().refine(isLoopbackEndpoint),
    token: z.string().refine(isWellFormedToken),
  })
  .strict()

/** True for http://127.0.0.1:<port>/mcp or http://localhost:<port>/mcp and nothing else. */
export function isLoopbackEndpoint(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    parsed.port !== '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === MCP_PATH &&
    parsed.search === '' &&
    parsed.hash === ''
  )
}

export async function writeBridgeConfig(path: string, config: BridgeConfig): Promise<void> {
  const parsed = configSchema.safeParse(config)
  if (!parsed.success) throw new SiteAdapterError('credential', 'invalid')
  await writePrivateFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`)
}

/** Throws SiteAdapterError('credential', 'not-found' | 'invalid'). */
export async function readBridgeConfig(path: string): Promise<BridgeConfig> {
  const text = await readPrivateFile(path)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new SiteAdapterError('credential', 'invalid')
  }
  const parsed = configSchema.safeParse(json)
  if (!parsed.success) throw new SiteAdapterError('credential', 'invalid')
  return parsed.data
}
