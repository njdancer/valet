import type { ComponentProps } from 'react'
import { type ExternalToast, Toaster as Sonner, toast as sonnerToast } from 'sonner'

/**
 * Toasts: a short confirmation of something that just happened ("Copied", "Woolworths paused"), with
 * an Undo where the action can be undone. Never the only place an error or a request for the
 * person appears; those get a Banner on the page or a notification. Put <Toaster /> once in the app.
 */
export function Toaster(props: ComponentProps<typeof Sonner>) {
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
  },
)
