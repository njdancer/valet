import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'

// Moments of delight. Each marks a finished job, never decoration for its own sake, and each
// is still complete under reduced motion (it appears in its final state, without the travel).

/** Valet's mark: a bow tie in brass on an ink tile. */
export function ValetMark({
  size = 24,
  className,
  title,
}: {
  size?: number
  className?: string
  title?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="valet-mark-ink" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.4 0.12 258)" />
          <stop offset="1" stopColor="oklch(0.26 0.07 258)" />
        </linearGradient>
        <linearGradient id="valet-mark-brass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.88 0.1 85)" />
          <stop offset="0.55" stopColor="oklch(0.74 0.12 75)" />
          <stop offset="1" stopColor="oklch(0.6 0.11 65)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#valet-mark-ink)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="oklch(1 0 0 / 0.18)" />
      <path
        d="M6.5 10.2c0-.9 1-1.5 1.8-1l6.2 4.1a2 2 0 0 1 1.5-.7 2 2 0 0 1 1.5.7l6.2-4.1c.8-.5 1.8.1 1.8 1v11.6c0 .9-1 1.5-1.8 1l-6.2-4.1a2 2 0 0 1-1.5.7 2 2 0 0 1-1.5-.7l-6.2 4.1c-.8.5-1.8-.1-1.8-1Z"
        fill="url(#valet-mark-brass)"
      />
    </svg>
  )
}

/** A tick in a circle that draws itself. For a step done (a test call that worked). */
export function SuccessCheck({
  size = 40,
  className,
  label,
}: {
  size?: number
  className?: string
  label?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('text-success-solid', className)}
    >
      <circle
        cx="20"
        cy="20"
        r="18"
        fill="currentColor"
        className="origin-center animate-pop-in"
        opacity="0.14"
      />
      <circle
        cx="20"
        cy="20"
        r="17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="107"
        className="animate-draw [--v-draw-length:107] origin-center -rotate-90"
      />
      <path
        d="m12.5 20.5 5 5 10-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="24"
        className="animate-draw [--v-draw-length:24] [animation-delay:220ms]"
      />
    </svg>
  )
}

/**
 * The approval seal: a brass rosette that stamps down with a spring when the person approves an
 * adapter or an update. It says "you checked this, and Valet has recorded it".
 */
export function ApprovalSeal({
  size = 72,
  className,
  label = 'Approved',
}: {
  size?: number
  className?: string
  label?: string
}) {
  const teeth = 18
  const points: string[] = []
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? 34 : 30.5
    const a = (Math.PI * i) / teeth
    points.push(`${(36 + r * Math.sin(a)).toFixed(2)},${(36 - r * Math.cos(a)).toFixed(2)}`)
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      role="img"
      aria-label={label}
      className={cn('animate-seal', className)}
    >
      <defs>
        <linearGradient id="valet-seal-brass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.9 0.09 88)" />
          <stop offset="0.5" stopColor="oklch(0.75 0.12 76)" />
          <stop offset="1" stopColor="oklch(0.58 0.11 64)" />
        </linearGradient>
      </defs>
      <polygon points={points.join(' ')} fill="url(#valet-seal-brass)" />
      <circle cx="36" cy="36" r="25" fill="none" stroke="oklch(1 0 0 / 0.55)" strokeWidth="1" />
      <circle cx="36" cy="36" r="22" fill="oklch(0.3 0.08 258)" />
      <path
        d="m26 36.5 6.5 6.5 13.5-14"
        fill="none"
        stroke="oklch(0.9 0.09 88)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="32"
        className="animate-draw [--v-draw-length:32] [animation-delay:380ms]"
      />
    </svg>
  )
}

/** A burst of brass sparks, played once around its child (setup finished). */
export function Sparkle({
  children,
  play = true,
  className,
}: {
  children: ReactNode
  play?: boolean
  className?: string
}) {
  return (
    <span className={cn('relative inline-flex', className)}>
      {children}
      {play ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0">
          {Array.from({ length: 8 }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              key={i}
              className="valet-spark absolute top-1/2 left-1/2 h-2.5 w-0.5 rounded-full bg-brass-solid"
              style={
                {
                  '--spark-angle': `${i * 45}deg`,
                  animationDelay: `${(i % 2) * 60}ms`,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
      ) : null}
    </span>
  )
}

/** A number that rolls to its new value, for live counts (calls today). Tabular, so it doesn't jitter. */
export function AnimatedNumber({
  value,
  className,
  duration = 600,
}: {
  value: number
  className?: string
  duration?: number
}) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || typeof requestAnimationFrame !== 'function') {
      setShown(value)
      from.current = value
      return
    }
    const start = performance.now()
    const a = from.current
    let frame = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - (1 - p) ** 3
      setShown(Math.round(a + (value - a) * eased))
      if (p < 1) frame = requestAnimationFrame(tick)
      else from.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, duration])
  return (
    <span className={cn('tabular', className)}>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{value}</span>
    </span>
  )
}
