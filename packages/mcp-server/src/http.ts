// The local MCP endpoint: Streamable HTTP on 127.0.0.1, one MCP server per client session. Every
// request must pass the Host, Origin and bearer-token checks before the SDK sees it.

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SiteAdapterError, toReportable } from '@siteadapter/core'
import { bearerAuthorized, hostAllowed, originAllowed } from './http-guards'
import { createMcpServer, type ServerInfo, type SiteAdapterMcpServer } from './server'
import { isWellFormedToken } from './token'
import type { ToolCaller } from './tool-caller'
import { planTools, type SkippedTool, type ToolPlan } from './tool-names'

export const MCP_PATH = '/mcp'
const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_SESSIONS = 32

export interface HttpServerOptions {
  readonly caller: ToolCaller
  /** From generateToken(). Anything else is refused, so a blank token can't open the endpoint. */
  readonly token: string
  /** 0, the default, picks a free port. */
  readonly port?: number
  readonly info?: ServerInfo
  readonly newCallId?: () => string
  readonly newSessionId?: () => string
  /** Sessions kept at once. Beyond it, the least recently used session is closed. */
  readonly maxSessions?: number
}

export interface RunningHttpServer {
  readonly url: string
  readonly port: number
  /**
   * Re-reads the caller's tools once, gives every session that same list and tells each client it
   * changed. Returns the tools that were withheld and why. If the caller can't list its tools,
   * throws SiteAdapterError and every session keeps the tools it had.
   */
  refresh(): readonly SkippedTool[]
  close(): Promise<void>
}

interface Session {
  readonly endpoint: SiteAdapterMcpServer
  readonly transport: StreamableHTTPServerTransport
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  if (!isWellFormedToken(options.token)) throw new SiteAdapterError('credential', 'invalid')
  const info = options.info ?? { name: 'siteadapter', version: '0.0.0' }
  const newSessionId = options.newSessionId ?? randomUUID
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  // Map order is use order: a session is moved to the end each time it is used.
  const sessions = new Map<string, Session>()
  let port = 0

  const closeSession = (id: string): Promise<void> => {
    const session = sessions.get(id)
    sessions.delete(id)
    return session === undefined ? Promise.resolve() : session.endpoint.server.close()
  }

  const openSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const endpoint = createMcpServer(options.caller, info, {
      ...(options.newCallId === undefined ? {} : { newCallId: options.newCallId }),
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: newSessionId,
      maxRequestBodySize: MAX_BODY_BYTES,
      onsessioninitialized: (id) => {
        sessions.set(id, { endpoint, transport })
        for (const oldest of sessions.keys()) {
          if (sessions.size <= maxSessions) break
          void closeSession(oldest)
        }
      },
    })
    endpoint.server.server.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
    }
    await endpoint.server.connect(transport)
    await transport.handleRequest(req, res)
    // Anything but a successful initialize leaves no session behind.
    if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) {
      await endpoint.server.close()
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostAllowed(req.headers.host, port) || !originAllowed(req.headers.origin)) {
      return reject(res, 403, 'Forbidden')
    }
    if (!bearerAuthorized(req.headers.authorization, options.token)) {
      return reject(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' })
    }
    if ((req.url ?? '').split('?')[0] !== MCP_PATH) return reject(res, 404, 'Not found')
    const sessionId = req.headers['mcp-session-id']
    if (sessionId === undefined) {
      if (req.method !== 'POST') return reject(res, 400, 'Bad request: no session')
      return openSession(req, res)
    }
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (session === undefined || typeof sessionId !== 'string') return reject(res, 404, 'Session not found')
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
    server.once('error', reject)
    server.listen({ port: options.port ?? 0, host: '127.0.0.1' }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    port,
    refresh() {
      let plan: ToolPlan
      try {
        plan = planTools(options.caller.listTools())
      } catch (error) {
        // All or nothing: a session left on the old list could keep offering a revoked tool.
        const { stage, errorClass } = toReportable(error, 'tool-run')
        throw new SiteAdapterError(stage, errorClass)
      }
      for (const session of sessions.values()) session.endpoint.apply(plan)
      return plan.skipped
    },
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
