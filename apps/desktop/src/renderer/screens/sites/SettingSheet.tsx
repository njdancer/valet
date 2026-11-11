// The store sheet (#/sites/<id>/store/<setting>, wireframe `site-store-sheet`): "Choose your
// Woolworths store", over the site's page, which the shell renders beneath it. Escape, Cancel and
// Save all return to the site page. Its title is the Needs you item's, so the two read as one task.

import { Banner, Button, Dialog, SheetContent, Skeleton, Spacer, Stack, Text, toast } from '@valet/ui'
import { useState } from 'react'
import type { AdapterDetail, AdapterSettingInfo } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { href, navigate } from '../../lib/router'
import { ChosenSetting, SettingChoiceRadios, SettingSearchForm, useSettingSearch } from './SettingChooser'
import { ActionError, capSiteText, SiteText } from './site-ui'

export function SettingSheet({
  adapterId,
  setting,
}: {
  readonly adapterId: string
  readonly setting: string
}) {
  const detail = useLoad((api) => api.adapters.get(adapterId), [adapterId], ['adapters-changed'])
  const close = () => navigate(href.site(adapterId))
  const adapter = detail.status === 'ready' ? detail.data : null
  const info = adapter?.settings.find((s) => s.name === setting) ?? null
  const title =
    adapter === null
      ? 'Choose a setting'
      : info === null
        ? `${adapter.name} has no such setting`
        : `Choose your ${adapter.name} ${info.title.toLowerCase()}`

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      {detail.status === 'loading' ? (
        <SheetContent title="Choose a setting">
          <Stack gap={2} aria-hidden="true">
            <Skeleton className="h-7" />
            <Skeleton className="h-16" />
          </Stack>
        </SheetContent>
      ) : adapter === null || info === null ? (
        <SheetContent
          title={detail.status === 'error' ? 'Couldn’t load this setting' : title}
          footer={<Button onClick={close}>Close</Button>}
        >
          <Text tone="muted">
            {detail.status === 'error'
              ? 'Valet couldn’t load it. Close this and try again.'
              : 'There is nothing to choose here. The link may be from an older version of the site.'}
          </Text>
        </SheetContent>
      ) : (
        <SettingForm
          key={`${adapter.id}/${info.name}`}
          adapter={adapter}
          setting={info}
          title={title}
          onDone={close}
        />
      )}
    </Dialog>
  )
}

function SettingForm({
  adapter,
  setting,
  title,
  onDone,
}: {
  readonly adapter: AdapterDetail
  readonly setting: AdapterSettingInfo
  readonly title: string
  readonly onDone: () => void
}) {
  const api = useApi()
  const now = useNow(30_000)
  const search = useSettingSearch(adapter.id, setting.name)
  const save = useAction()
  const clear = useAction()
  const [picked, setPicked] = useState<string | null>(null)
  const approved = adapter.approval === 'approved'
  const noun = setting.title.toLowerCase()
  const choices = search.reply?.reply.status === 'ok' ? search.reply.reply.choices : []
  const choice = choices.find((c) => c.id === picked) ?? null
  const unchanged = choice !== null && choice.id === setting.chosen?.id

  const onSave = () =>
    save.run(async () => {
      if (choice === null) return
      await api.adapters.setSetting(adapter.id, setting.name, choice.id)
      toast.success(`${adapter.name} ${noun} saved. The next call uses it.`)
      onDone()
    })
  const onClear = () =>
    clear.run(async () => {
      await api.adapters.clearSetting(adapter.id, setting.name)
      toast(`${adapter.name} has no ${noun} now.`)
      onDone()
    })

  return (
    <SheetContent
      title={title}
      description={<SiteText text={setting.description} />}
      footer={
        <>
          {setting.chosen !== null ? (
            <Button variant="ghost" loading={clear.busy} onClick={() => void onClear()}>
              Clear {noun}
            </Button>
          ) : null}
          <Spacer />
          <Button onClick={onDone}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.busy}
            disabled={choice === null || unchanged}
            disabledReason={
              choice === null
                ? `Search, then pick a ${noun}`
                : unchanged
                  ? `This is already your ${noun}`
                  : undefined
            }
            onClick={() => void onSave()}
          >
            {choice === null ? `Use this ${noun}` : `Use ${capSiteText(choice.label, 40)}`}
          </Button>
        </>
      }
    >
      <Stack gap={4}>
        {setting.chosen !== null ? (
          <ChosenSetting setting={setting} now={now} />
        ) : setting.required ? (
          <Text tone="muted">
            Nothing chosen yet, so {adapter.name}’s tools won’t run: an agent that calls one is told you need
            to choose a {noun}.
          </Text>
        ) : null}
        {!approved ? (
          <Banner
            tone="info"
            title={`Approve ${adapter.name} first`}
            action={
              <Button size="sm" variant="primary" asChild>
                <a href={href.review(adapter.id)}>Review {adapter.name}</a>
              </Button>
            }
          >
            The search runs the adapter’s code against the site, so it waits for your review.
          </Banner>
        ) : (
          <>
            <SettingSearchForm adapter={adapter} setting={setting} search={search} />
            <SettingChoiceRadios
              adapter={adapter}
              setting={setting}
              search={search}
              value={picked}
              onValueChange={setPicked}
              now={now}
            />
          </>
        )}
        <ActionError failed={save.failed} what={`save the ${noun}`} />
        <ActionError failed={clear.failed} what={`clear the ${noun}`} />
      </Stack>
    </SheetContent>
  )
}
