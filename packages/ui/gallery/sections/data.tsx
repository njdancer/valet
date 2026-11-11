import { Inbox, MoreHorizontal, Plug } from 'lucide-react'
import { useState } from 'react'
import {
  Accordion,
  AccordionItem,
  Badge,
  Banner,
  Breadcrumb,
  Button,
  DeadlineChip,
  DescriptionList,
  Diff,
  Disclosure,
  EmptyState,
  HashChip,
  HealthLine,
  IconButton,
  InboxItem,
  List,
  ListRow,
  NavTabs,
  ObjectLink,
  Progress,
  RiskBadge,
  RowLink,
  SiteAvatar,
  Skeleton,
  Sparkline,
  Stack,
  Stepper,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  Text,
  TH,
  THead,
  Timeline,
  TR,
} from '../../src'
import { GalleryPage, Row, Specimen } from './frame'

const sites = [
  { id: 'woolworths', name: 'Woolworths', host: 'woolworths.com.au', tools: 6, status: 'Signed in' },
  {
    id: 'yahoo-finance',
    name: 'Yahoo Finance',
    host: 'finance.yahoo.com',
    tools: 3,
    status: 'No login needed',
  },
  { id: 'wikipedia', name: 'Wikipedia', host: 'en.wikipedia.org', tools: 3, status: 'No login needed' },
]

const calls = [
  {
    id: 'c1',
    tool: 'woolworths_update_cart',
    site: 'woolworths',
    purpose: 'write' as const,
    outcome: 'Done',
    time: '2 min ago',
    ms: 14200,
  },
  {
    id: 'c2',
    tool: 'yahoo_finance_get_quote',
    site: 'yahoo-finance',
    purpose: 'read' as const,
    outcome: 'Done',
    time: '9 min ago',
    ms: 3100,
  },
  {
    id: 'c3',
    tool: 'woolworths_search_products',
    site: 'woolworths',
    purpose: 'read' as const,
    outcome: 'Call again',
    time: '12 min ago',
    ms: 900,
  },
  {
    id: 'c4',
    tool: 'wikipedia_get_summary',
    site: 'wikipedia',
    purpose: 'read' as const,
    outcome: 'Done',
    time: '1 h ago',
    ms: 2400,
  },
]

export function DataSection() {
  const [sort, setSort] = useState<'asc' | 'desc'>('desc')
  const sorted = [...calls].sort((a, b) => (sort === 'asc' ? a.ms - b.ms : b.ms - a.ms))
  return (
    <GalleryPage
      title="Data and status"
      intro="Anything that names an object is a link to it, with a hover card. Rows that open something are one big target. Status is words first, colour second."
    >
      <Specimen
        title="Inbox"
        notes="Things waiting on the person, each with its action on the item. The home page and the tray are lists of these."
      >
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          <InboxItem
            icon={<SiteAvatar id="woolworths" name="Woolworths" />}
            title="Woolworths update 1.5.0"
            description="Asks for one new permission: place orders. Tools run 1.4.0 until you decide."
            href="#/data"
            meta={<RiskBadge purpose="irreversible">New: place orders</RiskBadge>}
            action={
              <Button size="sm" variant="primary">
                Review
              </Button>
            }
          />
          <InboxItem
            tone="warning"
            icon={<SiteAvatar id="woolworths" name="Woolworths" />}
            title="Enter the code Woolworths sent"
            description="Valet couldn't read it from Messages."
            meta={<DeadlineChip until={Date.now() + 250_000} />}
            action={
              <Button size="sm" variant="primary">
                Enter code
              </Button>
            }
          />
        </ul>
      </Specimen>

      <Specimen
        title="List"
        notes="A row is a link (chevron), a button, or static with controls on the right. Never a dead end."
      >
        <List label="Sites">
          {sites.map((s) => (
            <ListRow
              key={s.id}
              href="#/data"
              leading={<SiteAvatar id={s.id} name={s.name} />}
              title={s.name}
              description={`${s.host} · ${s.tools} tools`}
              meta={<Badge tone={s.status === 'Signed in' ? 'success' : 'neutral'}>{s.status}</Badge>}
            />
          ))}
          <ListRow
            title="Start Valet when I log in"
            description="Valet keeps running in the menu bar."
            trailing={<Switch aria-label="Start Valet when I log in" defaultChecked />}
          />
        </List>
      </Specimen>

      <Specimen
        title="Table"
        notes="For comparing across columns. The tool name is the row's link; the whole row is clickable. Sort headers say their direction to a screen reader."
      >
        <Table aria-label="Recent calls">
          <THead>
            <tr>
              <TH>Tool</TH>
              <TH>Site</TH>
              <TH>Risk</TH>
              <TH>Outcome</TH>
              <TH align="right" sort={sort} onSort={() => setSort(sort === 'asc' ? 'desc' : 'asc')}>
                Took
              </TH>
              <TH align="right">When</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {sorted.map((c) => (
              <TR key={c.id} interactive>
                <TD>
                  <RowLink href="#/data">
                    <span className="font-mono text-sm">{c.tool}</span>
                  </RowLink>
                </TD>
                <TD>
                  <span className="relative z-[1]">
                    <ObjectLink href="#/data" icon={<SiteAvatar id={c.site} name={c.site} size="xs" />}>
                      {sites.find((s) => s.id === c.site)?.name}
                    </ObjectLink>
                  </span>
                </TD>
                <TD>
                  <RiskBadge purpose={c.purpose} />
                </TD>
                <TD>
                  <Badge tone={c.outcome === 'Done' ? 'success' : 'warning'}>{c.outcome}</Badge>
                </TD>
                <TD align="right">{(c.ms / 1000).toFixed(1)} s</TD>
                <TD align="right" className="text-fg-muted">
                  {c.time}
                </TD>
                <TD align="right">
                  <IconButton
                    label={`More for ${c.tool}`}
                    icon={<MoreHorizontal />}
                    size="sm"
                    variant="quiet"
                    className="relative z-[1]"
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Specimen>

      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Object links and hashes" notes="Hover or focus the site name for its card.">
          <Stack gap={3}>
            <Text>
              Last call to{' '}
              <ObjectLink
                href="#/data"
                icon={<SiteAvatar id="woolworths" name="Woolworths" size="xs" />}
                card={
                  <Stack gap={2}>
                    <div className="flex items-center gap-2">
                      <SiteAvatar id="woolworths" name="Woolworths" size="sm" />
                      <Text weight="semibold">Woolworths</Text>
                      <Badge tone="success">Signed in</Badge>
                    </div>
                    <Text size="sm" tone="muted">
                      6 tools · 14 calls today · version 1.4.0
                    </Text>
                  </Stack>
                }
              >
                Woolworths
              </ObjectLink>{' '}
              was 2 min ago from <ObjectLink href="#/data">“Claude”</ObjectLink>.
            </Text>
            <Row label="Hash">
              <HashChip
                value="9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
                href="#/data"
              />
            </Row>
          </Stack>
        </Specimen>
        <Specimen title="Health and deadlines">
          <Stack gap={3}>
            <HealthLine tone="success">Signed in · last call 2 min ago</HealthLine>
            <HealthLine
              tone="danger"
              action={
                <Button size="sm" variant="primary">
                  Sign in
                </Button>
              }
            >
              Signed out · the last login needed a code
            </HealthLine>
            <HealthLine tone="warning" live>
              Waiting 8 s for pacing
            </HealthLine>
            <Row label="Deadline">
              <DeadlineChip until={Date.now() + 42_000} />
              <DeadlineChip until={Date.now() - 1} />
            </Row>
          </Stack>
        </Specimen>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Details">
          <DescriptionList
            items={[
              { term: 'Version', value: '1.4.0' },
              { term: 'Origins', value: 'woolworths.com.au' },
              {
                term: 'Manifest',
                value: (
                  <HashChip
                    value="3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d"
                    label="manifest hash"
                  />
                ),
              },
            ]}
          />
        </Specimen>
        <Specimen title="Timeline and sparkline">
          <Stack gap={4}>
            <Timeline
              items={[
                { id: 'a', title: 'Logged in', time: '0:03', tone: 'success' },
                { id: 'b', title: 'Searching “oat milk”', time: '0:05', tone: 'accent', live: true },
              ]}
            />
            <div className="flex items-end gap-3">
              <Sparkline
                values={[1, 3, 2, 6, 4, 9, 5, 7, 12, 8, 6, 3]}
                className="w-40"
                label="Calls per hour today"
              />
              <Text size="sm" tone="muted">
                Calls per hour
              </Text>
            </div>
          </Stack>
        </Specimen>
      </div>

      <Specimen title="Diff" notes="What an update changes. Sign and colour and a screen reader prefix.">
        <Diff
          label="Permission changes in 1.5.0"
          lines={[
            { kind: 'same', text: 'Read your trolley and orders' },
            {
              kind: 'add',
              text: 'Place orders with your saved card',
              note: <RiskBadge purpose="irreversible" />,
            },
            { kind: 'del', text: 'Read your saved lists' },
          ]}
        />
      </Specimen>

      <Specimen title="Banners and empty states">
        <Stack gap={3}>
          <Banner tone="info" title="Remote access is off">
            Claude on the web can't reach Valet until you turn it on.
          </Banner>
          <Banner tone="success" title="Audit chain intact" onDismiss={() => {}}>
            All 1,284 entries check out.
          </Banner>
          <Banner
            tone="warning"
            title="Calls are waiting for pacing"
            action={
              <Button size="sm" variant="secondary">
                Show queue
              </Button>
            }
          />
          <Banner
            tone="danger"
            title="Audit chain broken at entry 1,203"
            action={
              <Button size="sm" variant="danger">
                See what changed
              </Button>
            }
          >
            Someone or something edited the log file.
          </Banner>
          <div className="rounded-lg ring-[0.5px] ring-line ring-inset">
            <EmptyState
              icon={<Plug />}
              title="No clients yet"
              action={
                <Button variant="primary" leading={<Inbox />}>
                  Add to Claude Desktop
                </Button>
              }
            >
              A client is an app that calls Valet's tools, such as Claude Desktop.
            </EmptyState>
          </div>
        </Stack>
      </Specimen>

      <Specimen title="Progress and loading">
        <Stack gap={3}>
          <Progress value={64} label="Checking the audit chain" />
          <Progress value={null} label="Logging in" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-8" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        </Stack>
      </Specimen>

      <Specimen
        title="Navigation"
        notes="Tabs within a page; link tabs when each is an address; breadcrumbs for depth; the stepper for setup, where done steps are links back."
      >
        <Stack gap={5}>
          <Tabs defaultValue="tools">
            <div className="border-b border-line-subtle">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="tools" count={6}>
                  Tools
                </TabsTrigger>
                <TabsTrigger value="access">Access</TabsTrigger>
                <TabsTrigger value="updates" count={1} attention>
                  Updates
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="overview" className="pt-3">
              <Text tone="muted">Overview panel</Text>
            </TabsContent>
            <TabsContent value="tools" className="pt-3">
              <Text tone="muted">Tools panel</Text>
            </TabsContent>
            <TabsContent value="access" className="pt-3">
              <Text tone="muted">Access panel</Text>
            </TabsContent>
            <TabsContent value="updates" className="pt-3">
              <Text tone="muted">Updates panel</Text>
            </TabsContent>
          </Tabs>
          <div className="border-b border-line-subtle">
            <NavTabs
              label="Activity views"
              items={[
                { href: '#/data', label: 'Calls', active: true },
                { href: '#/data?q', label: 'Logins', active: false },
              ]}
            />
          </div>
          <Breadcrumb
            items={[
              { label: 'Adapters', href: '#/data' },
              { label: 'Woolworths', href: '#/data' },
              { label: 'Review update' },
            ]}
          />
          <div className="grid grid-cols-2 gap-6">
            <Stepper
              steps={[
                { id: 'w', label: 'Welcome', state: 'done', href: '#/data' },
                {
                  id: 'p',
                  label: '1Password',
                  state: 'done',
                  href: '#/data',
                  hint: 'Service account connected',
                },
                { id: 's', label: 'Store', state: 'current', hint: 'Pick where you shop' },
                { id: 'c', label: 'Connect Claude', state: 'upcoming' },
              ]}
            />
            <Accordion type="single" collapsible defaultValue="a">
              <AccordionItem value="a" title="What can this adapter do?" meta={<Badge>6 tools</Badge>}>
                <Text size="sm" tone="muted">
                  Search products, read and change the trolley, read orders.
                </Text>
              </AccordionItem>
              <AccordionItem value="b" title="Where does it type secrets?">
                <Text size="sm" tone="muted">
                  Only into woolworths.com.au, in a separate browser partition.
                </Text>
              </AccordionItem>
            </Accordion>
          </div>
          <Disclosure summary="Details">
            <Text size="sm" tone="muted">
              Technical detail lives one click away from the plain-words summary.
            </Text>
          </Disclosure>
        </Stack>
      </Specimen>
    </GalleryPage>
  )
}
