import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { CredentialError, type Grant, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  HELPER_MAX_LOOKBACK_MS,
  MessagesHelperOtpReader,
  messagesHelperSocketPath,
  type SocketFiles,
  type SocketLike,
} from '../src/messages-helper'
import { ManualTimers } from './fake-process'

const NOW = new Date('2026-11-07T00:10:00.000Z')
const NOT_BEFORE = new Date('2026-11-07T00:08:00.000Z')
const SOCKET = '/Users/nick/Library/Application Support/me.dncr.valet.messages-helper/helper.sock'
const WOOLWORTHS = { sender: 'Woolworths', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 }
const GRANT: Grant = {
  adapterId: 'woolworths',
  adapterHash: 'a'.repeat(64),
  secret: 'messages',
  provider: 'messages',
  itemRef: 'Woolworths',
  origins: ['https://auth.woolworths.com.au'],
  grantedAt: '2026-11-07T00:00:00.000Z',
}

class FakeSocket extends EventEmitter implements SocketLike {
  readonly written: string[] = []
  destroyed = false
  write(data: string): void {
    this.written.push(data)
  }
  destroy(): void {
    this.destroyed = true
  }
}

function socketFiles(info: { socket?: boolean; uid?: number } | 'missing' = {}): SocketFiles {
  return {
    lstat: (async () => {
      if (info === 'missing') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isSocket: () => info.socket ?? true, uid: info.uid ?? 501 }
    }) as unknown as SocketFiles['lstat'],
  }
}

/** A reader whose helper answers `reply` (a line, or a function of the request) once asked. */
function reader(
  reply: string | ((request: Record<string, unknown>) => string) | null,
  options: { files?: SocketFiles; timers?: ManualTimers; requireGrant?: boolean } = {},
) {
  const sockets: FakeSocket[] = []
  const timers = options.timers ?? new ManualTimers()
  const instance = new MessagesHelperOtpReader({
    socketPath: SOCKET,
    connect: (path) => {
      expect(path).toBe(SOCKET)
      const socket = new FakeSocket()
      sockets.push(socket)
      queueMicrotask(() => {
        socket.emit('connect')
        if (reply === null) return
        const request = JSON.parse(socket.written[0] ?? '{}') as Record<string, unknown>
        const line = typeof reply === 'string' ? reply : reply(request)
        socket.emit('data', Buffer.from(line))
      })
      return socket
    },
    files: options.files ?? socketFiles(),
    now: () => NOW,
    timers,
    uid: 501,
    ...(options.requireGrant === undefined ? {} : { requireGrant: options.requireGrant }),
  })
  return { instance, sockets, timers }
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('MessagesHelperOtpReader', () => {
  it('asks for the exact handle, its services, the pattern and the cut-off, and returns the code', async () => {
    const { instance, sockets } = reader('{"code":"123456"}\n')
    const code = await instance.latest(WOOLWORTHS, NOT_BEFORE, GRANT)
    expect(code.reveal((plaintext) => plaintext)).toBe('123456')
    expect(sockets[0]?.written).toEqual([
      `${JSON.stringify({
        v: 1,
        handle: 'woolworths',
        services: ['SMS', 'RCS'],
        pattern: 'code is (\\d{6})',
        sinceMs: NOT_BEFORE.getTime(),
      })}\n`,
    ])
    expect(sockets[0]?.destroyed).toBe(true)
  })

  it('accepts the answer split across chunks', async () => {
    const sockets: FakeSocket[] = []
    const instance = new MessagesHelperOtpReader({
      socketPath: SOCKET,
      connect: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => {
          socket.emit('connect')
          socket.emit('data', Buffer.from('{"code":"65'))
          socket.emit('data', Buffer.from('4321"}\n'))
        })
        return socket
      },
      files: socketFiles(),
      now: () => NOW,
      timers: new ManualTimers(),
      uid: 501,
    })
    expect((await instance.latest(WOOLWORTHS, NOT_BEFORE)).reveal((plaintext) => plaintext)).toBe('654321')
  })

  it('never asks further back than the helper allows', async () => {
    const { instance, sockets } = reader('{"code":"123456"}\n')
    await instance.latest({ ...WOOLWORTHS, maxAgeSeconds: 24 * 3600 }, new Date(0))
    const request = JSON.parse(sockets[0]?.written[0] ?? '{}') as { sinceMs: number }
    expect(request.sinceMs).toBe(NOW.getTime() - HELPER_MAX_LOOKBACK_MS)
  })

  it('refuses a sender the grant does not name before connecting', async () => {
    const { instance, sockets } = reader('{"code":"123456"}\n')
    const error = await failureOf(
      instance.latest({ ...WOOLWORTHS, sender: '+61400000000' }, NOT_BEFORE, GRANT),
    )
    expect(error).toEqual(new ValetError('otp', 'not-granted'))
    expect(sockets).toHaveLength(0)
  })

  it('refuses a lookup without a grant when told to', async () => {
    const { instance, sockets } = reader('{"code":"123456"}\n', { requireGrant: true })
    expect(await failureOf(instance.latest(WOOLWORTHS, NOT_BEFORE))).toEqual(
      new ValetError('otp', 'not-granted'),
    )
    expect(sockets).toHaveLength(0)
  })

  it('refuses an unscreened pattern or an unusable sender before connecting', async () => {
    const { instance, sockets } = reader('{"code":"123456"}\n')
    expect(await failureOf(instance.latest({ ...WOOLWORTHS, pattern: '(a+)+' }, NOT_BEFORE))).toEqual(
      new ValetError('otp', 'invalid'),
    )
    expect(await failureOf(instance.latest({ ...WOOLWORTHS, sender: '' }, NOT_BEFORE))).toEqual(
      new ValetError('otp', 'invalid'),
    )
    expect(sockets).toHaveLength(0)
  })

  it('maps the helper’s answers', async () => {
    expect(
      await failureOf(reader('{"error":"not-found"}\n').instance.latest(WOOLWORTHS, NOT_BEFORE)),
    ).toEqual(new CredentialError('not-found'))
    expect(await failureOf(reader('{"error":"invalid"}\n').instance.latest(WOOLWORTHS, NOT_BEFORE))).toEqual(
      new ValetError('otp', 'invalid'),
    )
    for (const line of ['{"error":"unavailable"}\n', 'not json\n', '7\n', '{"code":5}\n']) {
      expect(await failureOf(reader(line).instance.latest(WOOLWORTHS, NOT_BEFORE))).toEqual(
        new CredentialError('unavailable'),
      )
    }
  })

  it('never hands on an answer that is not code-shaped', async () => {
    const message = 'Hi Nick, the spare key is under the mat'
    const error = await failureOf(reader(`{"code":"${message}"}\n`).instance.latest(WOOLWORTHS, NOT_BEFORE))
    expect(error).toEqual(new CredentialError('not-found'))
    expect(inspect(error)).not.toContain('spare key')
  })

  it('is unavailable when the helper is not running, or the socket is not this user’s', async () => {
    for (const files of [socketFiles('missing'), socketFiles({ socket: false }), socketFiles({ uid: 0 })]) {
      const { instance, sockets } = reader('{"code":"123456"}\n', { files })
      expect(await failureOf(instance.latest(WOOLWORTHS, NOT_BEFORE))).toEqual(
        new CredentialError('unavailable'),
      )
      expect(sockets).toHaveLength(0)
    }
  })

  it('gives up on a helper that does not answer', async () => {
    const { instance, sockets, timers } = reader(null)
    const pending = failureOf(instance.latest(WOOLWORTHS, NOT_BEFORE))
    await new Promise((resolve) => setTimeout(resolve, 0))
    timers.fireAll()
    expect(await pending).toEqual(new CredentialError('unavailable'))
    expect(sockets[0]?.destroyed).toBe(true)
  })

  it('gives up on an oversized answer, and on a connection that drops', async () => {
    const big = reader(`{"code":"${'1'.repeat(5000)}`)
    expect(await failureOf(big.instance.latest(WOOLWORTHS, NOT_BEFORE))).toEqual(
      new CredentialError('unavailable'),
    )
    const dropped = reader(null)
    const pending = failureOf(dropped.instance.latest(WOOLWORTHS, NOT_BEFORE))
    await new Promise((resolve) => setTimeout(resolve, 0))
    dropped.sockets[0]?.emit('close')
    expect(await pending).toEqual(new CredentialError('unavailable'))
    const errored = reader(null)
    const failing = failureOf(errored.instance.latest(WOOLWORTHS, NOT_BEFORE))
    await new Promise((resolve) => setTimeout(resolve, 0))
    errored.sockets[0]?.emit('error', new Error('ECONNREFUSED'))
    expect(await failing).toEqual(new CredentialError('unavailable'))
  })

  it('is unavailable when it cannot connect at all', async () => {
    const instance = new MessagesHelperOtpReader({
      socketPath: SOCKET,
      connect: () => {
        throw new Error('EACCES')
      },
      files: socketFiles(),
      now: () => NOW,
      timers: new ManualTimers(),
      uid: 501,
    })
    expect(await failureOf(instance.latest(WOOLWORTHS, NOT_BEFORE))).toEqual(
      new CredentialError('unavailable'),
    )
  })

  it('puts the socket under the agent label in Application Support', () => {
    expect(messagesHelperSocketPath('me.dncr.valet.messages-helper', '/Users/nick')).toBe(SOCKET)
  })
})
