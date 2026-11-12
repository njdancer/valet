// Where the QuickJS-ng WebAssembly file is, for the main process (which sends its bytes to each
// sandbox renderer) and for tests in Node.

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { compileQuickJS, type QuickJSFactory, quickJSFactory } from './module'

/** The path of `emscripten-module.wasm` in the installed variant package. */
export function quickJSWasmPath(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm')
}

export async function readQuickJSWasm(path: string = quickJSWasmPath()): Promise<ArrayBuffer> {
  const bytes = await readFile(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

let cached: Promise<QuickJSFactory> | null = null

/** Compiled once per process, for tests; each run still gets its own instance. */
export function nodeQuickJS(): Promise<QuickJSFactory> {
  cached ??= readQuickJSWasm().then(compileQuickJS).then(quickJSFactory)
  return cached
}
