// What only a showcase build (`electron-vite build --mode showcase`, packaged by
// scripts/package-showcase.mjs as Valet Demo) compiles in, behind __VALET_SHOWCASE_BUILD__.
//
// A showcase build exists to be installed and recorded end to end on a fresh Mac (the demo video
// workflow, .github/workflows/demo-video.yml): it runs demo mode always, packaged or not, so it only
// ever talks to the fake shop in its own process, with the fake's test account and no real
// 1Password, Keychain item or Messages. A plain build drops every use of these.

/** A string only a showcase build's bundle contains. */
export const SHOWCASE_BUILD_MARKER = 'valet-showcase-build-5d0e93'

/**
 * The one argv a showcase build accepts besides the normal shapes (core/argv.ts): Chromium's mock
 * keychain (so the cookie key is never a Keychain item) and the DevTools protocol on a fixed
 * loopback port, which the recording script drives the windows through. Exactly these, in order.
 */
export const SHOWCASE_ARGV = ['--use-mock-keychain', '--remote-debugging-port=9333'] as const

/** The fake shop's house brand in a showcase, so a recording shows only the made-up brand. */
export const SHOWCASE_HOUSE_BRAND = 'Gumleaf'
