import { Search, X } from 'lucide-react'
import { type ComponentProps, forwardRef, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { useFieldControlProps } from './field'

export const controlSurface = cn(
  'rounded-sm bg-raised text-fg shadow-[inset_0_0_0_0.5px_var(--border-control),inset_0_1px_1px_oklch(0_0_0/0.04)] transition-interactive',
  'hover:shadow-[inset_0_0_0_0.5px_var(--border-strong),inset_0_1px_1px_oklch(0_0_0/0.04)]',
  'focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-line-focus',
  'has-[[aria-invalid=true]]:shadow-[inset_0_0_0_1px_var(--danger-solid)]',
  'has-disabled:opacity-50',
)

export type InputProps = Omit<ComponentProps<'input'>, 'size'> & {
  leading?: ReactNode
  trailing?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

/** A text input. Inside a Field it is labelled and described automatically. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, size = 'md', id, ...props },
  ref,
) {
  const field = useFieldControlProps(id)
  return (
    <div
      className={cn(
        controlSurface,
        'flex min-w-0 items-center gap-1.5 px-2 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-subtle',
        size === 'sm' && 'h-6 text-sm',
        size === 'md' && 'h-7 text-md',
        size === 'lg' && 'h-9 px-3 text-lg',
        className,
      )}
    >
      {leading}
      <input
        ref={ref}
        {...field}
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-subtle focus-visible:outline-none"
        {...props}
      />
      {trailing}
    </div>
  )
})

/** A search box: magnifier, clear button, Escape clears. */
export const SearchInput = forwardRef<
  HTMLInputElement,
  Omit<InputProps, 'value' | 'onChange'> & { value: string; onValueChange: (value: string) => void }
>(function SearchInput({ value, onValueChange, placeholder = 'Search', ...props }, ref) {
  return (
    <Input
      ref={ref}
      type="search"
      role="searchbox"
      aria-label={props['aria-label'] ?? placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value !== '') {
          e.stopPropagation()
          onValueChange('')
        }
      }}
      leading={<Search aria-hidden="true" />}
      trailing={
        value !== '' ? (
          <button
            type="button"
            aria-label="Clear search"
            className="-mr-1 flex size-5 cursor-pointer items-center justify-center rounded-full text-fg-subtle hover:bg-hover hover:text-fg"
            onClick={() => onValueChange('')}
          >
            <X className="size-3" />
          </button>
        ) : null
      }
      className="[&_input::-webkit-search-cancel-button]:hidden"
      {...props}
    />
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(function Textarea(
  { className, id, ...props },
  ref,
) {
  const field = useFieldControlProps(id)
  return (
    <textarea
      ref={ref}
      {...field}
      className={cn(
        controlSurface,
        'field-sizing-content min-h-16 w-full resize-y px-2 py-1.5 text-md outline-none placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus',
        'aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger-solid)]',
        className,
      )}
      {...props}
    />
  )
})
