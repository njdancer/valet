// Pieces the Sites pages share: adapter-written text shown as the adapter's, failures in the app's
// own words, the per-site pause (feature-detected: older main processes have none), and the one
// button that fixes a site's health line, so the fix always sits next to the problem (IA
// principle 2) and every surface names it the same way.

import { Button, Text, toast } from '@valet/ui'
import type { AdapterSummary, RunSummary, ValetApi } from '../../../shared/api'
import { useAction, useApi } from '../../lib/api-context'
import { href } from '../../lib/router'
import type { SiteStatus } from '../../lib/site-status'
import { foldRetries } from '../activity/calls-list'

/** Adapter-written text is cut to this many characters wherever the app shows it. */
export const MAX_SITE_TEXT = 280

export function capSiteText(text: string, max = MAX_SITE_TEXT): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

/**
 * Text the adapter wrote (a manifest description) or the site sent back through it (a store's
 * name), visibly marked as theirs and quoted, so it never reads as Valet's own statement. Always
 * plain text: React escapes it, and nothing here renders markup.
 */
export function SiteText({
  text,
  from = 'From the manifest',
  className,
}: {
  readonly text: string
  /** Where it came from. Null leaves the tag off under a heading that already says so. */
  readonly from?: string | null
  readonly className?: string
}) {
  return (
    <span data-site-text="" className={className}>
      {from === null ? null : (
        <span className="mr-1.5 text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{from}</span>
      )}
      <span className="selectable italic">“{capSiteText(text)}”</span>
    </span>
  )
}

/** A failed action, in the app's words: the main process's error text never reaches the screen. */
export function ActionError({ failed, what }: { readonly failed: boolean; readonly what: string }) {
  if (!failed) return null
  return (
    <Text role="alert" size="sm" tone="danger">
      Couldn’t {what}. Try again.
    </Text>
  )
}

type PauseFn = (adapterId: string, paused: boolean) => Promise<void>

/** The per-site pause, when this build's main process has one. */
export function sitePause(api: ValetApi): PauseFn | null {
  const adapters = api.adapters as ValetApi['adapters'] & { readonly setPaused?: PauseFn }
  const fn = adapters.setPaused
  return typeof fn === 'function' ? (id, paused) => fn.call(adapters, id, paused) : null
}

export function isPaused(adapter: AdapterSummary): boolean {
  return (adapter as { readonly paused?: boolean }).paused === true
}

/**
 * Pause or resume one site, with an Undo on the toast (reversible, so it acts at once: E4).
 * Null when the main process can't pause a single site.
 */
export function usePauseSite(adapter: Pick<AdapterSummary, 'id' | 'name'>): {
  readonly run: ((paused: boolean) => void) | null
  readonly busy: boolean
  readonly failed: boolean
} {
  const api = useApi()
  const action = useAction()
  const pause = sitePause(api)
  if (pause === null) return { run: null, busy: false, failed: false }
  const run = (paused: boolean) =>
    void action.run(async () => {
      await pause(adapter.id, paused)
      toast(
        paused
          ? `${adapter.name} paused. Calls are refused until you resume.`
          : `${adapter.name} resumed. Calls run again.`,
        { action: { label: 'Undo', onClick: () => void pause(adapter.id, !paused).catch(() => undefined) } },
      )
    })
  return { run, busy: action.busy, failed: action.failed }
}

/**
 * The button that fixes a health line, named with the site (principle 2: "Review Woolworths
 * update"). `setting` is the setting the health line asks for, when the caller knows its name.
 */
export function SiteFixButton({
  adapter,
  status,
  setting,
  variant = 'primary',
}: {
  readonly adapter: AdapterSummary
  readonly status: SiteStatus
  readonly setting?: { readonly name: string; readonly title: string } | null
  readonly variant?: 'primary' | 'secondary'
}) {
  const api = useApi()
  const show = useAction()
  const pause = usePauseSite(adapter)
  switch (status.fix) {
    case 'review':
      return (
        <Button size="sm" variant={variant} asChild>
          <a href={href.review(adapter.id)}>Review {adapter.name}</a>
        </Button>
      )
    case 'review-update':
      return (
        <Button size="sm" variant={variant} asChild>
          <a href={href.review(adapter.id)}>Review {adapter.name} update</a>
        </Button>
      )
    case 'login': {
      const missing = adapter.secrets.find((s) => !s.granted)
      return missing === undefined ? null : (
        <Button size="sm" variant={variant} asChild>
          <a href={href.grant(adapter.id, missing.name)}>Choose {adapter.name} login…</a>
        </Button>
      )
    }
    case 'show-login':
      return (
        <>
          <Button
            size="sm"
            variant={variant}
            loading={show.busy}
            onClick={() => void show.run(() => api.openLoginWindow(adapter.id))}
          >
            Show login window
          </Button>
          <ActionError failed={show.failed} what="open the login window" />
        </>
      )
    case 'choose-setting':
      return setting == null ? (
        <Button size="sm" variant={variant} asChild>
          <a href={href.site(adapter.id)}>Open {adapter.name}</a>
        </Button>
      ) : (
        <Button size="sm" variant={variant} asChild>
          <a href={href.setting(adapter.id, setting.name)}>Choose {setting.title.toLowerCase()}…</a>
        </Button>
      )
    case 'resume':
      return pause.run === null ? null : (
        <Button size="sm" variant={variant} loading={pause.busy} onClick={() => pause.run?.(false)}>
          Resume {adapter.name}
        </Button>
      )
    default:
      return null
  }
}

/** Local midnight before `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Calls to one site since midnight. */
export function callsToday(runs: readonly RunSummary[], adapterId: string, now: number): RunSummary[] {
  const since = startOfDay(now)
  // As the Calls list shows them: a "call again" answer folded into the call that followed it, so
  // the counts here match the list they link to (its retries aren't failures the person must read).
  return foldRetries(runs)
    .map((l) => l.run)
    .filter((r) => r.adapterId === adapterId && Date.parse(r.startedAt) >= since)
}

/** Who called, most calls first: the reported client name and how many calls. */
export function callers(runs: readonly RunSummary[]): { readonly client: string; readonly calls: number }[] {
  const counts = new Map<string, number>()
  for (const r of runs) counts.set(r.client, (counts.get(r.client) ?? 0) + 1)
  return [...counts.entries()]
    .map(([client, calls]) => ({ client, calls }))
    .sort((a, b) => b.calls - a.calls || a.client.localeCompare(b.client))
}
