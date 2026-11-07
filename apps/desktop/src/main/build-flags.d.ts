// Constants electron.vite.config.ts defines at build time. A production build sets the first two to
// false, so the code behind them (demo mode, the dev server's renderer URL) is dropped from the
// bundle. The feed's two are empty unless a plain build's environment gives both
// (core/feed-defines.ts); a dev or demo build never has them.

/** electron-vite dev, or `electron-vite build --mode demo`: demo mode may be switched on. */
declare const __VALET_DEMO_BUILD__: boolean
/** electron-vite dev: the renderer may come from the dev server (ELECTRON_RENDERER_URL). */
declare const __VALET_DEV_SERVER__: boolean
/** The update feed's base URL (VALET_UPDATE_URL at build time), or ''. */
declare const __VALET_FEED_BASE_URL__: string
/** The SPKI PEM public key the feed's envelopes are signed for (VALET_FEED_PUBLIC_KEY_FILE), or ''. */
declare const __VALET_FEED_PUBLIC_KEY__: string
/**
 * `electron-vite build --mode smoke`, for scripts/package-smoke.mjs only: the smoke's own argv
 * (core/smoke.ts) and a self-check report. electron-builder.config.ts refuses a release from it.
 */
declare const __VALET_SMOKE_BUILD__: boolean
