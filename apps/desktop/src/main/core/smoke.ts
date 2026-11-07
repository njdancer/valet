// What only a smoke build (`electron-vite build --mode smoke`, for scripts/package-smoke.mjs)
// compiles in, behind __VALET_SMOKE_BUILD__. A plain build drops every use of these, so the
// marker never appears in its bundle; electron-builder.config.ts refuses to package a release from a
// bundle that holds it.

/** A string only a smoke build's bundle contains. */
export const SMOKE_BUILD_MARKER = 'valet-smoke-build-a7c41e'

/**
 * The one argv a smoke build accepts besides the normal shapes (core/argv.ts): Chromium's mock
 * keychain, the DevTools protocol on a free port (the smoke reads the control panel over it), and a
 * resolver that resolves nothing but loopback. Exactly these, in this order.
 */
export const SMOKE_ARGV = [
  '--use-mock-keychain',
  '--remote-debugging-port=0',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
] as const

/** Where a smoke build writes its self-check, under userData. */
export const SMOKE_REPORT_FILE = 'smoke-report.json'
