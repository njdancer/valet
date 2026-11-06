// @vitest-environment node
// The IPC dispatcher: every request is refused unless it comes from the main frame of one of the
// app's windows, on the app's own page, on one of our channels, with arguments matching that
// channel's schema exactly.

import { describe, expect, it, vi } from 'vitest'
import { INVOKE_METHODS, invokeChannel } from '../../src/main/core/channels'
import { createDispatcher, IpcRefused, type MainApi, methodOf, type Sender } from '../../src/main/core/ipc'

const PAGE = 'file:///Applications/siteadapter.app/Contents/Resources/app/out/renderer/index.html#/adapters'
const isAppPage = (url: string) =>
  url.startsWith('file:///Applications/siteadapter.app/Contents/Resources/app/out/renderer/')
const control: Sender = { role: 'control', frameUrl: PAGE, mainFrame: true }
const HASH = 'a'.repeat(64)

/** An API whose every method records its arguments and resolves with a marker. */
function recordingApi() {
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return { method }
    }
  const tree: Record<string, unknown> = {}
  for (const method of INVOKE_METHODS) {
    const parts = method.split('.')
    let node = tree
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {}
      node = node[part] as Record<string, unknown>
    }
    node[parts.at(-1) as string] = record(method)
  }
  return { api: tree as unknown as MainApi, calls }
}

function dispatcher() {
  const { api, calls } = recordingApi()
  const refused = vi.fn()
  return { d: createDispatcher(api, { isAppPage, onRefused: refused }), calls, refused }
}

describe('channels', () => {
  it('maps only our exact channel names to methods', () => {
    expect(methodOf('siteadapter:adapters.list')).toBe('adapters.list')
    expect(methodOf('adapters.list')).toBeNull()
    expect(methodOf('siteadapter:adapters.list ')).toBeNull()
    expect(methodOf('siteadapter:__proto__')).toBeNull()
    expect(methodOf('siteadapter:constructor')).toBeNull()
    expect(methodOf('siteadapter:adapters')).toBeNull()
  })

  it('reaches the API for a valid request', async () => {
    const { d, calls } = dispatcher()
    await expect(d.dispatch(invokeChannel('adapters.get'), ['woolworths'], control)).resolves.toEqual({
      method: 'adapters.get',
    })
    expect(calls).toEqual([{ method: 'adapters.get', args: ['woolworths'] }])
  })
})

describe('who may send', () => {
  const cases: [string, Sender][] = [
    ['a window that is not ours', { role: null, frameUrl: PAGE, mainFrame: true }],
    ['a subframe of our window', { ...control, mainFrame: false }],
    ['our window showing another page', { ...control, frameUrl: 'https://evil.test/index.html' }],
    ['our window showing a lookalike file', { ...control, frameUrl: 'file:///tmp/out/renderer/index.html' }],
    ['an empty frame URL', { ...control, frameUrl: '' }],
  ]
  for (const [name, sender] of cases) {
    it(`refuses ${name}`, async () => {
      const { d, calls, refused } = dispatcher()
      await expect(d.dispatch(invokeChannel('adapters.list'), [], sender)).rejects.toBeInstanceOf(IpcRefused)
      expect(calls).toEqual([])
      expect(refused).toHaveBeenCalledWith('adapters.list', 'sender')
    })
  }

  it('refuses an unknown channel before looking at anything else', async () => {
    const { d, calls, refused } = dispatcher()
    await expect(d.dispatch('siteadapter:grants.export', [], control)).rejects.toBeInstanceOf(IpcRefused)
    expect(calls).toEqual([])
    expect(refused).toHaveBeenCalledWith(null, 'channel')
  })
})

describe('arguments', () => {
  const refusedArgs: [string, string, unknown[]][] = [
    ['an extra argument', 'adapters.list', ['x']],
    ['a missing argument', 'adapters.get', []],
    ['an adapter id with a path in it', 'adapters.get', ['../woolworths']],
    ['an oversized adapter id', 'adapters.get', ['a'.repeat(65)]],
    ['a short hash', 'approvals.approve', ['woolworths', 'abc']],
    ['an uppercase hash', 'approvals.approve', ['woolworths', 'A'.repeat(64)]],
    ['a number where a string goes', 'adapters.get', [42]],
    ['an unknown provider', 'grants.vaultItems', ['keychain']],
    ['a call id with spaces', 'runs.trace', ['call one']],
    ['an oversized copy', 'app.copyText', ['x'.repeat(10_001)]],
    ['a URL for a route', 'app.openControlPanel', ['https://evil.test/#/adapters']],
    ['a file URL for a route', 'app.openControlPanel', ['file:///etc/passwd#/adapters']],
    ['a route parseRoute reads as not found', 'app.openControlPanel', ['#/nowhere']],
    ['a non-boolean answer', 'answerConfirmation', ['cf_1', 'yes']],
    ['an unknown client kind', 'endpoint.copyClientConfig', ['cursor']],
    ['an undefined optional argument', 'runs.list', [undefined]],
  ]
  for (const [name, method, args] of refusedArgs) {
    it(`refuses ${name}`, async () => {
      const { d, calls } = dispatcher()
      await expect(
        d.dispatch(invokeChannel(method as (typeof INVOKE_METHODS)[number]), args, control),
      ).rejects.toBeInstanceOf(IpcRefused)
      expect(calls).toEqual([])
    })
  }

  const grant = {
    adapterId: 'woolworths',
    adapterHash: HASH,
    secret: 'login',
    provider: 'onepassword-cli',
    itemRef: 'abc123',
    origins: ['https://auth.woolworths.com.au'],
  }

  it('passes a well-formed grant request through as a fresh object', async () => {
    const { d, calls } = dispatcher()
    await d.dispatch(invokeChannel('grants.make'), [grant], control)
    expect(calls[0]?.args[0]).toEqual(grant)
    expect(calls[0]?.args[0]).not.toBe(grant)
  })

  it.each([
    ['an extra key', { ...grant, itemRefContents: 'op://siteadapter/Woolworths/password' }],
    ['an opPath key smuggled in', { ...grant, opPath: '/tmp/op' }],
    ['no origins', { ...grant, origins: [] }],
    ['too many origins', { ...grant, origins: Array.from({ length: 21 }, (_, i) => `https://o${i}.test`) }],
    ['a control character in the item', { ...grant, itemRef: 'abc\u0000' }],
    ['a bidi override in the item', { ...grant, itemRef: 'abc‮' }],
    ['an oversized item', { ...grant, itemRef: 'a'.repeat(201) }],
  ])('refuses a grant request with %s', async (_name, request) => {
    const { d, calls } = dispatcher()
    await expect(d.dispatch(invokeChannel('grants.make'), [request], control)).rejects.toBeInstanceOf(
      IpcRefused,
    )
    expect(calls).toEqual([])
  })

  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses a %s key in an object argument',
    async (key) => {
      const { d, calls } = dispatcher()
      // As a structured clone of JSON would deliver it: an own property with that name.
      const polluted = JSON.parse(`{"launchAtLogin": true, "${key}": {"opPath": "/tmp/op"}}`)
      await expect(d.dispatch(invokeChannel('settings.set'), [polluted], control)).rejects.toBeInstanceOf(
        IpcRefused,
      )
      const query = JSON.parse(`{"limit": 5, "${key}": {"isAdmin": true}}`)
      await expect(d.dispatch(invokeChannel('audit.page'), [query], control)).rejects.toBeInstanceOf(
        IpcRefused,
      )
      expect(calls).toEqual([])
      expect(({} as Record<string, unknown>)['opPath']).toBeUndefined()
    },
  )

  it('refuses opPath in a settings patch: only chooseOpPath changes it', async () => {
    const { d, calls } = dispatcher()
    await expect(
      d.dispatch(invokeChannel('settings.set'), [{ opPath: '/tmp/op' }], control),
    ).rejects.toBeInstanceOf(IpcRefused)
    expect(calls).toEqual([])
  })

  it('drops undefined optional keys rather than passing them on', async () => {
    const { d, calls } = dispatcher()
    await d.dispatch(invokeChannel('audit.page'), [{ limit: 5, search: undefined }], control)
    expect(calls[0]?.args[0]).toEqual({ limit: 5 })
    expect(Object.keys(calls[0]?.args[0] as object)).toEqual(['limit'])
  })

  it('accepts optional arguments left out, and a checked route', async () => {
    const { d, calls } = dispatcher()
    await d.dispatch(invokeChannel('runs.list'), [], control)
    await d.dispatch(invokeChannel('app.openControlPanel'), [], control)
    await d.dispatch(invokeChannel('app.openControlPanel'), ['#/adapters/woolworths/review'], control)
    expect(calls.map((c) => c.args)).toEqual([[], [], ['#/adapters/woolworths/review']])
  })

  it('refuses an audit query with a bad date, a huge limit or an oversized search', async () => {
    const { d } = dispatcher()
    for (const query of [
      { since: 'yesterday' },
      { limit: 10_000 },
      { search: 'x'.repeat(201) },
      { beforeSeq: 0 },
    ]) {
      await expect(d.dispatch(invokeChannel('audit.page'), [query], control)).rejects.toBeInstanceOf(
        IpcRefused,
      )
    }
  })
})

describe('confirmation answers', () => {
  it('tells the service which window answered', async () => {
    const { d, calls } = dispatcher()
    await d.dispatch(invokeChannel('answerConfirmation'), ['cf_abc', true], {
      role: 'confirmation',
      frameUrl: `${PAGE.split('#')[0]}#/confirm/cf_abc`,
      mainFrame: true,
    })
    await d.dispatch(invokeChannel('answerConfirmation'), ['cf_abc', true], control)
    expect(calls.map((c) => c.args)).toEqual([
      ['cf_abc', true, 'confirmation'],
      ['cf_abc', true, 'control'],
    ])
  })
})

describe('failures', () => {
  it('rejects with a fixed error that says nothing of what went wrong', async () => {
    const { api } = recordingApi()
    const failing = {
      ...api,
      grants: {
        ...api.grants,
        list: async () => {
          throw new Error('grant file at /Users/nick/Library has op://siteadapter/Woolworths')
        },
      },
    } as MainApi
    const d = createDispatcher(failing, { isAppPage })
    const error = await d.dispatch(invokeChannel('grants.list'), [], control).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IpcRefused)
    expect((error as Error).message).toBe('siteadapter: request refused')
  })
})
