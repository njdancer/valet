import { ChevronRight } from 'lucide-react'
import { Accordion as AccordionPrimitive, Collapsible as CollapsiblePrimitive } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * "Details" that open in place: the plain-words summary first, the technical detail one click away
 * (D-words). The chevron turns and the content's height animates.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  open,
  onOpenChange,
  className,
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}) {
  return (
    <CollapsiblePrimitive.Root
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className={className}
    >
      <CollapsiblePrimitive.Trigger className="group -mx-1 inline-flex items-center gap-1 rounded-xs px-1 text-md font-medium text-fg-muted hover:text-fg">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform duration-(--v-duration-base) ease-standard group-data-[state=open]:rotate-90"
        />
        {summary}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="overflow-hidden data-[state=closed]:animate-collapse-close data-[state=open]:animate-collapse-open">
        <div className="pt-2">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  )
}

export const Accordion = AccordionPrimitive.Root

export function AccordionItem({
  value,
  title,
  meta,
  children,
  className,
}: {
  value: string
  title: ReactNode
  meta?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <AccordionPrimitive.Item
      value={value}
      className={cn('border-b border-line-subtle last:border-b-0', className)}
    >
      <AccordionPrimitive.Header className="m-0">
        <AccordionPrimitive.Trigger className="group flex w-full items-center gap-2 px-1 py-2.5 text-left text-md font-medium text-fg hover:bg-hover">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-(--v-duration-base) ease-standard group-data-[state=open]:rotate-90"
          />
          <span className="flex-1">{title}</span>
          {meta}
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-collapse-close data-[state=open]:animate-collapse-open">
        <div className="pb-3 pl-6">{children}</div>
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  )
}
