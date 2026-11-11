import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/** Where this page sits: "Adapters › Woolworths › Review update". Every crumb but the last is a link. */
export function Breadcrumb({
  items,
  className,
}: {
  items: readonly { label: ReactNode; href?: string }[]
  className?: string
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-sm', className)}>
      <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-fg-muted">
        {items.map((item, i) => {
          const last = i === items.length - 1
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional
            <li key={i} className="flex items-center gap-1">
              {item.href && !last ? (
                <a
                  href={item.href}
                  className="cursor-pointer rounded-xs text-fg-muted no-underline hover:text-fg hover:underline"
                >
                  {item.label}
                </a>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cn(last && 'text-fg')}>
                  {item.label}
                </span>
              )}
              {last ? null : <ChevronRight aria-hidden="true" className="size-3 text-fg-subtle" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
