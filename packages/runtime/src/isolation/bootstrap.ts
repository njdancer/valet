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
    if (error && error.kind === 'valet') return new ValetError(error.stage, error.errorClass)
    if (error && error.kind === 'needsUser') return new NeedsUserError(error.reason)
    return new Error('capability failed')
  }
  const toWire = (error) => {
    if (error instanceof ValetError) return { kind: 'valet', stage: error.stage, errorClass: error.errorClass }
    if (error instanceof NeedsUserError) return { kind: 'needsUser', reason: error.reason }
    return { kind: 'other' }
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
  })
  return function deliver(text) {
    const m = JSON.parse(text)
    if (typeof m.url === 'string') url = m.url
    if (m.t === 'run') {
      const impl = Object.prototype.hasOwnProperty.call(tools, m.tool) ? tools[m.tool] : undefined
      if (!impl || typeof impl.run !== 'function') { post({ t: 'done', ok: false, error: { kind: 'valet', stage: 'manifest', errorClass: 'not-found' } }); return }
      const parse = (schema, value, stage) => {
        if (!schema || typeof schema.safeParseAsync !== 'function') return Promise.resolve(value)
        return schema.safeParseAsync(value).then((r) => {
          if (r && r.success === true) return r.data
          throw new ValetError(stage, 'invalid')
        })
      }
      Promise.resolve()
        .then(() => parse(impl.input, m.input, 'tool-input'))
        .then((input) => impl.run(ctx, input))
        .then((raw) => parse(impl.output, raw, 'tool-output'))
        .then(
          (value) => value === undefined ? post({ t: 'done', ok: true }) : post({ t: 'done', ok: true, value }),
          (error) => post({ t: 'done', ok: false, error: toWire(error) }),
        )
        .then((sent) => { if (!sent) post({ t: 'done', ok: false, error: { kind: 'valet', stage: 'tool-output', errorClass: 'invalid' } }) })
    } else if (m.t === 'check') {
      // The tool's own input schema, before anything about the call has happened (settings, a
      // confirmation): a refinement that refuses the input refuses the call while nothing is sent.
      const impl = Object.prototype.hasOwnProperty.call(tools, m.tool) ? tools[m.tool] : undefined
      if (!impl || !impl.input || typeof impl.input.safeParseAsync !== 'function') { post({ t: 'checked', ok: false }); return }
      Promise.resolve()
        .then(() => impl.input.safeParseAsync(m.input))
        .then((r) => post({ t: 'checked', ok: !!(r && r.success === true) }), () => post({ t: 'checked', ok: false }))
    } else if (m.t === 'describe') {
      // Each tool's schemas as JSON Schema, or null where one can't be represented; the host
      // bounds and checks what comes back before it uses any of it.
      const described = {}
      const convert = (schema, io) => {
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
