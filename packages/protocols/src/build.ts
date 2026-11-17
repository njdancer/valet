// Build time only: bundles each protocol host into one CommonJS script, so the sandboxed process
// needs exactly one readable file. The IMAP host (host/protocol-host.ts) imports nothing but Valet's
// own code and Node's modules. The SFTP host (host/sftp-host.ts) also carries ssh2's client and the
// three small packages it needs, at the versions in the lockfile, and nothing else from npm. Used by
// the app's build and by tests; esbuild is a dev dependency.

import { builtinModules, createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMAP_POLICY = join(HERE, '..', '..', 'core', 'src', 'imap-policy.ts')
const SFTP_POLICY = join(HERE, '..', '..', 'core', 'src', 'sftp-policy.ts')

export const PROTOCOL_HOST_ENTRY = join(HERE, 'host', 'protocol-host.ts')
export const SFTP_HOST_ENTRY = join(HERE, 'host', 'sftp-host.ts')

/** The npm packages the SFTP host may carry: ssh2's client and what it requires. */
const SFTP_PACKAGES = new Set(['asn1', 'bcrypt-pbkdf', 'tweetnacl', 'safer-buffer'])
const BUILTINS = new Set(builtinModules)

/** The protocol host as one script. */
export async function buildProtocolHost(): Promise<string> {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [PROTOCOL_HOST_ENTRY],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        name: 'valet-protocol-host',
        setup(b) {
          // Only Valet's own files, core's dependency-free IMAP policy and Node's modules: nothing
          // else from node_modules, so the host is exactly the code in this repository.
          b.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path.startsWith('node:')) return { path: args.path, external: true }
            if (args.path === '@valet/core/imap-policy') return { path: IMAP_POLICY }
            return { errors: [{ text: `the protocol host may not import ${args.path}` }] }
          })
        },
      },
    ],
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('the protocol host build produced nothing')
  return output.text
}

/** The SFTP host as one script. */
export async function buildSftpHost(): Promise<string> {
  const { build } = await import('esbuild')
  // ssh2 itself, resolved from this package, so its own dependencies resolve beside it.
  const ssh2Client = createRequire(import.meta.url).resolve('ssh2/lib/client.js')
  const result = await build({
    entryPoints: [SFTP_HOST_ENTRY],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        name: 'valet-sftp-host',
        setup(b) {
          // ssh2's optional native parts: never in the sandbox (--no-addons). ssh2 requires them
          // inside try/catch and does without.
          b.onResolve({ filter: /sshcrypto\.node$|^cpu-features$/ }, (args) => ({
            path: args.path,
            namespace: 'valet-absent',
          }))
          b.onLoad({ filter: /.*/, namespace: 'valet-absent' }, () => ({
            contents: "throw new Error('not in the SFTP host')",
            loader: 'js',
          }))
          // Its Poly1305 in WebAssembly, loaded at start-up for chacha20-poly1305. That cipher is
          // never offered (sftp/ssh.ts ALGORITHMS), so the host carries a stand-in that loads and
          // refuses to run, and no WebAssembly at all.
          b.onResolve({ filter: /[\\/]poly1305\.js$/ }, (args) => ({ path: args.path, namespace: 'valet-poly1305' }))
          b.onLoad({ filter: /.*/, namespace: 'valet-poly1305' }, () => ({
            contents:
              "module.exports = () => Promise.resolve({ _malloc: () => 0, cwrap: () => () => { throw new Error('chacha20-poly1305 is not offered') } })",
            loader: 'js',
          }))
          // `ssh2` is its client alone: not its server, agents or HTTP agents.
          b.onResolve({ filter: /^ssh2$/ }, () => ({ path: 'ssh2', namespace: 'valet-ssh2' }))
          b.onLoad({ filter: /.*/, namespace: 'valet-ssh2' }, () => ({
            contents: `module.exports = { Client: require(${JSON.stringify(ssh2Client)}) }`,
            loader: 'js',
            resolveDir: dirname(ssh2Client),
          }))
          b.onResolve({ filter: /^[^./]/ }, (args) => {
            const bare = args.path.startsWith('node:') ? args.path.slice(5) : args.path
            if (BUILTINS.has(bare)) return { path: args.path, external: true }
            if (args.path === '@valet/core/sftp-policy') return { path: SFTP_POLICY }
            if (SFTP_PACKAGES.has(args.path)) return undefined
            return { errors: [{ text: `the SFTP host may not import ${args.path}` }] }
          })
        },
      },
    ],
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('the SFTP host build produced nothing')
  return output.text
}

/** Writes the bundled SFTP host to `path` (made private to this user) and returns the path. */
export async function writeSftpHost(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await buildSftpHost(), { mode: 0o600 })
  return path
}

/** Writes the bundled host to `path` (made private to this user) and returns the path. */
export async function writeProtocolHost(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await buildProtocolHost(), { mode: 0o600 })
  return path
}
