// Pieces Connections, Secrets and Settings share: the failure line, a copy button that copies
// through the main process, the not-found state, and what an approved site can reach.

import { Button, IconButton, Text } from '@valet/ui'
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { AdapterDetail, ClientInfo, GrantInfo } from '../../../shared/api'
import { useLoad } from '../../lib/api-context'
import { hostOf } from '../../lib/format'
import { clientLabel } from '../../lib/wording'

/**
 * "Couldn’t <what>. Try again.", as an alert beside the control that failed. The main process's
 * error text never reaches the screen.
 */
export function Failed({ failed, what }: { readonly failed: boolean; readonly what: string }) {
  if (!failed) return null
  return (
    <Text role="alert" size="sm" tone="danger" className="animate-rise-in">
      Couldn’t {what}. Try again.
    </Text>
  )
}

/**
 * A copy button that asks the main process to copy (the sandboxed renderer's own clipboard is not
 * to be relied on). The icon turns into a tick for a moment and the change is announced.
 */
export function CopyThrough({
  label,
  copy,
  size = 'sm',
}: {
  readonly label: string
  readonly copy: () => Promise<void>
  readonly size?: 'sm' | 'md'
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      <IconButton
        size={size}
        variant="quiet"
        label={label}
        className={state === 'copied' ? 'text-success-fg' : undefined}
        icon={state === 'copied' ? <Check className="animate-pop-in" /> : <Copy />}
        onClick={async () => {
          clearTimeout(timer.current)
          try {
            await copy()
            setState('copied')
          } catch {
            setState('failed')
          }
          timer.current = setTimeout(() => setState('idle'), 1400)
        }}
      />
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : ''}
      </span>
    </>
  )
}

/** A labelled copy button ("Copy URL") for when the value it copies isn't on screen beside it. */
export function CopyButtonThrough({
  children,
  copy,
  variant = 'secondary',
}: {
  readonly children: ReactNode
  readonly copy: () => Promise<void>
  readonly variant?: 'secondary' | 'ghost'
}) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        leading={copied ? <Check className="animate-pop-in" /> : <Copy />}
        onClick={async () => {
          clearTimeout(timer.current)
          setFailed(false)
          try {
            await copy()
            setCopied(true)
            timer.current = setTimeout(() => setCopied(false), 1400)
          } catch {
            setFailed(true)
          }
        }}
      >
        {copied ? 'Copied' : children}
      </Button>
      <Failed failed={failed} what="copy" />
    </>
  )
}

/** "Claude Code", "Claude Desktop": the two letters an app's tile shows. */
export function initials(name: string): string {
  return (
    name
      .split(/[\s-]+/)
      .filter((w) => w.length > 0)
      .map((w) => w.charAt(0).toUpperCase())
      .join('')
      .slice(0, 2) || '?'
  )
}

/** A square tile for an app or cloud agent: its initials, never a logo it could fake. */
export function AppTile({ name, size = 'md' }: { readonly name: string; readonly size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={
        size === 'lg'
          ? 'flex size-9 shrink-0 items-center justify-center rounded-md bg-inset text-md font-semibold text-fg-muted'
          : 'flex size-7 shrink-0 items-center justify-center rounded-sm bg-inset text-sm font-semibold text-fg-muted'
      }
    >
      {initials(name)}
    </span>
  )
}

export function activeClients(list: readonly ClientInfo[]): ClientInfo[] {
  return list.filter((c) => c.revokedAt === null)
}

/** One approved site as a call could reach it: its tools, the hosts it may contact, its logins. */
export interface SiteReach {
  readonly id: string
  readonly name: string
  readonly tools: readonly { readonly name: string; readonly title: string; readonly sideEffect: string }[]
  readonly hosts: readonly string[]
  readonly logins: readonly GrantInfo[]
}

/** The hosts a site's calls may contact: its pages and its allowed requests, as host names. */
export function siteHosts(detail: AdapterDetail): string[] {
  return [...new Set([...detail.navigation.map(hostOf), ...detail.egress.map(hostOf)])]
}

/**
 * Every approved site with what its calls can reach, computed from what is approved now. Logins
 * count only for the approved version: a grant for another hash can't be filled.
 */
export function useReach() {
  return useLoad(
    async (api): Promise<readonly SiteReach[]> => {
      const [adapters, grants] = await Promise.all([api.adapters.list(), api.grants.list()])
      const approved = adapters.filter((a) => a.approval === 'approved')
      const details = await Promise.all(approved.map((a) => api.adapters.get(a.id)))
      return details
        .filter((d): d is AdapterDetail => d !== null)
        .map((d) => ({
          id: d.id,
          name: d.name,
          tools: d.tools
            .filter((t) => !t.internal)
            .map((t) => ({ name: t.name, title: t.title, sideEffect: t.sideEffect })),
          hosts: siteHosts(d),
          logins: grants.filter((g) => g.adapterId === d.id && g.adapterHash === d.hash),
        }))
    },
    [],
    ['adapters-changed', 'approvals-changed', 'grants-changed'],
  )
}

/** "2 change things · 1 asks you first" for a site's tools. */
export function toolSummary(tools: SiteReach['tools']): string {
  const writes = tools.filter((t) => t.sideEffect !== 'read').length
  const asks = tools.filter((t) => t.sideEffect === 'irreversible').length
  const parts = [tools.length === 1 ? '1 tool' : `${tools.length} tools`]
  if (writes === 0) parts.push('read only')
  else parts.push(`${writes} change${writes === 1 ? 's' : ''} things`)
  if (asks > 0) parts.push(`${asks} ask${asks === 1 ? 's' : ''} you first`)
  return parts.join(' · ')
}

/** A login's name as the person reads it: "Woolworths login", "Woolworths one-time codes". */
export function loginName(siteName: string, grant: Pick<GrantInfo, 'secret' | 'provider'>): string {
  if (grant.provider === 'messages') return `${siteName} one-time codes`
  return grant.secret === 'login' ? `${siteName} login` : `${siteName} ${grant.secret}`
}

/**
 * A name an app reported for itself, as it reported it ("claude-code"), so it reads as the claim
 * it is rather than as Valet's own name for the app. Anything but a plain identifier goes through
 * clientLabel, which strips control and bidi characters and cuts it short.
 */
export function reportedAs(reportedName: string): string {
  return /^[A-Za-z0-9._-]{1,40}$/.test(reportedName) ? reportedName : clientLabel(reportedName)
}
