// Turns a package into what the tool host registers: check, hash, compile, describe, and an
// AdapterDefinition whose tools carry the derived schemas and never run in this process (the tool
// host runs them in the tool process, from `script`). Used at install and at every load: nothing
// compiled or derived is ever stored (docs/adapter-packages.md).

import {
  type AdapterDefinition,
  type CheckedPackage,
  checkPackage,
  type DependencyLock,
  defineAdapter,
  type PackageFiles,
  runtimeOf,
  sha256Hex,
  type ToolImplementation,
  ValetError,
} from '@valet/core'
import { describeIsolated, type ToolProcessFactory } from '@valet/runtime'
import { COMPILER_VERSION, type Compiler, compileNodePackage, compilePackage } from './compile'
import { SchemaError, toolSchemas } from './schemas'

/** What the app gives every load: the library prelude and how to start a tool process. */
export interface PackageRuntime {
  /** The library prelude (buildToolLibrary), evaluated before every adapter script. */
  readonly prelude: string
  readonly start: ToolProcessFactory
  readonly describeTimeoutMs?: number
  /** Defaults to one shared Compiler over the installed esbuild-wasm. */
  readonly compiler?: Compiler
  /**
   * What a `raw` adapter needs to load (docs/node-runtime.md): its dependencies' files, read from
   * Valet's tarball store and checked against the lockfile again, and the Node runtime to describe
   * its tools in (a process with no endpoints). Without it, a raw package doesn't load.
   */
  readonly raw?: RawPackageRuntime
}

export interface RawPackageRuntime {
  /** Package key (`name@version`) to its files, for every package in `lock`. */
  dependencies(
    lock: DependencyLock | null,
  ): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>>
  /** A Node runtime process with no network at all, for describe and input checks. */
  readonly start: ToolProcessFactory
}

/** What the adapter hash doesn't cover, recorded with each version (B's review, point 5). */
export interface BuildRecord {
  readonly appVersion: string
  readonly preludeHash: string
  readonly compiler: string
}

export interface LoadedPackage extends CheckedPackage {
  /** The prelude and the compiled adapter, as the tool process evaluates them. */
  readonly script: string
  readonly definition: AdapterDefinition
}

export type LoadStage = 'compile' | 'describe' | 'schema'

/** Why a package that passed checkPackage still can't load. `detail` never holds file contents. */
export class LoadError extends Error {
  constructor(
    readonly stage: LoadStage,
    readonly detail: string,
  ) {
    super(`package did not load (${stage}): ${detail}`)
    this.name = 'LoadError'
  }
}

export function buildRecord(appVersion: string, prelude: string): BuildRecord {
  return { appVersion, preludeHash: sha256Hex(prelude), compiler: `esbuild-wasm ${COMPILER_VERSION}` }
}

/** Throws PackageError (core) or LoadError. */
export async function loadPackage(input: PackageFiles, runtime: PackageRuntime): Promise<LoadedPackage> {
  const checked = checkPackage(input)
  const raw = runtimeOf(checked.manifest) === 'raw'
  if (raw && runtime.raw === undefined) throw new LoadError('compile', 'this build can’t run raw adapters')
  let compiled: string
  try {
    if (raw) {
      const packages = await (runtime.raw as RawPackageRuntime).dependencies(checked.dependencies)
      compiled = await (runtime.compiler === undefined
        ? compileNodePackage(checked.files, checked.dependencies, packages)
        : runtime.compiler.compileNode(checked.files, checked.dependencies, packages))
    } else {
      compiled = await (runtime.compiler === undefined
        ? compilePackage(checked.files)
        : runtime.compiler.compile(checked.files))
    }
  } catch (error) {
    throw new LoadError(
      'compile',
      error instanceof Error && 'detail' in error ? String(error.detail) : clipMessage(error),
    )
  }
  const script = `${runtime.prelude}\n;\n${compiled}`
  // A raw adapter's code is Node code: it is described in the Node runtime, never in the sandbox.
  const start = raw ? (runtime.raw as RawPackageRuntime).start : runtime.start
  let described: Readonly<Record<string, unknown>>
  try {
    described = await describeIsolated(start, script, runtime.describeTimeoutMs)
  } catch {
    throw new LoadError('describe', 'the tool process gave no usable answer')
  }
  const declared = checked.manifest.tools.map((t) => t.name)
  const implemented = Object.keys(described)
  for (const name of implemented) {
    if (!declared.includes(name))
      throw new LoadError('schema', `${clip(name)} is implemented but not declared`)
  }
  const tools: Record<string, ToolImplementation> = {}
  for (const name of declared) {
    if (!Object.hasOwn(described, name))
      throw new LoadError('schema', `${name} is declared but not implemented`)
    try {
      const { input: inputSchema, output } = toolSchemas(described[name])
      tools[name] = { input: inputSchema, output, run: outOfProcess }
    } catch (error) {
      throw new LoadError('schema', schemaProblem(name, error))
    }
  }
  return { ...checked, script, definition: defineAdapter({ manifest: checked.manifest, tools }) }
}

/** What's wrong with one tool's schemas, in words an author can act on. */
export function schemaProblem(name: string, error: unknown): string {
  if (!(error instanceof SchemaError)) return `${name}: invalid`
  if (error.problem === 'missing') {
    return error.detail === 'input'
      ? `${name} has no input schema: give tool({ input: z.object({...}) }) (z.object({}) for none)`
      : `${name} has no output schema: give tool({ output: z.object({...}) }), bounding each string and array with .max()`
  }
  if (error.problem === 'convert' && / not representable$/.test(error.detail)) {
    const which = error.detail.startsWith('output') ? 'output' : 'input'
    return `${name}: its ${which} schema can’t be written as JSON Schema (z.date(), z.function(), a transform or a custom type can’t); use plain zod types such as z.object, z.string and z.number`
  }
  return `${name}: ${error.problem}: ${error.detail}`
}

/** A package's tools only ever run in the tool process; reaching this is a wiring bug. */
function outOfProcess(): Promise<never> {
  return Promise.reject(new ValetError('tool-run', 'internal'))
}

/** A dependency the store can't give (DependencyError), say: its message, which names no file contents. */
function clipMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'DependencyError') return clip(error.message)
  return 'failed'
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
