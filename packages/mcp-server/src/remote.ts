// The remote listener: the same Streamable HTTP handler and MCP server as the local endpoint
// (http.ts), started a second time with the remote hook and the remote policy in front of the same
// caller (D41, relay.md "A separate listener with its own guards"). Nothing here handles a tool call
// itself. It binds 127.0.0.1 only: a tunnel daemon (Funnel, cloudflared) or the relay client in the
// app connects to it there, and it never listens on another interface.
//
// The OAuth authorisation server that mints the access tokens (oauth-server.ts) answers on this
// listener too, ahead of the MCP path. The tunnel is not built yet.

import { type HttpServerOptions, type LiveSessions, startHttpServer } from './http'
import type { RemoteAuthorization } from './oauth-server'
import { type RemoteAccessTokens, remoteAuthenticator } from './remote-auth'
import { type RemotePolicy, RemotePolicyCaller, type RemotePolicyOptions } from './remote-policy'
import type { ToolCaller } from './tool-caller'
import type { SkippedTool } from './tool-names'

export interface RemoteListenerOptions
  extends Omit<HttpServerOptions, 'authenticate' | 'host' | 'caller'>,
    RemotePolicyOptions {
  /** The caller the local endpoint uses. The listener wraps it in the remote policy. */
  readonly caller: ToolCaller
  readonly policy: RemotePolicy
  readonly tokens: RemoteAccessTokens
  /** The public names the tunnel forwards. Read on every request. */
  readonly hosts: () => ReadonlySet<string>
  /** The authorisation server minting into `tokens`. Without it, no OAuth path answers. */
  readonly authorization?: RemoteAuthorization
}

export interface RunningRemoteListener {
  /** The loopback URL a tunnel daemon points at. Not the public URL, which is the tunnel's. */
  readonly url: string
  readonly port: number
  /** Re-reads the tools and the policy for every remote session. */
  refresh(): readonly SkippedTool[]
  sessions(): LiveSessions
  /** Revokes one client's access tokens and closes its sessions. */
  endClient(clientId: string): Promise<void>
  /**
   * The kill switch: refuses every access token, fails every remote call in flight with aborted,
   * closes every session and stops listening. Client registrations (later) are kept, so clients
   * refresh and carry on when remote access is resumed.
   */
  close(): Promise<void>
}

export async function startRemoteListener(options: RemoteListenerOptions): Promise<RunningRemoteListener> {
  const { caller, policy, tokens, hosts, authorization, callsPerHour, now, refused, ...http } = options
  const remote = new RemotePolicyCaller(caller, policy, {
    ...(callsPerHour === undefined ? {} : { callsPerHour }),
    ...(now === undefined ? {} : { now }),
    ...(refused === undefined ? {} : { refused }),
  })
  const server = await startHttpServer({
    ...http,
    caller: remote,
    authenticate: remoteAuthenticator({ tokens, hosts }),
    ...(authorization === undefined ? {} : { before: authorization.handler(hosts) }),
    host: '127.0.0.1',
  })
  let closed = false
  return {
    url: server.url,
    port: server.port,
    refresh: () => server.refresh(),
    sessions: () => server.sessions(),
    async endClient(clientId) {
      tokens.revokeClient(clientId)
      await server.endSessions((identity) => identity.origin === 'remote' && identity.clientId === clientId)
    },
    async close() {
      if (closed) return
      closed = true
      // Tokens first, so nothing new gets in while the rest winds down.
      tokens.revokeAll()
      remote.abortInFlight()
      await server.close()
    },
  }
}
