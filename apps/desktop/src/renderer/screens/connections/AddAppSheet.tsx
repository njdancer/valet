// "Add an app" (sheet over Connections): name it, and Valet makes it its own token; then the ways to
// set it up, and a live line that ticks when its first call arrives.

import {
  Button,
  Dialog,
  Field,
  Input,
  SheetContent,
  Spacer,
  Stack,
  StatusDot,
  SuccessCheck,
  Text,
  TextLink,
} from '@valet/ui'
import { useState } from 'react'
import type { ClientInfo } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { href } from '../../lib/router'
import { SetupSnippets } from './SetupSnippets'
import { Failed } from './shared'

const DEFAULT_NAME = 'Claude Code'

export function AddAppSheet({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const api = useApi()
  const add = useAction()
  const [name, setName] = useState(DEFAULT_NAME)
  const [added, setAdded] = useState<ClientInfo | null>(null)
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setAdded(null)
      setName(DEFAULT_NAME)
    }
  }
  const submit = async () => {
    if (name.trim() === '') return
    let made: ClientInfo | null = null
    const ok = await add.run(async () => {
      made = await api.clients.add(name.trim())
    })
    if (ok) setAdded(made)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <SheetContent
        wide={added !== null}
        title={added === null ? 'Add an app' : `Set up ${added.name}`}
        description={
          added === null
            ? 'Each app gets its own token, so you can tell its calls apart and cut one off without touching the others.'
            : 'Pick the way that fits. Valet waits here for its first call.'
        }
        footer={
          added === null ? (
            <>
              <Spacer />
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={add.busy}
                disabled={name.trim() === ''}
                disabledReason="Name the app first"
                onClick={() => void submit()}
              >
                Add app
              </Button>
            </>
          ) : (
            <>
              <TextLink href={href.client(added.id)} onClick={() => close(false)}>
                Open {added.name}’s page
              </TextLink>
              <Spacer />
              <Button variant="primary" onClick={() => close(false)}>
                Done
              </Button>
            </>
          )
        }
      >
        {added === null ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Stack gap={3}>
              <Field
                label="Name for the app"
                description="Your name for it, shown in Activity and the audit log."
              >
                <Input
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Claude Code"
                />
              </Field>
              <Failed failed={add.failed} what="add the app" />
            </Stack>
          </form>
        ) : (
          <Stack gap={5}>
            <SetupSnippets client={added} />
            <FirstCall client={added} />
          </Stack>
        )}
      </SheetContent>
    </Dialog>
  )
}

/** Waits for the new app's first call, and says so when it arrives. */
function FirstCall({ client }: { readonly client: ClientInfo }) {
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const seen = clients.status === 'ready' && clients.data.find((c) => c.id === client.id)?.lastSeen != null
  return (
    <div aria-live="polite" className="flex items-center gap-2 rounded-md bg-inset px-3 py-2.5">
      {seen ? (
        <>
          <SuccessCheck size={18} />
          <Text weight="medium">{client.name} made its first call. It’s connected.</Text>
        </>
      ) : (
        <>
          <StatusDot tone="accent" pulse />
          <Text tone="muted">Waiting for {client.name}’s first call…</Text>
        </>
      )}
    </div>
  )
}
