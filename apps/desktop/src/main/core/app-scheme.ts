// The app:// scheme the packaged renderer is served from. The grantFileProtocolExtraPrivileges fuse
// is off (electron-builder.config.ts), and with it off a file:// page can't run Vite's module
// scripts, so loadFile would leave the control panel blank. A standard, secure custom scheme gives
// the renderer an origin of its own (app://renderer), under which module scripts, the page's CSP
// 'self' and fetch work as on https.
//
// Every build the main process loads from its own files uses it, packaged or not; only the dev
// server (electron-vite dev) is loaded over http instead. electron/app.ts wires it, in this order:
//
//   protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }])
//   app.whenReady().then(() => {
//     protocol.handle(APP_SCHEME, createAppSchemeHandler({ root: <out/renderer>, readFile }))
//     window.loadURL(appPageUrl('index.html'))   // never loadFile
//   })
//
// protocol.handle serves the default session only, which only the app's own windows use: the
// adapters' auth and tool partitions can't load app:// at all.
//
// Requests are answered only for files under `root` (inside app.asar when packaged), with a fixed
// content type per extension and a deny for anything else: other hosts, query strings, dot or
// encoded-separator segments, symlink tricks via '..', and extensions the renderer never ships.

import { extname, join, sep } from 'node:path'

export const APP_SCHEME = 'app'
/** The one host the scheme answers for. */
export const APP_HOST = 'renderer'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/**
 * Electron's CustomScheme privileges. standard: parsed like http (an origin, relative URLs);
 * secure: a secure context, as module scripts need; supportFetchAPI: fetch() of its own assets.
 * Not bypassCSP, corsEnabled, allowServiceWorkers or stream: the renderer needs none of them.
 */
export const APP_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true } as const

/** What the renderer build emits, and the only types served. */
export const APP_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

/**
 * True for a URL on app://renderer and nothing else (no credentials or port). Node's URL parser
 * doesn't know the scheme is standard, so its `origin` is "null": compare scheme and host instead.
 */
export function onAppOrigin(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host === APP_HOST &&
    parsed.username === '' &&
    parsed.password === ''
  )
}

/** The app:// URL of a page or asset path relative to the renderer root, e.g. "index.html". */
export function appPageUrl(path: string, hash = ''): string {
  const url = new URL(`${APP_ORIGIN}/`)
  url.pathname = `/${path}`
  url.hash = hash
  return url.href
}

/**
 * The file under `root` an app:// URL names, or null if it names none we serve. `root` must be
 * absolute. Pure: it never touches the disk.
 */
export function resolveAppPath(url: string, root: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null
  // An empty query ("?") parses to an empty search; refuse it too.
  if ((url.split('#')[0] ?? '').includes('?')) return null
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '' || parsed.search !== '')
    return null
  const segments = parsed.pathname.split('/').slice(1)
  if (segments.length === 0 || segments.some((s) => s === '')) return null
  const decoded: string[] = []
  for (const segment of segments) {
    let text: string
    try {
      text = decodeURIComponent(segment)
    } catch {
      return null
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
    if (text === '.' || text === '..' || /[/\\\u0000-\u001f\u007f]/.test(text) || text.startsWith('.')) {
      return null
    }
    decoded.push(text)
  }
  const file = join(root, ...decoded)
  if (!file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return null
  if (!(extname(file).toLowerCase() in APP_CONTENT_TYPES)) return null
  return file
}

export interface AppSchemeOptions {
  /** Absolute path of the built renderer (out/renderer, inside app.asar when packaged). */
  readonly root: string
  /** Reads a file; rejects if it doesn't exist. Electron's fs reads inside the asar. */
  readonly readFile: (path: string) => Promise<Uint8Array>
}

/** The part of a request the handler reads; Electron's protocol.handle passes a GlobalRequest. */
export interface AppSchemeRequest {
  readonly url: string
  readonly method: string
}

const NOT_FOUND = () => new Response(null, { status: 404 })

/** A protocol.handle handler for APP_SCHEME. */
export function createAppSchemeHandler(options: AppSchemeOptions) {
  if (!options.root.startsWith(sep)) throw new TypeError('root must be absolute')
  return async (request: AppSchemeRequest): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const file = resolveAppPath(request.url, options.root)
    if (file === null) return NOT_FOUND()
    let body: Uint8Array
    try {
      body = await options.readFile(file)
    } catch {
      return NOT_FOUND()
    }
    const type = APP_CONTENT_TYPES[extname(file).toLowerCase()] as string
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    })
  }
}
