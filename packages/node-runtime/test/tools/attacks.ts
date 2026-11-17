// The red team's tools (test/redteam): each one is something hostile adapter code would try, and
// reports what happened, so a test can check it was refused.

import { z } from 'zod'

declare const require: (id: string) => any

const outcome = z.record(z.string(), z.unknown())
const input = z.record(z.string(), z.unknown())

const codeOf = (error: unknown): string => {
  const e = error as { code?: unknown; cause?: { code?: unknown } }
  if (typeof e?.cause?.code === 'string') return e.cause.code
  if (typeof e?.code === 'string') return e.code
  return String((error as Error)?.message ?? error).slice(0, 200)
}

const attempt = async (f: () => unknown): Promise<Record<string, unknown>> => {
  try {
    return { ok: true, value: (await f()) as unknown }
  } catch (error) {
    return { ok: false, code: codeOf(error) }
  }
}

const tool = (run: (args: any) => unknown) => ({
  description: 'attack',
  input,
  output: outcome,
  run: (_ctx: unknown, args: unknown) => run(args),
})

/** Connects with whatever socket `make` gives, and resolves with what came back or rejects. */
function reach(make: () => any, send = 'ping'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = make()
    let data = ''
    socket.setEncoding?.('utf8')
    socket.on('connect', () => socket.write(send))
    socket.on('data', (d: string) => {
      data += d
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => reject(new Error('timeout')), 4_000)
  })
}

export const tools = {
  /** Fills memory outside V8's heap, where the heap cap doesn't look. */
  bufferHog: tool(() => {
    const keep: Buffer[] = []
    for (;;) keep.push(Buffer.alloc(32 * 1024 * 1024, keep.length))
  }),
  /** Ways around the shim to a host and port nobody declared. */
  aroundTheShim: tool(async ({ port }: { port: number }) => {
    const net = require('node:net')
    return {
      // Node's own TCP binding, under the shim.
      binding: await attempt(() => (process as any).binding('tcp_wrap')),
      // A fresh copy of the module system, hoping for an unpatched net.
      freshRequire: await attempt(() => {
        const { createRequire } = require('node:module')
        const fresh = createRequire('/nonexistent/x.js')('node:net')
        return reach(() => fresh.connect({ host: '127.0.0.1', port }))
      }),
      // The prototype the shim patched, reached through a TLS socket's parent class.
      viaTls: await attempt(() =>
        reach(() => require('node:tls').connect({ host: '127.0.0.1', port, rejectUnauthorized: false })),
      ),
      // A synthetic address with a port that isn't declared.
      synthetic: await attempt(() => reach(() => net.connect({ host: '198.18.0.1', port }))),
      // IPv6 loopback and the IPv4-mapped form.
      ipv6: await attempt(() => reach(() => net.connect({ host: '::1', port }))),
      mapped: await attempt(() => reach(() => net.connect({ host: '::ffff:127.0.0.1', port }))),
      // Host names that only look declared.
      suffix: await attempt(() =>
        reach(() => net.connect({ host: 'echo.example.test.attacker.test', port: 7000 })),
      ),
      prefix: await attempt(() => reach(() => net.connect({ host: 'x.echo.example.test', port: 7000 }))),
      // A Unix socket.
      unix: await attempt(() => reach(() => net.connect({ path: '/var/run/mDNSResponder' }))),
    }
  }),
  /** Reaching processes, signals and the person's files with what Node offers. */
  outOfProcess: tool(async ({ home }: { home: string }) => {
    const fs = require('node:fs')
    return {
      killParent: await attempt(() => process.kill(process.ppid, 0)),
      inspector: await attempt(() => require('node:inspector').open(0)),
      wasi: await attempt(() => new (require('node:wasi').WASI)({ version: 'preview1' })),
      dlopen: await attempt(() => (process as any).dlopen({ exports: {} }, '/usr/lib/libz.dylib')),
      fsBinding: await attempt(() => (process as any).binding('fs')),
      // The permission model by path, through a symlink, a relative climb, a URL and a Buffer.
      etc: await attempt(() => fs.readFileSync('/etc/passwd', 'utf8').length),
      climb: await attempt(() => fs.readFileSync('../../../../../../../../etc/passwd', 'utf8').length),
      url: await attempt(() => fs.readFileSync(new URL('file:///etc/passwd'), 'utf8').length),
      buffer: await attempt(() => fs.readFileSync(Buffer.from('/etc/passwd'), 'utf8').length),
      symlink: await attempt(() => {
        const link = `${process.env['TMPDIR']}link`
        fs.symlinkSync('/etc/passwd', link)
        return fs.readFileSync(link, 'utf8').length
      }),
      home: await attempt(() => fs.readdirSync(home).length),
    }
  }),
}
