import { Check, Minus } from 'lucide-react'
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Switch as SwitchPrimitive,
} from 'radix-ui'
import { type ComponentProps, type ReactNode, useId } from 'react'
import { cn } from '../lib/cn'
import { useFieldControlProps } from './field'
import { Spinner } from './spinner'

const box =
  'peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-xs bg-raised text-fg-on-accent shadow-[inset_0_0_0_1px_var(--border-control)] transition-interactive press after:absolute after:-inset-1 after:content-[""] disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-accent-solid data-[state=checked]:shadow-none data-[state=indeterminate]:bg-accent-solid data-[state=indeterminate]:shadow-none aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger-solid)]'

export function Checkbox({ className, id, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  const field = useFieldControlProps(id)
  return (
    <CheckboxPrimitive.Root className={cn(box, className)} {...field} {...props}>
      <CheckboxPrimitive.Indicator className="flex animate-pop-in items-center justify-center">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/**
 * An on/off switch for a setting that applies at once. (A choice that waits for a Save button is a
 * checkbox.) The thumb travels on the spring curve.
 */
export function Switch({
  className,
  id,
  size = 'md',
  pending = false,
  onClick,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'sm' | 'md'
  /** The change is being applied: the thumb shows a spinner and clicks wait. */
  pending?: boolean
}) {
  const field = useFieldControlProps(id)
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-interactive',
        'bg-control-off data-[state=checked]:bg-accent-solid',
        size === 'sm' && 'after:absolute after:-inset-y-1 after:-inset-x-0.5 after:content-[""]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'md' ? 'h-5 w-8.5' : 'h-4 w-6.5',
        className,
      )}
      aria-busy={pending || undefined}
      onClick={pending ? (e) => e.preventDefault() : onClick}
      {...field}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        data-travel=""
        className={cn(
          'pointer-events-none flex items-center justify-center rounded-full bg-white text-accent-solid shadow-[0_1px_2px_oklch(0_0_0/0.25),0_0_0_0.5px_oklch(0_0_0/0.06)]',
          'transition-transform duration-(--v-duration-slow) ease-spring',
          size === 'md'
            ? 'size-4 data-[state=checked]:translate-x-3.5'
            : 'size-3 data-[state=checked]:translate-x-2.5',
        )}
      >
        {pending ? <Spinner size={size === 'md' ? 10 : 8} /> : null}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioPrimitive.Root>) {
  return <RadioPrimitive.Root className={cn('flex flex-col gap-2', className)} {...props} />
}

export function RadioItem({ className, ...props }: ComponentProps<typeof RadioPrimitive.Item>) {
  return (
    <RadioPrimitive.Item
      className={cn(
        'peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-raised shadow-[inset_0_0_0_1px_var(--border-control)] transition-interactive press after:absolute after:-inset-1 after:rounded-full after:content-[""]',
        'data-[state=checked]:bg-accent-solid data-[state=checked]:shadow-none disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-dot"
        className="block size-1.5 animate-pop-in rounded-full bg-white"
      />
    </RadioPrimitive.Item>
  )
}

/** A radio with its label and an optional hint. The label is the click target; the hint describes. */
export function RadioOption({
  value,
  label,
  description,
  meta,
  disabled,
}: {
  value: string
  label: ReactNode
  description?: ReactNode
  /** A badge after the label ("Can't be undone", "Matches"). */
  meta?: ReactNode
  disabled?: boolean
}) {
  const id = `${useId()}-radio`
  return (
    <div className="flex items-start gap-2">
      <RadioItem
        value={value}
        id={id}
        disabled={disabled}
        className="mt-0.5"
        aria-describedby={description ? `${id}-d` : undefined}
      />
      <div className="flex flex-col gap-0.5 peer-disabled:opacity-50">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="text-md text-fg peer-disabled:cursor-not-allowed">
            {label}
          </label>
          {meta}
        </span>
        {description ? (
          <span id={`${id}-d`} className="text-sm text-fg-muted">
            {description}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * A checkbox with its label, an optional hint and badge: a tool to allow, an acknowledgement, a
 * Lock down extra. The label is the click target; the hint describes it. Disabled explains why.
 */
export function CheckboxOption({
  label,
  description,
  meta,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  disabledReason,
  name,
  value,
}: {
  label: ReactNode
  description?: ReactNode
  meta?: ReactNode
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  /** Why it can't be changed ("Needed for every order"). Shown under the label. */
  disabledReason?: string
  name?: string
  value?: string
}) {
  const id = `${useId()}-check`
  const hint = [description ? `${id}-d` : '', disabled && disabledReason ? `${id}-r` : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(c) => onCheckedChange?.(c === true)}
        disabled={disabled}
        name={name}
        value={value}
        aria-describedby={hint || undefined}
      />
      <div className="flex min-w-0 flex-col gap-0.5 peer-disabled:opacity-60">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="text-md text-fg peer-disabled:cursor-not-allowed">
            {label}
          </label>
          {meta}
        </span>
        {description ? (
          <span id={`${id}-d`} className="text-sm text-fg-muted">
            {description}
          </span>
        ) : null}
        {disabled && disabledReason ? (
          <span id={`${id}-r`} className="text-sm text-fg-muted">
            {disabledReason}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * A radio choice as a card, for choices whose body holds more than a sentence (Add an app: each way
 * to connect has its own steps and code). Use inside a RadioGroup. The card's `children` show only
 * while it is `selected`, outside the radio's label, so buttons and code in them stay their own
 * controls.
 */
export function ChoiceCard({
  value,
  title,
  description,
  meta,
  selected = false,
  disabled,
  children,
  className,
}: {
  value: string
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  /** Whether the group's value is this card's. Shows `children`. */
  selected?: boolean
  disabled?: boolean
  children?: ReactNode
  className?: string
}) {
  const id = `${useId()}-choice`
  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        'flex flex-col gap-3 rounded-lg bg-surface p-3.5 shadow-1 ring-[0.5px] ring-line ring-inset transition-interactive',
        selected && 'bg-selected ring-1 ring-accent-solid',
        disabled && 'opacity-50',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <RadioItem
          value={value}
          id={id}
          disabled={disabled}
          className="mt-0.5"
          aria-describedby={description ? `${id}-d` : undefined}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label htmlFor={id} className="cursor-pointer text-md font-medium text-fg">
              {title}
            </label>
            {meta}
          </span>
          {description ? (
            <span id={`${id}-d`} className="text-sm text-fg-muted text-pretty">
              {description}
            </span>
          ) : null}
        </div>
      </div>
      {selected && children ? <div className="flex flex-col gap-2 pl-6.5">{children}</div> : null}
    </div>
  )
}
