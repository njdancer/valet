import { X } from 'lucide-react'
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from 'radix-ui'
import { type ComponentProps, type ReactNode, useState } from 'react'
import { cn } from '../lib/cn'
import { Button } from './button'
import { IconButton } from './icon-button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

/**
 * Where focus lands on open: the first form field if there is one, otherwise the overlay itself
 * (so Tab starts at the top). Never an icon button, whose tooltip would open and eat the first Escape.
 */
function focusFirstField(e: Event, own?: (e: Event) => void) {
  own?.(e)
  if (e.defaultPrevented) return
  const content = e.target as HTMLElement
  const field = content.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role="combobox"]',
  )
  e.preventDefault()
  ;(field ?? content).focus({ preventScroll: true })
}

/**
 * Where focus goes on close: back to what had it when the overlay opened. Radix only does this for
 * its own Trigger, and most overlays here are opened from state (a button's onClick), so without
 * this focus fell to <body> and the next Tab started from the top of the window.
 */
function useReturnFocus(own?: (e: Event) => void) {
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  return (e: Event) => {
    own?.(e)
    if (e.defaultPrevented) return
    if (opener && opener !== document.body && opener.isConnected) {
      e.preventDefault()
      opener.focus({ preventScroll: true })
    }
  }
}

const overlay =
  'fixed inset-0 z-[var(--v-z-overlay)] bg-backdrop data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out'

/**
 * Three ways to put something over the window, and when to use each:
 * - DialogContent (centred): a short, self-contained task or question.
 * - SheetContent (drops from the top edge): a task that belongs to the page below it and returns to
 *   it, such as granting a credential. Full window width up to 560 px; its footer is always in view.
 * - DrawerContent (from the right): detail for an item in a list, while the list stays visible.
 * All three trap focus, close on Escape, return focus to what opened them, and make the rest inert.
 */
export function DialogContent({
  className,
  children,
  title,
  description,
  footer,
  hideClose = false,
  size = 'md',
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  hideClose?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <ReturningContent
        className={cn(
          'fixed top-1/2 left-1/2 z-[var(--v-z-modal)] flex max-h-[calc(100vh-48px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col',
          'rounded-xl bg-raised text-fg shadow-4 ring-[0.5px] ring-line ring-inset outline-hidden',
          'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          size === 'sm' && 'max-w-[400px]',
          size === 'md' && 'max-w-[520px]',
          size === 'lg' && 'max-w-[720px]',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
        tabIndex={-1}
        onOpenAutoFocus={(e) => focusFirstField(e, props.onOpenAutoFocus)}
      >
        <OverlayHeader title={title} description={description} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer ? <OverlayFooter>{footer}</OverlayFooter> : null}
        {hideClose ? null : <OverlayClose />}
      </ReturningContent>
    </DialogPrimitive.Portal>
  )
}

function OverlayHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-1 px-5 pt-5 pb-3 pr-12">
      <DialogPrimitive.Title className="m-0 text-lg font-semibold tracking-snug text-fg">
        {title}
      </DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description className="m-0 text-md text-fg-muted text-pretty">
          {description}
        </DialogPrimitive.Description>
      ) : null}
    </div>
  )
}

/**
 * The close button sits last in the DOM (so focus starts on the first field, not on Close, and its
 * tooltip doesn't open on arrival) but shows in the top corner.
 */
function OverlayClose() {
  return (
    <DialogPrimitive.Close asChild>
      <IconButton
        label="Close"
        icon={<X />}
        variant="quiet"
        size="sm"
        className="absolute top-4 right-4"
        shortcut="Esc"
      />
    </DialogPrimitive.Close>
  )
}

function OverlayFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 rounded-b-[inherit] border-t border-line-subtle bg-canvas/60 px-5 py-3">
      {children}
    </div>
  )
}

export function SheetContent({
  className,
  children,
  title,
  description,
  footer,
  wide = false,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  /** 720 px instead of 560, for a sheet with a table or two columns. */
  wide?: boolean
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <ReturningContent
        className={cn(
          'fixed top-(--titlebar-height) left-1/2 z-[var(--v-z-modal)] flex max-h-[calc(100vh-24px-var(--titlebar-height))] -translate-x-1/2 flex-col',
          wide ? 'w-[min(720px,calc(100vw-32px))]' : 'w-[min(560px,calc(100vw-32px))]',
          'rounded-b-xl bg-raised text-fg shadow-4 ring-[0.5px] ring-line ring-inset outline-hidden',
          'data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
        tabIndex={-1}
        onOpenAutoFocus={(e) => focusFirstField(e, props.onOpenAutoFocus)}
      >
        <OverlayHeader title={title} description={description} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer ? <OverlayFooter>{footer}</OverlayFooter> : null}
        <OverlayClose />
      </ReturningContent>
    </DialogPrimitive.Portal>
  )
}

export function DrawerContent({
  className,
  children,
  title,
  description,
  footer,
  width = 440,
  overlay: dim = true,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  width?: number
  /**
   * Dim the list behind. Leave it on for a modal drawer. For a drawer you keep open while working
   * the list (an inspector), use <Dialog modal={false}> with overlay={false}.
   */
  overlay?: boolean
}) {
  return (
    <DialogPrimitive.Portal>
      {dim ? <DialogPrimitive.Overlay className={cn(overlay, 'bg-backdrop/50')} /> : null}
      <ReturningContent
        style={{ width: `min(${width}px, calc(100vw - 48px))` }}
        className={cn(
          'fixed top-(--titlebar-height) right-0 bottom-0 z-[var(--v-z-modal)] flex flex-col',
          'border-l border-line bg-raised text-fg shadow-4 outline-hidden',
          'data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
        tabIndex={-1}
        onOpenAutoFocus={(e) => focusFirstField(e, props.onOpenAutoFocus)}
      >
        <OverlayHeader title={title} description={description} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer ? <OverlayFooter>{footer}</OverlayFooter> : null}
        <OverlayClose />
      </ReturningContent>
    </DialogPrimitive.Portal>
  )
}

/**
 * A question that needs an answer before anything else: "Revoke this client?". Focus starts on the
 * safe choice (Cancel), not the destructive one. Doesn't close on an outside click.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  trigger,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  confirmLabel: ReactNode
  cancelLabel?: ReactNode
  destructive?: boolean
  onConfirm: () => void
  trigger?: ReactNode
  children?: ReactNode
}) {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertPrimitive.Trigger asChild>{trigger}</AlertPrimitive.Trigger> : null}
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlay} />
        <ConfirmContent
          className={cn(
            'fixed top-1/2 left-1/2 z-[var(--v-z-modal)] flex w-[min(420px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-5',
            'rounded-xl bg-raised text-fg shadow-4 ring-[0.5px] ring-line ring-inset outline-hidden',
            'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          )}
        >
          <div className="flex flex-col gap-1.5">
            <AlertPrimitive.Title className="m-0 text-lg font-semibold tracking-snug">
              {title}
            </AlertPrimitive.Title>
            <AlertPrimitive.Description className="m-0 text-md text-fg-muted text-pretty">
              {description}
            </AlertPrimitive.Description>
          </div>
          {children}
          <div className="flex justify-end gap-2">
            <AlertPrimitive.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </AlertPrimitive.Cancel>
            <AlertPrimitive.Action asChild>
              <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertPrimitive.Action>
          </div>
        </ConfirmContent>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  )
}

/** Content mounts only while open (inside the Portal), so it notes what had focus just before. */
function ReturningContent(props: ComponentProps<typeof DialogPrimitive.Content>) {
  const returnFocus = useReturnFocus(props.onCloseAutoFocus)
  return <DialogPrimitive.Content {...props} onCloseAutoFocus={returnFocus} />
}

/** Mounted only while open, so it can note what had focus just before (see useReturnFocus). */
function ConfirmContent(props: ComponentProps<typeof AlertPrimitive.Content>) {
  const returnFocus = useReturnFocus(props.onCloseAutoFocus)
  return <AlertPrimitive.Content {...props} onCloseAutoFocus={returnFocus} />
}
