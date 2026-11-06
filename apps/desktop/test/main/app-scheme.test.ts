// @vitest-environment node
// The app:// scheme the packaged renderer is served from: only files under the renderer root, only
// the types the build emits. scripts/package-smoke.mjs checks it in a packaged window.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  appPageUrl,
  createAppSchemeHandler,
  onAppOrigin,
  resolveAppPath,
} from '../../src/main/core/app-scheme'

const ROOT = '/Applications/siteadapter.app/Contents/Resources/app.asar/out/renderer'

describe('appPageUrl', () => {
  it('names a page under the one host, with a hash route', () => {
    expect(appPageUrl('index.html')).toBe('app://renderer/index.html')
    expect(appPageUrl('tray.html', '#/activity')).toBe('app://renderer/tray.html#/activity')
  })

  it('registers the scheme with the privileges module scripts need, and no more', () => {
    expect(APP_SCHEME).toBe('app')
    expect(APP_SCHEME_PRIVILEGES).toEqual({ standard: true, secure: true, supportFetchAPI: true })
  })
})

describe('onAppOrigin', () => {
  it('takes app://renderer only', () => {
    expect(onAppOrigin('app://renderer/index.html#/adapters')).toBe(true)
    expect(onAppOrigin('app://renderer/assets/index-abc.js')).toBe(true)
    for (const url of [
      'app://other/index.html',
      'app://renderer.evil/index.html',
      'app://renderer:80/index.html',
      'app://u:p@renderer/index.html',
      'file:///index.html',
      'https://renderer/index.html',
      'not a url',
    ])
      expect(onAppOrigin(url), url).toBe(false)
  })
})

describe('resolveAppPath', () => {
  it('maps pages and assets under the root', () => {
    expect(resolveAppPath('app://renderer/index.html', ROOT)).toBe(`${ROOT}/index.html`)
    expect(resolveAppPath('app://renderer/assets/index-abc123.js', ROOT)).toBe(
      `${ROOT}/assets/index-abc123.js`,
    )
    expect(resolveAppPath('app://renderer/assets/a%20b.css', ROOT)).toBe(`${ROOT}/assets/a b.css`)
    // The hash never reaches the handler, but is harmless if it does.
    expect(resolveAppPath('app://renderer/index.html#/x', ROOT)).toBe(`${ROOT}/index.html`)
  })

  it('refuses anything outside the root', () => {
    for (const url of [
      'app://renderer/../main/index.js',
      'app://renderer/assets/../../main/index.js',
      'app://renderer/%2e%2e/main/index.js',
      'app://renderer/assets%2f..%2f..%2fmain%2findex.js',
      'app://renderer/..%5c..%5cmain%5cindex.js',
      'app://renderer/%2Fetc%2Fpasswd.json',
      'app://renderer//etc/passwd.json',
    ]) {
      const file = resolveAppPath(url, ROOT)
      if (file !== null) expect(file.startsWith(`${ROOT}/`), url).toBe(true)
      expect(file === null || !file.includes('..'), url).toBe(true)
    }
    expect(resolveAppPath('app://renderer/assets%2f..%2f..%2fmain%2findex.js', ROOT)).toBeNull()
    expect(resolveAppPath('app://renderer/..%5c..%5cmain%5cindex.js', ROOT)).toBeNull()
  })

  it('refuses other hosts, schemes, credentials, ports and query strings', () => {
    for (const url of [
      'app://other/index.html',
      'app://renderer.evil/index.html',
      'file:///index.html',
      'https://renderer/index.html',
      'app://user@renderer/index.html',
      'app://renderer:80/index.html',
      'app://renderer/index.html?x=1',
      'app://renderer/index.html?',
      'not a url',
    ]) {
      expect(resolveAppPath(url, ROOT), url).toBeNull()
    }
  })

  it('refuses directories, hidden files, control characters and types the build never emits', () => {
    for (const url of [
      'app://renderer/',
      'app://renderer',
      'app://renderer/assets/',
      'app://renderer/.env.json',
      'app://renderer/assets/.hidden.js',
      'app://renderer/a%00.js',
      'app://renderer/a%0a.js',
      'app://renderer/assets/index.js.map',
      'app://renderer/package',
      'app://renderer/main.cjs',
      'app://renderer/x.node',
      'app://renderer/%E0%A4%A.js',
    ]) {
      expect(resolveAppPath(url, ROOT), url).toBeNull()
    }
  })
})

describe('createAppSchemeHandler', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'siteadapter-scheme-'))
    await mkdir(join(dir, 'renderer', 'assets'), { recursive: true })
    await writeFile(join(dir, 'renderer', 'index.html'), '<!doctype html><title>x</title>')
    await writeFile(join(dir, 'renderer', 'assets', 'app.js'), "document.title = 'ok'")
    await writeFile(join(dir, 'secret.json'), '{"token":"s3cret"}')
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const handler = () =>
    createAppSchemeHandler({ root: join(dir, 'renderer'), readFile: (path) => readFile(path) })

  it('serves a page and a module script with fixed types and nosniff', async () => {
    const page = await handler()({ url: 'app://renderer/index.html', method: 'GET' })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await page.text()).toContain('<title>x</title>')
    const script = await handler()({ url: 'app://renderer/assets/app.js', method: 'GET' })
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toBe("document.title = 'ok'")
  })

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await handler()({ url: 'app://renderer/index.html', method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await handler()({ url: 'app://renderer/index.html', method: 'POST' })).status).toBe(405)
  })

  it('404s a missing file and anything resolveAppPath refuses, without reading it', async () => {
    const reads: string[] = []
    const watched = createAppSchemeHandler({
      root: join(dir, 'renderer'),
      readFile: async (path) => {
        reads.push(path)
        return readFile(path)
      },
    })
    expect((await watched({ url: 'app://renderer/missing.html', method: 'GET' })).status).toBe(404)
    expect((await watched({ url: 'app://renderer/../secret.json', method: 'GET' })).status).not.toBe(200)
    expect((await watched({ url: 'app://renderer/%2e%2e/secret.json', method: 'GET' })).status).not.toBe(200)
    expect((await watched({ url: 'app://other/index.html', method: 'GET' })).status).toBe(404)
    expect(reads.every((path) => path.startsWith(join(dir, 'renderer')))).toBe(true)
  })

  it('refuses a relative root', () => {
    expect(() => createAppSchemeHandler({ root: 'out/renderer', readFile })).toThrow('absolute')
  })
})
