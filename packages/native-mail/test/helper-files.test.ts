import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HelperMailFiles, MailFilesError } from '../src/files'

let dir: string
let server: Server | null = null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'valet-helper-'))
})
afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

async function serve(answer: (request: Record<string, unknown>) => string): Promise<string> {
  const path = join(dir, 'helper.sock')
  server = createServer((socket) => {
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString()
      if (data.includes('\n')) socket.end(answer(JSON.parse(data)))
    })
  })
  await new Promise<void>((resolve) => server?.listen(path, resolve))
  return path
}

describe('HelperMailFiles', () => {
  it('asks the helper and reads its answers', async () => {
    const seen: Record<string, unknown>[] = []
    const path = await serve((r) => {
      seen.push(r)
      switch (r['op']) {
        case 'mail.info':
          return '{"library":"V10"}\n'
        case 'mail.query':
          return '{"columns":["a","b"],"rows":[[1,"x"],[null,2.5]]}\n'
        case 'mail.file':
          return `{"base64":"${Buffer.from('hello').toString('base64')}"}\n`
        case 'mail.list':
          return '{"entries":[{"name":"a","dir":true},{"bad":1}],"truncated":false}\n'
        default:
          return '{"paths":["x/1.emlx",3]}\n'
      }
    })
    const files = new HelperMailFiles({ socketPath: path })
    expect(await files.library()).toBe('V10')
    expect(await files.query('envelope', 'SELECT ?', [1])).toEqual([
      { a: 1, b: 'x' },
      { a: null, b: 2.5 },
    ])
    expect((await files.file('a.emlx')).toString()).toBe('hello')
    expect(await files.list('')).toEqual([{ name: 'a', dir: true }])
    expect(await files.spotlight('word')).toEqual(['x/1.emlx'])
    expect(seen[1]).toEqual({ v: 1, op: 'mail.query', db: 'envelope', sql: 'SELECT ?', params: [1] })
  })

  it('passes on the helper’s refusals', async () => {
    const path = await serve(() => '{"error":"not-found"}\n')
    await expect(new HelperMailFiles({ socketPath: path }).file('x.emlx')).rejects.toEqual(
      new MailFilesError('not-found'),
    )
  })

  it('is unavailable when the helper isn’t there or answers nonsense', async () => {
    await expect(new HelperMailFiles({ socketPath: join(dir, 'none.sock') }).library()).rejects.toEqual(
      new MailFilesError('unavailable'),
    )
    const path = await serve(() => 'not json\n')
    await expect(new HelperMailFiles({ socketPath: path }).library()).rejects.toEqual(
      new MailFilesError('unavailable'),
    )
  })

  it('refuses a socket another user owns', async () => {
    const path = await serve(() => '{"library":"V10"}\n')
    const files = new HelperMailFiles({ socketPath: path, uid: 12345 })
    await expect(files.library()).rejects.toEqual(new MailFilesError('unavailable'))
  })
})
