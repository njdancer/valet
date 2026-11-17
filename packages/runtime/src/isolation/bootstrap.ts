// The script every isolated tool run evaluates around the adapter's tool script: the prelude
// before it and the bootstrap after it. Shared by the `vm` worker (worker.ts) and the QuickJS
// sandbox (packages/sandbox), so a tool behaves the same in both. No imports: the sandbox
// renderer's preload bundles this file.

/** Run in the fresh context before the tool script, so the script never sees what it removes. */
export const PRELUDE = `'use strict'; delete globalThis.SharedArrayBuffer; delete globalThis.Atomics; delete globalThis.WebAssembly; delete globalThis.console;`

/**
 * Inside the context. `send` is the only host function it ever holds, kept in this closure and
 * called with strings; what it throws is never rethrown. It returns `deliver`, which the host calls
 * with JSON text. The tool script must define `__valetTools` (its IIFE's global) with `tools`,
 * `ValetError` and `NeedsUserError`, and for `describe`, zod's `toJSONSchema`.
 *
 * The tool's own zod schemas parse its input before `run` and its output after, here inside the
 * context, so a transform, default or refinement behaves exactly as written without adapter code
 * running in the main process. The main process checks both again against JSON Schemas derived
 * from the same zod (docs/adapter-packages.md#schemas-without-adapter-code-in-the-main-process).
 */
export const BOOTSTRAP = `(function (send) {
  'use strict'
  // False when the message isn't JSON (a cycle, say); what send throws is never rethrown either way.
  const post = (message) => {
    let text
    try { text = JSON.stringify(message) } catch { return false }
    if (typeof text !== 'string') return false
    try { send(text) } catch {}
    return true
  }
  const lib = globalThis.__valetTools
  // A var the script declared, so it can't be deleted; emptied instead.
  globalThis.__valetTools = undefined
  if (!lib || typeof lib !== 'object') { post({ t: 'done', ok: false, error: { kind: 'other' } }); return () => {} }
  const { tools, ValetError, NeedsUserError, toJSONSchema } = lib
  let url = ''
  let next = 1
  const pending = new Map()
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) { if (type === 'abort' && typeof listener === 'function') listeners.add(listener) },
    removeEventListener(type, listener) { listeners.delete(listener) },
    throwIfAborted() { if (signal.aborted) throw new ValetError('tool-run', 'aborted') },
  }
  const fromWire = (error) => {
    if (error && error.kind === 'valet') return new ValetError(error.stage, error.errorClass, error.issue)
    if (error && error.kind === 'needsUser') return new NeedsUserError(error.reason)
    return new Error('capability failed')
  }
  // A failure's own words, kept only for a run that asks (an author's cases): see protocol.ts.
  const details = new WeakMap()
  const clipDetail = (text) => text.length > 300 ? text.slice(0, 299) + '…' : text
  const messageOf = (error) => {
    try {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
        const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
        return error.message === '' ? name : name + ': ' + error.message
      }
      return String(error)
    } catch { return undefined }
  }
  const issuesOf = (zodError) => {
    try {
      const issues = Array.isArray(zodError && zodError.issues) ? zodError.issues.slice(0, 3) : []
      return issues.map((issue) => {
        let path = ''
        for (const p of Array.isArray(issue.path) ? issue.path : []) {
          path += typeof p === 'number' ? '[' + p + ']' : (path === '' ? '' : '.') + String(p)
        }
        if (path === '') path = '(top level)'
        return path + ': ' + String(issue.message)
      }).join('; ')
    } catch { return undefined }
  }
  const toWire = (error, withDetail) => {
    let wire
    if (error instanceof ValetError) wire = error.issue === undefined ? { kind: 'valet', stage: error.stage, errorClass: error.errorClass } : { kind: 'valet', stage: error.stage, errorClass: error.errorClass, issue: error.issue }
    else if (error instanceof NeedsUserError) return { kind: 'needsUser', reason: error.reason }
    else wire = { kind: 'other' }
    if (withDetail) {
      const text = (error !== null && typeof error === 'object' && details.has(error))
        ? details.get(error)
        : wire.kind === 'other' ? messageOf(error) : undefined
      if (typeof text === 'string' && text !== '') wire.detail = clipDetail(text)
    }
    return wire
  }
  const call = (capability, ...args) => {
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
    const id = next++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (!post({ t: 'call', id, capability, args })) {
        pending.delete(id)
        reject(new ValetError('tool-run', 'invalid'))
      }
    })
  }
  const ctx = Object.freeze({
    page: Object.freeze({
      goto: (u) => call('page.goto', u).then(() => undefined),
      currentUrl: () => url,
      click: (s) => call('page.click', s).then(() => undefined),
      fill: (s, t) => call('page.fill', s, t).then(() => undefined),
      extract: (s, o) => call('page.extract', s, o),
      evaluate: (source, a) => call('page.evaluate', source, a),
      fetch: (p, init) => call('page.fetch', p, init),
    }),
    session: Object.freeze({ ensure: () => call('session.ensure') }),
    confirm: (action) => call('confirm', action),
    signal,
    // Each needs its declared exception; the host refuses the rest (docs/sandbox.md).
    local: Object.freeze({
      files: Object.freeze({
        list: (d) => call('local.files.list', d),
        stat: (p) => call('local.files.stat', p),
        read: (p, o) => call('local.files.read', p, o),
        write: (p, c, o) => call('local.files.write', p, c, o).then(() => undefined),
        mkdir: (d) => call('local.files.mkdir', d).then(() => undefined),
      }),
      fetch: (u, init) => call('local.fetch', u, init),
      service: (port, p, init) => call('local.service', port, p, init),
      run: (args, o) => call('local.run', args, o),
      appleScript: (id, source) => call('local.appleScript', id, source),
    }),
    // The egress broker, for an adapter whose runtime isn't browser (docs/adapter-kinds.md#ctxhttp).
    http: Object.freeze({
      fetch: (u, init) => call('http.fetch', u, init),
      websocket: (u, options) => call('http.ws.open', u, options).then((opened) => {
        const id = opened && opened.id
        return Object.freeze({
          send: (data, o) => call('http.ws.send', id, data, o).then(() => undefined),
          receive: (o) => call('http.ws.receive', id, o),
          close: () => call('http.ws.close', id).then(() => undefined),
        })
      }),
    }),
    // Credentials entrusted to a raw adapter (docs/adapter-kinds.md#raw); not-granted for the rest.
    secrets: Object.freeze({ get: (name) => call('secrets.get', name) }),
    // The protocol host, for a protocol adapter with IMAP (docs/imap.md). Each operation is one call.
    imap: Object.freeze(Object.fromEntries(['listFolders', 'status', 'search', 'fetch', 'message', 'attachment',
      'setFlags', 'copy', 'move', 'append', 'createFolder', 'expunge', 'deleteFolder']
      .map((name) => [name, (...args) => {
        while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
        return call('imap.op', name, args)
      }]))),
  })
  return function deliver(text) {
    const m = JSON.parse(text)
    if (typeof m.url === 'string') url = m.url
    if (m.t === 'run') {
      const impl = Object.prototype.hasOwnProperty.call(tools, m.tool) ? tools[m.tool] : undefined
      if (!impl || typeof impl.run !== 'function') { post({ t: 'done', ok: false, error: { kind: 'valet', stage: 'manifest', errorClass: 'not-found' } }); return }
      const withDetail = m.detail === true
      const parse = (schema, value, stage) => {
        if (!schema || typeof schema.safeParseAsync !== 'function') return Promise.resolve(value)
        return schema.safeParseAsync(value).then((r) => {
          if (r && r.success === true) return r.data
          const error = new ValetError(stage, 'invalid')
          if (withDetail) {
            const text = issuesOf(r && r.error)
            if (typeof text === 'string' && text !== '') details.set(error, text)
          }
          throw error
        })
      }
      Promise.resolve()
        .then(() => parse(impl.input, m.input, 'tool-input'))
        .then((input) => impl.run(ctx, input))
        .then((raw) => parse(impl.output, raw, 'tool-output'))
        .then(
          (value) => value === undefined ? post({ t: 'done', ok: true }) : post({ t: 'done', ok: true, value }),
          (error) => post({ t: 'done', ok: false, error: toWire(error, withDetail) }),
        )
        .then((sent) => { if (!sent) post({ t: 'done', ok: false, error: { kind: 'valet', stage: 'tool-output', errorClass: 'invalid' } }) })
    } else if (m.t === 'check') {
      // The tool's own input schema, before anything about the call has happened (settings, a
      // confirmation): a refinement that refuses the input refuses the call while nothing is sent.
      const impl = Object.prototype.hasOwnProperty.call(tools, m.tool) ? tools[m.tool] : undefined
      if (!impl || !impl.input || typeof impl.input.safeParseAsync !== 'function') { post({ t: 'checked', ok: false }); return }
      Promise.resolve()
        .then(() => impl.input.safeParseAsync(m.input))
        .then((r) => {
          if (r && r.success === true) return post({ t: 'checked', ok: true })
          // The first issue's codes, path and bounds only, never its message: the host maps them to
          // its own vocabulary and trusts nothing else in them.
          const first = r && r.error && Array.isArray(r.error.issues) ? r.error.issues[0] : undefined
          const issue = {}
          if (first && typeof first === 'object') {
            for (const key of ['code', 'path', 'keys', 'minimum', 'maximum', 'inclusive', 'origin']) {
              const value = first[key]
              if (typeof value === 'bigint') issue[key] = Number(value)
              else if (value !== undefined && typeof value !== 'function' && typeof value !== 'symbol') issue[key] = value
            }
            if (Array.isArray(issue.path)) issue.path = issue.path.filter((p) => typeof p === 'string' || typeof p === 'number')
            if (first.params && typeof first.params === 'object') issue.params = { reason: first.params.reason, limit: first.params.limit }
          }
          if (!post({ t: 'checked', ok: false, issue })) post({ t: 'checked', ok: false })
        }, () => post({ t: 'checked', ok: false }))
    } else if (m.t === 'describe') {
      // Each tool's schemas as JSON Schema, 'missing' where the tool gives none, or null where one
      // can't be represented; the host bounds and checks what comes back before it uses any of it.
      const described = {}
      const convert = (schema, io) => {
        if (schema === undefined || schema === null) return 'missing'
        try { return toJSONSchema(schema, { io, target: 'draft-7' }) } catch { return null }
      }
      for (const name of Object.keys(tools || {})) {
        const impl = tools[name]
        if (!impl || typeof impl !== 'object' || typeof toJSONSchema !== 'function') { described[name] = null; continue }
        described[name] = { input: convert(impl.input, 'input'), output: convert(impl.output, 'output') }
      }
      if (!post({ t: 'described', tools: described })) post({ t: 'described', tools: null })
    } else if (m.t === 'reply') {
      const waiting = pending.get(m.id)
      if (!waiting) return
      pending.delete(m.id)
      if (m.ok) waiting.resolve(m.value)
      else waiting.reject(fromWire(m.error))
    } else if (m.t === 'abort') {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = new ValetError('tool-run', 'aborted')
      for (const listener of listeners) { try { listener() } catch {} }
    }
  }
})`
