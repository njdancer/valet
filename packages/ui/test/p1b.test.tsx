import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AddFilter,
  Badge,
  Button,
  CanReach,
  ChangeList,
  ChoiceCard,
  CodeDiff,
  FilterBar,
  FilterSelect,
  InboxItem,
  InboxList,
  ObjectLink,
  PageHeader,
  RadioGroup,
  RowLink,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TooltipProvider,
  TR,
  TrayFooter,
  TrayMenuItem,
  TrayPanel,
  TrayRow,
  TraySection,
} from '../src'

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

afterEach(() => {
  delete document.documentElement.dataset['platform']
})

describe('Tray rows', () => {
  it('two-line rows carry deadline and verb in the name; focus starts on Needs you', () => {
    document.documentElement.dataset['platform'] = 'mac'
    const onPause = vi.fn()
    const until = new Date(2026, 10, 11, 21, 46).getTime()
    wrap(
      <TrayPanel autoFocus>
        <TraySection label="Recent">
          <TrayRow href="#/calls/1" place>
            Checked the trolley
          </TrayRow>
        </TraySection>
        <TraySection label="Needs you" more={{ count: 2, href: '#/needs-you' }}>
          <TrayRow
            href="#/needs-you/1"
            description="Valet will remove 2 items."
            deadline={until}
            verb="Answer"
            urgent
          >
            Remove 2 items from your trolley?
          </TrayRow>
        </TraySection>
        <TrayFooter stacked>
          <TrayMenuItem shortcut="mod+shift+P" onSelect={onPause}>
            Pause Valet
          </TrayMenuItem>
        </TrayFooter>
      </TrayPanel>,
    )
    const row = screen.getByRole('link', { name: /Remove 2 items from your trolley\?, until 9:46.*Answer/i })
    expect(document.activeElement).toBe(row)
    expect(row.getAttribute('data-urgent')).toBe('true')
    expect(screen.getByRole('link', { name: '+2 more in Valet' })).toBeTruthy()
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '+2 more in Valet' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    const pause = screen.getByRole('button', { name: 'Pause Valet' })
    expect(document.activeElement).toBe(pause)
    expect(pause.getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+P')
    expect(pause.textContent).toContain('⇧⌘P')
    fireEvent.click(pause)
    expect(onPause).toHaveBeenCalled()
  })
})

describe('Row navigation', () => {
  it('a table moves between linked rows, reports the active row and copies its ref', async () => {
    document.documentElement.dataset['platform'] = 'windows'
    const onActive = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    wrap(
      <Table density="compact" bare>
        <THead>
          <tr>
            <TH>Call</TH>
            <TH priority={3}>Client</TH>
          </tr>
        </THead>
        <TBody onActiveRowChange={onActive}>
          <TR interactive copyValue="c-1">
            <TD>
              <RowLink href="#/calls/1">First</RowLink>
            </TD>
            <TD priority={3}>Claude</TD>
          </TR>
          <TR>
            <TD>No link</TD>
            <TD priority={3} />
          </TR>
          <TR interactive copyValue="c-2">
            <TD>
              <RowLink href="#/calls/2">Second</RowLink>
            </TD>
            <TD priority={3}>Claude</TD>
          </TR>
        </TBody>
      </Table>,
    )
    expect(screen.getByRole('columnheader', { name: 'Client' }).className).toContain('hidden')
    const first = screen.getByRole('link', { name: 'First' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    const second = screen.getByRole('link', { name: 'Second' })
    expect(document.activeElement).toBe(second)
    expect(onActive).toHaveBeenCalledWith(1, expect.anything())
    fireEvent.keyDown(second, { key: 'c', ctrlKey: true })
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('c-2')
    expect(screen.getByText('No link').closest('tr')?.hasAttribute('tabindex')).toBe(false)
  })

  it('an inbox list is one Tab stop; Return runs the main action and Delete dismisses', async () => {
    const onAnswer = vi.fn()
    const onDismiss = vi.fn()
    wrap(
      <InboxList label="Needs you" onDismiss={onDismiss} autoFocus>
        <InboxItem title="Answer the trolley" action={<Button onClick={onAnswer}>Answer…</Button>} />
        <InboxItem title="Missed one" missed action={<Button>Ask again</Button>} />
      </InboxList>,
    )
    const items = within(screen.getByRole('list', { name: 'Needs you' })).getAllByRole('listitem')
    expect(document.activeElement).toBe(items[0])
    expect(items[0]?.tabIndex).toBe(0)
    expect(items[1]?.tabIndex).toBe(-1)
    fireEvent.keyDown(items[0] as Element, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalled()
    fireEvent.keyDown(items[0] as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1] as Element, { key: 'Delete' })
    expect(onDismiss).toHaveBeenCalledWith(1, items[1])
  })
})

describe('Filters', () => {
  it('a filter select reads Any when unset, becomes a removable chip when set, and the count is live', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const options = [
      { value: 'woolworths', label: 'Woolworths' },
      { value: 'yahoo', label: 'Yahoo Finance' },
    ]
    const { rerender } = wrap(
      <FilterBar count="38 calls">
        <FilterSelect label="Site" options={options} onChange={onChange} />
        <AddFilter filters={[{ key: 'client', label: 'Client' }]} onAdd={() => {}} />
      </FilterBar>,
    )
    expect(screen.getByRole('status').textContent).toBe('38 calls')
    await user.click(screen.getByRole('button', { name: /Site\s*Any/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Yahoo Finance' }))
    expect(onChange).toHaveBeenCalledWith('yahoo')
    rerender(
      <TooltipProvider>
        <FilterBar>
          <FilterSelect label="Site" value="yahoo" options={options} onChange={onChange} />
        </FilterBar>
      </TooltipProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Remove filter Site' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})

describe('Object links and changes', () => {
  it('an object link says its kind, takes a contextual name and copies its ref', async () => {
    document.documentElement.dataset['platform'] = 'mac'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    wrap(
      <>
        <ObjectLink href="#/sites/w" kind="site">
          Woolworths
        </ObjectLink>
        <ObjectLink href="#/calls?f=failed" aria-label="2 failed calls on Woolworths" copyValue="ref-9">
          2 failed
        </ObjectLink>
      </>,
    )
    expect(screen.getByRole('link', { name: 'Woolworths, site' })).toBeTruthy()
    const failed = screen.getByRole('link', { name: '2 failed calls on Woolworths' })
    expect(failed.getAttribute('aria-keyshortcuts')).toBe('Meta+C')
    fireEvent.keyDown(failed, { key: 'c', metaKey: true })
    expect(writeText).toHaveBeenCalledWith('ref-9')
  })

  it('change rows say their impact in words; a code diff numbers lines and switches files', async () => {
    const user = userEvent.setup()
    wrap(
      <>
        <ChangeList
          label="What changes"
          changes={[
            { impact: 'widens', content: 'Can now reach checkout.woolworths.com.au' },
            { impact: 'same', content: 'Reads your trolley' },
          ]}
        />
        <CodeDiff
          files={[
            {
              path: 'adapters/woolworths.ts',
              hunks: [
                {
                  header: '@@ -1,2 +1,2 @@',
                  lines: [
                    { kind: 'same', text: 'export const a = 1', old: 1, new: 1 },
                    { kind: 'del', text: 'const b = 2', old: 2 },
                    { kind: 'add', text: 'const b = 3', new: 2 },
                  ],
                },
              ],
            },
            {
              path: 'adapters/stores.ts',
              hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', text: 'x', new: 1 }] }],
            },
          ]}
        />
      </>,
    )
    const changes = within(screen.getByRole('list', { name: 'What changes' })).getAllByRole('listitem')
    expect(changes[0]?.textContent).toContain('Widens access')
    expect(changes[1]?.textContent).toContain('Same')
    expect(screen.getByText('Removed:').closest('tr')?.textContent).toContain('const b = 2')
    expect(screen.getByRole('region', { name: 'adapters/woolworths.ts' }).tabIndex).toBe(0)
    await user.click(screen.getByRole('button', { name: 'stores.ts' }))
    expect(screen.getByRole('region', { name: 'adapters/stores.ts' })).toBeTruthy()
  })
})

describe('Header overflow, choice cards and Can reach', () => {
  it('overflow actions fold into a named menu; the primary stays', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    wrap(
      <PageHeader
        title="Woolworths"
        actions={<Button variant="primary">Run test</Button>}
        overflowActions={[{ label: 'Export', onSelect: onExport }]}
      />,
    )
    expect(screen.getByRole('button', { name: 'Run test' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'More actions for Woolworths' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }))
    expect(onExport).toHaveBeenCalled()
  })

  it('a choice card shows its body only when selected, outside the label', () => {
    const { rerender } = wrap(
      <RadioGroup value="desktop" aria-label="How to connect">
        <ChoiceCard value="desktop" title="Claude Desktop" selected>
          <Button>Copy config</Button>
        </ChoiceCard>
        <ChoiceCard value="code" title="Claude Code">
          <Button>Copy command</Button>
        </ChoiceCard>
      </RadioGroup>,
    )
    expect(screen.getByRole('radio', { name: 'Claude Desktop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy config' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
    rerender(
      <TooltipProvider>
        <RadioGroup value="code" aria-label="How to connect">
          <ChoiceCard value="desktop" title="Claude Desktop" />
          <ChoiceCard value="code" title="Claude Code" selected>
            <Button>Copy command</Button>
          </ChoiceCard>
        </RadioGroup>
      </TooltipProvider>,
    )
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy()
  })

  it('Can reach keeps its old props, adds callers and badges, and folds to a summary', () => {
    const { rerender } = wrap(
      <CanReach
        callers={['Claude Desktop']}
        tools={[{ content: 'get_cart', badge: <Badge>New</Badge> }, 'search']}
        hosts={['woolworths.com.au']}
        logins={[]}
        basis="From the adapter's manifest."
      />,
    )
    const region = screen.getByRole('region', { name: 'Can reach' })
    expect(region.textContent).toContain('Apps that can call')
    expect(region.textContent).toContain('New')
    expect(region.textContent).toContain('No logins')
    rerender(
      <TooltipProvider>
        <CanReach direction="reachedBy" collapsed tools={['a', 'b']} hosts={['x']} logins={['l']} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('region', { name: 'Reached by' }).textContent).toContain(
      '2 tools · 1 site · 1 login',
    )
  })
})
