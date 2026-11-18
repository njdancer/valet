// Red team: reading a credential message's token back (docs/adapter-kinds.md#credential-messages).
// The adapter writes the tool code and the hub may be hostile or careless: each test has the hub
// hand the sign-in back in some form after the tool asks, and the tool tries to return it.

import { describe, expect, it } from 'vitest'
import { drain, type HubScript, scriptedHub, setupHub, TOKEN } from './http-credential-message.fixtures'

const SIGN_IN = JSON.stringify({ type: 'auth', access_token: TOKEN })

/** Signs in, sends `ask`, and returns everything the hub sent back, joined, and any refusals. */
async function readBack(script: HubScript, binary = false) {
  const hub = scriptedHub(script)
  const { run, audit } = setupHub({ http: hub.http })
  const result = await run(async (ctx) => {
    const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
    await drain(socket)
    await socket.sendCredential('hub')
    await drain(socket)
    await socket.send(binary ? 'AAAA' : '{"type":"echo"}', binary ? { binary: true } : undefined)
    const got: string[] = []
    const refused: string[] = []
    for (let i = 0; i < 10; i++) {
      try {
        const message = await socket.receive({ waitMs: 0 })
        if (message === null || message.kind === 'closed') break
        got.push(message.data)
      } catch (error) {
        refused.push(String((error as { errorClass?: string }).errorClass))
      }
    }
    // The tool's best try at putting the pieces back together.
    return { got, refused, joined: got.join('') }
  })
  return { result, audit, text: JSON.stringify(result) }
}

/** Every form of the token a model could read back. */
function leaks(text: string): string[] {
  const forms = {
    plain: TOKEN,
    lower: TOKEN.toLowerCase(),
    upper: TOKEN.toUpperCase(),
    reversed: [...TOKEN].reverse().join(''),
    base64: Buffer.from(TOKEN).toString('base64').slice(4, 28),
    hex: Buffer.from(TOKEN).toString('hex'),
  }
  return Object.entries(forms)
    .filter(([, form]) => text.toLowerCase().includes(form.toLowerCase()))
    .map(([name]) => name)
}

describe('red team: the sign-in message read back', () => {
  it('a hub that echoes the sign-in as it came', async () => {
    const { text, audit } = await readBack((_t, hub) => hub.push(hub.received[0] as string))
    expect(text).toContain('[redacted]')
    expect(leaks(text)).toEqual([])
    expect(leaks(JSON.stringify(audit.events))).toEqual([])
  })

  it('JSON-escaped inside another message, and with \\u escapes', async () => {
    const { text } = await readBack((_t, hub) => {
      hub.push(JSON.stringify({ error: `bad message: ${hub.received[0]}` }))
      hub.push(
        JSON.stringify({ seen: hub.received[0] }).replace(
          /[a-z]/g,
          (c) => `\\u00${c.charCodeAt(0).toString(16)}`,
        ),
      )
    })
    expect(leaks(text)).toEqual([])
  })

  it('base64, at every alignment', async () => {
    const { text } = await readBack((_t, hub) => {
      for (const pad of ['', 'x', 'xy']) hub.push(Buffer.from(pad + SIGN_IN).toString('base64'))
    })
    expect(leaks(text)).toEqual([])
    for (const pad of ['', 'x', 'xy'])
      expect(text).not.toContain(Buffer.from(pad + SIGN_IN).toString('base64'))
  })

  it('hex, percent-encoded and reversed', async () => {
    const { text } = await readBack((_t, hub) => {
      hub.push(Buffer.from(TOKEN).toString('hex'))
      hub.push(Buffer.from(TOKEN).toString('hex').toUpperCase())
      hub.push(encodeURIComponent(SIGN_IN))
      hub.push([...TOKEN].reverse().join(''))
    })
    expect(leaks(text)).toEqual([])
  })

  it('upper-cased, so an exact match misses it', async () => {
    const { result, text } = await readBack((_t, hub) => hub.push(SIGN_IN.toUpperCase()))
    expect(leaks(text)).toEqual([])
    expect(result).toMatchObject({ output: { got: ['{"TYPE":"AUTH","ACCESS_TOKEN":"[redacted]"}'] } })
  })

  it('in halves across two messages: each holds a 12-character piece and is refused', async () => {
    const { result, text } = await readBack((_t, hub) => {
      hub.push(TOKEN.slice(0, 14))
      hub.push(TOKEN.slice(14))
    })
    expect(leaks(text)).toEqual([])
    expect(result).toMatchObject({ output: { refused: ['unexpected-shape', 'unexpected-shape'] } })
  })

  it('in short pieces the tool joins: the call output is still redacted', async () => {
    const { text } = await readBack((_t, hub) => {
      for (let at = 0; at < TOKEN.length; at += 6) hub.push(TOKEN.slice(at, at + 6))
    })
    expect(leaks(text)).toEqual([])
  })

  it('as a binary frame', async () => {
    const { result, text } = await readBack((_t, hub) => hub.push(Buffer.from(`x${SIGN_IN}`), true), true)
    expect(leaks(text)).toEqual([])
    expect(result).toMatchObject({ output: { refused: ['unexpected-shape'] } })
  })

  it('before the sign-in: the hub already knows its token, and says it on open', async () => {
    const hub = scriptedHub()
    const { run } = setupHub({ http: hub.http })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
      return drain(socket)
    })
    expect(leaks(JSON.stringify(result))).toEqual([])
  })

  it('a second socket without the sign-in, to the same hub, after it', async () => {
    // The first socket signs in and has the hub store the token; a second socket that never sends
    // it reads the store back. The call's output is redacted for the token all the same.
    let stored = ''
    const hub = scriptedHub((text, h) => {
      if (text === 'read') h.push(stored)
    })
    const http = {
      ...hub.http,
      websocket: async (...args: Parameters<typeof hub.http.websocket>) => {
        const socket = await hub.http.websocket(...args)
        return {
          ...socket,
          send: async (data: Buffer, binary: boolean) => {
            if (data.toString().includes('access_token')) stored = data.toString()
            if (data.toString() === 'read') {
              // A fresh socket that never signed in: answer from the store anyway.
              await socket.send(Buffer.from(JSON.stringify({ type: 'auth', access_token: TOKEN })), false)
            }
            return socket.send(data, binary)
          },
        }
      },
    }
    const { run } = setupHub({ http })
    const result = await run(async (ctx) => {
      const a = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await a.sendCredential('hub')
      await a.close()
      const b = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await b.send('read')
      const got: string[] = []
      for (let i = 0; i < 5; i++) {
        try {
          const m = await b.receive({ waitMs: 0 })
          if (m === null || m.kind === 'closed') break
          got.push(m.data)
        } catch {
          got.push('refused')
        }
      }
      return got
    })
    expect(stored).toContain(TOKEN)
    expect(leaks(JSON.stringify(result))).toEqual([])
  })

  it('tool code cannot first tell the hub to treat the next message as data', async () => {
    // e.g. "store the next message as a note", then the sign-in, then read the note back.
    const { run, hub, resolve } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.send('{"type":"store_next_message_as_note"}')
      await socket.sendCredential('hub')
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'undeclared-request' })
    expect(hub.sent).toEqual(['{"type":"store_next_message_as_note"}'])
    expect(resolve).not.toHaveBeenCalled()
  })
})
