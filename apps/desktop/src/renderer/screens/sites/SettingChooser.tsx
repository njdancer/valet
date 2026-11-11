// Choosing one of an adapter's settings (D69), e.g. the Woolworths store. The search is a real,
// paced request to the site through the adapter, so it runs only when the person asks, never as
// they type. What it finds is the site's text: shown as text, under a heading that says it came
// from the site through the adapter, never as the app's own words.
//
// Two forms share the search: the store sheet over the site page (pick one, then Save) and the
// inline block setup's store step uses (Choose saves at once).

import {
  Badge,
  Button,
  DescriptionList,
  Field,
  Heading,
  Inline,
  Input,
  RadioGroup,
  RadioItem,
  Skeleton,
  Stack,
  Text,
} from '@valet/ui'
import { type ReactNode, useId, useState } from 'react'
import type { AdapterDetail, AdapterSettingInfo, SettingChoicesReply } from '../../../shared/api'
import { useAction, useApi } from '../../lib/api-context'
import { formatIn, formatTime } from '../../lib/format'
import { ActionError, SiteText } from './site-ui'

export interface SearchReply {
  readonly query: string
  readonly reply: SettingChoicesReply
}

/** The search's state: what was typed, what came back, and whether it is running or failed. */
export function useSettingSearch(adapterId: string, setting: string) {
  const api = useApi()
  const search = useAction()
  const [query, setQuery] = useState('')
  const [reply, setReply] = useState<SearchReply | null>(null)
  const run = () =>
    search.run(async () => {
      const asked = query.trim()
      setReply(null)
      setReply({ query: asked, reply: await api.adapters.settingChoices(adapterId, setting, asked) })
    })
  return {
    query,
    setQuery,
    reply,
    clear: () => setReply(null),
    run,
    busy: search.busy,
    failed: search.failed,
  }
}

type Search = ReturnType<typeof useSettingSearch>

/** The query field and its Search button. Submitting is the only thing that searches. */
export function SettingSearchForm({
  adapter,
  setting,
  search,
  extra,
}: {
  readonly adapter: AdapterDetail
  readonly setting: AdapterSettingInfo
  readonly search: Search
  readonly extra?: ReactNode
}) {
  const title = setting.title.toLowerCase()
  const empty = search.query.trim() === ''
  return (
    <Stack gap={1.5}>
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!search.busy && !empty) void search.run()
        }}
      >
        <Field label={setting.queryLabel} className="min-w-40 flex-1">
          <Input
            aria-label={`${setting.queryLabel} to find a ${title}`}
            placeholder={setting.queryLabel}
            maxLength={100}
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          loading={search.busy}
          disabled={empty}
          disabledReason={empty ? `Type a ${setting.queryLabel.toLowerCase()} first` : undefined}
        >
          Search
        </Button>
        {extra}
      </form>
      <Text size="sm" tone="subtle">
        Searching asks {adapter.site} through the adapter, {adapter.limits.minGapMs / 1000} s apart like every
        call, so it can take a moment.
      </Text>
      <ActionError failed={search.failed} what={`search for a ${title}`} />
    </Stack>
  )
}

/**
 * What a search that found nothing usable came back with, in the app's own words. Null when there
 * are choices to show.
 */
export function replyProblem(reply: SearchReply, now: number): string | null {
  const r = reply.reply
  switch (r.status) {
    case 'blocked':
      return `The site is refusing or slowing Valet. Try again ${formatIn(r.retryAt, now)}.`
    case 'not-approved':
      return 'The adapter isn’t approved, so it can’t search.'
    case 'site-changed':
      return 'The site answered in a way the adapter doesn’t understand. The adapter may need an update.'
    case 'failed':
      return 'The search didn’t work. Try again in a moment.'
    default:
      return r.choices.length === 0 ? `Nothing found for “${reply.query}”.` : null
  }
}

/** "From woolworths.com.au, through the adapter": the choices below are the site's words. */
function FromSite({ site, id }: { readonly site: string; readonly id?: string }) {
  return (
    <Heading level={3} size="eyebrow" id={id}>
      From {site}, through the adapter
    </Heading>
  )
}

/**
 * The choices as radio options, for the store sheet: picking one doesn't save it; the sheet's
 * Save does. The chosen one is marked Current, so changing it is deliberate.
 */
export function SettingChoiceRadios({
  adapter,
  setting,
  search,
  value,
  onValueChange,
  now,
}: {
  readonly adapter: AdapterDetail
  readonly setting: AdapterSettingInfo
  readonly search: Search
  readonly value: string | null
  readonly onValueChange: (id: string) => void
  readonly now: number
}) {
  const heading = useId()
  if (search.busy) {
    return (
      <Stack gap={2} aria-hidden="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </Stack>
    )
  }
  if (search.reply === null) return null
  const problem = replyProblem(search.reply, now)
  if (problem !== null) {
    return (
      <Text role="status" tone="muted">
        {problem}
      </Text>
    )
  }
  const choices = search.reply.reply.status === 'ok' ? search.reply.reply.choices : []
  return (
    <Stack gap={2}>
      <Text role="status" size="sm" tone="muted">
        {choices.length === 1 ? '1 found' : `${choices.length} found`} for “{search.reply.query}”
      </Text>
      <FromSite site={adapter.site} id={heading} />
      <RadioGroup
        aria-labelledby={heading}
        value={value ?? ''}
        onValueChange={onValueChange}
        className="flex flex-col gap-0 overflow-hidden rounded-lg bg-surface ring-[0.5px] ring-line ring-inset [&>*+*]:border-t [&>*+*]:border-line-subtle"
      >
        {choices.map((choice) => (
          <ChoiceRadio
            key={choice.id}
            value={choice.id}
            label={choice.label}
            detail={choice.detail}
            current={setting.chosen?.id === choice.id}
          />
        ))}
      </RadioGroup>
    </Stack>
  )
}

function ChoiceRadio({
  value,
  label,
  detail,
  current,
}: {
  readonly value: string
  readonly label: string
  readonly detail: string | null
  readonly current: boolean
}) {
  const id = `${useId()}-choice`
  return (
    // The whole row is the label, so it is one target; the radio itself carries the name.
    <label
      htmlFor={id}
      className="flex min-w-0 cursor-default items-start gap-2.5 px-3 py-2.5 hover:bg-hover has-[[data-state=checked]]:bg-selected"
    >
      <RadioItem id={id} value={value} className="mt-0.5" aria-describedby={detail ? `${id}-d` : undefined} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SiteText text={label} from={null} className="text-md text-fg" />
        {detail === null || detail === '' ? null : (
          <span id={`${id}-d`} className="text-sm text-fg-muted">
            <SiteText text={detail} from={null} />
          </span>
        )}
      </span>
      {current ? <Badge>Current</Badge> : null}
    </label>
  )
}

/** What is chosen now, as the person saw it when they chose it. */
export function ChosenSetting({
  setting,
  now,
}: {
  readonly setting: AdapterSettingInfo
  readonly now: number
}) {
  const chosen = setting.chosen
  if (chosen === null) return null
  return (
    <div data-testid="setting-chosen">
      <DescriptionList
        items={[
          {
            term: setting.title,
            value: (
              <Stack gap={0.5}>
                <SiteText text={chosen.label} from="From the site" />
                {chosen.detail === null || chosen.detail === '' ? null : (
                  <span className="text-sm text-fg-muted">
                    <SiteText text={chosen.detail} from={null} />
                  </span>
                )}
              </Stack>
            ),
          },
          { term: 'Chosen', value: formatTime(chosen.chosenAt, now) },
        ]}
      />
    </div>
  )
}

/**
 * One setting inline, for setup's store step: what is chosen, and a search whose Choose button
 * saves the choice at once.
 */
export function SettingBlock({
  adapter,
  setting,
  now,
}: {
  readonly adapter: AdapterDetail
  readonly setting: AdapterSettingInfo
  readonly now: number
}) {
  const api = useApi()
  const choose = useAction()
  const search = useSettingSearch(adapter.id, setting.name)
  const [open, setOpen] = useState(false)
  const searching = open || setting.chosen === null
  const approved = adapter.approval === 'approved'
  const title = setting.title.toLowerCase()

  const pick = (choiceId: string) =>
    choose.run(async () => {
      await api.adapters.setSetting(adapter.id, setting.name, choiceId)
      setOpen(false)
      search.clear()
      search.setQuery('')
    })

  const problem = search.reply === null ? null : replyProblem(search.reply, now)
  const choices = search.reply?.reply.status === 'ok' ? search.reply.reply.choices : []

  return (
    <Stack gap={3} data-testid={`setting-${setting.name}`}>
      <Inline gap={2}>
        <Heading level={3} size="group" className="flex-1">
          {setting.title}
        </Heading>
        {setting.chosen !== null ? (
          <Badge tone="success">Chosen</Badge>
        ) : setting.required ? (
          <Badge tone="warning">Needed</Badge>
        ) : (
          <Badge>Not chosen</Badge>
        )}
      </Inline>
      <Text size="sm" tone="muted">
        <SiteText text={setting.description} />
      </Text>
      {setting.chosen !== null ? (
        <>
          <ChosenSetting setting={setting} now={now} />
          {searching ? null : (
            <Inline>
              <Button onClick={() => setOpen(true)}>Change {title}…</Button>
            </Inline>
          )}
        </>
      ) : setting.required ? (
        <Text size="sm" tone="muted">
          Nothing chosen yet, so {adapter.name}’s tools won’t run: an agent that calls one is told you need to
          choose a {title}.
        </Text>
      ) : null}
      {!searching ? null : !approved ? (
        <Text size="sm" tone="muted">
          Approve the adapter first: the search runs its code against the site.
        </Text>
      ) : (
        <>
          <SettingSearchForm
            adapter={adapter}
            setting={setting}
            search={search}
            extra={
              open ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false)
                    search.clear()
                  }}
                >
                  Cancel
                </Button>
              ) : null
            }
          />
          {search.reply === null ? null : problem !== null ? (
            <Text role="status" tone="muted">
              {problem}
            </Text>
          ) : (
            <Stack gap={1.5}>
              <FromSite site={adapter.site} />
              <ul aria-label="Choices" className="m-0 flex list-none flex-col gap-2 p-0">
                {choices.map((choice) => (
                  <li key={choice.id} className="flex min-w-0 items-center gap-3">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <SiteText text={choice.label} from={null} />
                      {choice.detail === null || choice.detail === '' ? null : (
                        <span className="text-sm text-fg-muted">
                          <SiteText text={choice.detail} from={null} />
                        </span>
                      )}
                    </span>
                    <Button size="sm" disabled={choose.busy} onClick={() => void pick(choice.id)}>
                      Choose
                    </Button>
                  </li>
                ))}
              </ul>
            </Stack>
          )}
          <ActionError failed={choose.failed} what={`save the ${title}`} />
        </>
      )}
    </Stack>
  )
}
