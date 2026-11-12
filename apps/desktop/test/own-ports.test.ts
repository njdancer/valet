import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { addOwnPort, ownPorts, recordOwnPorts } from '../src/main/core/own-ports'

describe('own ports', () => {
  it('records every server this process listens on, until it closes', async () => {
    recordOwnPorts()
    recordOwnPorts()
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    expect(ownPorts()).toContain(port)
    await new Promise<void>((r) => server.close(() => r()))
    expect(ownPorts()).not.toContain(port)
    addOwnPort(9229)
    addOwnPort(-1)
    expect(ownPorts()).toContain(9229)
    expect(ownPorts()).not.toContain(-1)
  })
})
