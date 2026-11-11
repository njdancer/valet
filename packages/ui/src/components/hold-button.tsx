import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { type ButtonProps, buttonVariants } from './button'
import { ConfirmDialog } from './dialog'
import { Tooltip } from './tooltip'

/**
 * Press and hold to confirm, for the few actions that can't be undone (erase all data, place an
 * order). A fill sweeps across while held; letting go early cancels, and the fill eases back. Works
 * the same with Space or Enter held down.
 *
 * Screen readers activate a button with a plain click (VoiceOver, NVDA browse mode), which can't
 * be held, so a click that didn't come from a pointer or the keyboard opens a confirm dialog
 * instead. The hold time is announced up front and "Confirmed" when it lands.
 */
export function HoldToConfirm({
  children,
  onConfirm,
  holdMs = 1200,
  variant = 'danger',
  size = 'md',
  className,
  disabled,
  disabledReason,
  confirmTitle,
  confirmDescription = "This can't be undone.",
}: {
  children: ReactNode
  onConfirm: () => void
  holdMs?: number
  variant?: 'danger' | 'primary'
  size?: ButtonProps['size']
  className?: string
  disabled?: boolean
  /** Why it can't be used yet. The button stays focusable and says so. */
  disabledReason?: string
  /** Title of the fallback dialog for assistive tech. Defaults to the button's label. */
  confirmTitle?: ReactNode
  confirmDescription?: ReactNode
}) {
  const [progress, setProgress] = useState(0)
  const [releasing, setReleasing] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [asking, setAsking] = useState(false)
  const frame = useRef(0)
  const start = useRef<number | null>(null)
  const handled = useRef(false)

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current)
    if (start.current !== null) setReleasing(true)
    start.current = null
    setProgress(0)
  }, [])

  const confirm = useCallback(() => {
    setAnnounce('Confirmed')
    onConfirm()
    window.setTimeout(() => setAnnounce(''), 1500)
  }, [onConfirm])

  const begin = useCallback(() => {
    if (disabled || start.current !== null) return
    setReleasing(false)
    start.current = performance.now()
    const tick = (t: number) => {
      if (start.current === null) return
      const p = Math.min(1, (t - start.current) / holdMs)
      setProgress(p)
      if (p >= 1) {
        start.current = null
        setProgress(0)
        confirm()
      } else frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [disabled, holdMs, confirm])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const seconds = (holdMs / 1000).toFixed(holdMs % 1000 === 0 ? 0 : 1)
  const button = (
    <button
      type="button"
      aria-disabled={disabled || undefined}
      aria-description={
        disabled && disabledReason ? disabledReason : `Press and hold for ${seconds} seconds to confirm`
      }
      data-slot="hold-button"
      className={cn(
        buttonVariants({ variant, size }),
        'overflow-hidden select-none',
        disabled && disabledReason && 'aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed',
        className,
      )}
      onPointerDown={(e) => {
        handled.current = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
        begin()
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          handled.current = true
          if (!e.repeat) begin()
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop()
      }}
      onBlur={stop}
      onClick={(e) => {
        // A click with no pointer or key behind it comes from assistive tech: ask instead.
        if (!handled.current && e.detail === 0 && !disabled) setAsking(true)
        handled.current = false
      }}
    >
      <span
        aria-hidden="true"
        data-slot="hold-fill"
        className={cn(
          'absolute inset-y-0 left-0 bg-[oklch(0_0_0/0.22)]',
          releasing && 'transition-[width] duration-(--v-duration-base) ease-(--v-ease-exit)',
        )}
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative inline-flex items-center gap-1.5">{children}</span>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </button>
  )
  return (
    <>
      {disabled && disabledReason ? <Tooltip content={disabledReason}>{button}</Tooltip> : button}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={confirmTitle ?? children}
        description={confirmDescription}
        confirmLabel={children}
        destructive={variant === 'danger'}
        onConfirm={confirm}
      />
    </>
  )
}
