// Small presentational pieces shared by every screen. Text is always rendered as React text, never
// as HTML, so adapter-authored strings can't inject markup.

import type { Purpose, RunOutcome } from '@siteadapter/core'
import type { ReactNode } from 'react'
import type { Loaded } from '../lib/api-context'
import { shortHash } from '../lib/format'
import { OUTCOME_TONE, OUTCOME_WORDING } from '../lib/wording'

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

export function OutcomePill({ outcome }: { readonly outcome: RunOutcome | 'running' }) {
  return <span className={`pill ${OUTCOME_TONE[outcome]}`.trim()}>{OUTCOME_WORDING[outcome]}</span>
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
        Couldn’t load {what}. siteadapter will try again when something changes.
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
