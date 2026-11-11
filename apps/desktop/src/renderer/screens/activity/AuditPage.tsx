// Activity › Audit log (#/activity/audit, mod+shift+3): the hash-chained record of everything Valet
// did, with the chain's status (when it was checked, and Check now beside it), filters in the address
// (category, site, call), a paged table, and the selected record (#/activity/audit/<seq>) in the
// inspector with its call, its place in the chain and Copy. Records are core's AuditRecord as
// written; the inspector shows only the fields core's audit format defines for each event type.

import type { AuditRecord } from '@valet/core'
import {
  Badge,
  Banner,
  Button,
  CodeBlock,
  DescriptionList,
  Disclosure,
  EmptyState,
  FilterBar,
  FilterChip,
  HashChip,
  Heading,
  HealthLine,
  Inline,
  ObjectLink,
  Page,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RowLink,
  SearchInput,
  Spacer,
  SplitView,
  Stack,
  StatusDot,
  Table,
  TBody,
  TD,
  Text,
  TH,
  THead,
  TR,
} from '@valet/ui'
import { ChevronLeft, ChevronRight, Download, FileSearch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AuditPage as AuditPageData, AuditQuery, ChainStatus } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { callRef, formatSeconds, formatTime } from '../../lib/format'
import {
  AUDIT_CATEGORIES,
  type AuditCategoryFilter,
  type AuditFilters,
  href,
  navigate,
} from '../../lib/router'
import { callOf, details, eventWords, hashText, shownRecord, siteOf } from './audit-events'
import { ActivityTabs, FilterMenu } from './shared'

export const CATEGORY_LABELS: Readonly<Record<AuditCategoryFilter, string>> = {
  'tool-calls': 'Calls',
  logins: 'Logins',
  'secret-use': 'Login use',
  blocked: 'Blocked',
  confirmations: 'Confirmations',
  'approvals-grants': 'Approvals',
}

const PAGE_SIZE = 50

/** Older records loaded under one head page, and the cursor for the next page (null: no more). */
interface Older {
  readonly head: AuditPageData | null
  readonly records: readonly AuditRecord[]
  readonly next: number | null
}

export function AuditPage({ seq, filters }: { readonly seq: number | null; readonly filters: AuditFilters }) {
  const api = useApi()
  const now = useNow(60_000)
  const [search, setSearch] = useState('')
  const [older, setOlder] = useState<Older>({ head: null, records: [], next: null })
  const verify = useAction()
  const more = useAction()
  const exporting = useAction()
  const [verified, setVerified] = useState<ChainStatus | null>(null)
  const [appendedSeq, setAppendedSeq] = useState<number | null>(null)

  // A record appended after Check now ran isn't covered by it: drop the result so the line shows the
  // main process's last verification, and remember how far the log now goes.
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type !== 'audit-appended') return
        setVerified(null)
        setAppendedSeq((s) => Math.max(s ?? 0, event.seq))
      }),
    [api],
  )

  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed'])
  const chain = useLoad((a) => a.audit.chainStatus(), [], ['audit-appended', 'audit-verified'])
  const query: AuditQuery = {
    ...(filters.category === null ? {} : { category: filters.category }),
    ...(filters.site === null ? {} : { adapterId: filters.site }),
    // A call filter is a search for its id; the rows are then narrowed to that call's records.
    ...(filters.call !== null
      ? { search: filters.call }
      : search.trim() === ''
        ? {}
        : { search: search.trim() }),
    limit: PAGE_SIZE,
  }
  const queryKey = JSON.stringify(query)
  const page = useLoad((a) => a.audit.page(query), [queryKey], ['audit-appended'])

  // Older pages belong to the head page they were loaded under. A new head page (a filter change,
  // or a record appended, which shifts every page by one) starts from its own cursor again.
  const head = page.status === 'ready' ? page.data : null
  const paged: Older =
    head !== null && older.head === head ? older : { head, records: [], next: head?.nextBeforeSeq ?? null }
  const records = (head === null ? [] : [...head.records, ...paged.records]).filter(
    (r) => filters.call === null || callOf(r.event) === filters.call,
  )
  const status = verified ?? (chain.status === 'ready' ? chain.data : null)
  const newestSeq = Math.max(appendedSeq ?? 0, ...(head?.records.map((r) => r.seq) ?? []))

  // The selected record may be outside the loaded pages (a link to the break, an old record).
  const listed = seq === null ? undefined : records.find((r) => r.seq === seq)
  const single = useLoad(
    (a) =>
      seq === null || listed !== undefined
        ? Promise.resolve(null)
        : a.audit.page({ beforeSeq: seq + 1, limit: 1 }),
    [seq, listed === undefined],
    ['audit-appended'],
  )
  const selected =
    listed ??
    (single.status === 'ready' && single.data !== null
      ? (single.data.records.find((r) => r.seq === seq) ?? null)
      : null)
  const singleSettled = listed !== undefined || single.status !== 'loading'

  const loading = useRef(false)
  const loadMore = (from: AuditPageData, cursor: number) => {
    if (loading.current) return
    loading.current = true
    void more
      .run(async () => {
        const next = await api.audit.page({ ...query, beforeSeq: cursor })
        setOlder((current) => {
          const base: Older =
            current.head === from ? current : { head: from, records: [], next: from.nextBeforeSeq }
          // Another load already moved past this cursor: keep what it found.
          if (base.next !== cursor) return base
          const seen = new Set([...from.records, ...base.records].map((r) => r.seq))
          return {
            head: from,
            records: [...base.records, ...next.records.filter((r) => !seen.has(r.seq))],
            next: next.nextBeforeSeq,
          }
        })
      })
      .finally(() => {
        loading.current = false
      })
  }

  const siteName = (id: string) =>
    (adapters.status === 'ready' ? adapters.data.find((a) => a.id === id)?.name : undefined) ?? id
  const checkNow = () =>
    void verify.run(async () => {
      setVerified(await api.audit.verify())
    })
  const filtered = filters.category !== null || filters.site !== null || filters.call !== null

  return (
    <Page>
      <PageHeader
        title="Audit log"
        description={
          page.status === 'ready'
            ? `${page.data.total.toLocaleString('en-AU')} records, append-only and hash-chained.`
            : 'Append-only and hash-chained.'
        }
        status={<ChainBadge status={status} />}
        actions={
          <Button
            leading={<Download aria-hidden="true" />}
            loading={exporting.busy}
            onClick={() => void exporting.run(() => api.audit.exportJsonl())}
          >
            Export…
          </Button>
        }
      >
        <ActivityTabs active="audit" />
      </PageHeader>
      <div className="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-6 py-3">
        <ChainLine
          status={status}
          now={now}
          newestSeq={newestSeq}
          checking={verify.busy}
          onCheck={checkNow}
          filters={filters}
        />
        {verify.failed ? <Failed what="check the chain" /> : null}
        {exporting.failed ? <Failed what="export the log" /> : null}
      </div>
      <FilterBar aria-label="Filter the audit log">
        <SearchInput
          aria-label="Search the audit log"
          placeholder="Search refs, tools, hosts"
          value={search}
          onValueChange={setSearch}
          className="w-56"
          disabled={filters.call !== null}
        />
        <FilterMenu
          label="Category"
          anyLabel="All"
          value={filters.category}
          options={AUDIT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          to={(category) => href.audit({ ...filters, category: category as AuditCategoryFilter | null })}
        />
        <FilterMenu
          label="Site"
          value={filters.site}
          options={
            adapters.status === 'ready' ? adapters.data.map((a) => ({ value: a.id, label: a.name })) : []
          }
          to={(site) => href.audit({ ...filters, site })}
        />
        {filters.call !== null ? (
          <FilterChip
            label="Call"
            value={callRef(filters.call)}
            onRemove={() => navigate(href.audit({ ...filters, call: null }))}
            onClick={() => navigate(href.call(filters.call as string))}
          />
        ) : null}
        <Spacer />
        {filtered ? (
          <Button size="sm" variant="ghost" asChild>
            <a href={href.audit()}>Clear filters</a>
          </Button>
        ) : null}
      </FilterBar>
      <SplitView
        // The table is the detail; the selected record is the inspector. There is no list pane.
        className="[&>div>div:first-child]:hidden"
        list={null}
        listWidth={0}
        inspectorWidth={320}
        detail={
          <div className="flex flex-col gap-3 px-6 py-4">
            {page.status === 'error' ? (
              <Banner tone="danger" title="Couldn’t read the audit log.">
                It tries again when a record is added.
              </Banner>
            ) : page.status === 'loading' ? null : records.length === 0 ? (
              <EmptyState
                icon={<FileSearch />}
                title="No records match"
                action={
                  filtered ? (
                    <Button variant="primary" asChild>
                      <a href={href.audit()}>Clear filters</a>
                    </Button>
                  ) : null
                }
              >
                {filters.call !== null
                  ? `The audit log has no records for call ${callRef(filters.call)} on this page.`
                  : 'Try another category, site or search.'}
              </EmptyState>
            ) : (
              <RecordsTable
                records={records}
                filters={filters}
                selected={seq}
                status={status}
                now={now}
                siteName={siteName}
              />
            )}
            {head !== null && paged.next !== null ? (
              <Inline gap={2}>
                <Button loading={more.busy} onClick={() => paged.next !== null && loadMore(head, paged.next)}>
                  Load older records
                </Button>
                {more.failed ? <Failed what="load older records" /> : null}
              </Inline>
            ) : null}
          </div>
        }
        inspector={
          seq === null ? undefined : (
            <section aria-label="Record" className="px-4 py-5">
              {selected !== null ? (
                <Inspector
                  record={selected}
                  filters={filters}
                  status={status}
                  newestSeq={newestSeq}
                  now={now}
                  siteName={siteName}
                />
              ) : singleSettled ? (
                <Stack gap={2}>
                  <Heading level={2} size="group">
                    Record {seq}
                  </Heading>
                  <Text tone="muted">The audit log has no record {seq}.</Text>
                </Stack>
              ) : null}
            </section>
          )
        }
      />
    </Page>
  )
}

function Failed({ what }: { readonly what: string }) {
  return (
    <Text role="alert" tone="danger" size="sm">
      Couldn’t {what}. Try again.
    </Text>
  )
}

function ChainBadge({ status }: { readonly status: ChainStatus | null }) {
  if (status === null) return null
  if (status.state === 'broken') return <Badge tone="danger">Doesn’t check out</Badge>
  if (status.state === 'unverified') return <Badge>Not checked yet</Badge>
  return <Badge tone="success">Checks out</Badge>
}

/** The chain's status, when it was checked, and Check now beside it (IA principle 8). */
function ChainLine({
  status,
  now,
  newestSeq,
  checking,
  onCheck,
  filters,
}: {
  readonly status: ChainStatus | null
  readonly now: number
  readonly newestSeq: number
  readonly checking: boolean
  readonly onCheck: () => void
  readonly filters: AuditFilters
}) {
  const check = (label: string, variant: 'primary' | 'secondary' = 'secondary') => (
    <Button size="sm" variant={variant} loading={checking} onClick={onCheck}>
      {label}
    </Button>
  )
  if (status === null) return null
  if (status.state === 'broken')
    return (
      <Banner
        tone="danger"
        title={`The audit log doesn’t check out from record ${status.firstBadSeq}.`}
        action={
          <>
            <Button size="sm" variant="primary" asChild>
              <a href={href.audit({ category: filters.category, site: filters.site }, status.firstBadSeq)}>
                See where
              </a>
            </Button>
            {check('Check again')}
          </>
        }
      >
        Record {status.firstBadSeq}’s hash doesn’t match its contents or the record before it, so it, and
        every record after it, can’t be proved untouched. Checked {status.records.toLocaleString('en-AU')}{' '}
        records at {formatTime(status.verifiedAt, now)}. Export the log as it is and keep the copy.
      </Banner>
    )
  if (status.state === 'unverified')
    return (
      <HealthLine tone="neutral" action={check('Check now')}>
        <span className="font-medium text-fg">Not checked yet.</span> Check now verifies every record against
        the one before it.
      </HealthLine>
    )
  return (
    <Stack gap={1.5}>
      <HealthLine
        tone="success"
        action={
          <>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost">
                  What this proves
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end">
                <Text size="sm">
                  Each record’s hash covers the record before it, so an edit to an earlier record shows up.
                  Deleting the newest records, or rewriting the whole log, needs an outside anchor to detect
                  (planned).
                </Text>
              </PopoverContent>
            </Popover>
            {check('Check now')}
          </>
        }
      >
        <span className="font-medium text-fg">The audit log checks out up to record {status.headSeq}.</span>{' '}
        All {status.records.toLocaleString('en-AU')} records to there verified at{' '}
        {formatTime(status.verifiedAt, now)} · head <HashChip value={status.headHash} label="head hash" />
      </HealthLine>
      {newestSeq > status.headSeq ? (
        <Text size="sm" tone="warning">
          Records after {status.headSeq} were appended since and aren’t checked yet.
        </Text>
      ) : null}
    </Stack>
  )
}

type ChainPlace = 'verified' | 'unprovable' | 'unchecked' | null

function chainPlace(seq: number, status: ChainStatus | null): ChainPlace {
  if (status?.state === 'broken') return seq >= status.firstBadSeq ? 'unprovable' : 'verified'
  if (status?.state === 'intact') return seq <= status.headSeq ? 'verified' : 'unchecked'
  return null
}

// Positioned after the row link's click area in the DOM, so they paint (and click) above it, while
// staying under the sticky table header.
const ABOVE = 'relative'

/** Scrolls the nearest scrolling ancestor so `row` is in view, if it isn't already. */
function revealRow(row: HTMLElement | null): void {
  let pane = row?.parentElement ?? null
  while (pane !== null && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement
  if (row === null || pane === null) return
  const r = row.getBoundingClientRect()
  const p = pane.getBoundingClientRect()
  // Leave room for the sticky header above the row.
  if (r.top < p.top + 40 || r.bottom > p.bottom) pane.scrollTop += r.top - p.top - p.height / 3
}

function RecordsTable({
  records,
  filters,
  selected,
  status,
  now,
  siteName,
}: {
  readonly records: readonly AuditRecord[]
  readonly filters: AuditFilters
  readonly selected: number | null
  readonly status: ChainStatus | null
  readonly now: number
  readonly siteName: (id: string) => string
}) {
  const broken = status?.state === 'broken'
  // With a record open beside the table, the site column gives its room to the details.
  const narrow = selected !== null
  const selectedRow = useRef<HTMLTableRowElement>(null)
  // Opening at a record (See where, a link) brings its row into view, scrolling only the table's
  // own pane (scrollIntoView would scroll the window's fixed layout too).
  useEffect(() => {
    if (selected !== null) revealRow(selectedRow.current)
  }, [selected])
  return (
    <Table aria-label="Audit records">
      <THead>
        <tr>
          <TH align="right">Seq</TH>
          <TH>Time</TH>
          <TH>Event</TH>
          <TH>Details</TH>
          {narrow ? null : <TH>Site</TH>}
          {broken ? <TH>Chain</TH> : null}
          <TH>Call</TH>
        </tr>
      </THead>
      <TBody>
        {records.map((record) => {
          const words = eventWords(record.event)
          const site = siteOf(record.event)
          const call = callOf(record.event)
          const isSelected = record.seq === selected
          return (
            <TR key={record.seq} interactive selected={isSelected} ref={isSelected ? selectedRow : undefined}>
              <TD align="right" className="w-0">
                <RowLink href={href.audit(filters, record.seq)} className="selectable font-mono">
                  <span className="sr-only">Record </span>
                  {record.seq}
                </RowLink>
              </TD>
              <TD className="w-0 whitespace-nowrap text-fg-muted tabular">
                {narrow ? formatTime(record.at, now) : formatSeconds(record.at, now)}
              </TD>
              <TD className={narrow ? 'w-0 min-w-28' : 'w-0 whitespace-nowrap'}>
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={words.tone} />
                  {words.label}
                </span>
              </TD>
              <TD className="w-full max-w-0 min-w-20">
                <span className="block truncate [&_a]:relative [&_button]:relative">
                  {details(record.event, now)}
                </span>
              </TD>
              {narrow ? null : (
                <TD className="w-0 whitespace-nowrap">
                  {site !== null ? (
                    <ObjectLink href={href.site(site)} className={ABOVE}>
                      {siteName(site)}
                    </ObjectLink>
                  ) : null}
                </TD>
              )}
              {broken ? (
                <TD className="w-0 whitespace-nowrap">
                  {chainPlace(record.seq, status) === 'unprovable' ? (
                    <Badge tone="danger">Can’t be proved</Badge>
                  ) : (
                    <Badge tone="success">Checks out</Badge>
                  )}
                </TD>
              ) : null}
              <TD className="w-0 whitespace-nowrap">
                {call !== null ? (
                  <ObjectLink mono href={href.call(call)} className={ABOVE}>
                    <span className="sr-only">Call </span>
                    {callRef(call)}
                  </ObjectLink>
                ) : null}
              </TD>
            </TR>
          )
        })}
      </TBody>
    </Table>
  )
}

function Inspector({
  record,
  filters,
  status,
  newestSeq,
  now,
  siteName,
}: {
  readonly record: AuditRecord
  readonly filters: AuditFilters
  readonly status: ChainStatus | null
  readonly newestSeq: number
  readonly now: number
  readonly siteName: (id: string) => string
}) {
  const api = useApi()
  const copy = useAction()
  const text = JSON.stringify(shownRecord(record), null, 2)
  const words = eventWords(record.event)
  const site = siteOf(record.event)
  const call = callOf(record.event)
  const place = chainPlace(record.seq, status)
  const prev = hashText(record.prev)
  const hash = hashText(record.hash)
  return (
    <Stack gap={4}>
      <Inline gap={2} wrap={false}>
        <Heading level={2} size="section" className="flex-1">
          Record {record.seq}
        </Heading>
        {place === 'unprovable' ? (
          <Badge tone="danger">Can’t be proved</Badge>
        ) : place === 'verified' ? (
          <Badge tone="success">In the verified chain</Badge>
        ) : place === 'unchecked' ? (
          <Badge>Appended since the last check</Badge>
        ) : null}
      </Inline>
      <DescriptionList
        items={[
          { term: 'Time', value: formatSeconds(record.at, now) },
          {
            term: 'Event',
            value: (
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={words.tone} />
                {words.label}
              </span>
            ),
          },
          { term: 'Details', value: <span className="break-words">{details(record.event, now)}</span> },
          ...(site !== null
            ? [{ term: 'Site', value: <ObjectLink href={href.site(site)}>{siteName(site)}</ObjectLink> }]
            : []),
          ...(call !== null
            ? [
                {
                  term: 'Call',
                  value: (
                    <ObjectLink mono href={href.call(call)}>
                      {callRef(call)}
                    </ObjectLink>
                  ),
                },
              ]
            : []),
        ]}
      />
      <Inline gap={2}>
        {call !== null ? (
          <Button variant="primary" asChild>
            <a href={href.call(call)}>Open call {callRef(call)}</a>
          </Button>
        ) : null}
        {site !== null ? (
          <Button asChild>
            <a href={href.site(site)}>Open {siteName(site)}</a>
          </Button>
        ) : null}
        <Button loading={copy.busy} onClick={() => void copy.run(() => api.app.copyText(text))}>
          Copy record
        </Button>
      </Inline>
      {copy.failed ? <Failed what="copy the record" /> : null}
      <Stack gap={2}>
        <Heading level={3} size="group">
          Chain
        </Heading>
        <DescriptionList
          items={[
            {
              term: 'Previous',
              value: prev === null ? '[not shown]' : <HashChip value={prev} label="previous hash" />,
            },
            { term: 'This', value: hash === null ? '[not shown]' : <HashChip value={hash} label="hash" /> },
          ]}
        />
        <Inline gap={2}>
          {record.seq > 1 ? (
            <Button size="sm" asChild>
              <a href={href.audit(filters, record.seq - 1)} aria-label={`Previous record, ${record.seq - 1}`}>
                <ChevronLeft aria-hidden="true" />
                {record.seq - 1}
              </a>
            </Button>
          ) : null}
          {record.seq < newestSeq ? (
            <Button size="sm" asChild>
              <a href={href.audit(filters, record.seq + 1)} aria-label={`Next record, ${record.seq + 1}`}>
                {record.seq + 1}
                <ChevronRight aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </Inline>
      </Stack>
      <Disclosure summary="Record as JSON">
        <CodeBlock label={`Record ${record.seq} as JSON`}>{text}</CodeBlock>
      </Disclosure>
      <Text tone="subtle" size="sm">
        Login records name the provider, never the 1Password item. Secret values are never written here.
      </Text>
    </Stack>
  )
}
