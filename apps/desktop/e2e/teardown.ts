// After the whole run: no Electron this suite started may outlive it. Each spec closes its app, but
// a test that failed mid-launch, or a helper process Electron left behind, would otherwise keep the
// endpoint's port and the single-instance lock for the next run. Only processes running this
// worktree's Electron binary are matched, never another Electron app on the machine.

import { execFileSync } from 'node:child_process'
import { electronDist } from './harness'

export default function teardown(): void {
  try {
    execFileSync('pkill', ['-f', electronDist], { stdio: 'ignore' })
  } catch {
    // pkill exits 1 when nothing matched.
  }
}
