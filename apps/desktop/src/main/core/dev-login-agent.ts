// Start at login for a development run (unpackaged, from the repository). A packaged Valet registers
// itself with macOS as a login item; an unpackaged one can't, because macOS would register the bare
// Electron app, which opens without Valet's code. So a development run writes a per-user LaunchAgent
// that starts the same Electron binary on the same app folder at login, appending to the usual log.
// It runs once at login and is never restarted when Valet quits (no KeepAlive): an unexpected quit is
// logged with its cause and fixed, not hidden.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DEV_LOGIN_AGENT_LABEL = 'me.dncr.valet.dev.login'

export interface DevLoginAgentPaths {
  /** The user's home folder. */
  readonly home: string
  /** process.execPath: the Electron binary this run uses. */
  readonly electron: string
  /** app.getAppPath(): the folder Electron was started on. */
  readonly appPath: string
  /** The log the run appends to. */
  readonly logFile: string
  /** PATH to start with, so tools found from a terminal (op, xcrun) are found at login too. */
  readonly path: string | undefined
}

export function devLoginAgentFile(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${DEV_LOGIN_AGENT_LABEL}.plist`)
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function devLoginAgentPlist(paths: DevLoginAgentPaths): string {
  const env =
    paths.path === undefined
      ? ''
      : `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xml(paths.path)}</string>\n  </dict>\n`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DEV_LOGIN_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.electron)}</string>
    <string>${xml(paths.appPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.appPath)}</string>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.logFile)}</string>
</dict>
</plist>
`
}

/** Writes or removes the LaunchAgent. It takes effect at the next login; nothing is started now. */
export async function setDevLoginAgent(enabled: boolean, paths: DevLoginAgentPaths): Promise<void> {
  const file = devLoginAgentFile(paths.home)
  if (!enabled) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, devLoginAgentPlist(paths), { mode: 0o644 })
}
