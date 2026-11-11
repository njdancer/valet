// The app-wide state every surface shows the same way: paused or locked down, the Needs you count,
// and the sidebar's one status line ("Ready · 2 apps connected").

import type { DotTone } from '@valet/ui'
import type { AppStatus } from '../../shared/api'
import { useLoad } from '../lib/api-context'
import { useSetupLeft } from '../screens/setup/setup-logic'

export interface ShellState {
  readonly ready: boolean
  readonly demo: boolean
  readonly paused: boolean
  readonly lockedDown: boolean
  readonly needsYou: number
  readonly tone: DotTone
  readonly line: string
}

export function isLockedDown(status: AppStatus): boolean {
  return status.lockedDown
}

export function useShellState(): ShellState {
  const app = useLoad((api) => api.app.status(), [], ['app-changed'])
  const attention = useLoad((api) => api.attention.list(), [], ['attention-changed'])
  const endpoint = useLoad((api) => api.endpoint.status(), [], ['endpoint-changed'])
  const status = app.status === 'ready' ? app.data : null
  const paused = status?.paused === true
  const lockedDown = status !== null && isLockedDown(status)
  const setupLeft = useSetupLeft()
  // Unfinished setup is one more waiting item, as the menu bar counts it.
  const needsYou =
    (attention.status === 'ready' ? attention.data.filter((i) => i.kind !== 'missed').length : 0) +
    (setupLeft === null ? 0 : 1)
  const apps = endpoint.status === 'ready' ? endpoint.data.connectedClients : null
  const listening = endpoint.status === 'ready' ? endpoint.data.listening : null
  let tone: DotTone = 'success'
  let line = 'Ready'
  if (lockedDown) {
    tone = 'danger'
    line = 'Locked down'
  } else if (paused) {
    tone = 'warning'
    line = 'Paused'
  } else if (listening === false) {
    tone = 'neutral'
    line = 'Endpoint off · apps can’t reach Valet'
  } else if (apps !== null) {
    line = `Ready · ${apps === 0 ? 'no apps' : apps === 1 ? '1 app' : `${apps} apps`} connected`
  }
  return {
    ready: status !== null,
    demo: status?.demo === true,
    paused,
    lockedDown,
    needsYou,
    tone,
    line,
  }
}
