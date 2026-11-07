// Electron entry point for the smoke harness. Electron's main process can't load TypeScript, so this
// registers tsx and then loads the real harness, which imports the adapter and driver sources.

import { register } from 'tsx/esm/api'

register()
await import('./smoke.ts')
