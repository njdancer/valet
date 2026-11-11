import { Activity, Lock, Pause, Power } from 'lucide-react'
import { useState } from 'react'
import {
  AddFilter,
  Badge,
  Button,
  CanReach,
  ChangeList,
  CheckboxOption,
  CheckedAt,
  ChoiceCard,
  CodeBlock,
  CodeDiff,
  CopyButton,
  DeadlineChip,
  FilterBar,
  FilterSelect,
  InboxItem,
  InboxList,
  ObjectLink,
  OutcomeBadge,
  PageHeader,
  RadioGroup,
  RetryPopover,
  RowLink,
  SiteAvatar,
  Stack,
  Stepper,
  Table,
  TBody,
  TD,
  Text,
  TH,
  THead,
  TR,
  TrayBody,
  TrayFooter,
  TrayHeader,
  TrayMenuItem,
  TrayPanel,
  TrayRow,
  TraySection,
  toast,
  Value,
} from '../../src'
import { GalleryPage, Row, Specimen } from './frame'

const now = Date.now()
const calls = [
  { ref: 'c-7f3a', tool: 'get_cart', client: 'Claude Desktop', outcome: 'ok' as const, at: '9:41 pm' },
  {
    ref: 'c-7f39',
    tool: 'remove_from_cart',
    client: 'Claude Desktop',
    outcome: 'waiting' as const,
    at: '9:40 pm',
  },
  {
    ref: 'c-7f38',
    tool: 'search_products',
    client: 'Claude Code',
    outcome: 'limited' as const,
    at: '9:38 pm',
  },
  { ref: 'c-7f37', tool: 'get_quote', client: 'Claude Code', outcome: 'failed' as const, at: '9:31 pm' },
]
const sites = [
  { value: 'woolworths', label: 'Woolworths' },
  { value: 'yahoo', label: 'Yahoo Finance' },
  { value: 'wikipedia', label: 'Wikipedia' },
]

export function RedesignSection() {
  const [site, setSite] = useState<string | undefined>()
  const [active, setActive] = useState(0)
  const [how, setHow] = useState('desktop')
  const shown = site ? calls.slice(0, 2) : calls
  return (
    <GalleryPage
      title="Redesign additions"
      intro="Components added for the new information architecture: the tray's two-line rows, roving row focus, compact tables, filters, outcomes, change review and the setup pieces."
    >
      <Specimen
        title="Tray"
        notes="Two-line rows carry the deadline as a clock time and the verb Return runs. Focus starts on the first Needs you row. Commands sit in the same arrow-key loop, with their shortcuts written for this OS."
        className="flex justify-center bg-sunken"
      >
        <TrayPanel className="max-h-[520px]">
          <TrayHeader>
            <Text weight="semibold">Valet</Text>
            <Text size="sm" tone="muted">
              Running · 3 sites
            </Text>
          </TrayHeader>
          <TrayBody>
            <TraySection label="Needs you" more={{ count: 2, href: '#redesign' }}>
              <TrayRow
                href="#redesign"
                leading={<SiteAvatar id="woolworths" name="Woolworths" size="sm" />}
                description="Valet will remove 2 items from your Woolworths trolley."
                deadline={now + 20_000}
                verb="Answer"
                urgent
              >
                Remove 2 items from your trolley?
              </TrayRow>
              <TrayRow
                href="#redesign"
                leading={<SiteAvatar id="claude-code" name="Claude Code" size="sm" />}
                description="Claude Code wants to use Valet's tools."
                deadline={now + 9 * 60_000}
                verb="Review"
              >
                Approve a new connection
              </TrayRow>
            </TraySection>
            <TraySection label="Recent">
              <TrayRow
                href="#redesign"
                leading={<Activity className="size-4 text-fg-muted" />}
                trailing="9:41 pm"
                place
              >
                Checked the trolley
              </TrayRow>
            </TraySection>
          </TrayBody>
          <TrayFooter stacked>
            <TrayMenuItem icon={<Pause />} shortcut="mod+shift+P" onSelect={() => toast('Paused')}>
              Pause Valet
            </TrayMenuItem>
            <TrayMenuItem icon={<Lock />} shortcut="alt+shift+mod+L" destructive onSelect={() => {}}>
              Lock down…
            </TrayMenuItem>
            <TrayMenuItem icon={<Power />} onSelect={() => {}}>
              Quit Valet
            </TrayMenuItem>
          </TrayFooter>
        </TrayPanel>
      </Specimen>

      <Specimen
        title="Calls: filters, compact table, row focus"
        notes="Filters are always shown, reading Any until set. The count is announced as it changes. Up and Down move between rows, the inspector follows focus, and ⌘C copies the row's ref. Columns with a priority drop out as the table narrows."
        className="flex flex-col gap-0 p-0"
      >
        <FilterBar count={`${shown.length} calls`} className="px-4">
          <FilterSelect label="Site" value={site} options={sites} onChange={setSite} />
          <FilterSelect
            label="Outcome"
            options={[
              { value: 'ok', label: 'Done' },
              { value: 'failed', label: 'Failed' },
            ]}
            onChange={() => {}}
          />
          <AddFilter filters={[{ key: 'client', label: 'Client' }]} onAdd={() => {}} />
        </FilterBar>
        <Table density="compact" bare>
          <THead>
            <tr>
              <TH>Ref</TH>
              <TH>Tool</TH>
              <TH priority={2}>Client</TH>
              <TH>Outcome</TH>
              <TH align="right" priority={3}>
                Time
              </TH>
            </tr>
          </THead>
          <TBody onActiveRowChange={(i) => setActive(i)}>
            {shown.map((c, i) => (
              <TR key={c.ref} interactive selected={i === active} copyValue={c.ref}>
                <TD>
                  <RowLink href="#redesign" className="font-mono text-[0.92em]">
                    {c.ref}
                  </RowLink>
                </TD>
                <TD>{c.tool}</TD>
                <TD priority={2}>
                  <ObjectLink href="#redesign" kind="app">
                    {c.client}
                  </ObjectLink>
                </TD>
                <TD>
                  <OutcomeBadge kind={c.outcome} />
                </TD>
                <TD align="right" priority={3}>
                  {c.at}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Specimen>

      <Specimen
        title="Outcomes and freshness"
        notes="Every outcome a call can end in, in words with an icon. Freshness says when Valet last looked, with a button to look again."
      >
        <Row label="OutcomeBadge">
          <OutcomeBadge kind="ok" />
          <OutcomeBadge kind="ok-blocked" count={1} />
          <OutcomeBadge kind="waiting" />
          <OutcomeBadge kind="running" />
          <OutcomeBadge kind="failed" />
          <OutcomeBadge kind="missed" />
          <OutcomeBadge kind="declined" />
          <OutcomeBadge kind="refused" />
          <OutcomeBadge kind="limited" />
        </Row>
        <Row label="DeadlineChip">
          <DeadlineChip until={now + 8 * 60_000} subject="This confirmation" />
          <DeadlineChip until={now + 20_000} subject="This confirmation" size="lg" />
          <DeadlineChip until={now + 40 * 60_000} subject="This login" format="clock" />
        </Row>
        <Row label="CheckedAt">
          <CheckedAt at={now - 4 * 60_000} subject="1Password" onCheck={() => {}} />
        </Row>
      </Specimen>

      <Specimen
        title="Needs you"
        notes="One Tab stop for the whole list. Return runs an item's main action; Delete dismisses a missed one."
      >
        <InboxList label="Needs you">
          <InboxItem
            title="Remove 2 items from your trolley?"
            description="Claude Desktop asked at 9:40 pm."
            tone="danger"
            meta={<DeadlineChip until={now + 20_000} subject="This confirmation" />}
            action={<Button>Answer…</Button>}
          />
          <InboxItem
            missed
            title="Place order"
            description="Nothing was done."
            action={
              <RetryPopover
                trigger={<Button variant="ghost">Ask Claude to try again…</Button>}
                sentence="Please try placing my Woolworths order again."
              />
            }
          />
        </InboxList>
      </Specimen>

      <Specimen
        title="Reviewing an update"
        notes="Changes are tinted by what they do to access, and the badge says it in words. The code is numbered, selectable and copyable per file."
      >
        <Stack gap={4}>
          <ChangeList
            label="What changes"
            changes={[
              { impact: 'widens', content: 'Can reach checkout.woolworths.com.au', note: 'New host' },
              { impact: 'adds', content: 'New tool: place_order' },
              { impact: 'removes', content: 'Tool get_specials' },
              { impact: 'same', content: 'Fills your Woolworths login' },
            ]}
          />
          <CodeDiff
            files={[
              {
                path: 'adapters/woolworths/tools.ts',
                hunks: [
                  {
                    header: '@@ -12,4 +12,5 @@ export const tools',
                    lines: [
                      { kind: 'same', text: '  getCart,', old: 12, new: 12 },
                      { kind: 'del', text: '  getSpecials,', old: 13 },
                      { kind: 'add', text: '  placeOrder,', new: 13 },
                      { kind: 'add', text: '  searchProducts,', new: 14 },
                      { kind: 'same', text: ']', old: 14, new: 15 },
                    ],
                  },
                ],
              },
              {
                path: 'adapters/woolworths/manifest.json',
                hunks: [
                  {
                    header: '@@ -3,2 +3,3 @@',
                    lines: [
                      { kind: 'same', text: '  "hosts": [', old: 3, new: 3 },
                      { kind: 'add', text: '    "checkout.woolworths.com.au",', new: 4 },
                      { kind: 'same', text: '    "www.woolworths.com.au"', old: 4, new: 5 },
                    ],
                  },
                ],
              },
            ]}
          />
          <CanReach
            callers={['Claude Desktop', 'Claude Code']}
            tools={[
              { content: 'place_order', badge: <Badge tone="info">New</Badge> },
              'get_cart',
              'search_products',
            ]}
            hosts={[
              'www.woolworths.com.au',
              { content: 'checkout.woolworths.com.au', badge: <Badge tone="info">New</Badge> },
            ]}
            logins={['Woolworths']}
            basis="From the adapter's manifest, after this update."
          />
          <CanReach collapsed tools={['a', 'b', 'c']} hosts={['x', 'y']} logins={['l']} />
        </Stack>
      </Specimen>

      <Specimen
        title="Setup pieces"
        notes="Steps can wait on the person. Choice cards hold steps and code. The prompt sentence is the point of its screen."
      >
        <Stack gap={5}>
          <Stepper
            steps={[
              { id: 'a', label: 'Add Valet to Claude', state: 'done' },
              { id: 'b', label: 'Woolworths login', state: 'blocked', hint: '1Password is locked' },
              { id: 'c', label: 'Pick a store', state: 'upcoming' },
            ]}
          />
          <RadioGroup
            value={how}
            onValueChange={setHow}
            aria-label="How to connect"
            className="flex flex-col gap-2"
          >
            <ChoiceCard
              value="desktop"
              title="Claude Desktop"
              description="Add Valet to its config file."
              selected={how === 'desktop'}
            >
              <CodeBlock copy label="Claude Desktop config">
                {'{ "mcpServers": { "valet": { "command": "valet-mcp" } } }'}
              </CodeBlock>
            </ChoiceCard>
            <ChoiceCard
              value="code"
              title="Claude Code"
              description="One command in a terminal."
              selected={how === 'code'}
            >
              <CodeBlock copy label="Command">
                claude mcp add valet -- valet-mcp
              </CodeBlock>
            </ChoiceCard>
          </RadioGroup>
          <Stack gap={2}>
            <Value size="lg" copy="Use Valet to show my Woolworths trolley.">
              Use Valet to show my Woolworths trolley.
            </Value>
            <CopyButton
              value="Use Valet to show my Woolworths trolley."
              variant="primary"
              className="self-start"
            >
              Copy sentence
            </CopyButton>
          </Stack>
          <CheckboxOption
            label="Keep this login in Valet"
            description="Re-synced from your 1Password item with your approval."
            defaultChecked
          />
        </Stack>
      </Specimen>

      <Specimen
        title="Header with overflow"
        notes="Secondary actions fold into a named More menu in a narrow header; the primary never moves."
        className="p-0"
      >
        <PageHeader
          title="Woolworths"
          status={<Badge tone="warning">Update waiting</Badge>}
          actions={<Button variant="primary">Review update</Button>}
          overflowActions={[
            { label: 'Run test', onSelect: () => {} },
            { label: 'Pause site', onSelect: () => {} },
          ]}
        />
        <div className="p-4">
          <Button onClick={() => toast.undo('Removed Woolworths login', { onUndo: () => toast('Restored') })}>
            Show an Undo toast (then press ⌘Z)
          </Button>
        </div>
      </Specimen>
    </GalleryPage>
  )
}
