export interface Extracted {
  readonly version: string
  readonly source: string
  readonly sha256: string
}
export declare const PATCHES: readonly { readonly find: string; readonly replace: string }[]
export declare function extractInjectedScript(): Extracted
export declare function render(extracted: Extracted): string
