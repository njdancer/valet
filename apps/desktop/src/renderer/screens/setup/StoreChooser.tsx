// Choosing one of a site's settings, such as the Woolworths store its prices and stock come from
// (D69). The search runs the adapter's own lookup against the site, paced like every call, and the
// main process accepts only a choice the last search returned. What comes back is the site's text,
// so it is shown as that: plain text, under a line that says where it came from.

import { Badge, Button, Field, Input, Stack, Text } from '@valet/ui'
import { Search } from 'lucide-react'
import { useState } from 'react'
import type { AdapterDetail, AdapterSettingInfo, SettingChoicesReply } from '../../../shared/api'
import { useAction, useApi } from '../../lib/api-context'
import { formatIn, formatTime } from '../../lib/format'
import { Failed } from './SetupSteps'

export function StoreChooser({
  adapter,
  setting,
  now,
}: {
  readonly adapter: AdapterDetail
  readonly setting: AdapterSettingInfo
  readonly now: number
}) {
  const api = useApi()
  const search = useAction()
  const choose = useAction()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reply, setReply] = useState<{ readonly query: string; readonly reply: SettingChoicesReply } | null>(
    null,
  )
  const searching = open || setting.chosen === null
  const approved = adapter.approval === 'approved'
  const title = setting.title.toLowerCase()

  const runSearch = () =>
    search.run(async () => {
      const asked = query.trim()
      setReply(null)
      setReply({ query: asked, reply: await api.adapters.settingChoices(adapter.id, setting.name, asked) })
    })
  const pick = (choiceId: string) =>
    choose.run(async () => {
      await api.adapters.setSetting(adapter.id, setting.name, choiceId)
      setOpen(false)
      setReply(null)
      setQuery('')
    })

  return (
    <Stack gap={3} data-testid={`setting-${setting.name}`}>
      <div className="flex items-center gap-2">
        <Text weight="semibold" className="flex-1">
          {setting.title}
        </Text>
        {setting.chosen !== null ? (
          <Badge tone="success">Chosen</Badge>
        ) : setting.required ? (
          <Badge tone="warning">Needed</Badge>
        ) : (
          <Badge>Not chosen</Badge>
        )}
      </div>
      <Text size="sm" tone="muted">
        From the {adapter.name} adapter: <span className="selectable">“{setting.description}”</span>
      </Text>
      {setting.chosen !== null ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-sunken px-3 py-2.5 ring-[0.5px] ring-line-subtle ring-inset">
          <div data-testid="setting-chosen" className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-0.5">
            <Text weight="medium" className="selectable">
              {setting.chosen.label}
            </Text>
            {setting.chosen.detail === null || setting.chosen.detail === '' ? null : (
              <Text size="sm" tone="muted" className="selectable">
                {setting.chosen.detail}
              </Text>
            )}
            <Text size="xs" tone="subtle">
              From {adapter.site} · chosen {formatTime(setting.chosen.chosenAt, now)}
            </Text>
          </div>
          {searching ? null : <Button onClick={() => setOpen(true)}>Change {title}…</Button>}
        </div>
      ) : setting.required ? (
        <Text size="sm" tone="muted">
          Nothing chosen yet, so {adapter.name}’s tools won’t run: an agent that calls one is told you need to
          choose a {title}.
        </Text>
      ) : null}
      {!searching ? null : !approved ? (
        <Text size="sm" tone="muted">
          Approve {adapter.name} first: the search runs its code against the site.
        </Text>
      ) : (
        <Stack gap={3}>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!search.busy && query.trim() !== '') void runSearch()
            }}
          >
            <Field
              label={`${setting.queryLabel} to find a ${title}`}
              description={`Valet asks ${adapter.site} through the adapter, ${adapter.limits.minGapMs / 1000} s apart like every call, so it can take a moment.`}
              className="min-w-[min(100%,16rem)] flex-1"
            >
              <Input
                placeholder={setting.queryLabel}
                maxLength={100}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <div className="flex gap-2 pb-6">
              <Button
                type="submit"
                variant="primary"
                leading={<Search />}
                loading={search.busy}
                disabled={query.trim() === ''}
                disabledReason={`Type a ${setting.queryLabel.toLowerCase()} first`}
              >
                Search
              </Button>
              {open ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpen(false)
                    setReply(null)
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
          <Failed failed={search.failed} what={`search for a ${title}`} />
          {reply === null ? null : (
            <Choices reply={reply} site={adapter.site} busy={choose.busy} now={now} onPick={pick} />
          )}
          <Failed failed={choose.failed} what={`save the ${title}`} />
        </Stack>
      )}
    </Stack>
  )
}

function Choices({
  reply: { query, reply },
  site,
  busy,
  now,
  onPick,
}: {
  readonly reply: { readonly query: string; readonly reply: SettingChoicesReply }
  readonly site: string
  readonly busy: boolean
  readonly now: number
  readonly onPick: (choiceId: string) => void
}) {
  const status = (text: string) => (
    <Text role="status" size="sm" tone="muted">
      {text}
    </Text>
  )
  if (reply.status === 'blocked')
    return status(`The site is refusing or slowing Valet. Try again ${formatIn(reply.retryAt, now)}.`)
  if (reply.status === 'not-approved') return status('The adapter isn’t approved, so it can’t search.')
  if (reply.status === 'site-changed')
    return status(
      'The site answered in a way the adapter doesn’t understand. The adapter may need an update.',
    )
  if (reply.status === 'failed') return status('The search didn’t work. Try again in a moment.')
  if (reply.choices.length === 0) return status(`Nothing found for “${query}”.`)
  // What the site sent back through the adapter: one line says so, and each choice is plain text.
  return (
    <Stack gap={1.5}>
      <Text size="xs" tone="subtle">
        Found by {site}, through its adapter
      </Text>
      <ul
        aria-label="Choices"
        className="m-0 flex list-none flex-col divide-y divide-line-subtle rounded-md p-0 ring-[0.5px] ring-line ring-inset"
      >
        {reply.choices.map((choice) => (
          <li key={choice.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="flex min-w-[min(100%,14rem)] flex-1 flex-col">
              <span className="selectable text-md text-fg">{choice.label}</span>
              {choice.detail === null || choice.detail === '' ? null : (
                <span className="selectable text-sm text-fg-muted">{choice.detail}</span>
              )}
            </span>
            <Button
              size="sm"
              loading={busy}
              aria-label={`Choose ${choice.label}`}
              onClick={() => onPick(choice.id)}
            >
              Choose
            </Button>
          </li>
        ))}
      </ul>
    </Stack>
  )
}
