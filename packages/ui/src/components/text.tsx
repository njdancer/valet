import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { formatShortcut } from '../lib/shortcut'
import { CopyButton } from './copy-button'

export const headingVariants = cva('text-fg text-balance', {
  variants: {
    size: {
      display: 'text-3xl font-bold tracking-tight',
      page: 'text-2xl font-semibold tracking-tight',
      section: 'text-lg font-semibold tracking-snug',
      group: 'text-md font-semibold',
      eyebrow: 'text-2xs font-semibold uppercase tracking-wide text-fg-subtle',
    },
  },
  defaultVariants: { size: 'section' },
})

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/** A heading. `level` is the outline (h1 to h6); `size` is how it looks. They are chosen apart. */
export function Heading({
  level = 2,
  size,
  className,
  ...props
}: ComponentProps<'h2'> & { level?: HeadingLevel } & VariantProps<typeof headingVariants>) {
  const Tag = `h${level}` as const
  return <Tag className={cn('m-0', headingVariants({ size }), className)} {...props} />
}

export const textVariants = cva('m-0', {
  variants: {
    tone: {
      default: 'text-fg',
      muted: 'text-fg-muted',
      subtle: 'text-fg-subtle',
      success: 'text-success-fg',
      warning: 'text-warning-fg',
      danger: 'text-danger-fg',
      accent: 'text-accent-fg',
    },
    size: { xs: 'text-xs', sm: 'text-sm', md: 'text-md', lg: 'text-lg' },
    weight: { regular: 'font-regular', medium: 'font-medium', semibold: 'font-semibold' },
  },
  defaultVariants: { tone: 'default', size: 'md', weight: 'regular' },
})

/** Body text. A <p> by default; `asChild` styles another element. */
export function Text({
  className,
  tone,
  size,
  weight,
  asChild,
  ...props
}: ComponentProps<'p'> & VariantProps<typeof textVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'p'
  return <Comp className={cn(textVariants({ tone, size, weight }), 'text-pretty', className)} {...props} />
}

/**
 * A value a person may want to copy: an ID, hash, URL, path, version. Selectable (chrome text is
 * not), optionally monospace and truncated in the middle, optionally with a copy button.
 */
export function Value({
  children,
  mono = false,
  copy,
  truncate = false,
  className,
  title,
}: {
  children: ReactNode
  mono?: boolean
  /** The text to copy. Gives the value a copy button. */
  copy?: string
  /**
   * Cut a long value to fit. `middle` keeps the end in view, for paths, IDs and URLs where the end
   * is what tells them apart ("…/adapters/woolworths.ts"). The whole value stays in the DOM, so
   * selecting and copying get all of it.
   */
  truncate?: boolean | 'end' | 'middle'
  className?: string
  title?: string
}) {
  const text = typeof children === 'string' ? children : undefined
  const middle = truncate === 'middle' && text !== undefined && text.length > 16
  const tail = middle ? Math.min(12, Math.floor(text.length / 3)) : 0
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1 align-middle', className)}>
      <span
        title={title ?? (truncate ? text : undefined)}
        className={cn(
          'selectable min-w-0',
          mono && 'font-mono text-[0.92em]',
          truncate && !middle && 'truncate',
          middle && 'flex whitespace-nowrap',
        )}
      >
        {middle ? (
          <>
            <span className="min-w-0 truncate">{text.slice(0, -tail)}</span>
            <span className="shrink-0">{text.slice(-tail)}</span>
          </>
        ) : (
          children
        )}
      </span>
      {copy !== undefined ? <CopyButton value={copy} label="Copy" /> : null}
    </span>
  )
}

/** Inline code. Selectable. */
export function Code({ className, ...props }: ComponentProps<'code'>) {
  return (
    <code
      className={cn(
        'selectable rounded-xs bg-code-bg px-1 py-px font-mono text-[0.9em] text-code-fg',
        className,
      )}
      {...props}
    />
  )
}

/** A block of code, a config snippet or log text, with a copy button in the corner. */
export function CodeBlock({
  children,
  copy,
  className,
  label,
  wrap = false,
}: {
  children: string
  copy?: boolean
  className?: string
  /** What the block is, for a screen reader ("Claude Desktop config"). */
  label?: string
  wrap?: boolean
}) {
  return (
    <figure
      className={cn(
        'group relative m-0 rounded-md bg-code-bg ring-[0.5px] ring-line-subtle ring-inset',
        className,
      )}
    >
      {/* A scrolling block must be reachable by keyboard (WCAG 2.1.1), so it's a named, focusable region. */}
      <section
        aria-label={label ?? 'Code'}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-[inherit] outline-offset-[-2px]"
      >
        <pre
          className={cn(
            'selectable m-0 p-3 pr-10 font-mono text-sm leading-normal text-code-fg',
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
          )}
        >
          {children}
        </pre>
      </section>
      {copy ? (
        <div className="absolute top-1.5 right-1.5 opacity-70 transition-interactive group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton value={children} label={label ? `Copy ${label}` : 'Copy'} />
        </div>
      ) : null}
    </figure>
  )
}

/** A keyboard key or shortcut. Pass keys as separate children: <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-xs bg-raised px-1 font-sans text-2xs font-medium text-fg-muted',
        'shadow-[inset_0_-1px_0_var(--border-default),0_0_0_0.5px_var(--border-default)]',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A keyboard shortcut written platform-neutral (keys="mod+K") and shown as that OS writes it: ⌘K
 * on macOS, Ctrl+K on Windows and Linux.
 */
export function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return <Kbd className={className}>{formatShortcut(keys)}</Kbd>
}

/** A link inside text. Internal navigation uses this too: it is still a link, not a button. */
export function TextLink({
  className,
  external,
  children,
  ...props
}: ComponentProps<'a'> & { external?: boolean }) {
  return (
    <a
      className={cn(
        'cursor-pointer rounded-xs text-fg-link underline decoration-current/30 underline-offset-2 transition-interactive hover:decoration-current',
        className,
      )}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      {...props}
    >
      {children}
      {external ? <span className="sr-only"> (opens in your browser)</span> : null}
    </a>
  )
}
