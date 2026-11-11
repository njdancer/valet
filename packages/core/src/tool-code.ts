// What tool code may import from core when it runs in the isolated tool process: the error
// classes and vocabularies, the `tool()` helper, and the shapes a setting's tools exchange. Nothing here touches Node, so the tool script
// builder resolves `@valet/core` to this file and refuses any adapter import that needs more
// (packages/runtime/src/isolation/tool-script.ts). Types are erased and may come from anywhere.

export { MAX_CONFIRM_NOTE, tool } from './adapter'
export * from './errors'
export * from './settings'
export { BLOCK_REASONS } from './vocab'
