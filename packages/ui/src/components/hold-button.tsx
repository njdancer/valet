import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { type ButtonProps, buttonVariants } from './button'

/**
 * Press and hold to confirm, for the few actions that can't be undone (erase all data, place an
 * order). A fill sweeps across while held; letting go early cancels. Works the same with Space or
 * Enter held down. The hold time is announced, so it isn't a surprise to a screen reader user.
 */
export function HoldToConfirm({
  children,
  onConfirm,
  holdMs = 1200,
  variant = 'danger',
  size = 'md',
  className,
  disabled,
}: {
  children: ReactNode
  onConfirm: () => void
  holdMs?: number
  variant?: 'danger' | 'primary'
  size?: ButtonProps['size']
  className?: string
  disabled?: boolean
}) {
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const frame = useRef(0)
  const start = useRef<number | null>(null)

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current)
    start.current = null
    setProgress(0)
  }, [])

  const begin = useCallback(() => {
    if (disabled || start.current !== null || done) return
    start.current = performance.now()
    const tick = (t: number) => {
      if (start.current === null) return
      const p = Math.min(1, (t - start.current) / holdMs)
      setProgress(p)
      if (p >= 1) {
        start.current = null
        setDone(true)
        onConfirm()
      } else frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [disabled, done, holdMs, onConfirm])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const seconds = (holdMs / 1000).toFixed(holdMs % 1000 === 0 ? 0 : 1)
  return (
    <button
      type="button"
      disabled={disabled}
      aria-description={`Press and hold for ${seconds} seconds to confirm`}
      className={cn(buttonVariants({ variant, size }), 'overflow-hidden select-none', className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        begin()
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault()
          begin()
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop()
      }}
      onBlur={stop}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-[oklch(0_0_0/0.22)]"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative inline-flex items-center gap-1.5">{children}</span>
    </button>
  )
}
