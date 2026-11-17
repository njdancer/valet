// A raw adapter's tools for the runtime's tests: each one does one thing with Node and reports what
// happened, success or the error code, so a test can check both what works and what is refused.

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

function tcp(host: string, port: number, send: string): Promise<string> {
  const net = require('node:net')
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(send))
    socket.on('data', (d: string) => {
      data += d
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => reject(new Error('timeout')), 5_000)
  })
}

// biome-ignore lint/suspicious/noExplicitAny: probes take whatever the test sends
type Args = any

const tool = (run: (args: Args, ctx: any) => unknown) => ({
  input,
  output: outcome,
  run: (ctx: any, args: Args) => run(args, ctx),
})

export const tools = {
  echo: tool(async (args) => ({ echoed: args })),
  confirm: tool(async (args, ctx) => ({
    answer: await ctx.confirm({ kind: 'tool-request', note: args.note }),
  })),
  tcp: tool((a) => attempt(() => tcp(a.host, a.port, a.send ?? 'hello'))),
  fetch: tool((a) =>
    attempt(async () => {
      const response = await fetch(a.url, a.init)
      return { status: response.status, body: await response.text() }
    }),
  ),
  https: tool((a) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const https = require('node:https')
          const request = https.get(a.url, { ca: a.ca }, (response: any) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (d: string) => {
              body += d
            })
            response.on('end', () => resolve({ status: response.statusCode, body }))
          })
          request.on('error', reject)
        }),
    ),
  ),
  lookup: tool((a) => attempt(() => require('node:dns').promises.lookup(a.host))),
  lookupCallback: tool((a) =>
    attempt(
      () =>
        new Promise((resolve, reject) =>
          require('node:dns').lookup(a.host, { all: true }, (error: unknown, addresses: unknown) =>
            error ? reject(error) : resolve(addresses),
          ),
        ),
    ),
  ),
  resolve: tool((a) => attempt(() => require('node:dns').promises.resolve4(a.host))),
  udp: tool((a) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const socket = require('node:dgram').createSocket('udp4')
          socket.on('error', reject)
          socket.send('x', a.port, a.host, (error: unknown) => {
            socket.close()
            error ? reject(error) : resolve('sent')
          })
        }),
    ),
  ),
  read: tool((a) => attempt(() => require('node:fs').readFileSync(a.path, 'utf8').slice(0, 200))),
  write: tool((a) => attempt(() => require('node:fs').writeFileSync(a.path, a.content ?? 'x'))),
  list: tool((a) => attempt(() => require('node:fs').readdirSync(a.path).slice(0, 50))),
  symlinkRead: tool((a) =>
    attempt(() => {
      const fs = require('node:fs')
      const link = `${process.env['TMPDIR']}link-${Date.now()}`
      fs.symlinkSync(a.target, link)
      return fs.readFileSync(link, 'utf8').slice(0, 200)
    }),
  ),
  hardlinkRead: tool((a) =>
    attempt(() => {
      const fs = require('node:fs')
      const link = `${process.env['TMPDIR']}hard-${Date.now()}`
      fs.linkSync(a.target, link)
      return fs.readFileSync(link, 'utf8').slice(0, 200)
    }),
  ),
  spawn: tool((a) =>
    attempt(() => {
      const result = require('node:child_process').spawnSync(a.program ?? '/bin/echo', ['hi'], {
        encoding: 'utf8',
      })
      if (result.error) throw result.error
      return result.stdout
    }),
  ),
  worker: tool(() => attempt(() => new (require('node:worker_threads').Worker)('1', { eval: true }))),
  addon: tool((a) => attempt(() => process.dlopen({ exports: {} } as never, a.path))),
  environment: tool(async () => ({
    env: { ...process.env },
    cwd: process.cwd(),
    home: require('node:os').homedir(),
    argv: process.execArgv,
    permission: (process as any).permission?.has('fs.read', '/') ?? null,
  })),
  temp: tool(async () => {
    const fs = require('node:fs')
    const path = `${process.env['TMPDIR']}scratch.txt`
    fs.writeFileSync(path, 'kept?')
    return { path, read: fs.readFileSync(path, 'utf8') }
  }),
  hold: tool(() => new Promise(() => undefined)),
  spin: tool(() => {
    for (;;) {}
  }),
  heap: tool(() => {
    const keep: string[] = []
    for (;;) keep.push('x'.repeat(1_000_000) + keep.length)
  }),
  garble: tool(async () => {
    // Writes to the channel directly, around the bootstrap.
    require('node:fs').writeSync(3, 'not json\n')
    return {}
  }),
  globalState: tool(async () => {
    const g = globalThis as { __valetCount?: number }
    g.__valetCount = (g.__valetCount ?? 0) + 1
    return { count: g.__valetCount }
  }),
}
