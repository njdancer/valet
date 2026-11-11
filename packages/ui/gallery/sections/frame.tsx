import type { ReactNode } from 'react'
import { Heading, Text } from '../../src'
import { cn } from '../../src/lib/cn'

export function GalleryPage({
  title,
  intro,
  children,
}: {
  title: string
  intro: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex max-w-[1080px] flex-col gap-10 px-10 py-8">
      <header className="flex flex-col gap-2">
        <Heading level={1} size="display">
          {title}
        </Heading>
        <Text tone="muted" size="lg" className="max-w-[680px]">
          {intro}
        </Text>
      </header>
      {children}
    </div>
  )
}

export function Specimen({
  title,
  notes,
  children,
  className,
  id,
}: {
  title: string
  notes?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-col gap-1">
        <Heading level={2} size="section">
          {title}
        </Heading>
        {notes ? (
          <Text tone="muted" size="sm" className="max-w-[720px]">
            {notes}
          </Text>
        ) : null}
      </div>
      <div className={cn('rounded-xl bg-surface p-6 shadow-1 ring-[0.5px] ring-line ring-inset', className)}>
        {children}
      </div>
    </section>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-4 py-2">
      <span className="text-sm text-fg-subtle">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
