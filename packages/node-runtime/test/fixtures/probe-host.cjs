// The runtime's profile probed directly (profile.test.ts): a stand-in for the host script with no
// shim and, when the test asks, without Node's permission model, so what is refused here is refused
// by Seatbelt alone. It takes `init` with a JSON list of attempts and answers `done` with each
// attempt's outcome: "ok" or the error code.

'use strict'

const net = require('node:net')
const fs = require('node:fs')

const channel = new net.Socket({ fd: 3, readable: true, writable: true })
channel.setEncoding('utf8')
const post = (m) => channel.write(`${JSON.stringify(m)}\n`)
let tunnels = {}

const code = (e) => (e && typeof e.code === 'string' ? e.code : String((e && e.message) || e).slice(0, 120))

function connect(options) {
  return new Promise((resolve) => {
    const socket = net.connect(options)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('timeout')
    }, 3_000)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve('ok')
    })
    socket.on('error', (e) => {
      clearTimeout(timer)
      resolve(code(e))
    })
  })
}

const actions = {
  connect: (a) => connect({ host: a.host, port: a.port === 'tunnel' ? Object.values(tunnels)[0] : a.port }),
  unix: (a) => connect({ path: a.path }),
  udp: (a) =>
    new Promise((resolve) => {
      const socket = require('node:dgram').createSocket('udp4')
      socket.on('error', (e) => resolve(code(e)))
      socket.send('x', a.port, a.host, (e) => {
        socket.close()
        resolve(e ? code(e) : 'ok')
      })
    }),
  read: (a) => (fs.readFileSync(a.path), 'ok'),
  list: (a) => (fs.readdirSync(a.path), 'ok'),
  stat: (a) => (fs.statSync(a.path), 'ok'),
  write: (a) => (fs.writeFileSync(a.path === 'temp' ? `${process.env.TMPDIR}w.txt` : a.path, 'x'), 'ok'),
  symlinkRead: (a) => {
    const link = `${process.env.TMPDIR}s-${Math.random()}`
    fs.symlinkSync(a.target, link)
    fs.readFileSync(link)
    return 'ok'
  },
  hardlinkRead: (a) => {
    const link = `${process.env.TMPDIR}h-${Math.random()}`
    fs.linkSync(a.target, link)
    fs.readFileSync(link)
    return 'ok'
  },
  renameOut: (a) => {
    const file = `${process.env.TMPDIR}r.txt`
    fs.writeFileSync(file, 'x')
    fs.renameSync(file, a.to)
    return 'ok'
  },
  spawn: (a) => {
    const r = require('node:child_process').spawnSync(a.program, a.args || [], { encoding: 'utf8' })
    if (r.error) throw r.error
    return r.status === 0 ? 'ok' : `exit ${r.status}`
  },
  signal: (a) => (process.kill(a.pid === 'parent' ? process.ppid : a.pid, 0), 'ok'),
  self: () => (process.kill(process.pid, 0), 'ok'),
  userInfo: () => (require('node:os').userInfo(), 'ok'),
  interfaces: () => (require('node:os').networkInterfaces(), 'ok'),
  date: () =>
    new Date().toString().length > 0 && Intl.DateTimeFormat().resolvedOptions().timeZone ? 'ok' : 'no',
  crypto: () => (require('node:crypto').randomBytes(16).length === 16 ? 'ok' : 'no'),
}

let buffer = ''
channel.on('data', async (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    const m = JSON.parse(line)
    if (m.t === 'boot') tunnels = m.tunnels
    if (m.t !== 'init') continue
    const results = {}
    for (const attempt of JSON.parse(m.script)) {
      try {
        results[attempt.name] = await actions[attempt.action](attempt)
      } catch (e) {
        results[attempt.name] = code(e)
      }
    }
    post({ t: 'done', ok: true, value: results })
  }
})
