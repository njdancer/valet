// The little of jsdom's API the scratch browser's tests use; the package ships no types.
declare module 'jsdom' {
  export class JSDOM {
    constructor(
      html: string,
      options?: {
        readonly url?: string
        readonly runScripts?: 'outside-only'
        readonly pretendToBeVisual?: boolean
      },
    )
    readonly window: {
      eval(code: string): unknown
      readonly document: {
        querySelector(selector: string): Record<string, unknown> | null
        elementFromPoint: unknown
      }
    }
  }
}
