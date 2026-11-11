import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { IconButton } from './icon-button'

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Copies `value`. The icon turns into a tick for a moment, and the change is announced. */
export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  className,
  onCopied,
}: {
  value: string
  label?: string
  size?: 'sm' | 'md'
  className?: string
  onCopied?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      <IconButton
        size={size}
        variant="quiet"
        label={label}
        className={cn(copied && 'text-success-fg', className)}
        icon={copied ? <Check className="animate-pop-in" /> : <Copy />}
        onClick={async () => {
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
        }}
      />
      <span className="sr-only" aria-live="polite">
        {message}
      </span>
    </>
  )
}
