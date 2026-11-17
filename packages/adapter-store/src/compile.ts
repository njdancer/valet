// Compiles a checked package's sources into the tool script the tool process runs
// (docs/adapter-packages.md#compiling-in-the-app).
//
// esbuild-wasm's browser build, in a worker thread of its own: WebAssembly and JavaScript only, so
// the app ships no native binary for it and spawns no process (esbuild-wasm's Node API would run
// `node` from the PATH). The browser build has no file system at all, and the worker gets the
// files as data: a resolver serves relative imports of .ts files under src/ from the map and
// refuses everything else, so a package can't reach a file outside itself. `zod` and `@valet/core`
// resolve to the library prelude the app builds once (buildToolLibrary in @valet/runtime), which
// the tool process evaluates first. The worker also keeps the global the browser build needs
// (`self`) out of the main process.

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { type DependencyLock, EMPTY_LOCK, PACKAGE_ENTRY, type PackageFiles } from '@valet/core'
import { TOOL_LIBRARY_GLOBAL } from '@valet/runtime/tool-script'
import { NPM_RESOLVER_SOURCE } from './npm-resolve'

/** The esbuild version compiling packages. A test checks it matches the installed esbuild-wasm. */
export const COMPILER_VERSION = '0.28.2'

/** A compile that takes longer is abandoned and its worker replaced. */
export const COMPILE_TIMEOUT_MS = 30_000

export class CompileError extends Error {
  constructor(readonly detail: string) {
    super(`compile failed: ${detail}`)
    this.name = 'CompileError'
  }
}

/** Where to find esbuild-wasm's browser build and its WebAssembly module. */
export interface CompilerFiles {
  readonly browserJs: string
  readonly wasm: string
}

/** The installed esbuild-wasm. The app passes paths of its own when the module isn't resolvable. */
export function defaultCompilerFiles(): CompilerFiles {
  const require = createRequire(import.meta.url)
  return {
    browserJs: require.resolve('esbuild-wasm/lib/browser.js'),
    wasm: require.resolve('esbuild-wasm/esbuild.wasm'),
  }
}

// Runs in the worker. Plain JavaScript: it is evaluated from this string, never from a file.
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const posix = require('node:path').posix
globalThis.self = globalThis
const module = { exports: {} }
new Function('module', 'exports', workerData.source)(module, module.exports)
const esbuild = module.exports
const ready = esbuild.initialize({ wasmModule: new WebAssembly.Module(workerData.wasm), worker: false })
const LIBRARIES = { zod: 'zod', '@valet/core': 'core' }
${NPM_RESOLVER_SOURCE}
const BUILTINS = require('node:module').builtinModules
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const clip = (t) => (t.length > 200 ? t.slice(0, 197) + '...' : t)
function resolveRelative(files, specifier, importer) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const base = importer === null ? '' : posix.dirname(importer)
  const joined = posix.normalize(posix.join(base, specifier))
  for (const candidate of [joined, joined + '.ts', joined + '/index.ts']) {
    if (candidate.startsWith('src/') && candidate.endsWith('.ts') && own(files, candidate)) return candidate
  }
  return null
}
// A raw adapter: built for Node, its npm dependencies resolved from the lockfile and the files
// given, Node's built-ins left as require calls for the runtime (docs/node-runtime.md#bundling).
async function buildNode({ id, files, entry, global, node }) {
  const resolver = createNpmResolver(node.lock, node.packages, BUILTINS)
  const SEP = '::'
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { tools } from './" + entry + "'",
        "export { NeedsUserError, ValetError } from '@valet/core'",
        "export { toJSONSchema } from 'zod'",
      ].join('\n'),
      sourcefile: 'valet-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__valetTools',
    platform: 'node',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'silent',
    sourcemap: false,
    tsconfigRaw: '{}',
    plugins: [{
      name: 'valet-raw-package',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const fromNpm = args.namespace === 'npm'
          if (!fromNpm && own(LIBRARIES, args.path)) return { path: LIBRARIES[args.path], namespace: 'valet-library' }
          if (!fromNpm) {
            const path = resolveRelative(files, args.path, args.namespace === 'valet-package' ? args.importer : null)
            if (path !== null) return { path, namespace: 'valet-package' }
            if (args.path.startsWith('./') || args.path.startsWith('../')) return { errors: [{ text: 'may not import ' + clip(args.path) }] }
          }
          let from = null
          if (fromNpm) {
            const at = args.importer.indexOf(SEP)
            from = { key: args.importer.slice(0, at), path: args.importer.slice(at + SEP.length) }
          }
          const r = resolver.resolve(args.path, from, args.kind)
          if (r.external) return { path: r.external, external: true }
          if (r.error) return { errors: [{ text: r.error }] }
          return { path: r.key + SEP + r.path, namespace: 'npm' }
        })
        b.onLoad({ filter: /.*/, namespace: 'valet-package' }, (args) => ({ contents: files[args.path], loader: 'ts' }))
        b.onLoad({ filter: /.*/, namespace: 'npm' }, (args) => {
          const at = args.path.indexOf(SEP)
          const key = args.path.slice(0, at)
          const path = args.path.slice(at + SEP.length)
          return { contents: node.packages[key][path], loader: loaderOf(path) }
        })
        b.onLoad({ filter: /.*/, namespace: 'valet-library' }, (args) => ({
          contents: 'module.exports = globalThis.' + global + '.' + args.path,
          loader: 'js',
        }))
      },
    }],
  })
  const output = result.outputFiles && result.outputFiles[0]
  if (!output) parentPort.postMessage({ id, ok: false, detail: 'no output' })
  else if (output.text.length > MAX_NODE_OUTPUT) parentPort.postMessage({ id, ok: false, detail: 'the bundle is larger than 16 MB' })
  else parentPort.postMessage({ id, ok: true, text: output.text })
}
const loaderOf = (path) => (path.endsWith('.json') ? 'json' : 'js')
const MAX_NODE_OUTPUT = 16 * 1024 * 1024
parentPort.on('message', async ({ id, files, entry, global, node }) => {
  try {
    await ready
    if (node) return await buildNode({ id, files, entry, global, node })
    const result = await esbuild.build({
      stdin: {
        contents: [
          "export { tools } from './" + entry + "'",
          "export { NeedsUserError, ValetError } from '@valet/core'",
          "export { toJSONSchema } from 'zod'",
        ].join('\n'),
        sourcefile: 'valet-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__valetTools',
      platform: 'neutral',
      target: 'es2023',
      legalComments: 'none',
      logLevel: 'silent',
      sourcemap: false,
      tsconfigRaw: '{}',
      plugins: [{
        name: 'valet-package',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (own(LIBRARIES, args.path)) return { path: LIBRARIES[args.path], namespace: 'valet-library' }
            const path = resolveRelative(files, args.path, args.namespace === 'valet-package' ? args.importer : null)
            if (path === null) return { errors: [{ text: 'may not import ' + clip(args.path) }] }
            return { path, namespace: 'valet-package' }
          })
          b.onLoad({ filter: /.*/, namespace: 'valet-package' }, (args) => ({ contents: files[args.path], loader: 'ts' }))
          b.onLoad({ filter: /.*/, namespace: 'valet-library' }, (args) => ({
            contents: 'module.exports = globalThis.' + global + '.' + args.path,
            loader: 'js',
          }))
        },
      }],
    })
    const output = result.outputFiles && result.outputFiles[0]
    if (!output) parentPort.postMessage({ id, ok: false, detail: 'no output' })
    else parentPort.postMessage({ id, ok: true, text: output.text })
  } catch (error) {
    const first = error && Array.isArray(error.errors) ? error.errors[0] : undefined
    let detail = 'the bundler failed'
    // Without a located error the bundler itself broke (deep nesting can kill esbuild's service):
    // the main thread then replaces this worker rather than keep one that fails every compile.
    const fatal = !first
    if (first) {
      const at = first.location && typeof first.location.file === 'string'
        ? first.location.file.replace('valet-package:', '') + ':' + first.location.line + ': '
        : ''
      detail = clip(at + (typeof first.text === 'string' ? first.text : 'error'))
    }
    parentPort.postMessage({ id, ok: false, detail, fatal })
  }
})
`

interface Pending {
  readonly resolve: (text: string) => void
  readonly reject: (error: Error) => void
}

/** One worker for the app's life, started on first use. Compiles run one after another in it. */
export class Compiler {
  private worker: Promise<Worker> | null = null
  private readonly pending = new Map<number, Pending>()
  private next = 1

  constructor(
    private readonly files: CompilerFiles = defaultCompilerFiles(),
    private readonly timeoutMs = COMPILE_TIMEOUT_MS,
  ) {}

  /**
   * The adapter's own code as one IIFE defining `__valetTools` (`tools`, `ValetError`,
   * `NeedsUserError`, `toJSONSchema`). It needs the library prelude evaluated before it. Rejects
   * with CompileError carrying the first problem. The output depends only on `files` and the
   * compiler version.
   */
  async compile(files: PackageFiles): Promise<string> {
    return this.request({ files: { ...files }, entry: PACKAGE_ENTRY, global: TOOL_LIBRARY_GLOBAL })
  }

  /**
   * A `raw` adapter's code for the Node runtime (docs/node-runtime.md#bundling): one IIFE like
   * compile's, with its npm dependencies bundled in from `packages` (each package's files, by
   * lockfile key) as `lock` resolves them, and Node's built-ins left as `require` calls. Nothing
   * outside `files` and `packages` can be imported.
   */
  async compileNode(
    files: PackageFiles,
    lock: DependencyLock | null,
    packages: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): Promise<string> {
    return this.request({
      files: { ...files },
      entry: PACKAGE_ENTRY,
      global: TOOL_LIBRARY_GLOBAL,
      node: { lock: lock ?? EMPTY_LOCK, packages },
    })
  }

  private async request(message: Record<string, unknown>): Promise<string> {
    const worker = await this.start()
    const id = this.next++
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new CompileError('the compile took too long'))
        // A worker stuck on one package would hold every later compile: start afresh.
        void this.discard(worker)
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer)
          resolve(text)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      // Held open only while a compile is waiting, so an idle compiler never keeps a process alive.
      worker.ref()
      worker.postMessage({ id, ...message })
    })
  }

  /** Drops `worker` if it is still the current one, failing whatever waits on it. */
  private async discard(worker: Worker): Promise<void> {
    const current = this.worker === null ? null : await this.worker.catch(() => null)
    if (current !== worker) return
    this.worker = null
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id)
      waiting.reject(new CompileError('the compiler stopped'))
    }
    await worker.terminate()
  }

  /** Stops the worker. A later compile starts another. */
  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker !== null) await (await worker).terminate()
  }

  private start(): Promise<Worker> {
    if (this.worker !== null) return this.worker
    const started: Promise<Worker> = (async () => {
      const [source, wasm] = await Promise.all([
        readFile(this.files.browserJs, 'utf8'),
        readFile(this.files.wasm),
      ])
      const worker = new Worker(WORKER, {
        eval: true,
        workerData: { source, wasm },
        // A hostile package can't take the main process's memory with it.
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      })
      worker.unref()
      worker.on(
        'message',
        (m: { id: number; ok: boolean; text?: string; detail?: string; fatal?: boolean }) => {
          const waiting = this.pending.get(m.id)
          if (waiting !== undefined) {
            this.pending.delete(m.id)
            if (this.pending.size === 0) worker.unref()
            if (m.ok && typeof m.text === 'string') waiting.resolve(m.text)
            else waiting.reject(new CompileError(typeof m.detail === 'string' ? m.detail : 'failed'))
          }
          if (m.fatal === true) void this.discard(worker)
        },
      )
      const fail = (): void => {
        if (this.worker !== started) return
        this.worker = null
        for (const [id, waiting] of this.pending) {
          this.pending.delete(id)
          waiting.reject(new CompileError('the compiler stopped'))
        }
      }
      worker.on('error', fail)
      worker.on('exit', fail)
      return worker
    })()
    this.worker = started
    // A compiler that couldn't start (its files unreadable) is tried again next time.
    started.catch(() => {
      if (this.worker === started) this.worker = null
    })
    return started
  }
}

let shared: Compiler | null = null

/** Compiles with one shared Compiler over the installed esbuild-wasm. */
export function compilePackage(files: PackageFiles): Promise<string> {
  shared ??= new Compiler()
  return shared.compile(files)
}

/** compileNode with the shared Compiler. */
export function compileNodePackage(
  files: PackageFiles,
  lock: DependencyLock | null,
  packages: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<string> {
  shared ??= new Compiler()
  return shared.compileNode(files, lock, packages)
}
