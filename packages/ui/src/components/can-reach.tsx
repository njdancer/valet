import { Globe, KeyRound, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * What a call from here could cause Valet to touch (the blast radius): which tools, which hosts,
 * which logins. Shown on every site page and app page, so a security reviewer reads it in one place.
 */
export function CanReach({
  tools,
  hosts,
  logins,
  title = 'Can reach',
  className,
}: {
  tools: readonly ReactNode[]
  hosts: readonly ReactNode[]
  logins: readonly ReactNode[]
  title?: ReactNode
  className?: string
}) {
  const groups = [
    { key: 'tools', label: 'Tools', icon: <Wrench />, items: tools, none: 'No tools' },
    { key: 'hosts', label: 'Websites', icon: <Globe />, items: hosts, none: 'No websites' },
    { key: 'logins', label: 'Logins Valet may fill', icon: <KeyRound />, items: logins, none: 'No logins' },
  ]
  return (
    <section
      aria-label={typeof title === 'string' ? title : 'Can reach'}
      className={cn(
        'flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-1 ring-[0.5px] ring-line ring-inset',
        className,
      )}
    >
      <h3 className="m-0 text-md font-semibold">{title}</h3>
      <div className="grid grid-cols-3 gap-4 @max-[640px]:grid-cols-1">
        {groups.map((g) => (
          <div key={g.key} className="flex min-w-0 flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-sm text-fg-muted [&_svg]:size-3.5">
              {g.icon}
              {g.label}
              <span className="tabular text-fg-subtle">· {g.items.length}</span>
            </span>
            {g.items.length === 0 ? (
              <span className="text-sm text-fg-subtle">{g.none}</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-md">
                {g.items.map((item, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional
                  <li key={i} className="min-w-0 truncate">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
