import {
  Activity,
  AppWindow,
  ChevronDown,
  FileText,
  Globe,
  KeyRound,
  type LucideIcon,
  Plus,
  ScrollText,
  X,
} from 'lucide-react'
import { HoverCard as HoverCardPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { ariaShortcut, currentPlatform } from '../lib/shortcut'
import { CopyButton, copyText } from './copy-button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './menu'

/** What an ObjectLink points at. Picks the icon when none is given. */
export type ObjectKind = 'site' | 'call' | 'app' | 'login' | 'audit' | 'file'
const kindIcon: Record<ObjectKind, LucideIcon> = {
  site: Globe,
  call: Activity,
  app: AppWindow,
  login: KeyRound,
  audit: ScrollText,
  file: FileText,
}

/**
 * A reference to another object in the app (a site, a call, a client, a credential, an audit entry),
 * wherever it's mentioned. It is always a link to that object, and on hover or focus shows a small
 * card with what it is, so a name in a sentence is never a dead end.
 *
 *   <ObjectLink href="#/adapters/woolworths" icon={<SiteAvatar … size="xs" />} card={…}>Woolworths</ObjectLink>
 */
export function ObjectLink({
  href,
  icon,
  card,
  children,
  className,
  mono = false,
  kind,
  copyValue,
  copyLabel,
  'aria-label': ariaLabel,
  'aria-description': ariaDescription,
}: {
  href: string
  icon?: ReactNode
  /** Content for the hover card. Leave it off for a plain object link. */
  card?: ReactNode
  children: ReactNode
  className?: string
  mono?: boolean
  /** What it points at: gives a default icon and is said after the name ("2 failed, call"). */
  kind?: ObjectKind
  /** The ref or ID: right-click offers Copy, and mod+C copies it while the link has focus. */
  copyValue?: string
  /** The context menu's item: "Copy ref". Defaults to "Copy". */
  copyLabel?: string
  /** A name with context when the text alone doesn't say it: "2 failed calls on Woolworths". */
  'aria-label'?: string
  'aria-description'?: string
}) {
  const KindIcon = kind ? kindIcon[kind] : undefined
  const shownIcon = icon ?? (KindIcon ? <KindIcon aria-hidden="true" /> : null)
  const link = (
    <a
      href={href}
      aria-label={ariaLabel}
      aria-description={ariaDescription}
      aria-keyshortcuts={copyValue !== undefined ? ariaShortcut('mod+C') : undefined}
      onKeyDown={
        copyValue === undefined
          ? undefined
          : (e) => {
              const mod = currentPlatform() === 'mac' ? e.metaKey : e.ctrlKey
              if (!mod || e.key.toLowerCase() !== 'c' || window.getSelection()?.toString()) return
              e.preventDefault()
              void copyText(copyValue)
            }
      }
      className={cn(
        'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-xs align-baseline font-medium text-fg',
        'underline decoration-dotted decoration-current/35 underline-offset-[3px] hover:decoration-solid hover:decoration-current/60 [&_svg]:size-3.5 [&_svg]:text-fg-muted',
        mono && 'font-mono text-[0.92em] font-regular',
        className,
      )}
    >
      {shownIcon ? <span className="inline-flex shrink-0 self-center">{shownIcon}</span> : null}
      <span className="truncate">{children}</span>
      {kind && !ariaLabel ? <span className="sr-only">, {kind}</span> : null}
    </a>
  )
  const withMenu =
    copyValue === undefined ? (
      link
    ) : (
      <ContextMenu>
        <ContextMenuTrigger asChild>{link}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void copyText(copyValue)}>{copyLabel ?? 'Copy'}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  if (!card) return withMenu
  return (
    <HoverCardPrimitive.Root openDelay={450} closeDelay={120}>
      <HoverCardPrimitive.Trigger asChild>{withMenu}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          sideOffset={6}
          className={cn(
            'material-floating z-[var(--v-z-popover)] w-72 rounded-lg p-3 text-md text-fg',
            'origin-(--radix-hover-card-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
          )}
        >
          {card}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  )
}

/**
 * A hash or ID shown short ("a1b2c3d4…"), monospace and selectable, with the full value on hover
 * and a copy button. With `href` the short form links to where that hash is recorded.
 */
export function HashChip({
  value,
  href,
  short = 8,
  label = 'hash',
  className,
}: {
  value: string
  href?: string
  short?: number
  label?: string
  className?: string
}) {
  const shown = value.length > short + 1 ? `${value.slice(0, short)}…` : value
  const chip = cn(
    'inline-flex h-5 items-center rounded-xs bg-code-bg px-1.5 font-mono text-xs text-code-fg no-underline',
    href &&
      'cursor-pointer underline decoration-dotted decoration-current/40 underline-offset-2 hover:bg-hover hover:decoration-solid',
  )
  return (
    <span className={cn('inline-flex items-center gap-0.5 align-middle', className)}>
      {href ? (
        <a href={href} title={value} className={chip} aria-description={value}>
          {shown}
          <span className="sr-only">, {label}</span>
        </a>
      ) : (
        // The whole value is in the DOM and only clipped, so selecting and copying get all of it.
        <span title={value} className={cn(chip, 'selectable')}>
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ maxWidth: `${short + 1}ch` }}
          >
            {value}
          </span>
        </span>
      )}
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  )
}

/**
 * A filter bar over a list: search, segmented filters and filter chips, one row. `count` is the
 * live result count ("38 calls"), announced politely as filters change.
 */
export function FilterBar({
  className,
  count,
  children,
  ...props
}: ComponentProps<'search'> & { count?: ReactNode }) {
  return (
    <search
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-2 border-b border-line-subtle px-6 py-2.5',
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined ? (
        <span role="status" className="ml-auto text-sm text-fg-muted tabular">
          {count}
        </span>
      ) : null}
    </search>
  )
}

export type FilterOption = { value: string; label: ReactNode }

/**
 * A filter that is always shown, set or not. Unset it reads "Site Any ▾" and opens its choices;
 * set it is a FilterChip ("Site: Woolworths ×") whose label reopens them. The parent writes the
 * URL in `onChange`; `undefined` clears it.
 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  anyLabel = 'Any',
  className,
}: {
  label: string
  value?: string
  options: FilterOption[]
  onChange: (value: string | undefined) => void
  anyLabel?: string
  className?: string
}) {
  const chosen = options.find((o) => o.value === value)
  const menu = (
    <DropdownMenuContent align="start">
      <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(v) => onChange(v === '' ? undefined : v)}>
        <DropdownMenuRadioItem value="">{anyLabel}</DropdownMenuRadioItem>
        {options.map((o) => (
          <DropdownMenuRadioItem key={o.value} value={o.value}>
            {o.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  )
  if (!chosen) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-6 cursor-pointer items-center gap-1 rounded-full px-2.5 text-sm text-fg ring-[0.5px] ring-line-control ring-inset transition-interactive hover:bg-hover',
              className,
            )}
          >
            <span className="text-fg-muted">{label}</span>
            <span className="font-medium">{anyLabel}</span>
            <ChevronDown aria-hidden="true" className="size-3 text-fg-muted" />
          </button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full bg-accent-soft text-sm text-accent-fg',
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-full cursor-pointer items-center gap-1 rounded-l-full pr-1 pl-2.5 hover:bg-selected"
          >
            <span className="text-fg-muted">{label}:</span>
            <span className="font-medium">{chosen.label}</span>
            <ChevronDown aria-hidden="true" className="size-3 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
      <button
        type="button"
        onClick={() => onChange(undefined)}
        aria-label={`Remove filter ${label}`}
        className="flex size-6 cursor-pointer items-center justify-center rounded-r-full hover:bg-selected"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}

/** "+ Filter": adds one of the filters not yet shown. */
export function AddFilter({
  filters,
  onAdd,
  label = 'Filter',
}: {
  filters: { key: string; label: ReactNode }[]
  onAdd: (key: string) => void
  label?: string
}) {
  if (filters.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-sm text-fg-muted transition-interactive hover:bg-hover hover:text-fg"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {filters.map((f) => (
          <DropdownMenuItem key={f.key} onSelect={() => onAdd(f.key)}>
            {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One active filter ("Site: Woolworths"), removable. Filters live in the URL, so removing one is a
 * navigation and Back brings it back.
 */
export function FilterChip({
  label,
  value,
  onRemove,
  onClick,
  className,
}: {
  label: ReactNode
  value: ReactNode
  onRemove: () => void
  /** Opens the filter's choices. */
  onClick?: () => void
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full bg-accent-soft text-sm text-accent-fg',
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex h-full cursor-pointer items-center gap-1 rounded-l-full pr-1 pl-2.5 hover:bg-selected"
      >
        <span className="text-fg-muted">{label}:</span>
        <span className="font-medium">{value}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${typeof label === 'string' ? label : ''}`.trim()}
        className="flex size-6 cursor-pointer items-center justify-center rounded-r-full hover:bg-selected"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}
