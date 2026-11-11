import { ToggleGroup } from 'radix-ui'
import { type ReactNode, useRef } from 'react'
import { cn } from '../lib/cn'
import { useIndicator } from '../lib/use-indicator'

/**
 * A segmented control: one of a few views or filters. The selection is a pill that glides between
 * segments. Arrow keys move between segments (roving focus); it can't be emptied.
 */
export function Segmented<T extends string>({
  options,
  value,
  onValueChange,
  label,
  size = 'md',
  fullWidth = false,
  className,
}: {
  options: readonly { value: T; label: ReactNode; icon?: ReactNode }[]
  value: T
  onValueChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
  /** Stretch to the container, segments sharing the width equally (in a narrow panel or sheet). */
  fullWidth?: boolean
  className?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const pill = useIndicator(root, '[data-state="on"]')
  return (
    <ToggleGroup.Root
      ref={root}
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as T)
      }}
      className={cn(
        'relative items-center rounded-sm bg-inset p-0.5',
        fullWidth ? 'flex w-full' : 'inline-flex shrink-0',
        size === 'md' ? 'h-7' : 'h-6',
        className,
      )}
    >
      {pill ? (
        <span
          aria-hidden="true"
          data-travel=""
          className="absolute top-0.5 bottom-0.5 rounded-xs bg-raised shadow-1 transition-[left,width] duration-(--v-duration-slow) ease-spring"
          style={{ left: pill.left, width: pill.width }}
        />
      ) : null}
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            fullWidth && 'flex-1 justify-center',
            'relative z-[1] inline-flex h-full items-center gap-1.5 rounded-xs px-2.5 font-medium text-fg-muted transition-interactive',
            'hover:text-fg data-[state=on]:text-fg [&_svg]:size-3.5',
            size === 'md' ? 'text-md' : 'text-sm',
          )}
        >
          {o.icon}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
