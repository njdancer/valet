// Constants electron.vite.config.ts defines at build time. A production build sets both to false,
// so the code behind them (demo mode, the dev server's renderer URL) is dropped from the bundle.

/** electron-vite dev, or `electron-vite build --mode demo`: demo mode may be switched on. */
declare const __SITEADAPTER_DEMO_BUILD__: boolean
/** electron-vite dev: the renderer may come from the dev server (ELECTRON_RENDERER_URL). */
declare const __SITEADAPTER_DEV_SERVER__: boolean
