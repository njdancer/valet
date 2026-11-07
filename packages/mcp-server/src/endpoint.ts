// The local endpoint as the app runs it: one listener on 127.0.0.1 and a token per client (D42).
// Each client has its own bridge config file (mode 0600) holding the endpoint URL and that client's
// token; the stdio bridge it launches reads that file and follows changes to it on its own.
//
// The files also carry the port from one launch to the next. By default every token is new at each
// launch: a token someone collected while the app was down (by listening on the saved port and
// waiting for a client to connect) stops working at the next launch. Keeping tokens until the
// person resets them is an opt-in, for HTTP clients that store the token themselves.

import { rm } from 'node:fs/promises'
import { ValetError } from '@valet/core'
import { isClientId } from './auth'
import { type BridgeConfig, readBridgeConfig, writeBridgeConfig } from './bridge-config'
import { type HttpServerOptions, type LiveSessions, type RunningHttpServer, startHttpServer } from './http'
import { ClientTokens, localAuthenticator } from './local-auth'
import { generateToken } from './token'
import type { SkippedTool } from './tool-names'

/** A client the person has added: the app's id for it, and where its bridge config file goes. */
export interface EndpointClient {
  readonly id: string
  readonly configPath: string
}

export interface EndpointOptions extends Omit<HttpServerOptions, 'authenticate' | 'port' | 'host'> {
  /** The clients to issue tokens to at start. Ids must be distinct and match CLIENT_ID_PATTERN. */
  readonly clients: readonly EndpointClient[]
  /** Listen on the port the clients' files name, when it is free. Default true; false picks any free port. */
  readonly stablePort?: boolean
  /**
   * 'every-launch' (the default) makes new tokens at each start. 'on-reset' keeps each client's
   * token from its file until resetClient(), so HTTP clients that store it keep working across
   * launches, at the cost of a collected token staying valid until the person resets it.
   */
  readonly tokenRotation?: 'on-reset' | 'every-launch'
  readonly generateToken?: () => string
  /** Injected so tests can see which port is asked for. */
  readonly start?: (options: HttpServerOptions) => Promise<RunningHttpServer>
}

export interface RunningEndpoint {
  readonly url: string
  readonly port: number
  refresh(): readonly SkippedTool[]
  /**
   * Issues a token to a new client and writes its config file. A client that already has one is
   * reset instead. Throws ValetError('config', 'invalid') for a malformed id, or 'unavailable' when
   * the file can't be written, and then nothing changes.
   */
  addClient(client: EndpointClient): Promise<void>
  /**
   * "Reset access": makes the client a new token, writes it to its file, then switches the
   * endpoint to it and closes that client's sessions. Other clients are untouched. If the file
   * can't be written, nothing changes and this throws; an unknown client is ValetError('config',
   * 'not-found').
   */
  resetClient(clientId: string): Promise<void>
  /** Withdraws the client's token, closes its sessions and deletes its file. Unknown ids are ignored. */
  removeClient(clientId: string): Promise<void>
  /** The clients holding a token now. */
  clientIds(): readonly string[]
  close(): Promise<void>
}

/**
 * What startEndpoint returns: a RunningEndpoint that also reports its sessions. Kept apart so that
 * code (and fakes) typed against RunningEndpoint keep working.
 */
export interface SessionReportingEndpoint extends RunningEndpoint {
  /** The sessions open now, which client each belongs to, and how each one arrived. */
  sessions(): LiveSessions
}

export async function startEndpoint(options: EndpointOptions): Promise<SessionReportingEndpoint> {
  const {
    clients,
    stablePort = true,
    tokenRotation = 'every-launch',
    generateToken: newToken = generateToken,
    start = startHttpServer,
    ...http
  } = options
  const paths = new Map<string, string>()
  for (const client of clients) {
    if (!isClientId(client.id) || paths.has(client.id)) throw new ValetError('config', 'invalid')
    paths.set(client.id, client.configPath)
  }

  // Any problem with a client's old file, including one others could read, means its token isn't
  // reused: it may have leaked. Every file is rewritten below.
  const previous = new Map<string, BridgeConfig>()
  for (const [id, path] of paths) {
    const config = await readBridgeConfig(path).catch(() => null)
    if (config !== null) previous.set(id, config)
  }
  const first = [...previous.values()][0]
  const savedPort = stablePort && first !== undefined ? Number(new URL(first.url).port) : 0

  // ClientTokens keeps only hashes; the tokens chosen at start are held here until written.
  const tokens = new ClientTokens()
  const chosen = new Map<string, string>()
  const issueAll = (keep: boolean): void => {
    for (const id of paths.keys()) {
      const kept = keep ? previous.get(id)?.token : undefined
      let token = kept ?? newToken()
      try {
        tokens.set(id, token)
      } catch {
        // A kept token another client's file also holds (a copied file): it can't name either
        // client, so this one gets a new one.
        token = newToken()
        tokens.set(id, token)
      }
      chosen.set(id, token)
    }
  }
  issueAll(tokenRotation === 'on-reset')

  const authenticate = localAuthenticator(tokens)
  let server: RunningHttpServer
  try {
    server = await start({ ...http, authenticate, port: savedPort })
  } catch (error) {
    if (savedPort === 0) throw error
    // Something else holds the port clients are configured for, and a client that connects there
    // hands it its token. Move to a free port with new tokens, which the old ones can't stand for.
    issueAll(false)
    server = await start({ ...http, authenticate, port: 0 })
  }
  const running = server

  // Tokens never leave this module except into the clients' own files.
  const write = (path: string, token: string): Promise<void> =>
    writeBridgeConfig(path, { url: running.url, token })

  try {
    for (const [id, path] of paths) await write(path, chosen.get(id) as string)
  } catch {
    await running.close()
    throw new ValetError('config', 'unavailable')
  }
  chosen.clear()

  // Changes run one at a time, so each file always holds the token the endpoint accepts.
  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => {})
    return run
  }

  const endFor = (clientId: string): Promise<void> =>
    running.endSessions((identity) => identity.origin === 'local' && identity.clientId === clientId)

  const issue = async (clientId: string, path: string): Promise<void> => {
    const next = newToken()
    // The file first: if it can't be written, the client's bridge would be left holding a dead token.
    await write(path, next)
    tokens.set(clientId, next)
    paths.set(clientId, path)
    await endFor(clientId)
  }

  return {
    url: running.url,
    port: running.port,
    refresh: () => running.refresh(),
    addClient: (client) =>
      serially(async () => {
        if (!isClientId(client.id)) throw new ValetError('config', 'invalid')
        await issue(client.id, client.configPath)
      }),
    resetClient: (clientId) =>
      serially(async () => {
        const path = paths.get(clientId)
        if (path === undefined) throw new ValetError('config', 'not-found')
        await issue(clientId, path)
      }),
    removeClient: (clientId) =>
      serially(async () => {
        const path = paths.get(clientId)
        if (path === undefined) return
        // Refuse the token before anything else, then end what it opened.
        tokens.delete(clientId)
        paths.delete(clientId)
        await endFor(clientId)
        await rm(path, { force: true }).catch(() => {})
      }),
    clientIds: () => tokens.ids(),
    sessions: () => running.sessions(),
    close: () => running.close(),
  }
}
