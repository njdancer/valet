// The relay in a local Workers runtime, for development and the pairing walkthrough
// (docs/phone-channel.md#running-it-locally). Not a deploy: nothing leaves this machine.
//
//   node apps/relay/scripts/local.mjs [--port 8787] [--origin https://relay.valet.test]
//
// Devices dial http://127.0.0.1:<port>; the relay names `origin` in its challenges, as the
// deployed one names its own host, so the Mac and the phone are configured with that origin and
// told to dial the local port instead (VALET_RELAY_CONNECT on the Mac, -valet-relay-connect on
// the iPhone dev build). Prints one line, `relay listening <url>`, once it is ready.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { buildWorker } from './build.mjs'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    origin: { type: 'string', default: 'https://relay.valet.test' },
  },
})
const origin = new URL(values.origin)
if (origin.protocol !== 'https:') throw new Error('the origin is https://<host>')

// Under the package: workerd won't load a module from outside its starting directory.
const root = fileURLToPath(new URL('..', import.meta.url))
// workerd resolves the script against the working directory, and refuses to climb out of it.
process.chdir(root)
const scratch = join(root, '.test-runtime')
mkdirSync(scratch, { recursive: true })
const scriptPath = await buildWorker(join(mkdtempSync(join(scratch, 'local-')), 'worker.js'))
const limit = (namespace) => ({ namespace_id: namespace, simple: { limit: 10_000, period: 60 } })
const mf = new Miniflare({
  modules: true,
  scriptPath,
  compatibilityDate: '2026-08-01',
  compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
  durableObjects: { MAC_RELAY: 'MacRelay', PUSH: 'PushRelay' },
  durableObjectsPersist: mkdtempSync(join(scratch, 'local-do-')),
  bindings: { RELAY_HOST: origin.host, RELAY_ORIGIN: origin.origin, WAIT_SECRET: 'local-wait-secret' },
  ratelimits: {
    CONNECT_LIMIT: limit('1'),
    FORWARD_LIMIT: limit('2'),
    SIGN_IN_LIMIT: limit('3'),
    POLL_LIMIT: limit('4'),
  },
  host: '127.0.0.1',
  port: Number(values.port),
})
const url = (await mf.ready).toString().replace(/\/$/, '')
console.log(`relay listening ${url} as ${origin.origin}`)
const stop = async () => {
  await mf.dispose()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
