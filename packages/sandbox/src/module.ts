// The QuickJS-ng WebAssembly module. It's compiled once (per renderer, or per test process) and
// instantiated afresh for every run, so no two runs ever share linear memory: a later run, even
// one that broke out of QuickJS, finds nothing an earlier one left in the heap
// (docs/sandbox.md#inside-quickjs). No Node imports here: node-module.ts reads the file.

import releaseSync from '@jitl/quickjs-ng-wasmfile-release-sync'
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core'

/** Makes a fresh QuickJS instance, with its own memory. */
export type QuickJSFactory = () => Promise<QuickJSWASMModule>

/** The global's compile; the base tsconfig has no DOM lib, so it's typed here. */
declare const WebAssembly: { compile(bytes: ArrayBuffer): Promise<WebAssembly.Module> }

export function compileQuickJS(wasm: ArrayBuffer): Promise<WebAssembly.Module> {
  return WebAssembly.compile(wasm)
}

export function quickJSFactory(compiled: WebAssembly.Module): QuickJSFactory {
  return () => newQuickJSWASMModuleFromVariant(newVariant(releaseSync, { wasmModule: compiled }))
}
