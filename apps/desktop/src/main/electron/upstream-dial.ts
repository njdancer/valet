// Demo builds only: the scratch browser's and live trials' upstream connections through an HTTP
// proxy, for the authoring evals (docs/authoring-tools.md#evals) in a container that reaches the
// internet only through one, where no name resolves. The public-only check can't run there (nothing
// to resolve), so a name goes to the proxy, whose own policy decides; an address is never sent
// through it. A private address is dialled directly, and only when the person let the draft reach
// it (R21), as `publicOnlyDial` does. `sites` stands the evals' own sites in for public ones: a name
// there goes straight to its loopback address and port. A release build never has this: app.ts
// reaches it only under __VALET_DEMO_BUILD__ with VALET_E2E_UPSTREAM_PROXY set.

import { isIP, Socket } from 'node:net'
import { isPublicAddress } from '@valet/sandbox'

const HEADER_END = '\r\n\r\n'
const MAX_HEADER = 8192

/** VALET_E2E_SITES: `name=127.0.0.1:port` pairs, comma separated. Anything else is dropped. */
export function evalSites(text: string | undefined): ReadonlyMap<string, { host: string; port: number }> {
  const sites = new Map<string, { host: string; port: number }>()
  for (const pair of (text ?? '').split(',')) {
    const match = /^([a-z0-9.-]+\.test)=(127\.0\.0\.1):(\d{1,5})$/.exec(pair.trim())
    if (match?.[1] !== undefined && match[2] !== undefined)
      sites.set(match[1], { host: match[2], port: Number(match[3]) })
  }
  return sites
}

export function upstreamProxyDial(
  proxy: string,
  allowed: (address: string, port: number) => boolean = () => false,
  sites: ReadonlyMap<string, { host: string; port: number }> = new Map(),
): (host: string, port: number) => Socket {
  const url = new URL(proxy)
  const proxyHost = url.hostname
  const proxyPort = Number(url.port === '' ? 80 : url.port)
  return (host, port) => {
    const socket = new Socket()
    const site = port === 443 ? sites.get(host) : undefined
    if (site !== undefined) {
      socket.connect(site)
      return socket
    }
    if (isIP(host) !== 0) {
      if (isPublicAddress(host) || !allowed(host, port)) socket.destroy(new Error('refused'))
      else socket.connect({ host, port })
      return socket
    }
    // The caller waits for 'connect' to start piping, so hold it until the proxy has said yes.
    const emit = socket.emit.bind(socket) as (event: string | symbol, ...args: unknown[]) => boolean
    let tunnelled = false
    socket.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event !== 'connect' || tunnelled) return emit(event, ...args)
      let reply = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        reply = Buffer.concat([reply, chunk])
        const end = reply.indexOf(HEADER_END)
        if (end === -1) {
          if (reply.length > MAX_HEADER) socket.destroy(new Error('proxy reply too long'))
          return
        }
        socket.removeListener('data', onData)
        socket.pause()
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(reply.subarray(0, end).toString('latin1'))?.[1]
        if (status !== '200') {
          socket.destroy(new Error('refused by the proxy'))
          return
        }
        const rest = reply.subarray(end + HEADER_END.length)
        if (rest.length > 0) socket.unshift(rest)
        tunnelled = true
        emit('connect')
        // Paused above so nothing is read before the caller listens; a listener it added in its
        // connect handler gets the stream going again (pipe does that itself).
        if (socket.listenerCount('data') > 0) socket.resume()
      }
      socket.on('data', onData)
      const authority = `${host}:${port}`
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
      return true
    }) as typeof socket.emit
    socket.connect({ host: proxyHost, port: proxyPort })
    return socket
  }
}
