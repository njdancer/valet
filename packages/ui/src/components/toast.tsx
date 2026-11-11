import type { ComponentProps } from 'react'
import { Toaster as Sonner, toast } from 'sonner'

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
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'material-floating flex w-[340px] items-start gap-2.5 rounded-lg px-3.5 py-3 text-md text-fg [&_[data-icon]]:mt-0.5 [&_[data-icon]_svg]:size-4',
          title: 'font-medium',
          description: 'text-sm text-fg-muted',
          actionButton:
            'ml-auto shrink-0 cursor-pointer rounded-xs bg-accent-soft px-2 h-6 text-sm font-medium text-accent-fg hover:bg-selected',
          cancelButton: 'shrink-0 cursor-pointer rounded-xs px-2 h-6 text-sm text-fg-muted hover:bg-hover',
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

export { toast }
