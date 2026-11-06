// @vitest-environment node
// A production build of the renderer, as the Electron build will make it: the dev fake (and its
// Woolworths fixtures) must not ship, and every page carries the strict CSP.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { CONTENT_SECURITY_POLICY } from '../vite.config'

const out = mkdtempSync(join(tmpdir(), 'siteadapter-renderer-'))

beforeAll(async () => {
  // Vitest sets NODE_ENV=test, which Vite would honour with a dev build (DEV true, fake included).
  const nodeEnv = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  try {
    await build({
      configFile: resolve(import.meta.dirname, '../vite.config.ts'),
      mode: 'production',
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    })
  } finally {
    process.env['NODE_ENV'] = nodeEnv
  }
}, 60_000)

afterAll(() => rmSync(out, { recursive: true, force: true }))

function assets(): string[] {
  return readdirSync(join(out, 'assets'))
}

describe('the production renderer build', () => {
  it('emits no fake-api chunk and none of its fixture data', () => {
    expect(assets().length).toBeGreaterThan(0)
    expect(assets().filter((f) => f.includes('fake'))).toEqual([])
    for (const file of assets()) {
      const text = readFileSync(join(out, 'assets', file), 'utf8')
      expect(text).not.toContain(WOOLWORTHS_HASH)
      expect(text).not.toContain('createFakeApi')
    }
  })

  it('gives both pages the CSP, with no inline script or style allowed', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline')
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'")
    for (const page of ['index.html', 'tray.html']) {
      const html = readFileSync(join(out, page), 'utf8')
      expect(html).toContain('http-equiv="Content-Security-Policy"')
      expect(html.replaceAll('&#39;', "'")).toContain(CONTENT_SECURITY_POLICY)
      // Nothing the CSP would have to allow inline.
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
      expect(html).not.toMatch(/<style[\s>]/)
      expect(html).not.toMatch(/\sstyle="/)
    }
  })
})
