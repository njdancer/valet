import { Label as LabelPrimitive } from 'radix-ui'
import { type ComponentProps, createContext, type ReactNode, useContext, useId } from 'react'
import { cn } from '../lib/cn'

type FieldIds = {
  control: string
  description: string
  error: string
  hasDescription: boolean
  hasError: boolean
}
const FieldContext = createContext<FieldIds | null>(null)

/** The ids a control inside a Field should wire up. Controls in this library read it themselves. */
export function useField(): FieldIds | null {
  return useContext(FieldContext)
}

/** aria props for a control inside a Field. */
export function useFieldControlProps(id?: string) {
  const field = useField()
  if (field === null) return { id }
  const describedBy = [field.hasDescription ? field.description : null, field.hasError ? field.error : null]
    .filter(Boolean)
    .join(' ')
  return {
    id: id ?? field.control,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': field.hasError || undefined,
  }
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-md font-medium text-fg peer-disabled:opacity-50', className)}
      {...props}
    />
  )
}

/**
 * A labelled control with an optional hint and error. The label, hint and error are wired to the
 * control (for, aria-describedby, aria-invalid) so a screen reader reads them together.
 * `inline` puts the control beside the label (switches, checkboxes in a settings list).
 */
export function Field({
  label,
  description,
  error,
  children,
  inline = false,
  optional = false,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  children: ReactNode
  inline?: boolean
  optional?: boolean
  className?: string
}) {
  const base = useId()
  const ids: FieldIds = {
    control: `${base}-control`,
    description: `${base}-description`,
    error: `${base}-error`,
    hasDescription: description !== undefined && description !== null,
    hasError: error !== undefined && error !== null && error !== false,
  }
  const labelEl = (
    <Label htmlFor={ids.control}>
      {label}
      {optional ? <span className="ml-1 font-regular text-fg-subtle">(optional)</span> : null}
    </Label>
  )
  const hint = ids.hasDescription ? (
    <p id={ids.description} className="m-0 text-sm text-fg-muted text-pretty">
      {description}
    </p>
  ) : null
  const err = ids.hasError ? (
    <p id={ids.error} role="alert" className="m-0 animate-rise-in text-sm font-medium text-danger-fg">
      {error}
    </p>
  ) : null
  return (
    <FieldContext.Provider value={ids}>
      {inline ? (
        <div className={cn('flex min-w-0 items-start gap-4', className)}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {labelEl}
            {hint}
            {err}
          </div>
          <div className="flex shrink-0 items-center pt-0.5">{children}</div>
        </div>
      ) : (
        <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
          {labelEl}
          {children}
          {hint}
          {err}
        </div>
      )}
    </FieldContext.Provider>
  )
}
