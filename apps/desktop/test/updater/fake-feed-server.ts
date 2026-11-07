// A static update feed on 127.0.0.1, port 0: serves what the test puts in it, records every request
// (path and headers), and can be told to answer a path with an HTTP error or a redirect instead.
// Also writes zips shaped like electron-builder's: one <name>.app with a real Info.plist.

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Writes `zipPath` holding `<appName>.app/Contents/Info.plist` with the given bundle ID and version,
 * and `payload` as the app's executable. Zipped with ditto, as electron-builder's zips are.
 */
export async function writeAppZip(
  zipPath: string,
  info: { readonly bundleId: string; readonly version: string; readonly appName?: string },
  payload: Buffer,
): Promise<void> {
  const staging = `${zipPath}.staging`
  const app = join(staging, `${info.appName ?? 'valet'}.app`)
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(
    join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>' +
      `<key>CFBundleIdentifier</key><string>${info.bundleId}</string>` +
      `<key>CFBundleShortVersionString</key><string>${info.version}</string>` +
      '</dict></plist>\n',
  )
  await writeFile(join(app, 'Contents', 'MacOS', 'valet'), payload)
  await mkdir(dirname(zipPath), { recursive: true })
  await promisify(execFile)('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zipPath])
}

export interface RecordedRequest {
  readonly method: string
  /** Without the query string electron-updater adds to defeat caches. */
  readonly path: string
  readonly headers: IncomingHttpHeaders
}

export class FakeFeedServer {
  readonly files = new Map<string, Buffer>()
  readonly failures = new Map<string, number>()
  /** Path to a Location header, answered with 302. */
  readonly redirects = new Map<string, string>()
  readonly requests: RecordedRequest[] = []
  private server: Server | null = null

  get url(): string {
    const address = this.server?.address() as AddressInfo | null | undefined
    if (address == null) throw new Error('not listening')
    return `http://127.0.0.1:${address.port}/`
  }

  requested(path: string): number {
    return this.requests.filter((r) => r.path === path).length
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://feed.invalid').pathname
      this.requests.push({ method: request.method ?? '', path, headers: request.headers })
      const location = this.redirects.get(path)
      if (location !== undefined) {
        response.writeHead(302, { location }).end()
        return
      }
      const failure = this.failures.get(path)
      if (failure !== undefined) {
        response.writeHead(failure).end()
        return
      }
      const body = this.files.get(path)
      if (body === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-length': body.length }).end(body)
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
