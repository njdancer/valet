// Types for node-runtime.mjs, so the tests that import it typecheck.

export type NodeArch = 'arm64' | 'x64'

export interface NodeRuntimePin {
  readonly version: string
  readonly identifier: string
  readonly archives: Record<NodeArch, { file: string; sha256: string }>
}

export declare const NODE_RUNTIME_PIN: string
export declare const NODE_RUNTIME_ENTITLEMENTS: string
export declare const NODE_RUNTIME_CACHE: string
export declare const NODE_RUNTIME_OUT: string
export declare const NODE_DIST: string
export declare const ARCHES: readonly NodeArch[]

export declare function readPin(text: string): NodeRuntimePin
export declare function archiveUrl(pin: NodeRuntimePin, arch: NodeArch): string
export declare function sha256(bytes: Uint8Array): string
export declare function verifiedArchive(
  pin: NodeRuntimePin,
  arch: NodeArch,
  options?: { cache?: string; fetch?: typeof fetch },
): Promise<string>
export declare function buildNodeRuntime(options?: {
  out?: string
  cache?: string
  fetch?: typeof fetch
}): Promise<{ out: string; pin: NodeRuntimePin }>
export declare function signArguments(
  pin: NodeRuntimePin,
  identity: string,
  file: string,
  options?: { timestamp?: boolean },
): string[]
export declare function signNodeRuntime(pin: NodeRuntimePin, identity: string, file?: string): void
