import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Plug } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import {
  Accordion,
  AccordionItem,
  ActionBar,
  AnimatedNumber,
  ApprovalSeal,
  AppShell,
  Badge,
  Banner,
  Breadcrumb,
  Button,
  CanReach,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Code,
  CodeBlock,
  ConfirmationPanel,
  DeadlineChip,
  DescriptionList,
  Diff,
  Disclosure,
  EmptyState,
  FilterBar,
  FilterChip,
  GlassFilter,
  HashChip,
  Heading,
  HealthLine,
  InboxItem,
  Inline,
  Kbd,
  List,
  ListRow,
  NavItem,
  NavTabs,
  NeedsYouItem,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  Progress,
  RowLink,
  Section,
  Separator,
  ShellStatus,
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SiteAvatar,
  Skeleton,
  Spacer,
  Sparkle,
  Sparkline,
  SplitView,
  Stack,
  Stepper,
  SuccessCheck,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  Text,
  TextLink,
  TH,
  THead,
  Timeline,
  TitleBar,
  Toolbar,
  TooltipProvider,
  TR,
  TrayFooter,
  TrayHeader,
  TrayPanel,
  TrayRow,
  TraySection,
  ValetMark,
  Value,
} from '../src'
import { clockTime } from '../src/components/attention'
import { applyPlatform, applyTheme, detectPlatform } from '../src/lib/platform'
import { expectAccessible } from './axe'

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

describe('Text', () => {
  it('headings take their level apart from their look; values are selectable', async () => {
    wrap(
      <>
        <Heading level={1} size="page">
          Sites
        </Heading>
        <Heading size="eyebrow">Recent</Heading>
        <Text tone="muted" size="sm" weight="semibold">
          Body
        </Text>
        <Text asChild>
          <span>Span text</span>
        </Text>
        <Value mono copy="abc" truncate>
          abc
        </Value>
        <Value>plain</Value>
        <Code>get_cart</Code>
        <Kbd>K</Kbd>
        <TextLink href="#/a">Inside</TextLink>
        <TextLink href="https://example.com" external>
          Help
        </TextLink>
      </>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Sites' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Recent' })).toBeTruthy()
    expect(screen.getByText('abc').className).toContain('selectable')
    expect(screen.getByText('abc').getAttribute('title')).toBe('abc')
    expect(screen.getByText('get_cart').className).toContain('selectable')
    expect(screen.getByRole('link', { name: /Help/ }).getAttribute('target')).toBe('_blank')
    expect(screen.getByText('(opens in your browser)')).toBeTruthy()
    await expectAccessible()
  })

  it('a code block is a named, focusable region with a copy button', async () => {
    wrap(
      <>
        <CodeBlock copy label="Claude Desktop config" wrap>
          {'{ "a": 1 }'}
        </CodeBlock>
        <CodeBlock>{'plain'}</CodeBlock>
      </>,
    )
    const region = screen.getByRole('region', { name: 'Claude Desktop config' })
    expect(region.tabIndex).toBe(0)
    expect(screen.getByRole('button', { name: 'Copy Claude Desktop config' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Code' })).toBeTruthy()
    await expectAccessible()
  })
})

describe('Layout', () => {
  it('a page has one header and one scroll body, and sections are labelled', async () => {
    wrap(
      <AppShell
        sidebar={
          <Sidebar>
            <SidebarGroup label="Places">
              <NavItem href="#/needs-you" active count={2} attention icon={<Plug />}>
                Needs you
              </NavItem>
              <NavItem href="#/sites" count={3} trailing={<span>·</span>}>
                Sites
              </NavItem>
            </SidebarGroup>
            <SidebarGroup>
              <NavItem href="#/x">No label group</NavItem>
            </SidebarGroup>
            <SidebarFooter>Ready</SidebarFooter>
          </Sidebar>
        }
      >
        <Page>
          <PageHeader
            title="Woolworths"
            description="Groceries"
            leading={<SiteAvatar id="woolworths" name="Woolworths" size="lg" />}
            breadcrumb={<Breadcrumb items={[{ label: 'Sites', href: '#/sites' }, { label: 'Woolworths' }]} />}
            actions={<Button>Pause</Button>}
          >
            <div>tabs</div>
          </PageHeader>
          <PageBody width="form">
            <Section
              id="tools"
              title="Tools"
              description="What Claude can do."
              actions={<Button>Rename</Button>}
            >
              <Stack gap={2} align="center" justify="between">
                <Inline gap={1} justify="end" wrap={false}>
                  <span>a</span>
                  <Spacer />
                  <span>b</span>
                </Inline>
              </Stack>
            </Section>
            <Section>untitled</Section>
          </PageBody>
          <ActionBar>
            <Button>Done</Button>
          </ActionBar>
        </Page>
      </AppShell>,
    )
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Needs you/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText(', 2 waiting for you')).toBeTruthy()
    expect(screen.getByText(', 3')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Tools' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Woolworths' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sites' })).toBeTruthy()
    expect(screen.getByText('Woolworths', { selector: '[aria-current="page"]' })).toBeTruthy()
    await expectAccessible()
  })

  it('an embedded shell has no second main; prose pages cap their width', () => {
    wrap(
      <AppShell embedded sidebar={<Sidebar label="Demo">x</Sidebar>}>
        <PageBody width="prose">y</PageBody>
      </AppShell>,
    )
    expect(screen.queryByRole('main')).toBeNull()
  })

  it('split view shows list, detail and inspector', () => {
    wrap(
      <>
        <SplitView list={<p>list</p>} detail={<p>detail</p>} inspector={<p>inspector</p>} />
        <SplitView list={<p>list2</p>} detail={<p>detail2</p>} showDetail={false} />
      </>,
    )
    expect(screen.getByRole('complementary', { name: 'Inspector' }).textContent).toBe('inspector')
    expect(screen.getByText('detail2')).toBeTruthy()
  })

  it('cards compose, flush and interactive', () => {
    wrap(
      <>
        <Card flush>
          <CardHeader>
            <CardTitle>Title</CardTitle>
            <CardDescription>Desc</CardDescription>
          </CardHeader>
          <CardContent>Content</CardContent>
          <CardFooter>Footer</CardFooter>
        </Card>
        <Card interactive asChild>
          <a href="#/x">Linked card</a>
        </Card>
        <Separator />
        <Separator orientation="vertical" />
      </>,
    )
    expect(screen.getByRole('link', { name: 'Linked card' }).className).toContain('cursor-pointer')
  })
})

describe('Navigation', () => {
  it('tabs switch by click and arrow keys, with counts', async () => {
    wrap(
      <Tabs defaultValue="a">
        <TabsList aria-label="Site">
          <TabsTrigger value="a">Overview</TabsTrigger>
          <TabsTrigger value="b" count={2} attention>
            Updates
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a">A panel</TabsContent>
        <TabsContent value="b">B panel</TabsContent>
      </Tabs>,
    )
    await userEvent.click(screen.getByRole('tab', { name: /Updates/ }))
    expect(screen.getByRole('tabpanel').textContent).toBe('B panel')
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    await expectAccessible()
  })

  it('link tabs mark the current one', () => {
    wrap(
      <NavTabs
        label="Activity"
        items={[
          { href: '#/calls', label: 'Calls', active: true, count: 3 },
          { href: '#/audit', label: 'Audit log', active: false },
        ]}
      />,
    )
    expect(screen.getByRole('link', { name: /Calls/ }).getAttribute('aria-current')).toBe('page')
  })

  it('the stepper links back to done steps and marks the current one', async () => {
    wrap(
      <>
        <Stepper
          steps={[
            { id: 'a', label: 'Welcome', state: 'done', href: '#/a' },
            { id: 'b', label: 'Store', state: 'current', hint: 'Pick a store' },
            { id: 'c', label: 'Skip me', state: 'skipped' },
            { id: 'd', label: 'Connect', state: 'upcoming' },
          ]}
        />
        <Stepper
          orientation="horizontal"
          steps={[
            { id: 'a', label: 'One', state: 'done' },
            { id: 'b', label: 'Two', state: 'current' },
          ]}
        />
      </>,
    )
    expect(screen.getByRole('link', { name: /Welcome/ }).textContent).toContain('(done)')
    expect(screen.getAllByText('(skipped)').length).toBe(1)
    expect(document.querySelectorAll('[aria-current="step"]').length).toBe(2)
    await expectAccessible()
  })

  it('the title bar has back, forward, search and actions', async () => {
    const onBack = vi.fn()
    const onSearch = vi.fn()
    wrap(
      <TitleBar
        title="Sites"
        onBack={onBack}
        onForward={() => {}}
        canGoForward={false}
        onSearch={onSearch}
        actions={<Button>Pause</Button>}
        insetStart
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: /Search Valet/ }))
    expect(onSearch).toHaveBeenCalled()
  })

  it('a plain title bar and a toolbar', () => {
    wrap(
      <>
        <TitleBar />
        <Toolbar label="Calls">
          <Button>Filter</Button>
        </Toolbar>
      </>,
    )
    expect(screen.getByRole('toolbar', { name: 'Calls' })).toBeTruthy()
  })
})

describe('Lists and tables', () => {
  it('rows are links, buttons or static', async () => {
    const onSelect = vi.fn()
    wrap(
      <List label="Sites">
        <ListRow
          href="#/w"
          title="Woolworths"
          description="6 tools"
          meta={<Badge>Signed in</Badge>}
          leading={<SiteAvatar id="w" name="W" />}
          selected
        />
        <ListRow href="#/y" title="Yahoo" trailing={<Button>Open</Button>} />
        <ListRow onSelect={onSelect} title="Pick me" selected />
        <ListRow title="Static" trailing={<Button>Act</Button>} />
      </List>,
    )
    expect(screen.getByRole('link', { name: /Woolworths/ }).getAttribute('aria-current')).toBe('page')
    await userEvent.click(screen.getByRole('button', { name: 'Pick me' }))
    expect(onSelect).toHaveBeenCalled()
    await expectAccessible()
  })

  it('arrow keys move between table rows; sortable headers say their direction', async () => {
    const onSort = vi.fn()
    wrap(
      <Table aria-label="Calls">
        <THead>
          <tr>
            <TH>Tool</TH>
            <TH sort="desc" onSort={onSort} align="right">
              Took
            </TH>
            <TH sort="asc">When</TH>
            <TH sort="none">Site</TH>
          </tr>
        </THead>
        <TBody>
          {['a', 'b', 'c'].map((r) => (
            <TR key={r} interactive selected={r === 'b'}>
              <TD>
                <RowLink href={`#/${r}`}>{r}</RowLink>
              </TD>
              <TD align="right">1 s</TD>
              <TD>now</TD>
              <TD>x</TD>
            </TR>
          ))}
        </TBody>
      </Table>,
    )
    expect(screen.getByRole('columnheader', { name: /Took/ }).getAttribute('aria-sort')).toBe('descending')
    expect(screen.getByRole('columnheader', { name: /When/ }).getAttribute('aria-sort')).toBe('ascending')
    await userEvent.click(screen.getByRole('button', { name: /Took/ }))
    expect(onSort).toHaveBeenCalled()
    screen.getByRole('link', { name: 'a' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'b' }))
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'c' }))
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'b' }))
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'a' }))
    await userEvent.keyboard('x')
    await expectAccessible()
  })

  it('details are a definition list of selectable values', () => {
    wrap(<DescriptionList columns={2} items={[{ term: 'Version', value: '1.4.0' }]} />)
    expect(screen.getByText('1.4.0').className).toContain('selectable')
  })
})

describe('Status and feedback', () => {
  it('banners carry their action and can be dismissed', async () => {
    const onDismiss = vi.fn()
    wrap(
      <>
        <Banner tone="danger" live title="Chain broken" action={<Button>See where</Button>}>
          Edited
        </Banner>
        <Banner tone="success" title="Intact" onDismiss={onDismiss} />
        <Banner tone="attention" title="Update waiting" />
        <Banner tone="warning" live title="Waiting" icon={<Plug />} />
        <Banner title="Info" />
      </>,
    )
    // Only banners that arrived after load are announced; danger interrupts, warning waits.
    expect(screen.getAllByRole('alert').length).toBe(1)
    expect(screen.getAllByRole('status').length).toBe(1)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
    await expectAccessible()
  })

  it('empty states, progress and skeletons', () => {
    wrap(
      <>
        <EmptyState icon={<Plug />} title="No apps yet" action={<Button>Add</Button>}>
          Apps call tools.
        </EmptyState>
        <EmptyState title="Bare" />
        <Progress value={50} label="Checking" tone="success" />
        <Progress value={null} label="Logging in" tone="warning" />
        <Progress value={150} label="Over" />
        <Skeleton className="h-3" />
      </>,
    )
    expect(screen.getByRole('progressbar', { name: 'Checking' }).getAttribute('aria-valuenow')).toBe('50')
    expect(screen.getByRole('progressbar', { name: 'Logging in' }).getAttribute('aria-valuenow')).toBeNull()
  })

  it('health lines and inbox items carry their action', async () => {
    wrap(
      <ul>
        <HealthLine tone="danger" live action={<Button>Sign in</Button>}>
          Signed out
        </HealthLine>
        <InboxItem
          title="Review update"
          href="#/r"
          description="1 permission"
          meta={<Badge>new</Badge>}
          icon={<Plug />}
          action={<Button>Review</Button>}
        />
        <InboxItem title="Enter code" tone="warning" action={<Button>Enter</Button>} />
        <NeedsYouItem title="Missed: confirm" tone="danger" missed action={<Button>Ask again</Button>} />
      </ul>,
    )
    expect(screen.getByRole('link', { name: 'Review update' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('deadlines show the clock, count down under 2 min, and turn at 30 s', () => {
    const now = new Date(2026, 10, 11, 21, 50, 0).getTime()
    const { rerender } = wrap(<DeadlineChip until={now + 10 * 60_000} now={now} locale="en-AU" />)
    expect(document.body.textContent).toContain(`until ${clockTime(now + 10 * 60_000, 'en-AU')} · 10 min`)
    rerender(
      <TooltipProvider>
        <DeadlineChip until={now + 90_000} now={now} locale="en-AU" />
      </TooltipProvider>,
    )
    expect(document.body.textContent).toContain('1 min 30 s · until')
    expect(document.body.textContent).toContain('2 min left')
    rerender(
      <TooltipProvider>
        <DeadlineChip until={now + 20_000} now={now} />
      </TooltipProvider>,
    )
    expect(document.body.textContent).toContain('20 s · until')
    expect(document.body.textContent).toContain('30 s left')
    rerender(
      <TooltipProvider>
        <DeadlineChip until={now + 2 * 3600_000 + 60_000} now={now} />
      </TooltipProvider>,
    )
    expect(document.body.textContent).toContain('2 h 1 min')
    rerender(
      <TooltipProvider>
        <DeadlineChip until={now + 60_000} now={now} />
      </TooltipProvider>,
    )
    expect(document.body.textContent).toContain('1 min · until')
    rerender(
      <TooltipProvider>
        <DeadlineChip until={now - 1} now={now} />
      </TooltipProvider>,
    )
    expect(document.body.textContent).toContain('Missed')
    expect(document.body.textContent).toContain('Time is up')
  })

  it('a live deadline ticks', () => {
    vi.useFakeTimers()
    wrap(<DeadlineChip until={Date.now() + 5000} />)
    act(() => vi.advanceTimersByTime(6000))
    expect(document.body.textContent).toContain('Missed')
    vi.useRealTimers()
  })

  it('status strips and can-reach', async () => {
    wrap(
      <>
        <ShellStatus state="paused" action={<Button>Resume</Button>}>
          Valet is paused
        </ShellStatus>
        <ShellStatus state="locked">Locked down</ShellStatus>
        <CanReach tools={['get_cart']} hosts={[]} logins={['Woolworths login']} />
      </>,
    )
    expect(screen.getAllByRole('status').length).toBe(2)
    expect(screen.getByText('No websites')).toBeTruthy()
    await expectAccessible()
  })
})

describe('Objects', () => {
  it('object links go to their object and show a card on focus', async () => {
    wrap(
      <p>
        Last call to{' '}
        <ObjectLink
          href="#/sites/w"
          icon={<SiteAvatar id="w" name="W" size="xs" />}
          card={<span>Card body</span>}
        >
          Woolworths
        </ObjectLink>{' '}
        and{' '}
        <ObjectLink href="#/c/1" mono>
          7F2A
        </ObjectLink>
      </p>,
    )
    expect(screen.getByRole('link', { name: 'Woolworths' }).getAttribute('href')).toBe('#/sites/w')
    await userEvent.hover(screen.getByRole('link', { name: 'Woolworths' }))
    expect(await screen.findByText('Card body', {}, { timeout: 2000 })).toBeTruthy()
  })

  it('hash chips show a short form, the full value to readers, and copy', async () => {
    wrap(
      <>
        <HashChip value="abcdef0123456789" />
        <HashChip value="abcdef0123456789" href="#/audit/1" label="audit hash" />
        <HashChip value="short" />
      </>,
    )
    expect(screen.getAllByText('abcdef01…').length).toBe(1)
    const link = screen.getByRole('link', { name: 'abcdef01…, audit hash' })
    expect(link.getAttribute('aria-description')).toBe('abcdef0123456789')
    // Unlinked, the whole value is in the DOM (clipped by CSS) so selection and copy get all of it.
    expect(screen.getByText('abcdef0123456789').style.maxWidth).toBe('9ch')
    expect(screen.getByText('short')).toBeTruthy()
  })

  it('filter chips open and remove', async () => {
    const onRemove = vi.fn()
    const onClick = vi.fn()
    wrap(
      <FilterBar>
        <FilterChip label="Site" value="Woolworths" onRemove={onRemove} onClick={onClick} />
      </FilterBar>,
    )
    expect(document.querySelector('search')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Site:/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Site' }))
    expect(onClick).toHaveBeenCalled()
    expect(onRemove).toHaveBeenCalled()
  })

  it('site avatars keep a colour per id', () => {
    const { container } = wrap(
      <>
        {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((s) => (
          <SiteAvatar key={s} id="woolworths" name="Woolworths" size={s} />
        ))}
        <SiteAvatar id="x" name=" " />
      </>,
    )
    const tiles = container.querySelectorAll('span[aria-hidden="true"]')
    expect((tiles[0] as HTMLElement).style.background).toBe((tiles[1] as HTMLElement).style.background)
    expect(screen.getByText('?')).toBeTruthy()
  })
})

describe('Diff, timeline and sparkline', () => {
  it('diff lines say added and removed', () => {
    wrap(
      <Diff
        label="Changes"
        lines={[
          { kind: 'same', text: 'Read trolley' },
          { kind: 'add', text: 'Place orders', note: 'new' },
          { kind: 'del', text: 'Read lists' },
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Changes' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Unchanged: Read trolley', 'Added: Place ordersnew', 'Removed: Read lists'])
  })

  it('timeline steps say their kind and move with arrow keys', async () => {
    const onSelect = vi.fn()
    wrap(
      <>
        <Timeline
          selected="b"
          onSelect={onSelect}
          items={[
            { id: 'a', title: 'Logged in', kind: 'ok', time: '0:01' },
            { id: 'b', title: 'Filled login', kind: 'secret', detail: 'Woolworths' },
            { id: 'c', title: 'Blocked a request', kind: 'blocked' },
            { id: 'd', title: 'Failed', kind: 'failed' },
            { id: 'e', title: 'Handed over', kind: 'handoff' },
            { id: 'f', title: 'Running', kind: 'running' },
            { id: 'g', title: 'Waiting', kind: 'waiting' },
          ]}
        />
        <Timeline
          items={[
            { id: 'x', title: 'Dot step', tone: 'success', live: true },
            { id: 'y', title: 'Plain' },
          ]}
          label="Login"
        />
      </>,
    )
    const current = screen.getByRole('button', { name: /Filled login/ })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.textContent).toContain('Filled a login:')
    current.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(onSelect).toHaveBeenLastCalledWith('c')
    await userEvent.keyboard('{ArrowUp}')
    expect(onSelect).toHaveBeenLastCalledWith('b')
    await userEvent.keyboard('{Enter}')
    await userEvent.click(screen.getByRole('button', { name: /Logged in/ }))
    expect(onSelect).toHaveBeenLastCalledWith('a')
    expect(screen.getByRole('list', { name: 'Login' })).toBeTruthy()
    await expectAccessible()
  })

  it('sparklines are images only with a label', () => {
    wrap(
      <>
        <Sparkline values={[1, 2, 3]} label="Calls per hour" tone="danger" />
        <Sparkline values={[]} tone="neutral" />
      </>,
    )
    expect(screen.getByRole('img', { name: 'Calls per hour' })).toBeTruthy()
  })
})

describe('Disclosure', () => {
  it('details open in place; accordion items too', async () => {
    wrap(
      <>
        <Disclosure summary="Details">Hidden detail</Disclosure>
        <Accordion type="single" collapsible>
          <AccordionItem value="a" title="What can it do?" meta={<Badge>6</Badge>}>
            Search products
          </AccordionItem>
        </Accordion>
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Hidden detail')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /What can it do/ }))
    expect(screen.getByText('Search products')).toBeTruthy()
  })
})

describe('Delight', () => {
  it('the mark, tick, seal and sparkle render with names when given', () => {
    wrap(
      <>
        <ValetMark title="Valet" />
        <ValetMark />
        <SuccessCheck label="Worked" />
        <SuccessCheck />
        <ApprovalSeal />
        <Sparkle>
          <span>star</span>
        </Sparkle>
        <Sparkle play={false}>
          <span>quiet</span>
        </Sparkle>
        <GlassFilter />
      </>,
    )
    expect(screen.getByRole('img', { name: 'Valet' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Worked' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Approved' })).toBeTruthy()
    expect(document.getElementById('valet-glass-refract')).not.toBeNull()
  })

  it('numbers roll to their value, or jump with reduced motion', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { rerender } = wrap(<AnimatedNumber value={3} />)
    rerender(
      <TooltipProvider>
        <AnimatedNumber value={30} duration={200} />
      </TooltipProvider>,
    )
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getAllByText('30').length).toBe(2)
    vi.useRealTimers()
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof window.matchMedia
    rerender(
      <TooltipProvider>
        <AnimatedNumber value={40} />
      </TooltipProvider>,
    )
    expect(screen.getAllByText('40').length).toBe(2)
    window.matchMedia = original
  })
})

describe('Confirmation panel', () => {
  it('focuses Decline; Allow waits while arming and explains why', async () => {
    const onAllow = vi.fn()
    const onDecline = vi.fn()
    const props = {
      site: <SiteAvatar id="w" name="W" />,
      sentence: 'Valet will remove 2 items from your Woolworths trolley.',
      fromSite: 'Remove oat milk and bread',
      details: <p>Details</p>,
      allowLabel: 'Remove from trolley',
      onAllow,
      onDecline,
      until: Date.now() + 60_000,
      now: Date.now(),
    }
    const { rerender } = wrap(<ConfirmationPanel {...props} state="arming" armingReason="Available in 2 s" />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Decline' }))
    const allow = screen.getByRole('button', { name: 'Remove from trolley' })
    expect(allow.getAttribute('aria-description')).toBe('Available in 2 s')
    await userEvent.click(allow)
    expect(onAllow).not.toHaveBeenCalled()
    rerender(
      <TooltipProvider>
        <ConfirmationPanel {...props} state="ready" />
      </TooltipProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Remove from trolley' }))
    expect(onAllow).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onDecline).toHaveBeenCalled()
    expect(screen.getByText('From the site')).toBeTruthy()
    rerender(
      <TooltipProvider>
        <ConfirmationPanel {...props} until={undefined} fromSite={undefined} state="expired" />
      </TooltipProvider>,
    )
    expect(screen.getByText(/Missed. Nothing was done/)).toBeTruthy()
  })
})

describe('Tray panel', () => {
  it('arrow keys move between rows', async () => {
    wrap(
      <TrayPanel>
        <TrayHeader>Valet</TrayHeader>
        <TraySection label="Needs you">
          <TrayRow href="#/1" leading={<Plug />} trailing="2 min">
            Review update
          </TrayRow>
          <TrayRow href="#/2">Enter code</TrayRow>
        </TraySection>
        <TrayFooter>
          <Button>Open Valet</Button>
        </TrayFooter>
      </TrayPanel>,
    )
    screen.getByRole('link', { name: /Review update/ }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Enter code' }))
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Review update/ }))
    screen.getByRole('button', { name: 'Open Valet' }).focus()
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement as Element, { key: 'x' })
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy()
  })
})

describe('Platform and theme', () => {
  it('detects the platform from the user agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(detectPlatform('Something else')).toBe('other')
  })

  it('applies platform and theme to the root', () => {
    const root = document.documentElement
    applyPlatform(root, 'windows')
    expect(root.dataset['platform']).toBe('windows')
    applyTheme(root, 'dark')
    expect(root.dataset['theme']).toBe('dark')
    applyTheme(root, 'system')
    expect(root.dataset['theme']).toBeUndefined()
  })
})
