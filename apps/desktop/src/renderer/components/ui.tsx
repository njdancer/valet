// Small presentational pieces shared by every screen. Text is always rendered as React text, never
// as HTML, so adapter-authored strings can't inject markup.

import type { Purpose, RunOutcome } from '@valet/core'
import type { ReactNode } from 'react'
import type { Loaded } from '../lib/api-context'
import { shortHash } from '../lib/format'
import { clientLabel, runTone, runWording } from '../lib/wording'

export type IconName =
  | 'adapter'
  | 'activity'
  | 'audit'
  | 'clients'
  | 'key'
  | 'gear'
  | 'search'
  | 'plus'
  | 'lock'
  | 'shield'
  | 'warn'
  | 'check'
  | 'x'
  | 'clock'
  | 'globe'
  | 'chevron'
  | 'down'
  | 'copy'
  | 'user'
  | 'bolt'
  | 'eye-off'
  | 'external'
  | 'pause'
  | 'refresh'
  | 'link'
  | 'touchid'
  | 'download'
  | 'filter'
  | 'logo'

export function Icon({
  name,
  size,
  className = '',
}: {
  readonly name: IconName
  readonly size?: 'sm' | 'lg' | 'xl'
  readonly className?: string
}) {
  return <span aria-hidden="true" className={`i i-${name}${size ? ` ${size}` : ''} ${className}`.trim()} />
}

const AVATAR_CLASSES: Readonly<Record<string, string>> = {
  woolworths: 'wow',
  coles: 'coles',
  bank: 'bank',
  agl: 'agl',
  auspost: 'auspost',
}

export function Avatar({
  adapterId,
  name,
  size,
}: {
  readonly adapterId: string
  readonly name: string
  readonly size?: 'sm' | 'lg'
}) {
  const brand = Object.hasOwn(AVATAR_CLASSES, adapterId) ? AVATAR_CLASSES[adapterId] : 'other'
  const letter = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span aria-hidden="true" className={`avatar ${brand}${size ? ` ${size}` : ''}`}>
      {letter}
    </span>
  )
}

export function SideEffect({
  purpose,
  children,
}: {
  readonly purpose: Purpose
  readonly children?: ReactNode
}) {
  return <span className={`badge ${purpose}`}>{children ?? purpose}</span>
}

export function SecretBadge({ name }: { readonly name: string }) {
  return (
    <span className="badge secret">
      <Icon name="key" size="sm" />
      {name}
    </span>
  )
}

export function Hash({ hash, full = false }: { readonly hash: string; readonly full?: boolean }) {
  return (
    <span className="hash" title={hash}>
      {full ? hash : shortHash(hash)}
    </span>
  )
}

/** A client's self-reported name, quoted and titled as unverified: it is a claim, not an identity. */
export function ClientName({ reported }: { readonly reported: string }) {
  return (
    <span
      className="client-name"
      title="The name this client reported. Any client with the endpoint token can report any name."
    >
      “{clientLabel(reported)}”
    </span>
  )
}

/** Adapter-written text is cut to this many characters wherever the app shows it. */
export const MAX_ADAPTER_TEXT = 280

export function capText(text: string, max = MAX_ADAPTER_TEXT): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

/**
 * Text the adapter's manifest wrote (a description), visibly marked as the adapter's and quoted, so
 * it never reads as the app's own statement.
 */
export function AdapterText({
  text,
  className,
  from = 'From the manifest',
}: {
  readonly text: string
  readonly className?: string
  /**
   * Where the text came from. Null leaves the tag off, for a line under a heading that already says
   * where it came from; the quotes and italics still mark it as the adapter's.
   */
  readonly from?: string | null
}) {
  return (
    <span className={`adapter-text${className === undefined ? '' : ` ${className}`}`}>
      {from === null ? null : <span className="adapter-text-from">{from}</span>}“{capText(text)}”
    </span>
  )
}

export function OutcomePill({
  outcome,
  errorClass = null,
}: {
  readonly outcome: RunOutcome | 'running'
  /** When given, a call answered "call again" reads as that rather than a red failure. */
  readonly errorClass?: string | null
}) {
  const run = { outcome, errorClass }
  return <span className={`pill ${runTone(run)}`.trim()}>{runWording(run)}</span>
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  readonly options: readonly { readonly value: T; readonly label: ReactNode }[]
  readonly value: T
  readonly onChange: (value: T) => void
  readonly label: string
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons
    <span className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

/** Shows loading and error states for a Loaded value, or renders `children` with its data. */
export function LoadState<T>({
  loaded,
  children,
  what,
}: {
  readonly loaded: Loaded<T>
  readonly children: (data: T) => ReactNode
  readonly what: string
}) {
  if (loaded.status === 'loading') return <div className="empty">Loading {what}…</div>
  if (loaded.status === 'error') {
    return (
      <div className="empty" role="alert">
        Couldn’t load {what}. Valet will try again when something changes.
      </div>
    )
  }
  return <>{children(loaded.data)}</>
}

export function ActionFailed({ failed, what }: { readonly failed: boolean; readonly what: string }) {
  if (!failed) return null
  return (
    <span className="xs danger-text" role="alert">
      Couldn’t {what}. Try again.
    </span>
  )
}

/** A tiny bar chart of hourly counts, scaled to the largest. */
export function Spark({ values, tone }: { readonly values: readonly number[]; readonly tone?: 'bad' }) {
  const max = Math.max(1, ...values)
  return (
    <div className="spark" aria-hidden="true">
      {values.map((v, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: hours are positional
          key={i}
          style={{
            height: `${Math.round((v / max) * 100)}%`,
            ...(tone === 'bad' ? { background: 'var(--irreversible)' } : {}),
          }}
        />
      ))}
    </div>
  )
}
