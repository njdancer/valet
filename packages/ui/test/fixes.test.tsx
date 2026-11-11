import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ariaShortcut,
  Badge,
  Banner,
  BrowserBar,
  Button,
  CheckItem,
  CheckList,
  CommandItem,
  CommandPalette,
  ConfirmationPanel,
  currentPlatform,
  DeadlineChip,
  Dialog,
  DialogContent,
  DrawerContent,
  formatShortcut,
  HandoffBanner,
  HealthLine,
  HoldToConfirm,
  IconButton,
  InboxItem,
  PageHeader,
  Segmented,
  SheetContent,
  Shortcut,
  Toaster,
  TooltipProvider,
  toast,
  Value,
} from '../src'

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

afterEach(() => {
  delete document.documentElement.dataset['platform']
})

describe('Shortcuts per platform', () => {
  it('formats neutral shortcuts the way each OS writes them', () => {
    expect(formatShortcut('mod+K', 'mac')).toBe('⌘K')
    expect(formatShortcut('mod+shift+p', 'mac')).toBe('⇧⌘P')
    expect(formatShortcut('alt+enter', 'mac')).toBe('⌥↩')
    expect(formatShortcut('mod+K', 'windows')).toBe('Ctrl+K')
    expect(formatShortcut('mod+shift+p', 'linux')).toBe('Ctrl+Shift+P')
    expect(formatShortcut('alt+esc', 'windows')).toBe('Alt+Esc')
    expect(formatShortcut('mod+[', 'mac')).toBe('⌘[')
    // Already formatted, or a single key, passes through.
    expect(formatShortcut('⌘K', 'windows')).toBe('⌘K')
    expect(formatShortcut('Esc', 'mac')).toBe('Esc')
  })

  it('gives aria-keyshortcuts values', () => {
    expect(ariaShortcut('mod+K', 'mac')).toBe('Meta+K')
    expect(ariaShortcut('mod+shift+K', 'windows')).toBe('Control+Shift+K')
    expect(ariaShortcut('alt+up', 'linux')).toBe('Alt+ArrowUp')
    expect(ariaShortcut('⌘K', 'mac')).toBeUndefined()
  })

  it('reads the platform from the page', () => {
    expect(currentPlatform()).toBe('other')
    document.documentElement.dataset['platform'] = 'mac'
    expect(currentPlatform()).toBe('mac')
    render(<Shortcut keys="mod+K" />)
    expect(screen.getByText('⌘K').tagName).toBe('KBD')
  })

  it('an icon button exposes its shortcut to assistive tech', () => {
    document.documentElement.dataset['platform'] = 'windows'
    wrap(<IconButton label="Search" icon={<span />} shortcut="mod+K" />)
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-keyshortcuts')).toBe('Control+K')
  })
})

describe('HoldToConfirm for everyone', () => {
  it('a screen reader click opens a confirm dialog instead of needing a hold', async () => {
    const onConfirm = vi.fn()
    wrap(<HoldToConfirm onConfirm={onConfirm}>Erase all data</HoldToConfirm>)
    // Assistive tech activates with a click that has no pointer or key behind it (detail 0).
    fireEvent.click(screen.getByRole('button', { name: 'Erase all data' }), { detail: 0 })
    const dialog = screen.getByRole('alertdialog', { name: 'Erase all data' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Erase all data' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.getByText('Confirmed')).toBeTruthy()
  })

  it('confirms again after a second hold, and a pointer click does not open the dialog', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance', 'setTimeout'] })
    const onConfirm = vi.fn()
    wrap(
      <HoldToConfirm onConfirm={onConfirm} holdMs={500}>
        Place order
      </HoldToConfirm>,
    )
    const button = screen.getByRole('button', { name: 'Place order' })
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(button, { pointerId: 1 })
      act(() => vi.advanceTimersByTime(700))
      fireEvent.pointerUp(button)
      fireEvent.click(button, { detail: 1 })
    }
    expect(onConfirm).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    act(() => vi.advanceTimersByTime(2000))
    vi.useRealTimers()
  })

  it('disabled with a reason stays focusable and explains itself', () => {
    const onConfirm = vi.fn()
    wrap(
      <HoldToConfirm onConfirm={onConfirm} disabled disabledReason="Sign in first">
        Place order
      </HoldToConfirm>,
    )
    const button = screen.getByRole('button', { name: 'Place order' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-description')).toBe('Sign in first')
    fireEvent.click(button, { detail: 0 })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Start</Button>
      <CommandPalette open={open} onOpenChange={setOpen}>
        <CommandItem shortcut="mod+1">Sites</CommandItem>
        <CommandItem>Settings</CommandItem>
      </CommandPalette>
    </>
  )
}

describe('Command palette', () => {
  it('is named, announces results and returns focus where it was', async () => {
    document.documentElement.dataset['platform'] = 'mac'
    wrap(<Harness />)
    const start = screen.getByRole('button', { name: 'Start' })
    start.focus()
    await userEvent.keyboard('{Enter}')
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    expect(within(dialog).getByText('⌘1')).toBeTruthy()
    await userEvent.type(within(dialog).getByRole('combobox'), 'set')
    expect(within(dialog).getByText(/^\d+ results?$/)).toBeTruthy()
    await userEvent.type(within(dialog).getByRole('combobox'), 'zzz')
    expect(within(dialog).getByText('No results')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(document.activeElement).toBe(start)
  })
})

describe('Overlays', () => {
  it('focus lands on the first field, or on the overlay when there is none', () => {
    const { unmount } = wrap(
      <Dialog defaultOpen>
        <SheetContent title="Grant login">
          <input aria-label="Name" />
        </SheetContent>
      </Dialog>,
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }))
    unmount()
    wrap(
      <Dialog defaultOpen>
        <DialogContent title="About">Text only</DialogContent>
      </Dialog>,
    )
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'About' }))
  })

  it('an inspector drawer can leave the list undimmed', () => {
    wrap(
      <Dialog defaultOpen modal={false}>
        <DrawerContent title="Call" overlay={false}>
          Body
        </DrawerContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Call' })).toBeTruthy()
    expect(document.querySelector('[data-state="open"].fixed.inset-0')).toBeNull()
  })
})

describe('Text and status', () => {
  it('middle truncation keeps the whole value and its end', () => {
    wrap(<Value truncate="middle">/Users/tess/Library/Valet/adapters/woolworths.ts</Value>)
    const full = '/Users/tess/Library/Valet/adapters/woolworths.ts'
    const tail = screen.getByText('oolworths.ts')
    const value = tail.parentElement as HTMLElement
    expect(value.textContent).toBe(full)
    expect(value.getAttribute('title')).toBe(full)
    expect(tail.previousElementSibling?.className).toContain('truncate')
  })

  it('short values are not cut in the middle', () => {
    wrap(<Value truncate="middle">abc</Value>)
    expect(screen.getByText('abc').className).not.toContain('flex')
  })

  it('a deadline announcement says what it is for', () => {
    const now = 1_000_000
    wrap(<DeadlineChip until={now + 50_000} now={now} subject="Woolworths code" />)
    expect(screen.getByText('Woolworths code: 1 min left')).toBeTruthy()
  })

  it('a missed or urgent inbox item says so in words', () => {
    wrap(
      <ul>
        <InboxItem title="Code" action={<Button>Enter</Button>} missed />
        <InboxItem title="Confirm" action={<Button>Confirm</Button>} tone="danger" href="#/x" appear />
      </ul>,
    )
    expect(screen.getByText('(missed)')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Confirm.*\(urgent\)/ })).toBeTruthy()
  })

  it('segmented can fill its container', () => {
    wrap(
      <Segmented
        label="View"
        fullWidth
        value="a"
        onValueChange={() => {}}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'View' }).className).toContain('w-full')
  })

  it('a toast with an action stays long enough to reach, and has a close button', async () => {
    wrap(<Toaster />)
    act(() => {
      toast('Paused', { action: { label: 'Undo', onClick: () => {} } })
      toast.error('Failed')
      toast.warning('Careful')
      toast.info('Note')
      toast.message('Hello')
    })
    expect(await screen.findByText('Paused')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThan(0)
  })
})

describe('Order-path components', () => {
  it('a confirmation is named by its title and its Allow follows the purpose', async () => {
    const onDecline = vi.fn()
    const onAllow = vi.fn()
    const now = 1_000_000
    wrap(
      <ConfirmationPanel
        site={<span />}
        title="Remove 2 items from your trolley?"
        sentence="Valet will remove oat milk and bread."
        purpose="write"
        allowLabel="Remove"
        state="ready"
        queue={{ position: 1, total: 4 }}
        until={now + 20_000}
        now={now}
        onAllow={onAllow}
        onDecline={onDecline}
      />,
    )
    const region = screen.getByRole('region', { name: 'Remove 2 items from your trolley?' })
    expect(within(region).getByText('1 of 4 waiting')).toBeTruthy()
    expect(within(region).getByText('Changes your account')).toBeTruthy()
    expect(within(region).queryByText('Can’t be undone')).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('bg-accent-solid')
    expect(region.querySelector('[data-slot="urgent-strip"]')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(onDecline).toHaveBeenCalledOnce()
  })

  it('shows the arming reason in words, and answered and missed states close', async () => {
    const onClose = vi.fn()
    const base = {
      site: <span />,
      sentence: 'Place the order?',
      allowLabel: 'Place order',
      onAllow: () => {},
      onDecline: () => {},
      onClose,
    }
    const { rerender } = wrap(<ConfirmationPanel {...base} state="arming" armingReason="Available in 2 s" />)
    expect(screen.getByText('Available in 2 s')).toBeTruthy()
    rerender(
      <TooltipProvider>
        <ConfirmationPanel
          {...base}
          state="answered"
          result="Order placed. Claude was told."
          next={<Button>Next: 2 of 4</Button>}
        />
      </TooltipProvider>,
    )
    expect(screen.getByRole('status').textContent).toContain('Order placed')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    rerender(
      <TooltipProvider>
        <ConfirmationPanel
          {...base}
          state="expired"
          missedActions={<Button>Ask Claude to try again</Button>}
        />
      </TooltipProvider>,
    )
    expect(screen.getByRole('button', { name: 'Ask Claude to try again' })).toBeTruthy()
  })

  it('a check list says each outcome in words', () => {
    wrap(
      <CheckList label="What Valet checked" live>
        <CheckItem state="pass" title="The adapter is the approved version" />
        <CheckItem
          state="fail"
          title="1Password"
          detail="1Password is locked."
          action={<Button>Open 1Password</Button>}
        />
        <CheckItem state="pending" title="Store" />
        <CheckItem state="info" title="Prices can change" />
        <CheckItem state="skipped" title="Delivery window" />
      </CheckList>,
    )
    const list = screen.getByRole('list', { name: 'What Valet checked' })
    expect(list.getAttribute('aria-live')).toBe('polite')
    for (const w of ['Passed:', 'Failed:', 'Checking:', 'Note:', 'Skipped:'])
      expect(within(list).getByText(w, { exact: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open 1Password' })).toBeTruthy()
  })

  it('the hand-off strip starts on I’m done and moves through its states', async () => {
    const onDone = vi.fn()
    const onCancel = vi.fn()
    const onClose = vi.fn()
    document.documentElement.dataset['platform'] = 'mac'
    const props = { site: 'Woolworths', onDone, onCancel, onClose }
    const { rerender } = wrap(<HandoffBanner {...props} state="waiting" until={Date.now() + 120_000} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'I’m done' }))
    expect(
      screen.getByRole('region', { name: 'Sign in to Woolworths' }).getAttribute('aria-keyshortcuts'),
    ).toBe('Meta+Shift+B')
    await userEvent.keyboard('{Enter}')
    expect(onDone).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(onCancel).toHaveBeenCalled()
    for (const state of ['checking', 'not-yet'] as const) {
      rerender(
        <TooltipProvider>
          <HandoffBanner {...props} state={state} />
        </TooltipProvider>,
      )
    }
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
    for (const state of ['success', 'expired'] as const) {
      rerender(
        <TooltipProvider>
          <HandoffBanner {...props} state={state} />
        </TooltipProvider>,
      )
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    }
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('the browser bar puts the host first and flags an insecure page', () => {
    const { rerender } = wrap(
      <BrowserBar
        url="https://auth.woolworths.com.au/login?x=1"
        typedInto="auth.woolworths.com.au"
        canGoBack
        onBack={() => {}}
      />,
    )
    expect(screen.getByText('auth.woolworths.com.au').className).toContain('font-semibold')
    expect(screen.getByRole('img', { name: 'Secure connection' })).toBeTruthy()
    rerender(
      <TooltipProvider>
        <BrowserBar url="http://example.test/" loading />
      </TooltipProvider>,
    )
    expect(screen.getByRole('img', { name: 'Not secure' })).toBeTruthy()
    rerender(
      <TooltipProvider>
        <BrowserBar url="not a url" />
      </TooltipProvider>,
    )
    expect(screen.getByText('not a url')).toBeTruthy()
  })

  it('a page header carries status beside the title, outside the heading', () => {
    wrap(<PageHeader title="Woolworths" status={<Badge tone="warning">Paused</Badge>} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Woolworths')
    expect(screen.getByText('Paused')).toBeTruthy()
  })

  it('a neutral banner and a wrapping health line', () => {
    wrap(
      <>
        <Banner tone="neutral" title="Showing 4 of 21 calls" />
        <HealthLine tone="danger" action={<Button>Open 1Password</Button>}>
          1Password is locked
        </HealthLine>
      </>,
    )
    expect(screen.getByText('Showing 4 of 21 calls')).toBeTruthy()
    expect(screen.getByText('1Password is locked').className).toContain('break-words')
  })
})
