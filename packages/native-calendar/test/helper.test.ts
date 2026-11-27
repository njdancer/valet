// The EventKit client over the reader helper's socket, with a fake socket: a stalled or broken
// helper fails the call soon, as unavailable, and says why in the diagnostics log (feedback #34),
// never with the person's calendar in it.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { EventKitError, HelperEventKit, type SocketLike } from '../src/helper'

class FakeSocket extends EventEmitter implements SocketLike {
  written: string[] = []
  destroyed = false
  write(line: string) {
    this.written.push(line)
    return true
  }
  destroy() {
    this.destroyed = true
  }
}

function kit(answer: (socket: FakeSocket) => void, timeoutMs = 50) {
  const lines: string[] = []
  const sockets: FakeSocket[] = []
  const eventKit = new HelperEventKit({
    socketPath: '/tmp/helper.sock',
    lstat: async () => ({ isSocket: () => true, uid: 501 }),
    uid: 501,
    timeoutMs,
    log: (line) => lines.push(line),
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      setImmediate(() => {
        socket.emit('connect')
        answer(socket)
      })
      return socket
    },
  })
  return { eventKit, lines, sockets }
}

const unavailable = expect.objectContaining({ code: 'unavailable' })

describe('the EventKit client', () => {
  it('answers what the helper says', async () => {
    const { eventKit, lines } = kit((s) => s.emit('data', Buffer.from('{"access":"full"}\n')))
    expect(await eventKit.access('events')).toBe('full')
    expect(lines).toEqual([])
  })

  it('fails a helper that never answers once its time is up, and logs it', async () => {
    const { eventKit, lines, sockets } = kit(() => undefined)
    const started = Date.now()
    await expect(eventKit.events({ calendars: ['c'], from: 0, to: 1, limit: 1 } as never)).rejects.toEqual(
      unavailable,
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(lines).toEqual(['eventkit: eventkit.events failed: no answer in 0.05 s'])
    expect(sockets[0]?.destroyed).toBe(true)
  })

  it('logs a socket error by its code only, a bad answer, and a closed socket', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED /tmp/helper.sock with secrets'), {
      code: 'ECONNREFUSED',
    })
    const cases: Array<[(s: FakeSocket) => void, string]> = [
      [(s) => s.emit('error', error), 'a socket error (ECONNREFUSED)'],
      [(s) => s.emit('error', new Error('odd')), 'a socket error'],
      [(s) => s.emit('close'), 'closed with no answer'],
      [(s) => s.emit('data', Buffer.from('not json\n')), 'an answer that is not JSON'],
      [(s) => s.emit('data', Buffer.from('[1]\n')), 'an answer that is not an object'],
      [(s) => s.emit('data', Buffer.from('{"error":"unavailable"}\n')), 'the helper said unavailable'],
      [(s) => s.emit('data', Buffer.from('{"error":"weird"}\n')), 'the helper said an unknown error'],
    ]
    for (const [answer, why] of cases) {
      const { eventKit, lines } = kit(answer)
      await expect(eventKit.calendars('events')).rejects.toBeInstanceOf(EventKitError)
      expect(lines).toEqual([`eventkit: eventkit.calendars failed: ${why}`])
      expect(lines.join('')).not.toContain('secrets')
    }
  })

  it('passes the helper’s own refusals on without calling them a fault', async () => {
    const { eventKit, lines } = kit((s) => s.emit('data', Buffer.from('{"error":"not-found"}\n')))
    await expect(eventKit.calendars('events')).rejects.toEqual(expect.objectContaining({ code: 'not-found' }))
    expect(lines).toEqual([])
  })

  it('logs a missing socket and a connect that throws', async () => {
    const lines: string[] = []
    const missing = new HelperEventKit({
      socketPath: '/tmp/none.sock',
      lstat: async () => {
        throw new Error('ENOENT')
      },
      log: (line) => lines.push(line),
    })
    await expect(missing.refresh()).rejects.toEqual(unavailable)
    const throwing = new HelperEventKit({
      socketPath: '/tmp/helper.sock',
      lstat: async () => ({ isSocket: () => true, uid: 501 }),
      uid: 501,
      log: (line) => lines.push(line),
      connect: () => {
        throw new Error('no')
      },
    })
    await expect(throwing.refresh()).rejects.toEqual(unavailable)
    expect(lines).toEqual([
      'eventkit: eventkit.refresh failed: no helper socket',
      'eventkit: eventkit.refresh failed: could not connect',
    ])
  })
})
