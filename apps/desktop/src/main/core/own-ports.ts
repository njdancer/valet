// The TCP ports this process listens on, so a `local-service` exception never reaches Valet itself
// (docs/sandbox.md; agent-run-security.md says the runtime refuses any port Valet listens on,
// checked at connect time). Every Node server in the main process (the MCP endpoint, the OAuth
// server, the egress proxies, the demo site, the relay bridge) is a net.Server, so recording each
// one as it starts listening covers them all, including ones added later. Chromium's own debugging
// port, if a switch opened one, is added by the caller.

import { type AddressInfo, Server } from 'node:net'

const ports = new Set<number>()
let installed = false

/** Starts recording. Idempotent; call before any server starts. */
export function recordOwnPorts(): void {
  if (installed) return
  installed = true
  const listen = Server.prototype.listen
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    this.once('listening', () => {
      const address = this.address()
      if (address !== null && typeof address === 'object') {
        const port = (address as AddressInfo).port
        ports.add(port)
        this.once('close', () => ports.delete(port))
      }
    })
    return (listen as (...a: unknown[]) => Server).apply(this, args)
  } as typeof Server.prototype.listen
}

export function addOwnPort(port: number): void {
  if (Number.isInteger(port) && port > 0) ports.add(port)
}

/** The ports listened on now. */
export function ownPorts(): readonly number[] {
  return [...ports]
}
