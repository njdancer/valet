// The title bar every page shares (IA section 4): back and forward, search (the command palette),
// and the kill switches: Pause Valet, with Lock down in its menu. Under it, while Valet is paused or
// locked down, one strip says so on every page, with the way back.

import {
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  formatShortcut,
  ShellStatus,
  SplitButton,
  TitleBar,
  toast,
} from '@valet/ui'
import { Lock, Pause, Play } from 'lucide-react'
import { useState } from 'react'
import { useAction, useApi } from '../lib/api-context'
import { useShellState } from './shell-state'

/** Lock down's API is newer than some main processes; this asks for it without assuming. */
export async function setLockedDown(api: ReturnType<typeof useApi>, locked: boolean): Promise<void> {
  await api.app.setLockedDown(locked)
}

export function TitleArea({ onSearch }: { readonly onSearch: () => void }) {
  const api = useApi()
  const shell = useShellState()
  const action = useAction()
  const [lockOpen, setLockOpen] = useState(false)

  const pause = async (paused: boolean) => {
    const ok = await action.run(() => api.app.setPaused(paused))
    if (!ok) toast.error(paused ? 'Valet couldn’t pause. Try again.' : 'Valet couldn’t resume. Try again.')
    else if (paused)
      toast('Valet paused. Calls are refused and nothing is sent.', {
        action: { label: 'Undo', onClick: () => void action.run(() => api.app.setPaused(false)) },
      })
  }

  const lock = async (locked: boolean) => {
    const ok = await action.run(() => setLockedDown(api, locked))
    if (!ok)
      toast.error(locked ? 'Valet couldn’t lock down. Try again.' : 'Valet couldn’t unlock. Try again.')
  }

  return (
    <>
      <TitleBar
        onBack={() => window.history.back()}
        onForward={() => window.history.forward()}
        onSearch={onSearch}
        actions={
          shell.lockedDown ? (
            <Button size="sm" leading={<Lock />} onClick={() => void lock(false)} loading={action.busy}>
              Unlock
            </Button>
          ) : (
            <SplitButton
              size="sm"
              leading={shell.paused ? <Play /> : <Pause />}
              onClick={() => void pause(!shell.paused)}
              menuLabel="More ways to stop Valet"
              menu={
                <DropdownMenuItem
                  onSelect={() => setLockOpen(true)}
                  shortcut={formatShortcut('mod+alt+shift+L')}
                >
                  Lock down…
                </DropdownMenuItem>
              }
            >
              {shell.paused ? 'Resume' : 'Pause Valet'}
            </SplitButton>
          )
        }
      />
      {shell.lockedDown ? (
        <ShellStatus
          state="locked"
          action={
            <Button size="sm" variant="ghost" onClick={() => void lock(false)}>
              Unlock
            </Button>
          }
        >
          Locked down · every call is refused and cloud agents were removed
        </ShellStatus>
      ) : shell.paused ? (
        <ShellStatus
          state="paused"
          action={
            <Button size="sm" variant="ghost" onClick={() => void pause(false)}>
              Resume
            </Button>
          }
        >
          Paused · calls are refused and nothing is sent
        </ShellStatus>
      ) : null}
      <LockDownDialog open={lockOpen} onOpenChange={setLockOpen} onConfirm={() => void lock(true)} />
    </>
  )
}

export function LockDownDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title="Lock down Valet?"
      description="For when you think something is wrong. Every call is refused until you unlock, with an answer that says Valet is locked down."
      confirmLabel="Lock down"
      onConfirm={onConfirm}
    >
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-md text-fg">
        <li>Every site stops: no call reaches any site.</li>
        <li>Apps on this Mac stay connected, so they can say why they were refused.</li>
        <li>
          <strong>Can’t be undone:</strong> every cloud agent is removed and has to be approved again.
        </li>
      </ul>
    </ConfirmDialog>
  )
}
