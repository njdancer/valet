import { type ComponentProps, useEffect } from 'react'
import { type ExternalToast, Toaster as Sonner, toast as sonnerToast } from 'sonner'
import { currentPlatform } from '../lib/shortcut'

/**
 * Toasts: a short confirmation of something that just happened ("Copied", "Woolworths paused"), with
 * an Undo where the action can be undone. Never the only place an error or a request for the
 * person appears; those get a Banner on the page or a notification. Put <Toaster /> once in the app.
 */
export function Toaster(props: ComponentProps<typeof Sonner>) {
  // ⌘Z (Ctrl+Z elsewhere) runs the newest Undo while its toast shows, unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = currentPlatform() === 'mac' ? e.metaKey : e.ctrlKey
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const last = undoStack.at(-1)
      if (!last) return
      e.preventDefault()
      runUndo(last.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <Sonner
      position="bottom-right"
      gap={8}
      offset={16}
      visibleToasts={3}
      closeButton
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'material-floating flex w-[340px] items-start gap-2.5 rounded-lg px-3.5 py-3 text-md text-fg [&_[data-icon]]:mt-0.5 [&_[data-icon]_svg]:size-4',
          title: 'font-medium',
          description: 'text-sm text-fg-muted',
          actionButton:
            'ml-auto shrink-0 rounded-xs bg-accent-soft px-2 h-6 text-sm font-medium text-accent-fg hover:bg-selected',
          cancelButton: 'shrink-0 rounded-xs px-2 h-6 text-sm text-fg-muted hover:bg-hover',
          closeButton:
            'order-last -mr-1 flex size-6 shrink-0 items-center justify-center rounded-xs text-fg-muted hover:bg-hover hover:text-fg [&_svg]:size-3.5',
          success: '[&_[data-icon]]:text-success-solid',
          error: '[&_[data-icon]]:text-danger-solid',
          warning: '[&_[data-icon]]:text-warning-solid',
          info: '[&_[data-icon]]:text-info-solid',
        },
      }}
      {...props}
    />
  )
}

/** A toast with an action (Undo) stays 10 s, long enough to reach by keyboard (Alt+T focuses toasts). */
const timed = (options?: ExternalToast): ExternalToast | undefined =>
  options?.action ? { duration: 10_000, ...options } : options

type Message = Parameters<typeof sonnerToast>[0]

export const toast = Object.assign(
  (message: Message, options?: ExternalToast) => sonnerToast(message, timed(options)),
  {
    ...sonnerToast,
    success: (message: Message, options?: ExternalToast) => sonnerToast.success(message, timed(options)),
    error: (message: Message, options?: ExternalToast) => sonnerToast.error(message, timed(options)),
    warning: (message: Message, options?: ExternalToast) => sonnerToast.warning(message, timed(options)),
    info: (message: Message, options?: ExternalToast) => sonnerToast.info(message, timed(options)),
    message: (message: Message, options?: ExternalToast) => sonnerToast.message(message, timed(options)),
    undo: (message: Message, options: ExternalToast & { onUndo: () => void }) => undoToast(message, options),
  },
)

type UndoEntry = { id: string | number; onUndo: () => void }
const undoStack: UndoEntry[] = []
const forget = (id: string | number) => {
  const i = undoStack.findIndex((u) => u.id === id)
  if (i >= 0) undoStack.splice(i, 1)
}
function runUndo(id: string | number) {
  const entry = undoStack.find((u) => u.id === id)
  if (!entry) return
  forget(id)
  sonnerToast.dismiss(id)
  entry.onUndo()
}

/**
 * A toast for something that can be put back: "Woolworths paused", with Undo. It stays 10 s (held
 * while hovered or focused), and ⌘Z / Ctrl+Z runs the Undo while it shows. Every Undo must also
 * exist on the page (Resume), so a missed toast never loses the way back.
 */
export function undoToast(message: Message, { onUndo, ...options }: ExternalToast & { onUndo: () => void }) {
  const id: string | number = sonnerToast.success(message, {
    duration: 10_000,
    ...options,
    action: { label: 'Undo', onClick: () => runUndo(id) },
    onDismiss: (t) => {
      forget(t.id)
      options.onDismiss?.(t)
    },
    onAutoClose: (t) => {
      forget(t.id)
      options.onAutoClose?.(t)
    },
  })
  undoStack.push({ id, onUndo })
  return id
}
