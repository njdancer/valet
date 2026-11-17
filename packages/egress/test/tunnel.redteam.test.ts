// Red team (workstream F): a tunnel listener lives in Valet's main process. An error it emits after it
// started listening (Node emits `accept` failures, such as running out of file descriptors, as an
// 'error' event on the server) had only listen()'s spent `once` handler, so the second such error
// would have been thrown as an uncaught exception and ended Valet itself. Now the call's tunnels
// close instead.

import { connect as netConnect, Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type ConnectionRecord, EgressBroker, type RunContext } from '../src/broker'
import type { Lookup } from '../src/dial'
import { RunMeter } from '../src/meter'

const loopback: Lookup = (_name, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])

/** Every net.Server that starts listening while a test runs, as own-ports.ts records them. */
const servers: Server[] = []
const listen = Server.prototype.listen
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  servers.push(this)
  return (listen as (...a: unknown[]) => Server).apply(this, args)
} as typeof Server.prototype.listen
afterEach(() => {
  servers.splice(0)
})

function run(): RunContext & { records: ConnectionRecord[] } {
  const records: ConnectionRecord[] = []
  return {
    meter: new RunMeter(64 * 1024),
    signal: new AbortController().signal,
    record: (r) => records.push(r),
    records,
  }
}

describe('red team: tunnel listeners in the main process', () => {
  it('survives an accept error on a listener, and closes the call’s tunnels', async () => {
    const broker = new EgressBroker(
      { egress: [], endpoints: ['api.example.test:443'] },
      { lookup: loopback, testing: { allowAddresses: ['127.0.0.1'] } },
    )
    const tunnels = await broker.tunnels(run())(['api.example.test:443'])
    const port = tunnels.ports.get('api.example.test:443') as number
    const server = servers.find((s) => {
      const address = s.address()
      return address !== null && typeof address === 'object' && address.port === port
    })
    expect(server).toBeDefined()
    const accept = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', syscall: 'accept' })
    // Before the fix the first error went to the listen() promise's stale `once` handler, and the
    // second had no listener at all: it threw.
    expect(() => server?.emit('error', accept)).not.toThrow()
    expect(() => server?.emit('error', accept)).not.toThrow()
    // Failed closed: the listener no longer takes connections.
    const refused = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => resolve(true))
    })
    expect(refused).toBe(true)
    tunnels.close()
  })
})
