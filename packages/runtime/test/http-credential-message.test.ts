// A kept credential in a WebSocket message (docs/adapter-kinds.md#credential-messages): Valet sends
// the manifest's declared sign-in message with the token filled in, when tool code asks, as the
// first thing on the socket; tool code never sees the token.

import { SecretValue, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  drain,
  grant,
  HASH,
  manifestJson,
  scriptedHub,
  setupHub,
  TOKEN,
  used,
} from './http-credential-message.fixtures'

const SIGN_IN = JSON.stringify({ type: 'auth', access_token: TOKEN })

describe('socket.sendCredential', () => {
  it('signs in with the declared message, audits the use, and never shows the token', async () => {
    const { run, audit, hub } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      const hello = await drain(socket)
      await socket.sendCredential('hub')
      return { hello, answer: await drain(socket) }
    })
    expect(result).toMatchObject({
      status: 'ok',
      output: { hello: ['{"type":"auth_required"}'], answer: ['{"type":"auth_ok"}'] },
    })
    expect(hub.sent).toEqual([SIGN_IN])
    // The upgrade carried no credential: only the message did.
    expect(hub.opened).toEqual([{ url: 'https://hub.example.test/api/websocket', headers: {} }])
    expect(used(audit.events)).toEqual([
      expect.objectContaining({
        adapterId: 'hub',
        adapterHash: HASH,
        secret: 'hub',
        field: 'token',
        origin: 'hub.example.test',
        callId: 'c-1',
        custody: 'kept',
      }),
    ])
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('writes the message in the manifest field order, with the value JSON-escaped', async () => {
    const tricky = 'a"b\\c</script>é tok-123456'
    const hub = scriptedHub(undefined, tricky)
    const manifest = {
      ...manifestJson,
      credentials: {
        ...manifestJson.credentials,
        hub: {
          ...manifestJson.credentials.hub,
          use: {
            message: { json: { access_token: '{value}', type: 'auth', v: 2, beta: true, extra: null } },
            hosts: ['hub.example.test'],
          },
        },
      },
    }
    const { run } = setupHub({
      http: hub.http,
      manifest,
      grants: {
        findGrant: async () => grant({ targets: ['hub.example.test'] }),
        resolve: async () => SecretValue.fromString(tricky),
      },
    })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
      return drain(socket)
    })
    expect(result).toMatchObject({ status: 'ok' })
    expect(hub.sent).toEqual([
      JSON.stringify({ access_token: tricky, type: 'auth', v: 2, beta: true, extra: null }),
    ])
    expect(JSON.parse(hub.sent[0] as string)).toMatchObject({ access_token: tricky })
  })

  it('sends nothing without a grant', async () => {
    const { run, hub, audit, resolve } = setupHub({
      grants: { findGrant: async () => null, resolve: async () => SecretValue.fromString(TOKEN) },
    })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
    })
    expect(result).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
    expect(used(audit.events)).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('sends nothing where credentials are not wired at all', async () => {
    const { run, hub } = setupHub({ grants: null })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
    })
    expect(result).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
  })

  it.each([
    ['a header-only credential', 'rest'],
    ['an undeclared credential', 'other'],
    ['an inherited name', 'constructor'],
    ['__proto__', '__proto__'],
  ])('refuses %s, and the refusal ends the call', async (_label, name) => {
    const { run, hub, resolve } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      try {
        await socket.sendCredential(name)
      } catch {
        // Caught by tool code: the call still fails.
      }
      return 'carried on'
    })
    expect(result).toMatchObject({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a host the credential does not name', async () => {
    const { run, hub, resolve } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://other.example.test/api/websocket')
      await socket.sendCredential('hub')
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a host the grant leaves out, though the manifest names it', async () => {
    const { run, hub } = setupHub({
      grants: {
        findGrant: async () => grant({ targets: ['192.168.1.30'] }),
        resolve: async () => SecretValue.fromString(TOKEN),
      },
    })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
  })

  it('never sends it over plain http, even to a host the credential names', async () => {
    const { run, hub, resolve } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('http://192.168.1.30:8080/api/websocket')
      await socket.sendCredential('hub')
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(hub.sent).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('must be the first thing sent on the socket', async () => {
    const { run, hub, resolve } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.send('{"type":"hello"}')
      try {
        await socket.sendCredential('hub')
      } catch {
        // Caught: the call still fails.
      }
      return 'carried on'
    })
    expect(result).toMatchObject({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'undeclared-request',
    })
    expect(hub.sent).toEqual(['{"type":"hello"}'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('goes once per socket', async () => {
    const { run, hub } = setupHub()
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
      await socket.sendCredential('hub')
    })
    expect(result).toMatchObject({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'undeclared-request',
    })
    expect(hub.sent).toEqual([SIGN_IN])
  })

  it('may go once on each of two sockets', async () => {
    const { run, hub, audit } = setupHub()
    const result = await run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
        await socket.sendCredential('hub')
        await socket.close()
      }
      return 'ok'
    })
    expect(result).toMatchObject({ status: 'ok' })
    expect(hub.sent).toEqual([SIGN_IN, SIGN_IN])
    expect(used(audit.events)).toHaveLength(2)
  })

  it('refuses a closed socket and a malformed name', async () => {
    const { run, hub } = setupHub()
    const closed = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.close()
      await socket.sendCredential('hub')
    })
    expect(closed).toMatchObject({ status: 'failed', stage: 'egress', errorClass: 'unavailable' })
    for (const name of [42, '', 'x'.repeat(65), null]) {
      const r = await run(async (ctx) => {
        const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
        await socket.sendCredential(name as string)
      })
      expect(r).toMatchObject({ status: 'failed', stage: 'tool-run', errorClass: 'invalid' })
    }
    expect(hub.sent).toEqual([])
  })

  it('spends the message from the upload budget', async () => {
    const spent: number[] = []
    const hub = scriptedHub()
    const http = {
      ...hub.http,
      websocket: async (
        url: URL,
        options: Parameters<typeof hub.http.websocket>[1],
        run: Parameters<typeof hub.http.websocket>[2],
      ) => {
        const socket = await hub.http.websocket(url, options, run)
        return {
          ...socket,
          send: async (data: Buffer, binary: boolean) => {
            spent.push(data.length)
            run.meter.spend(data.length)
            return socket.send(data, binary)
          },
        }
      },
    }
    const { run } = setupHub({ http })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await socket.sendCredential('hub')
      return 'ok'
    })
    expect(result).toMatchObject({ status: 'ok' })
    expect(spent).toEqual([Buffer.byteLength(SIGN_IN)])
  })

  it('a refused sign-in is the hub answering auth_invalid, nothing more', async () => {
    const hub = scriptedHub(undefined, 'some-other-token-entirely')
    const { run } = setupHub({ http: hub.http })
    const result = await run(async (ctx) => {
      const socket = await ctx.http!.websocket('https://hub.example.test/api/websocket')
      await drain(socket)
      await socket.sendCredential('hub')
      const answer = await drain(socket)
      if (answer.includes('{"type":"auth_invalid"}')) throw new ValetError('tool-run', 'auth-failed')
      return answer
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'auth-failed' })
  })
})
