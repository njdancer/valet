// 1Password on this Mac: the account Keychain copies come from, and the CLI Valet runs. Setup uses
// the account field too.

import { Button, Field, Inline, Input, Stack, Text, Value } from '@valet/ui'
import { useState } from 'react'
import { useAction, useApi } from '../../lib/api-context'
import { Failed } from '../connections/shared'

/**
 * The 1Password account Keychain copies come from (D6). It names an account, never a secret: the
 * person approves each copy in 1Password itself.
 */
export function OnePasswordAccountSetting({
  value,
  onSave,
}: {
  readonly value: string | null
  readonly onSave: (account: string | null) => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  const trimmed = draft.trim()
  const changed = (trimmed === '' ? null : trimmed) !== value
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (changed) onSave(trimmed === '' ? null : trimmed)
      }}
    >
      <Field
        label="1Password account"
        description="The account name at the top of 1Password’s sidebar. Valet copies the items you give it into your Keychain, with your approval in 1Password each time."
      >
        <Inline gap={2} wrap={false}>
          <Input
            placeholder="my.1password.com"
            value={draft}
            className="flex-1"
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={!changed} disabledReason="Nothing to save">
            Save
          </Button>
        </Inline>
      </Field>
    </form>
  )
}

/**
 * The 1Password CLI's path. The renderer can't type one: the main process shows a file dialog,
 * checks what was picked (absolute, not writable by others, 1Password's signature) and saves it.
 */
export function OpPathSetting({ value }: { readonly value: string | null }) {
  const api = useApi()
  const action = useAction()
  return (
    <Stack gap={1.5}>
      <Text weight="medium">1Password CLI</Text>
      <Inline gap={2}>
        {value === null ? (
          <Text data-testid="op-path">Found automatically</Text>
        ) : (
          <span data-testid="op-path" className="min-w-0">
            <Value mono>{value}</Value>
          </span>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          loading={action.busy}
          onClick={() => void action.run(() => api.settings.chooseOpPath())}
        >
          Choose…
        </Button>
        {value !== null ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() => void action.run(() => api.settings.clearOpPath())}
          >
            Find automatically
          </Button>
        ) : null}
      </Inline>
      <Text size="sm" tone="muted">
        Valet checks the file is 1Password’s, signed, before using it.
      </Text>
      <Failed failed={action.failed} what="use that file" />
    </Stack>
  )
}
