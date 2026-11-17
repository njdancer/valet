// The Node runtime's host script (docs/node-runtime.md). It is the entry point of every `raw`
// adapter process: the separately signed Node binary runs it under the adapter's Seatbelt profile
// (profile.ts), with Node's permission model on as well. Plain JavaScript with no imports beyond
// Node's own, so it needs no build step and nothing else has to be readable.
//
// The channel to Valet is file descriptor 3: newline-separated JSON, both ways. The first message is
// `boot` (the bootstrap text and the tunnel ports); after it come the messages every isolated tool
// process speaks (packages/runtime/src/isolation/protocol.ts): init, run, reply, abort, describe,
// check. What this process sends back is checked by the host as untrusted, because adapter code runs
// here and can write to the channel itself. Nothing here is a security boundary: the profile is.
//
// The network shim is for compatibility only. It points `net` connections (and so `tls`, `http`,
// `https` and the global `fetch`) for a declared endpoint at that endpoint's loopback tunnel, and
// makes `dns.lookup` answer for declared hosts without asking DNS, so ordinary npm packages work
// without knowing about Valet. Code that goes around it reaches nothing more: the profile allows
// connections to the tunnel ports alone.

'use strict'

const net = require('node:net')
const dns = require('node:dns')
const vm = require('node:vm')
const { createRequire } = require('node:module')

/** The longest line accepted from Valet: MAX_MESSAGE_CHARS in the protocol, plus the envelope. */
const MAX_LINE = 4_100_000
/** Where synthetic addresses for declared host names start (198.18.0.0/15, never routed). */
const SYNTHETIC_PREFIX = '198.18.'

const channel = new net.Socket({ fd: 3, readable: true, writable: true })
channel.setEncoding('utf8')

const post = (message) => {
  try {
    channel.write(`${JSON.stringify(message)}\n`)
  } catch {}
}

/** endpoint ("host:port", host lowercased, IPv6 without brackets) → loopback tunnel port. */
let tunnels = new Map()
/** host → synthetic address, and back. */
const synthetic = new Map()
const syntheticHost = new Map()
let deliver = null

const denied = (host, port) => {
  const error = new Error(`Valet: ${host}:${port} is not one of this adapter's endpoints`)
  error.code = 'EVALETDENIED'
  error.syscall = 'connect'
  error.address = host
  error.port = port
  return error
}

function endpointKey(host, port) {
  let h = String(host).toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (syntheticHost.has(h)) h = syntheticHost.get(h)
  return `${h}:${Number(port)}`
}

function installShim() {
  const tunnelPorts = new Set(tunnels.values())
  const hosts = new Set([...tunnels.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))))
  let next = 1
  for (const h of [...hosts].sort()) {
    if (net.isIP(h) !== 0) continue
    const address = `${SYNTHETIC_PREFIX}${Math.floor(next / 256)}.${next % 256}`
    next += 1
    synthetic.set(h, address)
    syntheticHost.set(address, h)
  }

  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function connect(...args) {
    // Node's own argument rules (port, host, listener; options, listener; path, listener). net.connect
    // hands over an array it already normalised.
    const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args)
    const options = normalized[0]
    const callback = normalized[1]
    // Node takes any truthy `path` as a Unix socket, and only that (an HTTP request's path arrives
    // as null). The profile refuses Unix sockets; let Node report how.
    if (options === null || typeof options !== 'object' || options.path) {
      return originalConnect.apply(this, args)
    }
    const host = options.host === undefined ? 'localhost' : options.host
    const port = Number(options.port)
    // Already pointed at a tunnel (a second connect of a reused socket, or code that knows).
    if ((host === '127.0.0.1' || host === 'localhost') && tunnelPorts.has(port)) {
      return originalConnect.apply(this, args)
    }
    const tunnel = tunnels.get(endpointKey(host, port))
    if (tunnel === undefined) {
      const error = denied(host, port)
      process.nextTick(() => this.destroy(error))
      return this
    }
    const rewritten = { ...options, host: '127.0.0.1', port: tunnel, family: 4 }
    delete rewritten.lookup
    delete rewritten.localAddress
    delete rewritten.localPort
    return callback === null || callback === undefined
      ? originalConnect.call(this, rewritten)
      : originalConnect.call(this, rewritten, callback)
  }

  const answer = (hostname) => {
    const h = String(hostname).toLowerCase().replace(/\.$/, '')
    if (net.isIP(h) !== 0) return { address: h, family: net.isIP(h) }
    const address = synthetic.get(h)
    return address === undefined ? null : { address, family: 4 }
  }
  const notFound = (hostname) => {
    const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
    error.code = 'ENOTFOUND'
    error.syscall = 'getaddrinfo'
    error.hostname = hostname
    return error
  }
  const lookup = function lookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    const all = options !== null && typeof options === 'object' && options.all === true
    const found = answer(hostname)
    process.nextTick(() => {
      if (found === null) cb(notFound(hostname))
      else if (all) cb(null, [found])
      else cb(null, found.address, found.family)
    })
  }
  dns.lookup = lookup
  dns.promises.lookup = (hostname, options) => {
    const found = answer(hostname)
    if (found === null) return Promise.reject(notFound(hostname))
    return Promise.resolve(
      options !== null && typeof options === 'object' && options.all === true ? [found] : found,
    )
  }
}

function evaluate(script, bootstrap) {
  // Tool code sees Node, as `raw` promises: `require` for Node's built-ins, `process`, timers and
  // the global `fetch`. What it can reach with them is the profile's business.
  globalThis.require = createRequire(__filename)
  globalThis.__filename = __filename
  globalThis.__dirname = __dirname
  vm.runInThisContext(script, { filename: 'tool-script.js' })
  const start = vm.runInThisContext(bootstrap, { filename: 'valet-bootstrap.js' })
  const inner = start((text) => {
    if (typeof text === 'string') channel.write(`${text}\n`)
  })
  return (text) => {
    try {
      inner(text)
    } catch {}
  }
}

let buffer = ''
let booted = false
let bootstrapText = null

function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object') return
  if (!booted) {
    if (message.t !== 'boot' || typeof message.bootstrap !== 'string') return
    booted = true
    bootstrapText = message.bootstrap
    const map = message.tunnels !== null && typeof message.tunnels === 'object' ? message.tunnels : {}
    tunnels = new Map(Object.entries(map).filter(([, port]) => Number.isInteger(port)))
    installShim()
    return
  }
  if (message.t === 'init') {
    if (deliver !== null || typeof message.script !== 'string') return
    try {
      deliver = evaluate(message.script, bootstrapText)
    } catch {
      post({ t: 'done', ok: false, error: { kind: 'other' } })
      deliver = () => {}
      return
    }
    post({ t: 'ready' })
    return
  }
  if (deliver !== null) deliver(line)
}

channel.on('data', (chunk) => {
  buffer += chunk
  if (buffer.length > MAX_LINE && !buffer.includes('\n')) process.exit(70)
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    handle(line)
    index = buffer.indexOf('\n')
  }
})
// Valet went away: nothing left to answer to.
channel.on('end', () => process.exit(0))
channel.on('error', () => process.exit(0))
