// The main process entry. Everything privileged lives behind it: see electron/app.ts.

// Electron glue: covered by the smoke test (test/smoke) and the e2e suite, not by unit tests.
/* v8 ignore start */

import './electron/app'
/* v8 ignore stop */
