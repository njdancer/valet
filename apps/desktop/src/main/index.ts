// The main process entry. Everything privileged lives behind it: see electron/app.ts.
//
// The command-line check comes first, before any other module's code runs (ES modules evaluate
// their imports in order): test/main/argv.test.ts holds this order in place.

import './electron/guard'
import './electron/app'
