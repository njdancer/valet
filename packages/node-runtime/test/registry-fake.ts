// A fake npm registry on loopback for the dependency tests: packuments and gzipped tarballs built
// in memory, including hostile ones. Nothing here touches the real registry.

import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:https'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { integrityOf } from '../src/deps/tarball'

export interface FakeFile {
  readonly path: string
  readonly content: string
  /** A tar type flag other than a plain file ('2' symlink, '1' hard link, '5' folder). */
  readonly type?: string
  readonly linkTo?: string
}

function header(name: string, size: number, type: string, linkTo = ''): Buffer {
  const block = Buffer.alloc(512)
  const put = (text: string, offset: number, length: number) =>
    block.write(text.slice(0, length), offset, 'utf8')
  if (Buffer.byteLength(name) > 100) throw new Error('use pax for long names')
  put(name, 0, 100)
  put('0000644\0', 100, 8)
  put('0000000\0', 108, 8)
  put('0000000\0', 116, 8)
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  put('00000000000\0', 136, 12)
  block.fill(0x20, 148, 156)
  put(type, 156, 1)
  put(linkTo, 157, 100)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  let sum = 0
  for (const b of block) sum += b
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return block
}

function pad(data: Buffer): Buffer {
  const rest = data.length % 512
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)])
}

/** A gzipped tarball with each file under `package/` (or as named, when it starts with `!`). */
export function tarball(files: readonly FakeFile[]): Buffer {
  const parts: Buffer[] = []
  for (const f of files) {
    const name = f.path.startsWith('!') ? f.path.slice(1) : `package/${f.path}`
    const body = Buffer.from(f.type === undefined || f.type === '0' ? f.content : '', 'utf8')
    if (Buffer.byteLength(name) > 100) {
      const record = ` path=${name}\n`
      let length = record.length
      length += String(length + String(length).length).length
      const pax = Buffer.from(`${length}${record}`, 'utf8')
      parts.push(header('PaxHeader', pax.length, 'x'), pad(pax))
      parts.push(header('long', body.length, f.type ?? '0', f.linkTo), pad(body))
    } else {
      parts.push(header(name, body.length, f.type ?? '0', f.linkTo), pad(body))
    }
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

export interface FakeVersion {
  readonly files: readonly FakeFile[]
  readonly packageJson?: Record<string, unknown>
  /** ISO time it was published; three weeks ago by default. */
  readonly published?: string
  /** Overrides for the registry's version document. */
  readonly doc?: Record<string, unknown>
  /** Serve different bytes from the ones the integrity was taken over. */
  readonly tamper?: boolean
}

const CERT = readFileSync(join(import.meta.dirname, 'fixtures', 'test-cert.pem'), 'utf8')
const KEY = readFileSync(join(import.meta.dirname, 'fixtures', 'test-key.pem'), 'utf8')

/** fetch over node:https that trusts the test certificate: what the tests hand addDependency. */
export const testFetch = ((input: string | URL, init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const req = request(
      input,
      { method: init?.method ?? 'GET', ca: CERT, checkServerIdentity: () => undefined },
      (res) => {
        if (init?.redirect === 'error' && (res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
          res.resume()
          return reject(new TypeError('redirect'))
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })))
      },
    )
    req.on('error', reject)
    req.end()
  })) as typeof fetch

const OLD = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString()

export async function fakeRegistry(
  packages: Readonly<Record<string, Readonly<Record<string, FakeVersion>>>>,
) {
  const tarballs = new Map<string, Buffer>()
  const requests: string[] = []
  let base = ''
  const docs = new Map<string, unknown>()
  const build = () => {
    for (const [name, versions] of Object.entries(packages)) {
      const vdocs: Record<string, unknown> = {}
      const time: Record<string, string> = {}
      for (const [version, v] of Object.entries(versions)) {
        const pj = { name, version, ...(v.packageJson ?? {}) }
        const bytes = tarball([{ path: 'package.json', content: JSON.stringify(pj) }, ...v.files])
        const file = `${name.replace('/', '-')}-${version}.tgz`
        const url = `${base}${name}/-/${file}`
        tarballs.set(
          new URL(url).pathname,
          v.tamper ? tarball([{ path: 'package.json', content: '{}' }]) : bytes,
        )
        vdocs[version] = {
          ...pj,
          dist: { integrity: integrityOf(bytes), tarball: url },
          ...(v.doc ?? {}),
        }
        time[version] = v.published ?? OLD
      }
      docs.set(name, { name, versions: vdocs, time })
    }
  }
  const server: Server = createServer({ cert: CERT, key: KEY }, (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    requests.push(path)
    const tgz = tarballs.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (tgz !== undefined) return res.end(tgz)
    const doc = docs.get(path.slice(1))
    if (doc === undefined) {
      res.statusCode = 404
      return res.end('{}')
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(doc))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}/`
  build()
  return { registry: base, requests, close: () => server.close() }
}
