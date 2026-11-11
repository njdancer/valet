// A sample control panel built only from the system, at the real window size (1180 × 780). It shows
// the layout principles at work; it is not the final IA, which comes from the UX wireframes.
import {
  Activity,
  FileClock,
  Home,
  KeyRound,
  MoreHorizontal,
  Pause,
  Plug,
  Search,
  Settings,
  Store,
  Wifi,
} from 'lucide-react'
import {
  AppShell,
  Badge,
  Banner,
  Breadcrumb,
  Button,
  DescriptionList,
  HashChip,
  HealthLine,
  IconButton,
  Inline,
  List,
  ListRow,
  NavItem,
  NavTabs,
  Page,
  PageBody,
  PageHeader,
  RiskBadge,
  SecretBadge,
  Section,
  Shortcut,
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SiteAvatar,
  StatusDot,
  Switch,
  Text,
  ValetMark,
} from '../../src'

const tools = [
  { name: 'search_products', purpose: 'read' as const, desc: 'Find products by name at your store' },
  { name: 'get_cart', purpose: 'read' as const, desc: 'Read the trolley and its total' },
  { name: 'update_cart', purpose: 'write' as const, desc: 'Add, remove or change quantities' },
  { name: 'place_order', purpose: 'irreversible' as const, desc: 'Check out with your saved card' },
]

export function SampleApp() {
  return (
    <AppShell
      embedded
      sidebar={
        <Sidebar label="Sample app sections">
          <Inline gap={2} className="px-2 pt-1">
            <ValetMark size={20} />
            <span className="text-md font-semibold">Valet</span>
            <span className="flex-1" />
            <IconButton size="sm" variant="quiet" label="Search" shortcut="mod+K" icon={<Search />} />
          </Inline>
          <SidebarGroup>
            <NavItem href="#/patterns" icon={<Home />} count={2} attention>
              Home
            </NavItem>
            <NavItem href="#/patterns" icon={<Store />}>
              Adapters
            </NavItem>
            <NavItem href="#/patterns" icon={<Activity />} count={14}>
              Activity
            </NavItem>
            <NavItem href="#/patterns" icon={<FileClock />}>
              Audit log
            </NavItem>
          </SidebarGroup>
          <SidebarGroup label="Connections">
            <NavItem href="#/patterns" icon={<Plug />}>
              Clients
            </NavItem>
            <NavItem href="#/patterns" icon={<Wifi />}>
              Remote access
            </NavItem>
            <NavItem href="#/patterns" icon={<KeyRound />}>
              Credentials
            </NavItem>
          </SidebarGroup>
          <SidebarGroup label="Sites">
            <NavItem
              href="#/patterns"
              icon={<SiteAvatar id="woolworths" name="Woolworths" size="xs" />}
              active
              count={1}
              attention
            >
              Woolworths
            </NavItem>
            <NavItem
              href="#/patterns"
              icon={<SiteAvatar id="yahoo-finance" name="Yahoo Finance" size="xs" />}
            >
              Yahoo Finance
            </NavItem>
            <NavItem href="#/patterns" icon={<SiteAvatar id="wikipedia" name="Wikipedia" size="xs" />}>
              Wikipedia
            </NavItem>
          </SidebarGroup>
          <SidebarFooter>
            <NavItem href="#/patterns" icon={<Settings />}>
              Settings
            </NavItem>
            <div className="flex items-center gap-2 px-2 text-sm text-fg-muted">
              <StatusDot tone="success" />
              MCP on · 127.0.0.1:7341
            </div>
          </SidebarFooter>
        </Sidebar>
      }
    >
      <Page>
        <PageHeader
          breadcrumb={
            <Breadcrumb items={[{ label: 'Adapters', href: '#/patterns' }, { label: 'Woolworths' }]} />
          }
          leading={<SiteAvatar id="woolworths" name="Woolworths" size="lg" />}
          title="Woolworths"
          description="Groceries at woolworths.com.au · version 1.4.0"
          actions={
            <>
              <Button leading={<Pause />}>Pause</Button>
              <IconButton label="More actions" icon={<MoreHorizontal />} variant="secondary" />
            </>
          }
        >
          <NavTabs
            label="Woolworths"
            items={[
              { href: '#/patterns', label: 'Overview', active: true },
              { href: '#/patterns', label: 'Tools', active: false, count: 6 },
              { href: '#/patterns', label: 'Access', active: false },
              { href: '#/patterns', label: 'Updates', active: false, count: 1, attention: true },
            ]}
          />
        </PageHeader>
        <PageBody width="form">
          <Banner
            tone="attention"
            title="Version 1.5.0 is waiting for your review"
            action={
              <Button size="sm" variant="primary">
                Review update
              </Button>
            }
          >
            It adds one permission that can't be undone: placing orders.
          </Banner>
          <Section title="Status">
            <div className="flex flex-col gap-2 rounded-lg bg-surface p-4 shadow-1 ring-[0.5px] ring-line ring-inset">
              <HealthLine tone="success" action={<Button size="sm">Sign out</Button>}>
                Signed in as tess@example.com · last call 2 min ago
              </HealthLine>
              <HealthLine tone="neutral" action={<Button size="sm">Change store</Button>}>
                Store: Bondi Junction
              </HealthLine>
            </div>
          </Section>
          <Section
            title="Tools"
            description="What Claude can ask Woolworths to do. Turn off any you don't want."
            actions={<Button size="sm">Rename tools…</Button>}
          >
            <List label="Tools">
              {tools.map((t) => (
                <ListRow
                  key={t.name}
                  title={<span className="font-mono text-sm">{t.name}</span>}
                  description={t.desc}
                  meta={<RiskBadge purpose={t.purpose} />}
                  trailing={
                    <Switch aria-label={`Allow ${t.name}`} defaultChecked={t.purpose !== 'irreversible'} />
                  }
                />
              ))}
            </List>
          </Section>
          <Section title="Access">
            <DescriptionList
              items={[
                { term: 'Secrets', value: <SecretBadge name="Woolworths login" /> },
                { term: 'Typed into', value: 'woolworths.com.au, auth.woolworths.com.au' },
                {
                  term: 'Approved',
                  value: (
                    <Inline gap={2}>
                      <Text>7 Nov 2026</Text>
                      <HashChip
                        value="3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d"
                        label="manifest hash"
                        href="#/patterns"
                      />
                    </Inline>
                  ),
                },
              ]}
            />
          </Section>
          <Text size="sm" tone="subtle">
            Tip: press <Shortcut keys="mod+K" /> to jump anywhere. <Badge size="sm">demo</Badge>
          </Text>
        </PageBody>
      </Page>
    </AppShell>
  )
}

export function SampleTray() {
  return (
    <div
      data-glass="refract"
      className="material-floating flex w-[360px] flex-col overflow-hidden rounded-xl text-fg"
    >
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <ValetMark size={18} />
        <span className="text-md font-semibold">Valet</span>
        <span className="flex-1" />
        <Badge tone="success">
          <StatusDot tone="success" /> Running
        </Badge>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <div className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle px-1 pt-1">
          Waiting for you
        </div>
        <div className="flex items-center gap-2.5 rounded-lg bg-surface/70 p-2.5 ring-[0.5px] ring-line ring-inset">
          <SiteAvatar id="woolworths" name="Woolworths" size="md" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-md font-semibold">Woolworths 1.5.0</span>
            <span className="truncate text-sm text-fg-muted">1 new permission</span>
          </div>
          <Button size="sm" variant="primary">
            Review
          </Button>
        </div>
        <div className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle px-1 pt-2">Recent</div>
        {[
          ['update_cart', 'Done · 2 min', 'success'],
          ['get_quote', 'Done · 9 min', 'success'],
          ['search_products', 'Call again · 12 min', 'warning'],
        ].map(([t, s, tone]) => (
          <a
            key={t}
            href="#/patterns"
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-md no-underline text-fg hover:bg-hover"
          >
            <StatusDot tone={tone as 'success'} />
            <span className="flex-1 truncate font-mono text-sm">{t}</span>
            <span className="text-sm text-fg-subtle">{s}</span>
          </a>
        ))}
      </div>
      <div className="flex items-center gap-1 border-t border-line-subtle px-2 py-1.5">
        <Button size="sm" variant="ghost">
          Open Valet
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="quiet" leading={<Pause />}>
          Pause all
        </Button>
      </div>
    </div>
  )
}
