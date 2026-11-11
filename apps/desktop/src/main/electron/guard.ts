// The packaged app's first statement (src/main/index.ts imports this before anything else): the
// command-line and environment check (core/argv.ts). A refused launch exits here, with a fixed
// message and status 64, before the app is ready, the single-instance lock, any window, partition
// or secret. electron/app.ts also does nothing in a refused launch, in case the exit isn't at once.
//
// Chromium has parsed its switches before this runs, so this is detection and early exit, not
// prevention: a --remote-debugging-port listener may already be up, in a process that has loaded
// nothing. Unpackaged runs (dev, demo, the e2e suite, which Playwright launches with its own
// switches) aren't checked.

import { app } from 'electron'
import { classifyArgv, refusedEnv } from '../core/argv'
import { SHOWCASE_ARGV } from '../core/showcase'
import { SMOKE_ARGV } from '../core/smoke'

/** A smoke or showcase build's own argv; a plain build drops both, and accepts only the normal shapes. */
const SMOKE_EXTRA: readonly string[] | null = __VALET_SMOKE_BUILD__
  ? SMOKE_ARGV
  : __VALET_SHOWCASE_BUILD__
    ? SHOWCASE_ARGV
    : null

function check(): boolean {
  if (!app.isPackaged) return false
  const argv = classifyArgv(process.argv, SMOKE_EXTRA)
  if (argv.mode === 'app' && refusedEnv(process.env).length === 0) return false
  process.stderr.write(
    argv.mode === 'bridge'
      ? 'valet: bridge mode is not built yet\n'
      : 'valet: refused to start: unexpected arguments or environment\n',
  )
  return true
}

/** True when this launch was refused: electron/app.ts then starts nothing. */
export const launchRefused = check()
if (launchRefused) process.exit(64)
