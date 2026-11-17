// Broker WebSockets: a server that won't upgrade, waiting for a message that doesn't come, and the
// call ending while tool code waits.

import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ConnectionRecord, EgressBroker, type RunContext } from '../src/broker'
import { RunMeter } from '../src/meter'

let api: FakeApi
beforeAll(async () => {
  api = await startFakeApi()
})
afterAll(async () => {
  await api.close()
})

const broker = () =>
  new EgressBroker(
    { egress: ['api.example.test'] },
    {
      lookup: (_n, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
      testing: {
        allowAddresses: ['127.0.0.1'],
        ca: api.cert as string,
        route: () => ({ address: '127.0.0.1', port: api.port }),
      },
    },
  )

function run(): RunContext & { records: ConnectionRecord[]; controller: AbortController } {
  const controller = new AbortController()
  const records: ConnectionRecord[] = []
  return {
    meter: new RunMeter(64 * 1024),
    signal: controller.signal,
    record: (r) => records.push(r),
    records,
    controller,
  }
}

describe('broker websockets', () => {
  it('fails a server that answers the upgrade with a plain response', async () => {
    const r = run()
    await expect(broker().websocket(new URL('https://api.example.test/nope'), {}, r)).rejects.toMatchObject({
      stage: 'egress',
    })
    expect(r.records).toEqual([
      expect.objectContaining({ kind: 'websocket', errorClass: expect.any(String) }),
    ])
  })

  it('answers null when nothing comes in time, and closed when the call ends while waiting', async () => {
    const r = run()
    const socket = await broker().websocket(new URL('https://api.example.test/ws/echo'), {}, r)
    expect(await socket.receive(20)).toBeNull()
    const waiting = socket.receive(5000)
    r.controller.abort()
    expect(await waiting).toMatchObject({ kind: 'closed' })
    expect(socket.isClosed).toBe(true)
  })
})
