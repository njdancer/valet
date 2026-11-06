// Constants electron.vite.config.ts defines at build time. A production build sets the first two to
// false, so the code behind them (demo mode, the dev server's renderer URL) is dropped from the
// bundle. The feed's two are empty unless a plain build's environment gives both
// (core/feed-defines.ts); a dev or demo build never has them.

/** electron-vite dev, or `electron-vite build --mode demo`: demo mode may be switched on. */
declare const __SITEADAPTER_DEMO_BUILD__: boolean
/** electron-vite dev: the renderer may come from the dev server (ELECTRON_RENDERER_URL). */
declare const __SITEADAPTER_DEV_SERVER__: boolean
/** The update feed's base URL (SITEADAPTER_UPDATE_URL at build time), or ''. */
declare const __SITEADAPTER_FEED_BASE_URL__: string
/** The SPKI PEM public key the feed's envelopes are signed for (SITEADAPTER_FEED_PUBLIC_KEY_FILE), or ''. */
declare const __SITEADAPTER_FEED_PUBLIC_KEY__: string
