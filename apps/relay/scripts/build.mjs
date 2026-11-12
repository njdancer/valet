// Bundles the Worker for tests and for `wrangler deploy --no-bundle`-free checks. Wrangler bundles
// the same entry itself on deploy; this build is what the miniflare suite loads.

import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

export async function buildWorker(outfile = `${root}dist/worker.js`) {
  await build({
    entryPoints: [`${root}src/index.ts`],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*'],
    logLevel: 'warning',
  })
  return outfile
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWorker()
