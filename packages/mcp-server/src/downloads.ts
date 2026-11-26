// Files an agent's browser downloaded, served on the remote listener at a short-lived address
// (docs/agent-browser.md, "Downloads"): GET /d/<id>/<name>. The id is the only key: random,
// unguessable, gone when it expires or its session closes. No token is asked for, so that an
// agent's own fetch tool can read it as it would any address. The name is for show only.
//
// Like the OAuth paths, it is answered ahead of the MCP path, and it applies the remote guards
// itself: a public name the tunnel forwards, and no Origin (no web page may read it from a browser).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { remoteRequestHost } from './remote-auth'

export interface ServedFile {
  readonly name: string
  readonly mimeType: string
  readonly data: Buffer
}

export const DOWNLOAD_PREFIX = '/d/'
const DOWNLOAD_PATH = /^\/d\/([A-Za-z0-9_-]{16,64})(?:\/[^/]*)?$/
/** A type a client may be told as it is; anything else is served as plain bytes. */
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,99}$/

/**
 * The listener's download handler: true when it answered the request. Never logs the id; the line
 * says only that a download was asked for, how it ended, and by what client.
 */
export function downloadHandler(
  files: (id: string) => ServedFile | null,
  hosts: () => ReadonlySet<string>,
  log?: (line: string) => void,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!path.startsWith(DOWNLOAD_PREFIX)) return false
    const started = Date.now()
    res.once('finish', () => {
      const agent = req.headers['user-agent']
      const line = `[download] ${req.method ?? '?'} /d/… ${res.statusCode} ${Date.now() - started}ms${
        agent === undefined ? '' : ` agent=${JSON.stringify(agent.slice(0, 80))}`
      }`
      try {
        log?.(line)
      } catch {
        // A log line is not worth failing a request over.
      }
    })
    const id = DOWNLOAD_PATH.exec(path)?.[1]
    const file = id === undefined || remoteRequestHost(req.headers, hosts()) === null ? null : files(id)
    if (file === null) {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found\n')
      return true
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(
        res,
        405,
        { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
        'Method not allowed\n',
      )
      return true
    }
    const type = file.mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
    send(
      res,
      200,
      {
        'content-type': MEDIA_TYPE.test(type) ? type : 'application/octet-stream',
        'content-length': String(file.data.length),
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        // Never run or rendered as a page of Valet's, never kept by a cache or indexed.
        'content-security-policy': "sandbox; default-src 'none'",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
      },
      req.method === 'HEAD' ? null : file.data,
    )
    return true
  }
}

function send(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string | Buffer | null,
): void {
  res.writeHead(status, { connection: 'close', ...headers })
  res.end(body ?? undefined)
}
