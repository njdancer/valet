// zod for the main process. apps/desktop doesn't list zod as a dependency yet (requested), and
// this unit may not change dependency lists, so it borrows core's copy: the same zod core's
// schemas are built with. Once zod is a dependency here, this file becomes `export { z } from 'zod'`.

export { z } from '../../../../../packages/core/node_modules/zod/index.js'
