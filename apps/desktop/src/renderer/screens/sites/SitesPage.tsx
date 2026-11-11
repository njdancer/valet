// Sites (IA section 3): one row per installed adapter. The name is the link to the site's page; the
// row itself is not a target, because it holds the health line's own buttons (wireframe
// `sites-list`). Numbers are doors: "21 calls today" opens Calls filtered to the site. Adding a site
// isn't done here (IA section 10), so the page says where sites come from instead.

import {
  Button,
  Code,
  EmptyState,
  HealthLine,
  Inline,
  List,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  SiteAvatar,
  Skeleton,
  Spacer,
  Stack,
  Text,
  TextLink,
} from '@valet/ui'
import { Globe } from 'lucide-react'
import type { AdapterSummary, RunSummary, SiteHealth } from '../../../shared/api'
import { useLoad, useNow } from '../../lib/api-context'
import { plural } from '../../lib/format'
import { href } from '../../lib/router'
import { healthFor, siteStatus } from '../../lib/site-status'
import { ActionError, callsToday, isPaused, SiteFixButton, usePauseSite } from './site-ui'

export function SitesPage() {
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed', 'approvals-changed'])
  const sites = useLoad((api) => api.health.sites(), [], ['health-changed'])
  const runs = useLoad((api) => api.runs.list({ limit: 500 }), [], ['runs-changed'])
  const now = useNow(60_000)
  const list = adapters.status === 'ready' ? adapters.data : []
  const health = sites.status === 'ready' ? sites.data : []

  return (
    <Page>
      <PageHeader
        title="Sites"
        description="Each site lets your agents use one website as you, in Valet’s own browser on this Mac."
        status={adapters.status === 'ready' ? <Text tone="muted">{plural(list.length, 'site')}</Text> : null}
      />
      <PageBody width="form">
        {adapters.status === 'loading' ? (
          <Stack gap={2} aria-hidden="true">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </Stack>
        ) : adapters.status === 'error' ? (
          <Text tone="muted">Valet couldn’t load its sites. It tries again when something changes.</Text>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Globe />}
            title="No sites yet"
            action={
              <Button variant="primary" asChild>
                <a href={href.setup()}>Continue setup</a>
              </Button>
            }
          >
            A site lets Claude use a website as you, in a browser on this Mac. Sites come with Valet or from
            Claude’s authoring agent in your IDE, and each one is reviewed before it runs.
          </EmptyState>
        ) : (
          <>
            <List label="All sites">
              {list.map((a) => (
                <SiteRow
                  key={a.id}
                  adapter={a}
                  health={healthFor(a, health)}
                  runs={runs.status === 'ready' ? runs.data : null}
                  now={now}
                />
              ))}
            </List>
            <Text tone="subtle" size="sm">
              Sites come with Valet or from Claude’s authoring agent in your IDE; there’s nothing to add here.
              A new one shows up in this list as “Not approved yet” with a Review button, and in{' '}
              <TextLink href={href.needsYou()}>Needs you</TextLink>.
            </Text>
          </>
        )}
      </PageBody>
    </Page>
  )
}

function SiteRow({
  adapter,
  health,
  runs,
  now,
}: {
  readonly adapter: AdapterSummary
  readonly health: SiteHealth | null
  readonly runs: readonly RunSummary[] | null
  readonly now: number
}) {
  const status = siteStatus(adapter, health)
  // The store sheet's address needs the setting's name, which only the detail has.
  const needsSetting = status.fix === 'choose-setting'
  const detail = useLoad(
    (api) => (needsSetting ? api.adapters.get(adapter.id) : Promise.resolve(null)),
    [adapter.id, needsSetting],
    ['adapters-changed'],
  )
  const setting =
    detail.status === 'ready' && detail.data !== null
      ? (detail.data.settings.find((s) => s.required && s.chosen === null) ?? null)
      : null
  const pause = usePauseSite(adapter)
  const canPause = pause.run !== null && adapter.approval === 'approved' && !isPaused(adapter)
  const today = runs === null ? null : callsToday(runs, adapter.id, now).length
  return (
    <li className="m-0 flex min-w-0 items-start gap-3 px-4 py-3">
      <SiteAvatar id={adapter.id} name={adapter.name} size="md" />
      <Stack gap={2} className="flex-1">
        <Inline gap={2} align="baseline">
          <ObjectLink href={href.site(adapter.id)} className="text-lg">
            {adapter.name}
          </ObjectLink>
          <Code>
            {adapter.id} {adapter.version}
          </Code>
          <Spacer />
          <span className="text-sm text-fg-muted">
            <TextLink href={href.calls({ site: adapter.id })}>
              {today === null ? 'Calls' : plural(today, 'call')} today
            </TextLink>{' '}
            · {adapter.calls7d} in 7 days
          </span>
        </Inline>
        <HealthLine
          tone={status.tone}
          action={
            <>
              <SiteFixButton adapter={adapter} status={status} setting={setting} />
              {/* An update waits behind a more urgent health line: its review stays one click away. */}
              {adapter.pendingUpdate !== null &&
              adapter.approval === 'approved' &&
              status.fix !== 'review-update' ? (
                <Button size="sm" variant="secondary" asChild>
                  <a href={href.review(adapter.id)}>Review {adapter.name} update</a>
                </Button>
              ) : null}
              {canPause ? (
                <Button size="sm" variant="ghost" loading={pause.busy} onClick={() => pause.run?.(true)}>
                  Pause {adapter.name}
                </Button>
              ) : null}
            </>
          }
        >
          {status.text}
        </HealthLine>
        <ActionError failed={pause.failed} what={`pause ${adapter.name}`} />
      </Stack>
    </li>
  )
}
