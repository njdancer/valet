// The endpoint as the app runs it. The bridge config file carries its port and token from one launch
// to the next, so a client registered with the HTTP URL and token (Claude Code, say) keeps working
// across restarts, and the token changes only when the person resets it.

import { SiteAdapterError } from '@siteadapter/core'
import { readBridgeConfig, writeBridgeConfig } from './bridge-config'
import { type HttpServerOptions, type RunningHttpServer, startHttpServer } from './http'
import { generateToken } from './token'
import type { SkippedTool } from './tool-names'

export interface EndpointOptions extends Omit<HttpServerOptions, 'token' | 'port'> {
  /** The bridge config file (mode 0600). It is also where the port and token are kept. */
  readonly configPath: string
  /** Listen on the port the config file names, when it is free. Default true; false picks any free port. */
  readonly stablePort?: boolean
  /**
   * 'on-reset' (the default) keeps the config file's token until resetToken(). 'every-launch'
   * makes a new one at each start, so HTTP clients must be given it again each time.
   */
  readonly tokenRotation?: 'on-reset' | 'every-launch'
  readonly generateToken?: () => string
  /** Injected so tests can see which port is asked for. */
  readonly start?: (options: HttpServerOptions) => Promise<RunningHttpServer>
}

export interface RunningEndpoint {
  readonly url: string
  readonly port: number
  /** The token clients must present, for the app to show the person when they connect a client. */
  readonly token: string
  refresh(): readonly SkippedTool[]
  /**
   * Makes a new token, writes it to the config file, then switches the endpoint to it and closes
   * every session. If the file can't be written, nothing changes and this throws.
   */
  resetToken(): Promise<void>
  close(): Promise<void>
}

export async function startEndpoint(options: EndpointOptions): Promise<RunningEndpoint> {
  const {
    configPath,
    stablePort = true,
    tokenRotation = 'on-reset',
    generateToken: newToken = generateToken,
    start = startHttpServer,
    ...http
  } = options
  // Any problem with the old file, including one others could read, means its token isn't reused:
  // it may have leaked. The file is rewritten below.
  const previous = await readBridgeConfig(configPath).catch(() => null)
  let token = tokenRotation === 'on-reset' && previous !== null ? previous.token : newToken()
  const savedPort = stablePort && previous !== null ? Number(new URL(previous.url).port) : 0

  let server: RunningHttpServer
  try {
    server = await start({ ...http, token, port: savedPort })
  } catch (error) {
    if (savedPort === 0) throw error
    // Something else holds the port clients are configured for, and a client that connects there
    // hands it the token. Move to a free port with a new token, which the old one can't stand for.
    token = newToken()
    server = await start({ ...http, token, port: 0 })
  }

  try {
    await writeBridgeConfig(configPath, { url: server.url, token })
  } catch {
    await server.close()
    throw new SiteAdapterError('config', 'unavailable')
  }

  return {
    url: server.url,
    port: server.port,
    get token() {
      return token
    },
    refresh: () => server.refresh(),
    async resetToken() {
      const next = newToken()
      // The file first: if it can't be written, the bridge would be left holding a dead token.
      await writeBridgeConfig(configPath, { url: server.url, token: next })
      token = next
      await server.setToken(next)
    },
    close: () => server.close(),
  }
}
