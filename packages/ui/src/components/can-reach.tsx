import { AppWindow, Globe, KeyRound, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/** One thing in a group: plain content, or content with a badge ("New" after an approve). */
export type CanReachItem = ReactNode | { content: ReactNode; badge?: ReactNode }

export type CanReachGroup = {
  key: string
  label: ReactNode
  icon?: ReactNode
  items: readonly CanReachItem[]
  /** Shown when the group is empty: "No logins". */
  none?: ReactNode
  /** Singular and plural for the folded summary: ['login', 'logins']. */
  noun?: readonly [string, string]
}

const isItem = (item: CanReachItem): item is { content: ReactNode; badge?: ReactNode } =>
  typeof item === 'object' && item !== null && !Array.isArray(item) && 'content' in item

/**
 * What a call from here could cause Valet to touch (the blast radius): which tools, which hosts,
 * which logins, and with `callers` which apps can make those calls. Shown on every site page and
 * app page, so a security reviewer reads it in one place.
 *
 * - `direction="reachedBy"` reads the other way, for a login or site: "Reached by".
 * - `basis` says where the answer comes from; `checked` and `actions` sit in the header.
 * - `collapsed` folds it to one line ("2 sites · 1 login · 9 tools").
 * - `live` announces changes politely, for the approve-connection preview while tools are ticked.
 */
export function CanReach({
  tools,
  hosts,
  logins,
  callers,
  groups,
  title,
  direction = 'reach',
  basis,
  checked,
  actions,
  collapsed = false,
  live = false,
  className,
}: {
  tools?: readonly CanReachItem[]
  hosts?: readonly CanReachItem[]
  logins?: readonly CanReachItem[]
  /** Apps that can call these tools. Adds a fourth group. */
  callers?: readonly CanReachItem[]
  /** Replaces the default groups entirely. */
  groups?: readonly CanReachGroup[]
  title?: ReactNode
  direction?: 'reach' | 'reachedBy'
  basis?: ReactNode
  checked?: ReactNode
  actions?: ReactNode
  collapsed?: boolean
  live?: boolean
  className?: string
}) {
  const shown: readonly CanReachGroup[] = groups ?? [
    ...(callers
      ? [
          {
            key: 'callers',
            label: 'Apps that can call',
            icon: <AppWindow />,
            items: callers,
            none: 'No apps',
            noun: ['app', 'apps'] as const,
          },
        ]
      : []),
    {
      key: 'tools',
      label: 'Tools',
      icon: <Wrench />,
      items: tools ?? [],
      none: 'No tools',
      noun: ['tool', 'tools'],
    },
    {
      key: 'hosts',
      label: 'Websites',
      icon: <Globe />,
      items: hosts ?? [],
      none: 'No websites',
      noun: ['site', 'sites'],
    },
    {
      key: 'logins',
      label: 'Logins Valet may fill',
      icon: <KeyRound />,
      items: logins ?? [],
      none: 'No logins',
      noun: ['login', 'logins'],
    },
  ]
  const heading = title ?? (direction === 'reachedBy' ? 'Reached by' : 'Can reach')
  const summary = shown
    .map((g) => {
      const n = g.items.length
      const word = g.noun ? g.noun[n === 1 ? 0 : 1] : typeof g.label === 'string' ? g.label.toLowerCase() : ''
      return `${n} ${word}`.trim()
    })
    .join(' · ')
  return (
    <section
      aria-label={typeof heading === 'string' ? heading : 'Can reach'}
      className={cn(
        'flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-1 ring-[0.5px] ring-line ring-inset',
        collapsed && 'gap-1 py-3',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="m-0 text-md font-semibold">{heading}</h3>
        {collapsed ? (
          <span className="text-sm text-fg-muted tabular" aria-live={live ? 'polite' : undefined}>
            {summary}
          </span>
        ) : null}
        {checked || actions ? (
          <span className="ml-auto flex items-center gap-2">
            {checked}
            {actions}
          </span>
        ) : null}
      </div>
      {basis ? <p className="m-0 text-sm text-fg-muted text-pretty">{basis}</p> : null}
      {collapsed ? null : (
        <>
          {live ? (
            <span className="sr-only" aria-live="polite">
              {summary}
            </span>
          ) : null}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
            {shown.map((g) => (
              <div key={g.key} className="flex min-w-0 flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-sm text-fg-muted [&_svg]:size-3.5">
                  {g.icon}
                  {g.label}
                  <span className="tabular text-fg-subtle">· {g.items.length}</span>
                </span>
                {g.items.length === 0 ? (
                  <span className="text-sm text-fg-subtle">{g.none ?? 'None'}</span>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-md">
                    {g.items.map((item, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional
                      <li key={i} className="flex min-w-0 flex-wrap items-center gap-1.5 break-words">
                        {isItem(item) ? (
                          <>
                            <span className="min-w-0 break-words">{item.content}</span>
                            {item.badge}
                          </>
                        ) : (
                          item
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
