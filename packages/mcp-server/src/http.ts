// The MCP endpoint's HTTP handler: Streamable HTTP, one MCP server per client session. Every
// request must pass the listener's authenticate hook before the SDK sees it, and a session answers
// only the client that opened it. The local listener binds 127.0.0.1 with localAuthenticator; a
// remote listener (after M3) runs this same handler with its own hook (D41).

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toReportable, ValetError } from '@valet/core'
import { type Authenticate, type AuthResult, type ClientIdentity, sameIdentity } from './auth'
import { clientLabel, createMcpServer, type ServerInfo, type ValetMcpServer } from './server'
import type { ClientTransport, ToolCaller } from './tool-caller'
import { planTools, type SkippedTool, type ToolPlan } from './tool-names'
import { TRANSPORT_HEADER, transportFrom } from './transport-label'

export const MCP_PATH = '/mcp'
const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_SESSIONS = 32

export interface HttpServerOptions {
  readonly caller: ToolCaller
  /** Names the client behind each request, or refuses it. localAuthenticator() for this Mac. */
  readonly authenticate: Authenticate
  /** The IPv4 address to bind. Default 127.0.0.1; the local listener must never bind anything else. */
  readonly host?: string
  /**
   * 0, the default, picks a free port. Any other port must be free: if it isn't, startHttpServer
   * fails rather than move, because clients configured for it would not follow. startEndpoint
   * handles the fallback.
   */
  readonly port?: number
  readonly info?: ServerInfo
  readonly newCallId?: () => string
  readonly newSessionId?: () => string
  /** How often a running call reports progress to a client that asked. See ServerOptions. */
  readonly progressIntervalMs?: number
  /** Sessions kept at once. Beyond it, the least recently used session is closed. */
  readonly maxSessions?: number
  /**
   * Called with the live sessions whenever one opens, finishes initializing, or closes. Must not
   * throw; if it does, the error is ignored.
   */
  readonly onSessionsChanged?: (sessions: LiveSessions) => void
}

/** One open session, as the app shows it. Never its id, which a request could use with the token. */
export interface LiveSession {
  /** The client the session's credential names. */
  readonly identity: ClientIdentity
  readonly transport: ClientTransport
  /** The client's self-reported name from initialize, flattened and capped; 'unknown' until known. */
  readonly client: string
}

export interface LiveSessions {
  readonly total: number
  readonly bridge: number
  readonly http: number
  /** Least recently used first. */
  readonly sessions: readonly LiveSession[]
}

export interface RunningHttpServer {
  readonly url: string
  readonly port: number
  /**
   * Re-reads the caller's tools once, gives every session that same list and tells each client it
   * changed. Returns the tools that were withheld and why. If the caller can't list its tools,
   * throws ValetError and every session keeps the tools it had.
   */
  refresh(): readonly SkippedTool[]
  /**
   * Closes every session whose client matches, so nothing opened with a credential that has been
   * withdrawn outlives it. Call it after the authenticate hook stops accepting that credential.
   */
  endSessions(match: (identity: ClientIdentity) => boolean): Promise<void>
  /** The sessions open now, and how each one arrived. */
  sessions(): LiveSessions
  close(): Promise<void>
}

interface Session {
  readonly endpoint: ValetMcpServer
  readonly transport: StreamableHTTPServerTransport
  readonly via: ClientTransport
  readonly identity: ClientIdentity
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const info = options.info ?? { name: 'valet', version: '0.0.0' }
  const newSessionId = options.newSessionId ?? randomUUID
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  // Map order is use order: a session is moved to the end each time it is used.
  const sessions = new Map<string, Session>()
  let port = 0

  const live = (): LiveSessions => {
    const list = [...sessions.values()].map(
      (session): LiveSession => ({
        identity: session.identity,
        transport: session.via,
        client: clientLabel(session.endpoint.server.server.getClientVersion()?.name),
      }),
    )
    const bridge = list.filter((session) => session.transport === 'stdio-bridge').length
    return { total: list.length, bridge, http: list.length - bridge, sessions: list }
  }
  const changed = (): void => {
    try {
      options.onSessionsChanged?.(live())
    } catch {
      // The app's listener is not ours to fail.
    }
  }

  const closeSession = (id: string): Promise<void> => {
    const session = sessions.get(id)
    sessions.delete(id)
    if (session === undefined) return Promise.resolve()
    changed()
    return session.endpoint.server.close()
  }

  const openSession = async (
    req: IncomingMessage,
    res: ServerResponse,
    identity: ClientIdentity,
  ): Promise<void> => {
    const via = transportFrom(req.headers[TRANSPORT_HEADER])
    const endpoint = createMcpServer(options.caller, info, {
      ...(options.newCallId === undefined ? {} : { newCallId: options.newCallId }),
      ...(options.progressIntervalMs === undefined ? {} : { progressIntervalMs: options.progressIntervalMs }),
      transport: via,
      identity,
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: newSessionId,
      maxRequestBodySize: MAX_BODY_BYTES,
      onsessioninitialized: (id) => {
        sessions.set(id, { endpoint, transport, via, identity })
        for (const oldest of sessions.keys()) {
          if (sessions.size <= maxSessions) break
          void closeSession(oldest)
        }
        changed()
      },
    })
    endpoint.server.server.onclose = () => {
      if (transport.sessionId !== undefined && sessions.delete(transport.sessionId)) changed()
    }
    // The client's name is known from here on.
    endpoint.server.server.oninitialized = changed
    await endpoint.server.connect(transport)
    await transport.handleRequest(req, res)
    // Anything but a successful initialize leaves no session behind.
    if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) {
      await endpoint.server.close()
    }
  }

  const authenticated = async (req: IncomingMessage): Promise<AuthResult> => {
    try {
      return await options.authenticate(req, { port })
    } catch {
      // A hook that throws lets nothing through; route's catch answers 500.
      throw new ValetError('config', 'unavailable')
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const auth = await authenticated(req)
    if (!auth.ok) {
      return reject(res, auth.status, auth.status === 403 ? 'Forbidden' : 'Unauthorized', auth.headers)
    }
    if ((req.url ?? '').split('?')[0] !== MCP_PATH) return reject(res, 404, 'Not found')
    const sessionId = req.headers['mcp-session-id']
    if (sessionId === undefined) {
      if (req.method !== 'POST') return reject(res, 400, 'Bad request: no session')
      return openSession(req, res, auth.identity)
    }
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    // Another client's session answers like one that doesn't exist: a session id is not a credential.
    if (
      session === undefined ||
      typeof sessionId !== 'string' ||
      !sameIdentity(session.identity, auth.identity)
    )
      return reject(res, 404, 'Session not found')
    sessions.delete(sessionId)
    sessions.set(sessionId, session)
    return session.transport.handleRequest(req, res)
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      // Never the exception's message: it can carry request or page content.
      if (!res.headersSent) reject(res, 500, 'Internal error')
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    // Usually EADDRINUSE. Node's message names the address; only the class leaves.
    const failed = (): void => reject(new ValetError('config', 'unavailable'))
    server.once('error', failed)
    server.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' }, () => {
      server.off('error', failed)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}${MCP_PATH}`,
    port,
    refresh() {
      let plan: ToolPlan
      try {
        plan = planTools(options.caller.listTools())
      } catch (error) {
        // All or nothing: a session left on the old list could keep offering a revoked tool.
        const { stage, errorClass } = toReportable(error, 'tool-run')
        throw new ValetError(stage, errorClass)
      }
      for (const session of sessions.values()) session.endpoint.apply(plan)
      return plan.skipped
    },
    async endSessions(match) {
      const ids = [...sessions].filter(([, session]) => match(session.identity)).map(([id]) => id)
      await Promise.all(ids.map(closeSession))
    },
    sessions: live,
    async close() {
      await Promise.all([...sessions.keys()].map(closeSession))
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

function reject(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}
