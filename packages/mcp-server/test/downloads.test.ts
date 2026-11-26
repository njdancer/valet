// The remote listener's download addresses (src/downloads.ts): served without a token by id alone,
// only on a public name and never to a web page, with headers that keep them from running or being
// kept, and logged without the id.

import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServedFile } from '../src/downloads'
import { startRemoteListener } from '../src/remote'
import { RemoteAccessTokens } from '../src/remote-auth'
import { FakeCaller } from './fake-caller'

const HOST = 'mac.example-tailnet.ts.net'
const ID = 'AbCdEfGhIjKlMnOpQrStUvWx'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function setup(files: Record<string, ServedFile>) {
  const lines: string[] = []
  const asked: string[] = []
  const listener = await startRemoteListener({
    caller: new FakeCaller([]),
    policy: { allows: () => false },
    tokens: new RemoteAccessTokens(),
    hosts: () => new Set([HOST]),
    refused: async () => undefined,
    downloads: (id) => {
      asked.push(id)
      return files[id] ?? null
    },
    log: (line) => void lines.push(line),
  })
  cleanup.push(() => listener.close())
  return { port: listener.port, lines, asked }
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = { host: HOST },
  method = 'GET',
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

describe('a download address', () => {
  it('serves the file by its id alone, with headers that keep it inert', async () => {
    const { port, lines } = await setup({
      [ID]: { name: 'report 1.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7') },
    })
    const got = await get(port, `/d/${ID}/report%201.pdf`, { host: HOST, 'user-agent': 'Claude-User' })
    expect(got.status).toBe(200)
    expect(got.body.toString()).toBe('%PDF-1.7')
    expect(got.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': '8',
      'content-disposition': "inline; filename*=UTF-8''report%201.pdf",
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    })
    // The name is for show; the id alone finds the file.
    expect((await get(port, `/d/${ID}/other.txt`)).status).toBe(200)
    expect((await get(port, `/d/${ID}`)).status).toBe(200)
    const head = await get(port, `/d/${ID}/x`, { host: HOST }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    expect(lines[0]).toMatch(/^\[download\] GET \/d\/… 200 \d+ms agent="Claude-User"$/)
    expect(lines.join('\n')).not.toContain(ID)
  })

  it('answers Not found for an unknown id, another name, a page’s request or a bad path', async () => {
    const { port, asked } = await setup({
      [ID]: { name: 'a', mimeType: 'text/plain', data: Buffer.from('a') },
    })
    expect((await get(port, '/d/ZZZZZZZZZZZZZZZZZZZZZZZZ/a')).status).toBe(404)
    expect((await get(port, `/d/${ID}/a`, { host: '127.0.0.1' })).status).toBe(404)
    expect((await get(port, `/d/${ID}/a`, { host: HOST, origin: 'https://evil.example' })).status).toBe(404)
    expect((await get(port, '/d/short/a')).status).toBe(404)
    expect((await get(port, `/d/${ID}/a/b`)).status).toBe(404)
    expect((await get(port, `/d/${ID}/a`, { host: HOST }, 'POST')).status).toBe(405)
    // Only a well-formed id from a public name is ever looked up.
    expect(asked).toEqual(['ZZZZZZZZZZZZZZZZZZZZZZZZ', ID])
  })

  it('serves a type it can’t vouch for as plain bytes', async () => {
    const { port } = await setup({
      [ID]: { name: 'x.html', mimeType: 'text/html; charset=utf-8', data: Buffer.from('<b>') },
      BbCdEfGhIjKlMnOpQrStUvWx: { name: 'y', mimeType: 'not a type<script>', data: Buffer.from('y') },
    })
    expect((await get(port, `/d/${ID}/x.html`)).headers['content-type']).toBe('text/html')
    expect((await get(port, '/d/BbCdEfGhIjKlMnOpQrStUvWx/y')).headers['content-type']).toBe(
      'application/octet-stream',
    )
  })

  it('leaves the MCP path to the listener', async () => {
    const { port } = await setup({})
    expect((await get(port, '/mcp', { host: HOST })).status).toBe(401)
  })
})
