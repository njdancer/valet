// Electron entry point for the e2e harness. Electron's main process can't load TypeScript, so this
// registers tsx and then loads the real harness, which imports the driver's source directly.

import { register } from 'tsx/esm/api'

register()
await import('./harness.ts')
