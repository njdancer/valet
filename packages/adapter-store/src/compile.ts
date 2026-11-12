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
import { PACKAGE_ENTRY, type PackageFiles } from '@valet/core'
import { TOOL_LIBRARY_GLOBAL } from '@valet/runtime/tool-script'

/** The esbuild version compiling packages. A test checks it matches the installed esbuild-wasm. */
export const COMPILER_VERSION = '0.28.2'

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
parentPort.on('message', async ({ id, files, entry, global }) => {
  try {
    await ready
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
    if (first) {
      const at = first.location && typeof first.location.file === 'string'
        ? first.location.file.replace('valet-package:', '') + ':' + first.location.line + ': '
        : ''
      detail = clip(at + (typeof first.text === 'string' ? first.text : 'error'))
    }
    parentPort.postMessage({ id, ok: false, detail })
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

  constructor(private readonly files: CompilerFiles = defaultCompilerFiles()) {}

  /**
   * The adapter's own code as one IIFE defining `__valetTools` (`tools`, `ValetError`,
   * `NeedsUserError`, `toJSONSchema`). It needs the library prelude evaluated before it. Rejects
   * with CompileError carrying the first problem. The output depends only on `files` and the
   * compiler version.
   */
  async compile(files: PackageFiles): Promise<string> {
    const worker = await this.start()
    const id = this.next++
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // Held open only while a compile is waiting, so an idle compiler never keeps a process alive.
      worker.ref()
      worker.postMessage({ id, files: { ...files }, entry: PACKAGE_ENTRY, global: TOOL_LIBRARY_GLOBAL })
    })
  }

  /** Stops the worker. A later compile starts another. */
  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker !== null) await (await worker).terminate()
  }

  private start(): Promise<Worker> {
    this.worker ??= (async () => {
      const [source, wasm] = await Promise.all([
        readFile(this.files.browserJs, 'utf8'),
        readFile(this.files.wasm),
      ])
      const worker = new Worker(WORKER, { eval: true, workerData: { source, wasm } })
      worker.unref()
      worker.on('message', (m: { id: number; ok: boolean; text?: string; detail?: string }) => {
        const waiting = this.pending.get(m.id)
        if (waiting === undefined) return
        this.pending.delete(m.id)
        if (this.pending.size === 0) worker.unref()
        if (m.ok && typeof m.text === 'string') waiting.resolve(m.text)
        else waiting.reject(new CompileError(typeof m.detail === 'string' ? m.detail : 'failed'))
      })
      const fail = (): void => {
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
    return this.worker
  }
}

let shared: Compiler | null = null

/** Compiles with one shared Compiler over the installed esbuild-wasm. */
export function compilePackage(files: PackageFiles): Promise<string> {
  shared ??= new Compiler()
  return shared.compile(files)
}
