// A stdio-to-HTTP bridge for MCP clients that can only launch a command. It relays JSON-RPC
// messages unchanged in both directions, so the client's own initialize (and its client name) reach
// the endpoint, and adds only the bearer token. Nothing but protocol messages is written to the
// output: for a stdio client, any other byte there is a protocol error.
//
// The endpoint's port and token change when the app restarts, which ends the session under a
// client that is still running. With `reconnect`, the bridge then re-reads where the endpoint is,
// replays the client's initialize into a new session, and tells the client to re-list its tools.

import type { Readable, Writable } from 'node:stream'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  type InitializeRequest,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'

export interface BridgeTarget {
  /** The endpoint URL, e.g. http://127.0.0.1:52011/mcp. */
  readonly url: string
  readonly token: string
}

export interface BridgeOptions extends BridgeTarget {
  /** What the stdio client writes: newline-delimited JSON-RPC. */
  readonly input: Readable
  /** Where the bridge writes for the stdio client. */
  readonly output: Writable
  /** Where the endpoint is now, for reconnecting after the app restarts. Without it, no retry. */
  readonly reconnect?: () => Promise<BridgeTarget>
  /** How long to wait for the endpoint to answer a replayed initialize. */
  readonly reconnectTimeoutMs?: number
  readonly fetch?: FetchLike
}

export interface RunningBridge {
  /** Resolves once the bridge has shut down, after the input ends or close() is called. */
  readonly done: Promise<void>
  close(): Promise<void>
}

/** JSON-RPC's implementation-defined server error range starts here. */
const BRIDGE_ERROR_CODE = -32000
const DEFAULT_RECONNECT_TIMEOUT_MS = 10_000
/** Ids for the bridge's own requests; answers to them are never passed to the client. */
const OWN_ID_PREFIX = 'siteadapter-bridge-'

class ReconnectFailed extends Error {}

export async function runBridge(options: BridgeOptions): Promise<RunningBridge> {
  const local = new StdioServerTransport(options.input, options.output)
  const initializeIds = new Set<RequestId>()
  const ownRequests = new Map<RequestId, (message: JSONRPCMessage) => void>()
  let clientInitialize: (JSONRPCRequest & InitializeRequest) | undefined
  let ownRequestCount = 0
  // Messages go upstream one at a time and in order. A send resolves once the response has started
  // (results stream back over SSE), so a slow tool call doesn't hold up the next message.
  let upstream: Promise<void> = Promise.resolve()
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  let closing: Promise<void> | undefined

  const sendDown = (message: JSONRPCMessage): Promise<void> => local.send(message).catch(() => {})

  const openRemote = (target: BridgeTarget): StreamableHTTPClientTransport => {
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers: { authorization: `Bearer ${target.token}` } },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    transport.onmessage = (message) => {
      if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
        const own = ownRequests.get(message.id)
        if (own !== undefined) return own(message)
      }
      if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
        adoptProtocolVersion(transport, message.result['protocolVersion'])
      }
      void sendDown(message)
    }
    // Failures of the background SSE stream; request failures are answered in relayUp.
    transport.onerror = () => {}
    return transport
  }

  let remote = openRemote(options)

  // Set while the upstream session is not one the client's initialize set up: a reopen that failed
  // part-way leaves a session nothing has initialized, which must not be sent to.
  let stale = false

  /** Starts a new upstream session that looks, to the endpoint, like the client's own. */
  const reopen = async (
    initialize: JSONRPCRequest & InitializeRequest,
    reconnect: () => Promise<BridgeTarget>,
  ): Promise<void> => {
    stale = true
    const target = await reconnect()
    await remote.close().catch(() => {})
    remote = openRemote(target)
    await remote.start()
    const id = `${OWN_ID_PREFIX}${++ownRequestCount}`
    const answer = new Promise<JSONRPCMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ReconnectFailed()),
        options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS,
      )
      ownRequests.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    }).finally(() => ownRequests.delete(id))
    await remote.send({ ...initialize, id })
    const response = await answer
    if (!isJSONRPCResultResponse(response)) throw new ReconnectFailed()
    adoptProtocolVersion(remote, response.result['protocolVersion'])
    await remote.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    stale = false
    // The new session may offer different tools; the client must not trust its cached list.
    await sendDown({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  /** Reopens when the client has a session to rebuild and the caller supplied a way to find it. */
  const tryReopen = async (): Promise<boolean> => {
    const { reconnect } = options
    if (reconnect === undefined || clientInitialize === undefined) return false
    await reopen(clientInitialize, reconnect)
    return true
  }

  const relayUp = async (message: JSONRPCMessage): Promise<void> => {
    const isInitialize = isJSONRPCRequest(message) && isInitializeRequest(message)
    if (isInitialize) initializeIds.add(message.id)
    try {
      if (stale && !isInitialize) await tryReopen()
      try {
        await remote.send(message)
      } catch (error) {
        if (isInitialize || !restartLike(error) || !(await tryReopen())) throw error
        await remote.send(message)
      }
      if (isInitialize) clientInitialize = message
    } catch (error) {
      // A notification has no one to answer; a request must get a reply or the client hangs.
      if (isJSONRPCRequest(message)) {
        await sendDown({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: BRIDGE_ERROR_CODE, message: describeFailure(error) },
        })
      }
    }
  }

  local.onmessage = (message) => {
    upstream = upstream.then(() => relayUp(message))
  }
  // A malformed line from the client. There is no id to answer, and stdout is not for diagnostics.
  local.onerror = () => {}

  const close = (): Promise<void> => {
    closing ??= (async () => {
      await upstream
      await remote.terminateSession().catch(() => {})
      await remote.close()
      await local.close()
      finish()
    })()
    return closing
  }
  options.input.once('end', () => void close())

  await remote.start()
  await local.start()
  return { done, close }
}

function adoptProtocolVersion(transport: StreamableHTTPClientTransport, version: unknown): void {
  if (typeof version === 'string') transport.setProtocolVersion(version)
}

/**
 * What an app restart looks like from here: the old port refuses connections, the session id is
 * unknown (404), or the token changed (401). A 403 is a refusal, not a restart.
 */
function restartLike(error: unknown): boolean {
  if (!(error instanceof StreamableHTTPError)) return true
  return error.code === 401 || error.code === 404
}

/** Fixed texts only: an upstream error message could carry anything the server sent. */
function describeFailure(error: unknown): string {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) return 'siteadapter refused the bridge token; check the bridge config'
    if (error.code === 403) return 'siteadapter refused the request'
    if (error.code === 404) return 'the siteadapter session has ended; restart this MCP server'
  }
  return 'siteadapter is not reachable; make sure the app is running'
}
