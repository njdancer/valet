import { Check, Copy } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { Button } from './button'
import { IconButton } from './icon-button'

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Copies a value. Icon-only by default (its name is the label, shown as a tooltip); with `children`
 * it is a text button ("Copy as JSON", "Copy sentence"). The label never changes; "Copied" or
 * "Couldn't copy" is announced once through a live region, and the icon turns to a tick.
 */
export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  variant,
  children,
  className,
  onCopied,
}: {
  value: string
  label?: string
  size?: 'sm' | 'md'
  /** For a text button: secondary by default, primary when it is the point of a popover. */
  variant?: 'primary' | 'secondary' | 'quiet'
  /** Visible text. Without it the button is icon-only. */
  children?: ReactNode
  className?: string
  onCopied?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const onClick = async () => {
    const ok = await copyText(value)
    clearTimeout(timer.current)
    setMessage(ok ? 'Copied' : "Couldn't copy")
    if (ok) {
      setCopied(true)
      onCopied?.()
    }
    timer.current = setTimeout(() => {
      setCopied(false)
      setMessage('')
    }, 1400)
  }
  const icon = copied ? <Check className="animate-pop-in" /> : <Copy />
  return (
    <>
      {children ? (
        <Button
          size={size}
          variant={variant ?? 'secondary'}
          leading={icon}
          className={className}
          onClick={onClick}
        >
          {children}
        </Button>
      ) : (
        <IconButton
          size={size}
          variant={variant ?? 'quiet'}
          label={label}
          className={cn(copied && 'text-success-fg', className)}
          icon={icon}
          onClick={onClick}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {message}
      </span>
    </>
  )
}
