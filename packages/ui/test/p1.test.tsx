import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Button,
  CheckboxOption,
  CheckedAt,
  CopyButton,
  DeadlineChip,
  OutcomeBadge,
  RadioGroup,
  RadioOption,
  RetryPopover,
  SplitView,
  Stepper,
  Toaster,
  TooltipProvider,
  toast,
  Value,
} from '../src'

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

afterEach(() => {
  delete document.documentElement.dataset['platform']
})

describe('P1 components', () => {
  it('a stepper shows a blocked step in words and wraps hints', () => {
    wrap(
      <Stepper
        steps={[
          { id: 'a', label: 'Approve', state: 'done' },
          { id: 'b', label: 'Login', state: 'blocked', hint: '1Password is locked' },
          { id: 'c', label: 'Store', state: 'upcoming' },
        ]}
      />,
    )
    expect(screen.getByText('(waiting on you)')).toBeTruthy()
    expect(screen.getByText('1Password is locked').className).toContain('text-warning-fg')
  })

  it('a text copy button and the retry popover', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    wrap(
      <>
        <CopyButton value="{}">Copy as JSON</CopyButton>
        <RetryPopover
          trigger={<Button>Ask Claude to try again…</Button>}
          sentence="Please try the order again."
          note="It starts from the top."
        />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Copy as JSON' }))
    expect(await screen.findByText('Copied')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Ask Claude to try again…' }))
    expect(screen.getByText('Please try the order again.').className).toContain('selectable')
    await userEvent.click(screen.getByRole('button', { name: 'Copy sentence' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Please try the order again.')
  })

  it('checkbox options carry hint, badge and a reason when disabled', async () => {
    const onChange = vi.fn()
    wrap(
      <>
        <CheckboxOption
          label="add_to_cart"
          description="Adds items"
          meta={<span>New</span>}
          onCheckedChange={onChange}
        />
        <CheckboxOption label="search" disabled disabledReason="Needed for every order" defaultChecked />
        <RadioGroup aria-label="Store">
          <RadioOption value="a" label="Bondi" meta={<span>Matches</span>} />
        </RadioGroup>
      </>,
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'add_to_cart' }))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole('checkbox', { name: 'search' }).getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('Needed for every order')).toBeTruthy()
    expect(screen.getByText('Matches')).toBeTruthy()
  })

  it('outcome badges use the shared words', () => {
    wrap(
      <>
        <OutcomeBadge kind="ok-blocked" count={2} />
        <OutcomeBadge kind="limited" />
        <OutcomeBadge kind="failed" reason="Signed out" />
      </>,
    )
    expect(screen.getByText('Done · 2 blocked')).toBeTruthy()
    expect(screen.getByText('Limited by site').className).toContain('bg-warning-soft')
    expect(screen.getByText('Signed out')).toBeTruthy()
  })

  it('checked-at checks now, and says checking while pending', async () => {
    const onCheck = vi.fn()
    const at = new Date(2026, 10, 11, 21, 46).getTime()
    const { rerender } = wrap(<CheckedAt at={at} subject="Woolworths" onCheck={onCheck} locale="en-AU" />)
    expect(screen.getByText(/checked 9:46/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Check Woolworths now' }))
    expect(onCheck).toHaveBeenCalled()
    rerender(
      <TooltipProvider>
        <CheckedAt at={at} subject="Woolworths" onCheck={onCheck} pending />
      </TooltipProvider>,
    )
    expect(screen.getByText('checking…')).toBeTruthy()
  })

  it('deadline chips can be large, clock-only, and urgent earlier', () => {
    const now = 1_000_000
    const { container } = wrap(
      <>
        <DeadlineChip until={now + 50_000} now={now} urgentAt={60_000} size="lg" />
        <DeadlineChip until={now + 600_000} now={now} format="clock" />
        <DeadlineChip until={now - 1} now={now} format="clock" />
      </>,
    )
    const chips = container.querySelectorAll('.tabular')
    expect(chips[0]?.className).toContain('bg-danger-soft')
    expect(chips[0]?.className).toContain('h-7')
    expect(chips[1]?.textContent).toMatch(/^until /)
    expect(chips[2]?.textContent).toMatch(/Missed/)
  })

  it('values can wrap or be large', () => {
    wrap(
      <>
        <Value wrap>https://example.test/a/very/long/path</Value>
        <Value size="lg">Use Valet to add milk</Value>
      </>,
    )
    expect(screen.getByText('https://example.test/a/very/long/path').className).toContain('break-all')
    expect(screen.getByText('Use Valet to add milk').className).toContain('text-lg')
  })

  it('a split view without a list names its inspector and hands Escape back', () => {
    const onEscape = vi.fn()
    wrap(
      <SplitView
        detail={<p>trace</p>}
        inspector={<button type="button">step</button>}
        inspectorLabel="Step details"
        onInspectorEscape={onEscape}
      />,
    )
    const aside = screen.getByRole('complementary', { name: 'Step details' })
    fireEvent.keyDown(within(aside).getByRole('button'), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalled()
    fireEvent.keyDown(within(aside).getByRole('button'), { key: 'a' })
    expect(onEscape).toHaveBeenCalledOnce()
  })

  it('an undo toast runs its Undo from the button or from mod+Z', async () => {
    document.documentElement.dataset['platform'] = 'windows'
    const onUndo = vi.fn()
    wrap(
      <>
        <Toaster />
        <input aria-label="Field" />
      </>,
    )
    act(() => {
      toast.undo('Woolworths paused', { onUndo })
    })
    expect(await screen.findByText('Woolworths paused')).toBeTruthy()
    // Typing in a field keeps the field's own undo.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Field' }), { key: 'z', ctrlKey: true })
    expect(onUndo).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    expect(onUndo).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(onUndo).toHaveBeenCalledOnce()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(onUndo).toHaveBeenCalledOnce()
    const second = vi.fn()
    act(() => {
      toast.undo('Paused again', { onUndo: second })
    })
    const toastEl = (await screen.findByText('Paused again')).closest('[data-sonner-toast]') as HTMLElement
    await userEvent.click(within(toastEl).getByRole('button', { name: 'Undo' }))
    expect(second).toHaveBeenCalledOnce()
  })
})
