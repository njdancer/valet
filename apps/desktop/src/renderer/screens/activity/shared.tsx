// Pieces both Activity tabs share: the tabs themselves (each its own address and shortcut), the
// filter menus (every filter lives in the URL, so choosing one is a navigation and Back undoes it),
// a call's outcome in plain words, and the redacted previews of a call's input and output.

import {
  Badge,
  type BadgeProps,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  NavTabs,
  Shortcut,
} from '@valet/ui'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PreviewPart, RunSummary } from '../../../shared/api'
import { href, navigate } from '../../lib/router'
import { askedToRetry, needsUserWording, runTone, runWording } from '../../lib/wording'

/** Calls and Audit log: two real tabs, each with its own URL, heading and shortcut. */
export function ActivityTabs({ active }: { readonly active: 'calls' | 'audit' }) {
  return (
    <NavTabs
      label="Activity"
      items={[
        {
          href: href.calls(),
          active: active === 'calls',
          label: (
            <>
              Calls <Shortcut keys="mod+3" />
            </>
          ),
        },
        {
          href: href.audit(),
          active: active === 'audit',
          label: (
            <>
              Audit log <Shortcut keys="mod+shift+3" />
            </>
          ),
        },
      ]}
    />
  )
}

export interface FilterOption {
  readonly value: string
  readonly label: string
}

/**
 * One filter as a button with a menu ("Site: Any"). Each choice is an address: picking it navigates,
 * so the filter is in the URL and Back undoes it.
 */
export function FilterMenu({
  label,
  value,
  options,
  to,
  anyLabel = 'Any',
}: {
  readonly label: string
  readonly value: string | null
  readonly options: readonly FilterOption[]
  /** The address for a choice; null clears the filter. */
  readonly to: (value: string | null) => string
  readonly anyLabel?: string
}) {
  const chosen = value === null ? null : (options.find((o) => o.value === value)?.label ?? value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={value === null ? 'secondary' : 'ghost'}
          className={value === null ? undefined : 'bg-accent-soft text-accent-fg hover:bg-selected'}
          trailing={<ChevronDown aria-hidden="true" />}
        >
          <span className={value === null ? 'text-fg-muted' : undefined}>{label}:</span>
          <span className="max-w-40 truncate">{chosen ?? anyLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(v) => navigate(to(v === '' ? null : v))}>
          <DropdownMenuRadioItem value="">{anyLabel}</DropdownMenuRadioItem>
          {options.length > 0 ? <DropdownMenuSeparator /> : null}
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type Tone = NonNullable<BadgeProps['tone']>

const TONE: Readonly<Record<ReturnType<typeof runTone>, Tone>> = {
  ok: 'success',
  warn: 'warning',
  bad: 'danger',
  info: 'info',
  '': 'neutral',
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`
}

/** A call's outcome in words: "Ok", "Ok, 2 blocked", "Needs you · Verification check", "Call again". */
export function outcomeWords(run: RunSummary): { readonly text: string; readonly tone: Tone } {
  if (run.outcome === 'ok' && run.blockedRequests > 0)
    return { text: `Ok, ${run.blockedRequests} blocked`, tone: 'info' }
  if (run.outcome === 'needsUser' && run.needsUser !== null)
    return { text: `Needs you · ${needsUserWording(run.needsUser).short}`, tone: 'warning' }
  if (run.outcome === 'running') return { text: 'Running', tone: 'accent' }
  return {
    text: askedToRetry(run) ? 'Call again' : capitalise(runWording(run)),
    tone: TONE[runTone(run)] ?? 'neutral',
  }
}

export function OutcomeBadge({ run }: { readonly run: RunSummary }) {
  const words = outcomeWords(run)
  return <Badge tone={words.tone}>{words.text}</Badge>
}

const REDACTION_LABELS: Readonly<Record<Extract<PreviewPart, { kind: 'redacted' }>['label'], string>> = {
  secret: 'secret',
  'session-cookie': 'session cookie',
  'session-storage': 'session storage',
}

export function redactionLabel(part: Extract<PreviewPart, { kind: 'redacted' }>): string {
  const base = Object.hasOwn(REDACTION_LABELS, part.label) ? REDACTION_LABELS[part.label] : 'redacted'
  return part.ref === null ? `[${base}]` : `[${base}:${part.ref}]`
}

/**
 * A redacted JSON preview from the main process. The main process has already replaced every secret
 * and session value with a marker; this only draws the markers. Everything is React text, so a
 * tool's output can't inject markup.
 */
export function PreviewBlock({
  parts,
  label,
}: {
  readonly parts: readonly PreviewPart[]
  readonly label: string
}) {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-md bg-code-bg ring-[0.5px] ring-line-subtle ring-inset outline-offset-[-2px]"
    >
      <pre className="selectable m-0 p-3 font-mono text-sm leading-normal whitespace-pre-wrap break-words text-code-fg">
        {parts.map((part, i) =>
          part.kind === 'redacted' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
            <span key={i} className="rounded-xs bg-risk-secret-soft px-0.5 text-risk-secret-fg">
              {redactionLabel(part)}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
            <span key={i}>{part.text}</span>
          ),
        )}
      </pre>
    </section>
  )
}

/** A label above a small group of facts ("Site", "Version"): chrome, not a value. */
export function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-subtle">{term}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-md text-fg">{children}</dd>
    </div>
  )
}
