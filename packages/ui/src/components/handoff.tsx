import { ArrowLeft, Lock, RotateCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { ariaShortcut, formatShortcut } from '../lib/shortcut'
import { DeadlineChip } from './attention'
import { Button } from './button'
import { IconButton } from './icon-button'
import { Spinner } from './spinner'

export type HandoffState = 'waiting' | 'checking' | 'not-yet' | 'success' | 'expired'

/**
 * The strip across the top of the login window when Valet hands the sign-in to the person: Valet
 * has typed the password; they finish what only they can (a code, a captcha) on the site's page
 * below, then say "I’m done". Valet's own chrome, never the site's, so the person can tell which
 * words are Valet's.
 *
 * Focus starts on "I’m done". The page below is another web view, so the window registers
 * `returnShortcut` (default mod+shift+B) in the main process to bring focus back here; the strip
 * shows that key.
 */
export function HandoffBanner({
  site,
  state,
  message,
  until,
  now,
  returnShortcut = 'mod+shift+B',
  onDone,
  onCancel,
  onClose,
  className,
}: {
  /** The site's name: "Woolworths". */
  site: string
  state: HandoffState
  /** Override the line for the state (e.g. what the site asked for). */
  message?: ReactNode
  until?: number
  now?: number
  returnShortcut?: string
  onDone: () => void
  onCancel: () => void
  /** For success and expired: closes the window. */
  onClose?: () => void
  className?: string
}) {
  const primary = useRef<HTMLButtonElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus the primary button whenever the state changes
  useEffect(() => {
    primary.current?.focus()
  }, [state])
  const line: Record<HandoffState, ReactNode> = {
    waiting: `Valet typed your ${site} password. Finish any code or check the site asks for below, then press I’m done.`,
    checking: `Checking that you’re signed in to ${site}…`,
    'not-yet': `${site} doesn’t show you as signed in yet. Finish the sign-in below, then try again.`,
    success: `Signed in to ${site}. Valet will carry on; you can close this window.`,
    expired: `This sign-in timed out. Nothing was saved. Claude can ask again.`,
  }
  const tone =
    state === 'success'
      ? 'bg-success-soft text-success-fg'
      : state === 'expired' || state === 'not-yet'
        ? 'bg-warning-soft text-warning-fg'
        : 'bg-accent-soft text-accent-fg'
  return (
    <section
      aria-label={`Sign in to ${site}`}
      data-state={state}
      tabIndex={-1}
      aria-keyshortcuts={ariaShortcut(returnShortcut)}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle px-4 py-2.5 outline-hidden',
        tone,
        className,
      )}
    >
      <p
        role="status"
        className="m-0 flex min-w-[min(100%,18rem)] flex-1 items-center gap-2 text-md font-medium text-pretty"
      >
        {state === 'checking' ? <Spinner size={14} /> : null}
        {state === 'not-yet' || state === 'expired' ? (
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
        ) : null}
        <span>{message ?? line[state]}</span>
      </p>
      {until !== undefined && (state === 'waiting' || state === 'not-yet') ? (
        <DeadlineChip until={until} now={now} subject={`${site} sign-in`} />
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {state === 'success' || state === 'expired' ? (
          <Button ref={primary} variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onCancel} disabled={state === 'checking'}>
              Cancel sign-in
            </Button>
            <Button ref={primary} variant="primary" onClick={onDone} loading={state === 'checking'}>
              {state === 'not-yet' ? 'Check again' : 'I’m done'}
            </Button>
          </>
        )}
        {state === 'waiting' || state === 'not-yet' ? (
          <span className="hidden text-xs opacity-80 min-[640px]:inline" aria-hidden="true">
            {formatShortcut(returnShortcut)} returns here
          </span>
        ) : null}
      </div>
    </section>
  )
}

/**
 * The address strip of Valet's login window: which site the page really is (host first, bold),
 * whether the connection is secure, and where Valet will type secrets. The URL is selectable.
 */
export function BrowserBar({
  url,
  typedInto,
  canGoBack = false,
  loading = false,
  onBack,
  onReload,
  className,
}: {
  url: string
  /** Hosts the login may be typed into: "woolworths.com.au, auth.woolworths.com.au". */
  typedInto?: string
  canGoBack?: boolean
  loading?: boolean
  onBack?: () => void
  onReload?: () => void
  className?: string
}) {
  let host = url
  let rest = ''
  let secure = false
  try {
    const parsed = new URL(url)
    host = parsed.host
    rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`
    secure = parsed.protocol === 'https:'
  } catch {
    // Not a URL: show it as given.
  }
  return (
    <div
      data-slot="browser-bar"
      className={cn(
        'flex min-w-0 items-center gap-1.5 border-b border-line-subtle bg-canvas px-2 py-1.5',
        className,
      )}
    >
      <IconButton
        label="Back"
        icon={<ArrowLeft />}
        size="sm"
        variant="quiet"
        disabled={!canGoBack}
        onClick={onBack}
      />
      <IconButton
        label="Reload"
        icon={loading ? <Spinner size={14} /> : <RotateCw />}
        size="sm"
        variant="quiet"
        onClick={onReload}
      />
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-inset px-2 text-md">
        {secure ? (
          <Lock aria-label="Secure connection" role="img" className="size-3.5 shrink-0 text-fg-muted" />
        ) : (
          <TriangleAlert aria-label="Not secure" role="img" className="size-3.5 shrink-0 text-danger-solid" />
        )}
        <span title={url} className="selectable min-w-0 truncate">
          <span className="font-semibold text-fg">{host}</span>
          <span className="text-fg-muted">{rest}</span>
        </span>
      </div>
      {typedInto ? (
        <span className="hidden shrink-0 text-sm text-fg-muted min-[720px]:inline">
          Typed into {typedInto} only
        </span>
      ) : null}
    </div>
  )
}
