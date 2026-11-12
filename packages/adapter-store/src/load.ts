// Turns a package into what the tool host registers: check, hash, compile, describe, and an
// AdapterDefinition whose tools carry the derived schemas and never run in this process (the tool
// host runs them in the tool process, from `script`). Used at install and at every load: nothing
// compiled or derived is ever stored (docs/adapter-packages.md).

import {
  type AdapterDefinition,
  type CheckedPackage,
  checkPackage,
  defineAdapter,
  type PackageFiles,
  sha256Hex,
  type ToolImplementation,
  ValetError,
} from '@valet/core'
import { describeIsolated, type ToolProcessFactory } from '@valet/runtime'
import { COMPILER_VERSION, type Compiler, compilePackage } from './compile'
import { SchemaError, toolSchemas } from './schemas'

/** What the app gives every load: the library prelude and how to start a tool process. */
export interface PackageRuntime {
  /** The library prelude (buildToolLibrary), evaluated before every adapter script. */
  readonly prelude: string
  readonly start: ToolProcessFactory
  readonly describeTimeoutMs?: number
  /** Defaults to one shared Compiler over the installed esbuild-wasm. */
  readonly compiler?: Compiler
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
  let compiled: string
  try {
    compiled = await (runtime.compiler === undefined
      ? compilePackage(checked.files)
      : runtime.compiler.compile(checked.files))
  } catch (error) {
    throw new LoadError(
      'compile',
      error instanceof Error && 'detail' in error ? String(error.detail) : 'failed',
    )
  }
  const script = `${runtime.prelude}\n;\n${compiled}`
  let described: Readonly<Record<string, unknown>>
  try {
    described = await describeIsolated(runtime.start, script, runtime.describeTimeoutMs)
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
      const problem = error instanceof SchemaError ? `${error.problem}: ${error.detail}` : 'invalid'
      throw new LoadError('schema', `${name}: ${problem}`)
    }
  }
  return { ...checked, script, definition: defineAdapter({ manifest: checked.manifest, tools }) }
}

/** A package's tools only ever run in the tool process; reaching this is a wiring bug. */
function outOfProcess(): Promise<never> {
  return Promise.reject(new ValetError('tool-run', 'internal'))
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
