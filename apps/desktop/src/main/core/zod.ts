// zod for the main process. apps/desktop doesn't list zod as a dependency yet (requested), and
// this unit may not change dependency lists, so 'zod' is aliased to core's copy (tsconfig.json
// paths, and resolve.alias in electron.vite.config.ts and vitest.config.ts): the same zod core's
// schemas are built with. Once zod is a dependency here, the aliases go and this file stays.

export { z } from 'zod'
