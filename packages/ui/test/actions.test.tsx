import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pause } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import {
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Count,
  Field,
  HoldToConfirm,
  IconButton,
  Input,
  RadioGroup,
  RadioOption,
  RiskBadge,
  SearchInput,
  SecretBadge,
  Segmented,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Spinner,
  StatusDot,
  Switch,
  Textarea,
  TooltipProvider,
} from '../src'
import { cn } from '../src/lib/cn'
import { expectAccessible } from './axe'

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

describe('Button', () => {
  it('is a button by default, and clicks', async () => {
    const onClick = vi.fn()
    wrap(<Button onClick={onClick}>Save</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button')).toHaveProperty('type', 'button')
  })

  it('blocks clicks while loading, keeping its label for screen readers', async () => {
    const onClick = vi.fn()
    wrap(
      <Button loading onClick={onClick} leading={<Pause />}>
        Saving
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Saving' })
    expect(button.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(button.querySelector('[aria-hidden="true"].animate-spin')).not.toBeNull()
  })

  it('a disabled button with a reason stays focusable and explains itself', async () => {
    const onClick = vi.fn()
    wrap(
      <Button disabled disabledReason="Choose a store first" onClick={onClick}>
        Continue
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-description')).toBe('Choose a store first')
    await userEvent.tab()
    expect(document.activeElement).toBe(button)
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders its child with asChild, for links styled as buttons', () => {
    wrap(
      <Button asChild variant="primary">
        <a href="#/x">Open</a>
      </Button>,
    )
    const link = screen.getByRole('link', { name: 'Open' })
    expect(link.getAttribute('href')).toBe('#/x')
    expect(link.className).toContain('bg-accent-solid')
  })

  it('an icon button is named by its label and shows it as a tooltip', async () => {
    wrap(<IconButton label="Refresh" icon={<Pause />} shortcut="⌘R" />)
    const button = screen.getByRole('button', { name: 'Refresh' })
    await userEvent.tab()
    expect(document.activeElement).toBe(button)
    expect((await screen.findAllByText('Refresh')).length).toBeGreaterThan(0)
    await expectAccessible()
  })

  it('an icon button can leave the tooltip off', () => {
    wrap(<IconButton label="Close" icon={<Pause />} noTooltip size="sm" />)
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})

describe('HoldToConfirm', () => {
  it('confirms only after the hold, by keyboard', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const onConfirm = vi.fn()
    wrap(<HoldToConfirm onConfirm={onConfirm}>Erase</HoldToConfirm>)
    const button = screen.getByRole('button', { name: 'Erase' })
    expect(button.getAttribute('aria-description')).toMatch(/hold for 1.2 seconds/)
    fireEvent.keyDown(button, { key: ' ' })
    act(() => vi.advanceTimersByTime(600))
    fireEvent.keyUp(button, { key: ' ' })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'Enter' })
    act(() => vi.advanceTimersByTime(1300))
    expect(onConfirm).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('confirms after a pointer hold and cancels when let go early', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const onConfirm = vi.fn()
    wrap(
      <HoldToConfirm onConfirm={onConfirm} holdMs={1000} variant="primary">
        Order
      </HoldToConfirm>,
    )
    const button = screen.getByRole('button', { name: 'Order' })
    expect(button.getAttribute('aria-description')).toMatch(/1 seconds/)
    fireEvent.pointerDown(button, { pointerId: 1 })
    act(() => vi.advanceTimersByTime(400))
    fireEvent.pointerLeave(button)
    fireEvent.pointerDown(button, { pointerId: 1 })
    act(() => vi.advanceTimersByTime(1100))
    expect(onConfirm).toHaveBeenCalledOnce()
    fireEvent.blur(button)
    vi.useRealTimers()
  })

  it('does nothing when disabled', () => {
    const onConfirm = vi.fn()
    wrap(
      <HoldToConfirm onConfirm={onConfirm} disabled>
        Erase
      </HoldToConfirm>,
    )
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('Badges, dots and counts', () => {
  it('risk badges say their level in words, with a shape', () => {
    wrap(
      <>
        <RiskBadge purpose="read" />
        <RiskBadge purpose="write" />
        <RiskBadge purpose="irreversible" />
        <RiskBadge purpose="write">Adds items</RiskBadge>
        <SecretBadge name="Woolworths login" />
        <Badge tone="brass" variant="outline" size="sm">
          Built in
        </Badge>
      </>,
    )
    for (const words of [
      'Reads',
      'Changes',
      'Can’t be undone',
      'Adds items',
      'Woolworths login',
      'Built in',
    ]) {
      expect(screen.getByText(words)).toBeTruthy()
    }
  })

  it('a dot is an image with a label, or hidden without one', () => {
    const { container } = wrap(
      <>
        <StatusDot tone="success" label="Healthy" pulse />
        <StatusDot />
      </>,
    )
    expect(screen.getByRole('img', { name: 'Healthy' }).className).toContain('animate-pulse-ring')
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(1)
  })

  it('counts cap at max, hide at zero and can speak a label', () => {
    const { container } = wrap(
      <>
        <Count value={0} />
        <Count value={140} />
        <Count value={2} attention label="2 waiting for you" />
      </>,
    )
    expect(screen.getByText('99+')).toBeTruthy()
    expect(screen.getByText('2 waiting for you').className).toContain('sr-only')
    expect(container.textContent).not.toContain('0')
  })

  it('a spinner is a status only with a label', () => {
    wrap(
      <>
        <Spinner label="Loading" />
        <Spinner />
      </>,
    )
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy()
  })
})

describe('Fields and inputs', () => {
  it('wires label, hint and error to the control', async () => {
    wrap(
      <Field label="Store" description="Where you shop." error="Pick a store." optional>
        <Input />
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: /Store/ })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? []
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Where you shop.',
      'Pick a store.',
    ])
    expect(screen.getByRole('alert').textContent).toBe('Pick a store.')
    expect(screen.getByText('(optional)')).toBeTruthy()
    await expectAccessible()
  })

  it('an inline field puts the control beside the label', () => {
    wrap(
      <Field inline label="Start at login" description="Keeps Valet in the menu bar.">
        <Switch />
      </Field>,
    )
    expect(screen.getByRole('switch', { name: 'Start at login' })).toBeTruthy()
  })

  it('an input outside a field keeps its own id and sizes', () => {
    wrap(
      <>
        <Input id="own" aria-label="Small" size="sm" />
        <Input aria-label="Large" size="lg" />
        <Textarea aria-label="Note" />
      </>,
    )
    expect(screen.getByRole('textbox', { name: 'Small' }).id).toBe('own')
    expect(screen.getByRole('textbox', { name: 'Note' })).toBeTruthy()
  })

  it('a textarea in a field is labelled', () => {
    wrap(
      <Field label="Why">
        <Textarea />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Why' })).toBeTruthy()
  })

  it('search clears with the button and with Escape', async () => {
    const onValueChange = vi.fn()
    const { rerender } = wrap(<SearchInput value="" onValueChange={onValueChange} />)
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'a')
    expect(onValueChange).toHaveBeenLastCalledWith('a')
    rerender(
      <TooltipProvider>
        <SearchInput value="milk" onValueChange={onValueChange} />
      </TooltipProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onValueChange).toHaveBeenLastCalledWith('')
    onValueChange.mockClear()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onValueChange).toHaveBeenLastCalledWith('')
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'a' })
  })
})

describe('Choices', () => {
  it('checkbox, switch and radio toggle by click and keyboard', async () => {
    const onSwitch = vi.fn()
    wrap(
      <>
        <Checkbox aria-label="Allow" />
        <Checkbox aria-label="Some" checked="indeterminate" />
        <Switch aria-label="Notify" onCheckedChange={onSwitch} size="sm" />
        <RadioGroup aria-label="Code" defaultValue="a">
          <RadioOption value="a" label="1Password" description="From the item" />
          <RadioOption value="b" label="Messages" />
        </RadioGroup>
      </>,
    )
    const box = screen.getByRole('checkbox', { name: 'Allow' })
    await userEvent.click(box)
    expect(box.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: 'Some' }).getAttribute('aria-checked')).toBe('mixed')
    await userEvent.click(screen.getByRole('switch', { name: 'Notify' }))
    expect(onSwitch).toHaveBeenCalledWith(true)
    await userEvent.click(screen.getByRole('radio', { name: 'Messages' }))
    expect(screen.getByRole('radio', { name: 'Messages' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: '1Password' }).getAttribute('aria-describedby')).toBeTruthy()
    await expectAccessible()
  })

  it('a pending switch waits', async () => {
    const onSwitch = vi.fn()
    wrap(<Switch aria-label="Remote" pending onCheckedChange={onSwitch} />)
    const s = screen.getByRole('switch', { name: 'Remote' })
    expect(s.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(s)
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('a switch in a field is labelled by it', () => {
    wrap(
      <Field label="Remote access">
        <Switch />
      </Field>,
    )
    expect(screen.getByRole('switch', { name: 'Remote access' })).toBeTruthy()
  })

  it('segmented: one choice, never empty', async () => {
    const onValueChange = vi.fn()
    wrap(
      <Segmented
        label="Theme"
        value="light"
        onValueChange={onValueChange}
        size="sm"
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy()
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(onValueChange).toHaveBeenCalledWith('dark')
    onValueChange.mockClear()
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('a select shows its value and lists its options', async () => {
    const onValueChange = vi.fn()
    wrap(
      <Field label="Store">
        <Select onValueChange={onValueChange} defaultOpen>
          <SelectTrigger size="sm">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Nearby</SelectLabel>
              <SelectItem value="bondi" description="NSW 2022">
                Bondi
              </SelectItem>
              <SelectSeparator />
              <SelectItem value="newtown">Newtown</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>,
    )
    expect(screen.getByRole('combobox', { name: /Store/, hidden: true })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Bondi/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /Newtown/ }))
    expect(onValueChange).toHaveBeenCalledWith('newtown')
  })
})

describe('CopyButton', () => {
  it('copies, ticks and announces', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onCopied = vi.fn()
    wrap(<CopyButton value="abc" label="Copy hash" onCopied={onCopied} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy hash' }))
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(onCopied).toHaveBeenCalled()
    expect(await screen.findByText('Copied')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy hash' })).toBeTruthy()
  })

  it('stays quiet when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
      configurable: true,
    })
    wrap(<CopyButton value="abc" size="md" />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })
})

describe('cn', () => {
  it('keeps a size and a colour, drops an overridden colour', () => {
    expect(cn('text-md text-fg-muted', 'text-fg')).toBe('text-md text-fg')
    expect(cn('rounded-sm', 'rounded-lg')).toBe('rounded-lg')
  })
})
