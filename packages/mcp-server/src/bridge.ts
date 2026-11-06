// A stdio-to-HTTP bridge for MCP clients that can only launch a command. It relays JSON-RPC
// messages unchanged in both directions, so the client's own initialize (and its client name) reach
// the endpoint, and adds only the bearer token. Nothing but protocol messages is written to the
// output: for a stdio client, any other byte there is a protocol error.
//
// The endpoint's token changes when the app restarts (and its port, if the saved one is taken) or
// when the person resets the token, which ends the session under a client that is still running.
// With `reconnect`, the bridge then re-reads where the endpoint is, replays the client's
// initialize into a new session, and tells the client to re-list its tools.
//
// Every request the client sends gets exactly one answer. A request whose response stream ends
// without one (the app quit mid-call) is answered with a fixed error at once, rather than leaving
// the client to wait out its own timeout, and any late answer to it is dropped.

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
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import { onStreamEnd } from './stream-end'

export interface BridgeTarget {
  /** The endpoint URL, e.g. http://127.0.0.1:52011/mcp. */
  readonly url: string
  readonly token: string
}

/** Runs `run` once after `ms` milliseconds; the returned function cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void

export interface BridgeOptions extends BridgeTarget {
  /** What the stdio client writes: newline-delimited JSON-RPC. */
  readonly input: Readable
  /** Where the bridge writes for the stdio client. */
  readonly output: Writable
  /** Where the endpoint is now, for reconnecting after the app restarts. Without it, no retry. */
  readonly reconnect?: () => Promise<BridgeTarget>
  /** How long to wait for the endpoint to answer a replayed initialize. */
  readonly reconnectTimeoutMs?: number
  /** The bridge's only timer. Defaults to setTimeout. */
  readonly schedule?: Schedule
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
const SESSION_ENDED = 'the siteadapter session ended before this request was answered'

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

class ReconnectFailed extends Error {}

export async function runBridge(options: BridgeOptions): Promise<RunningBridge> {
  const schedule = options.schedule ?? defaultSchedule
  const baseFetch = options.fetch ?? fetch
  const local = new StdioServerTransport(options.input, options.output)
  const initializeIds = new Set<RequestId>()
  // Client requests relayed upstream and not yet answered.
  const pending = new Set<RequestId>()
  // The bridge's own requests. Settled with undefined when their response stream ends unanswered.
  const ownRequests = new Map<RequestId, (message: JSONRPCMessage | undefined) => void>()
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

  /** Answers a client request with fixed text, unless it has been answered already. */
  const failRequest = (id: RequestId, text: string): void => {
    if (!pending.delete(id)) return
    void sendDown({ jsonrpc: '2.0', id, error: { code: BRIDGE_ERROR_CODE, message: text } })
  }

  /** The session these requests went to is gone, so nothing upstream will answer them. */
  const failPending = (except?: RequestId): void => {
    for (const id of [...pending]) if (id !== except) failRequest(id, SESSION_ENDED)
  }

  const streamEnded = (ids: readonly RequestId[]): void => {
    for (const id of ids) {
      ownRequests.get(id)?.(undefined)
      failRequest(id, SESSION_ENDED)
    }
  }

  // The SDK can't say when a response stream ends without the response it was opened for, so each
  // POST's stream is watched here for the ids it carried.
  const watchingFetch: FetchLike = async (url, init) => {
    const response = await baseFetch(url, init)
    const ids = init?.method === 'POST' ? requestIdsIn(init.body) : []
    const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    if (ids.length === 0 || !isStream || response.body === null) return response
    const body = onStreamEnd(response.body, () => {
      // The SDK parses events a few microtasks behind the bytes; let it deliver the last one first.
      setImmediate(() => streamEnded(ids))
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const openRemote = (target: BridgeTarget): StreamableHTTPClientTransport => {
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers: { authorization: `Bearer ${target.token}` } },
      fetch: watchingFetch,
    })
    transport.onmessage = (message) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        const id = message.id
        if (id === undefined) return
        const own = ownRequests.get(id)
        if (own !== undefined) return own(message)
        // Already answered with an error; a second answer would confuse the client.
        if (!pending.delete(id)) return
        if (isJSONRPCResultResponse(message) && initializeIds.delete(id)) {
          adoptProtocolVersion(transport, message.result['protocolVersion'])
        }
      }
      void sendDown(message)
    }
    // Failures of the background SSE stream; request failures are answered in relayUp, and response
    // streams that die are caught by watchingFetch.
    transport.onerror = () => {}
    return transport
  }

  let remote = openRemote(options)

  // Set while the upstream session is not one the client's initialize set up: a reopen that failed
  // part-way leaves a session nothing has initialized, which must not be sent to.
  let stale = false

  /** Sends a request of the bridge's own and waits, within the reconnect timeout, for its answer. */
  const ownRequest = async (request: JSONRPCRequest): Promise<JSONRPCMessage> => {
    const id = `${OWN_ID_PREFIX}${++ownRequestCount}`
    let settle: (message: JSONRPCMessage | undefined) => void = () => {}
    // Never rejects, so there is no rejection to go unhandled if the send below throws first.
    const answer = new Promise<JSONRPCMessage | undefined>((resolve) => {
      settle = resolve
    })
    ownRequests.set(id, settle)
    const cancel = schedule(
      () => settle(undefined),
      options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS,
    )
    try {
      await remote.send({ ...request, id })
      const response = await answer
      if (response === undefined) throw new ReconnectFailed()
      return response
    } finally {
      cancel()
      ownRequests.delete(id)
    }
  }

  /** Starts a new upstream session that looks, to the endpoint, like the client's own. */
  const reopen = async (
    initialize: JSONRPCRequest & InitializeRequest,
    reconnect: () => Promise<BridgeTarget>,
    retrying: RequestId | undefined,
  ): Promise<void> => {
    stale = true
    // Whatever else was in flight went to the old session; only the request being retried lives on.
    failPending(retrying)
    const target = await reconnect()
    await remote.close().catch(() => {})
    remote = openRemote(target)
    await remote.start()
    const response = await ownRequest(initialize)
    if (!isJSONRPCResultResponse(response)) throw new ReconnectFailed()
    adoptProtocolVersion(remote, response.result['protocolVersion'])
    await remote.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    stale = false
    // The new session may offer different tools; the client must not trust its cached list.
    await sendDown({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  /** Reopens when the client has a session to rebuild and the caller supplied a way to find it. */
  const tryReopen = async (retrying: RequestId | undefined): Promise<boolean> => {
    const { reconnect } = options
    if (reconnect === undefined || clientInitialize === undefined) return false
    await reopen(clientInitialize, reconnect, retrying)
    return true
  }

  const relayUp = async (message: JSONRPCMessage): Promise<void> => {
    const requestId = isJSONRPCRequest(message) ? message.id : undefined
    const isInitialize = isJSONRPCRequest(message) && isInitializeRequest(message)
    if (requestId !== undefined) pending.add(requestId)
    if (isInitialize) initializeIds.add(message.id)
    // A cancelled request gets no answer from the endpoint, and must not get one from here later.
    const cancelled = cancelledRequestId(message)
    if (cancelled !== undefined) pending.delete(cancelled)
    try {
      if (stale && !isInitialize) await tryReopen(requestId)
      try {
        await remote.send(message)
      } catch (error) {
        if (isInitialize || !restartLike(error) || !(await tryReopen(requestId))) throw error
        await remote.send(message)
      }
      if (isInitialize) clientInitialize = message
    } catch (error) {
      // A notification has no one to answer; a request must get a reply or the client hangs.
      if (requestId !== undefined) failRequest(requestId, describeFailure(error))
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
      failPending()
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

/** The ids of the requests in a POST body the SDK wrote: one message or a batch, as JSON text. */
function requestIdsIn(body: RequestInit['body']): RequestId[] {
  if (typeof body !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  return messages.filter(isJSONRPCRequest).map((message) => message.id)
}

function cancelledRequestId(message: JSONRPCMessage): RequestId | undefined {
  if (!isJSONRPCNotification(message) || message.method !== 'notifications/cancelled') return undefined
  const id = message.params?.['requestId']
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
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
