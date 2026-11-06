// A stdio-to-HTTP bridge for MCP clients that can only launch a command. It relays JSON-RPC
// messages unchanged in both directions, so the client's own initialize (and its client name) reach
// the endpoint, and adds only the bearer token. Nothing but protocol messages is written to the
// output: for a stdio client, any other byte there is a protocol error.

import type { Readable, Writable } from 'node:stream'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'

export interface BridgeOptions {
  /** The endpoint URL, e.g. http://127.0.0.1:52011/mcp. */
  readonly url: string
  readonly token: string
  /** What the stdio client writes: newline-delimited JSON-RPC. */
  readonly input: Readable
  /** Where the bridge writes for the stdio client. */
  readonly output: Writable
  readonly fetch?: FetchLike
}

export interface RunningBridge {
  /** Resolves once the bridge has shut down, after the input ends or close() is called. */
  readonly done: Promise<void>
  close(): Promise<void>
}

/** JSON-RPC's implementation-defined server error range starts here. */
const BRIDGE_ERROR_CODE = -32000

export async function runBridge(options: BridgeOptions): Promise<RunningBridge> {
  const local = new StdioServerTransport(options.input, options.output)
  const remote = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { authorization: `Bearer ${options.token}` } },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const initializeIds = new Set<RequestId>()
  // Messages go upstream one at a time and in order. A send resolves once the response has started
  // (results stream back over SSE), so a slow tool call doesn't hold up the next message.
  let upstream: Promise<void> = Promise.resolve()
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  let closing: Promise<void> | undefined

  const relayUp = async (message: JSONRPCMessage): Promise<void> => {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) initializeIds.add(message.id)
    try {
      await remote.send(message)
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

  const sendDown = (message: JSONRPCMessage): Promise<void> => local.send(message).catch(() => {})

  local.onmessage = (message) => {
    upstream = upstream.then(() => relayUp(message))
  }
  // A malformed line from the client. There is no id to answer, and stdout is not for diagnostics.
  local.onerror = () => {}
  remote.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
      const version = message.result['protocolVersion']
      if (typeof version === 'string') remote.setProtocolVersion(version)
    }
    void sendDown(message)
  }
  // Failures of the background SSE stream; request failures are answered in relayUp.
  remote.onerror = () => {}

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

/** Fixed texts only: an upstream error message could carry anything the server sent. */
function describeFailure(error: unknown): string {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) return 'siteadapter refused the bridge token; check the bridge config'
    if (error.code === 403) return 'siteadapter refused the request'
    if (error.code === 404) return 'the siteadapter session has ended; restart this MCP server'
  }
  return 'siteadapter is not reachable; make sure the app is running'
}
