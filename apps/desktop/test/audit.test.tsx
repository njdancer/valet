import type { AuditEvent, AuditRecord } from '@siteadapter/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { AuditQuery } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: FakeApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ControlPanel />
    </ApiProvider>,
  )
}

function queries(api: FakeApi): AuditQuery[] {
  return api.fake.calls.filter((c) => c.method === 'audit.page').map((c) => c.args[0] as AuditQuery)
}

/** One record of every event type core defines, newest first. */
const EVERY_EVENT: AuditEvent[] = [
  {
    type: 'adapter-approved',
    adapterId: 'woolworths',
    adapterHash: WOOLWORTHS_HASH,
    version: '0.4.0',
    previousHash: WOOLWORTHS_HASH,
  },
  { type: 'adapter-rejected', adapterId: 'woolworths', adapterHash: WOOLWORTHS_HASH, version: '0.4.1' },
  {
    type: 'grant-made',
    adapterId: 'woolworths',
    adapterHash: WOOLWORTHS_HASH,
    secret: 'login',
    provider: 'onepassword-cli',
    origins: ['https://auth.woolworths.com.au'],
  },
  {
    type: 'grant-made',
    adapterId: 'woolworths',
    adapterHash: WOOLWORTHS_HASH,
    secret: 'login',
    provider: 'some-future-provider',
    origins: [],
  },
  { type: 'grant-revoked', adapterId: 'woolworths', secret: 'login' },
  {
    type: 'tool-called',
    adapterId: 'woolworths',
    adapterHash: WOOLWORTHS_HASH,
    tool: 'get_cart',
    client: 'claude-ai',
    callId: 'c_1',
  },
  {
    type: 'tool-finished',
    adapterId: 'woolworths',
    callId: 'c_1',
    outcome: 'failed',
    stage: 'credential',
    errorClass: 'locked',
    durationMs: 900,
  },
  { type: 'login-started', adapterId: 'woolworths', callId: null },
  {
    type: 'login-finished',
    adapterId: 'woolworths',
    outcome: 'failed',
    stage: 'secret-fill',
    errorClass: 'origin-mismatch',
  },
  {
    type: 'secret-used',
    adapterId: 'woolworths',
    adapterHash: WOOLWORTHS_HASH,
    secret: 'login',
    field: 'otp',
    origin: 'https://auth.woolworths.com.au',
    callId: null,
  },
  {
    type: 'request-blocked',
    adapterId: 'woolworths',
    method: 'GET',
    target: 'https://www.woolworths.com.au/apis/ui/x',
    reason: 'purpose-exceeded',
    initiator: 'tool',
    partition: 'tool',
    callId: 'c_1',
  },
  {
    type: 'request-blocked',
    adapterId: 'woolworths',
    method: 'GET',
    target: 'https://x.example/',
    reason: 'something-new',
    initiator: 'page',
    partition: 'tool',
    callId: 'c_1',
  },
  {
    type: 'breaker-opened',
    host: 'www.woolworths.com.au',
    cause: 'rate-limited',
    retryAt: '2026-11-07T11:00:00Z',
    callId: null,
  },
  { type: 'breaker-closed', host: 'www.woolworths.com.au' },
  {
    type: 'confirmation',
    adapterId: 'woolworths',
    tool: 'checkout',
    client: 'claude-code',
    callId: 'c_2',
    answer: 'approved',
  },
]

const RECORDS: AuditRecord[] = EVERY_EVENT.map((event, i) => ({
  seq: 900 - i,
  at: new Date(NOW - i * 60_000).toISOString(),
  event,
  prev: `${String(i + 1).padStart(2, '0')}`.repeat(32),
  hash: `${String(i).padStart(2, '0')}`.repeat(32),
}))

/** A breaker-closed record at `seq`, for logs longer than one page. */
function closed(seq: number): AuditRecord {
  return {
    seq,
    at: new Date(NOW - (100 - seq) * 1000).toISOString(),
    event: { type: 'breaker-closed', host: 'www.coles.com.au' },
    prev: 'aa'.repeat(32),
    hash: 'bb'.repeat(32),
  }
}

/** The fake with an audit log of records 1..60, paged newest first as the main process pages it. */
function withLongLog(fake: FakeApi): { readonly api: FakeApi; readonly append: () => void } {
  const log = Array.from({ length: 60 }, (_, i) => closed(i + 1))
  const api: FakeApi = {
    ...fake,
    audit: {
      ...fake.audit,
      page: async (query) => {
        // Through the fake first, so failNext('audit.page') and the call log still work.
        await fake.audit.page(query)
        const matching = [...log]
          .sort((a, b) => b.seq - a.seq)
          .filter((r) => query.beforeSeq === undefined || r.seq < query.beforeSeq)
        const records = matching.slice(0, query.limit ?? 50)
        const last = records.at(-1)
        return {
          records,
          total: log.length,
          nextBeforeSeq: matching.length > records.length && last !== undefined ? last.seq : null,
        }
      },
    },
  }
  const append = () => {
    log.push(closed(log.length + 1))
    fake.fake.emit({ type: 'audit-appended', seq: log.length })
  }
  return { api, append }
}

describe('the audit log', () => {
  it('verifies the chain and shows a broken chain plainly', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/audit', api)
    expect(await screen.findByText('Chain intact up to record 4813.')).toBeTruthy()
    api.fake.breakChainAt(4799)
    await user.click(screen.getByRole('button', { name: 'Verify chain' }))
    const alert = await screen.findByText('Chain broken at record 4799.')
    expect(alert.closest('.callout')?.className).toContain('bad')
    await user.click(screen.getByRole('button', { name: 'Show record 4800' }))
    expect(
      within(screen.getByRole('complementary', { name: 'Record' })).getByText('After the break'),
    ).toBeTruthy()
    // The sidebar learns of the break from the verify itself, not only at the next record (the e2e
    // suite found it still saying "not verified yet" beside a broken chain).
    await waitFor(() => expect(screen.getByText('Audit chain broken')).toBeTruthy())
  })

  it('reports a verify that fails without its message', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/audit', api)
    await screen.findByText('Chain intact up to record 4813.')
    api.fake.failNext('audit.verify')
    await user.click(screen.getByRole('button', { name: 'Verify chain' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t verify the chain. Try again.')
  })

  it('shows an unverified chain as such', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt('#/audit', {
      ...fake,
      audit: { ...fake.audit, chainStatus: async () => ({ state: 'unverified' }) },
    })
    expect(await screen.findByText('Not verified yet.')).toBeTruthy()
    expect(screen.getByText('Audit chain not verified yet')).toBeTruthy()
  })

  it('filters by category, adapter, client, period and search', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/audit', api)
    await screen.findByText('Chain intact up to record 4813.')
    await user.click(screen.getByRole('button', { name: 'Secret use' }))
    expect(await screen.findAllByText('secret-used')).toHaveLength(2)
    expect(screen.queryByText('tool-called')).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Adapter' }), 'woolworths')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Client' }), 'claude-code')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'any')
    await user.type(screen.getByRole('textbox', { name: 'Search the audit log' }), 'c_9')
    await waitFor(() =>
      expect(queries(api).at(-1)).toEqual({
        category: 'secret-use',
        adapterId: 'woolworths',
        client: 'claude-code',
        search: 'c_9',
        limit: 50,
      }),
    )
    expect(await screen.findByText('No records match.')).toBeTruthy()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'today')
    await waitFor(() => expect(queries(api).at(-1)?.since).toBe(new Date(NOW - 86_400_000).toISOString()))
  })

  it('describes every event type from its fields', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt('#/audit', {
      ...fake,
      audit: {
        ...fake.audit,
        page: async () => ({ records: RECORDS, total: RECORDS.length, nextBeforeSeq: null }),
      },
    })
    const table = await screen.findByRole('table')
    const text = table.textContent ?? ''
    for (const expected of [
      'woolworths 0.4.0',
      'rejected',
      'login → 1Password app',
      'login → some-future-provider',
      'revoked',
      'get_cart · “Claude Desktop”',
      '1Password / 1Password is locked',
      'Started from the app',
      'Filling a secret / Wrong origin',
      'login.otp · auth.woolworths.com.au',
      'beyond the tool’s side effect',
      'page · blocked',
      'rate limited · until 10:00 pm',
      'calls allowed again',
      'approved',
    ]) {
      expect(text).toContain(expected)
    }
  })

  it('loads older records on request, and hides the button once there are none left', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const pages: AuditQuery[] = []
    const api: FakeApi = {
      ...fake,
      audit: {
        ...fake.audit,
        page: async (query) => {
          pages.push(query)
          return query.beforeSeq === undefined
            ? { records: RECORDS.slice(0, 5), total: RECORDS.length, nextBeforeSeq: 896 }
            : { records: RECORDS.slice(5, 8), total: RECORDS.length, nextBeforeSeq: null }
        },
      },
    }
    renderAt('#/audit', api)
    await screen.findByRole('button', { name: 'Show record 900' })
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    expect(await screen.findByRole('button', { name: 'Show record 893' })).toBeTruthy()
    expect(pages.at(-1)?.beforeSeq).toBe(896)
    expect(screen.queryByRole('button', { name: 'Load older records' })).toBeNull()
  })

  it('follows the cursor the main process returns, page after page', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const pages: AuditQuery[] = []
    const api: FakeApi = {
      ...fake,
      audit: {
        ...fake.audit,
        page: async (query) => {
          pages.push(query)
          if (query.beforeSeq === undefined)
            return { records: RECORDS.slice(0, 3), total: 9, nextBeforeSeq: 898 }
          if (query.beforeSeq === 898) return { records: RECORDS.slice(3, 6), total: 9, nextBeforeSeq: 895 }
          return { records: RECORDS.slice(6, 9), total: 9, nextBeforeSeq: null }
        },
      },
    }
    renderAt('#/audit', api)
    await screen.findByRole('button', { name: 'Show record 900' })
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await screen.findByRole('button', { name: 'Show record 895' })
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await screen.findByRole('button', { name: 'Show record 892' })
    expect(pages.map((q) => q.beforeSeq)).toEqual([undefined, 898, 895])
    expect(screen.queryByRole('button', { name: 'Load older records' })).toBeNull()
  })

  it('loads a page once however fast the button is clicked, with no repeated rows', async () => {
    const fake = createFakeApi({ now: NOW })
    let release: () => void = () => {}
    const older: AuditQuery[] = []
    const api: FakeApi = {
      ...fake,
      audit: {
        ...fake.audit,
        page: async (query) => {
          if (query.beforeSeq === undefined)
            return { records: RECORDS.slice(0, 5), total: 8, nextBeforeSeq: 896 }
          older.push(query)
          await new Promise<void>((resolve) => (release = resolve))
          // The main process overlaps pages by one here; the renderer still shows each record once.
          return { records: RECORDS.slice(4, 8), total: 8, nextBeforeSeq: null }
        },
      },
    }
    renderAt('#/audit', api)
    const load = await screen.findByRole('button', { name: 'Load older records' })
    // Two clicks in the same frame, before React has re-rendered the button as busy.
    act(() => {
      load.click()
      load.click()
    })
    await act(async () => release())
    await screen.findByRole('button', { name: 'Show record 893' })
    expect(older).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Show record 896' })).toHaveLength(1)
    const seqs = screen.getAllByRole('button', { name: /^Show record / }).map((b) => b.textContent)
    expect(seqs).toEqual(['900', '899', '898', '897', '896', '895', '894', '893'])
  })

  it('starts paging again from the new head when a record is appended, so none drops out of view', async () => {
    const user = userEvent.setup()
    const { api, append } = withLongLog(createFakeApi({ now: NOW }))
    renderAt('#/audit', api)
    await screen.findByRole('button', { name: 'Show record 60' })
    const shown = () => screen.getAllByRole('button', { name: /^Show record / }).map((b) => b.textContent)
    expect(shown()).toHaveLength(50)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await waitFor(() => expect(shown()).toHaveLength(60))

    // Record 61 arrives: the newest page is now 61..12. Record 11, which was the first older
    // record, must not vanish between the two lists.
    act(() => append())
    await screen.findByRole('button', { name: 'Show record 61' })
    expect(shown()).toHaveLength(50)
    expect(new Set(shown()).size).toBe(50)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await screen.findByRole('button', { name: 'Show record 11' })
    expect(shown()).toEqual(Array.from({ length: 61 }, (_, i) => String(61 - i)))
  })

  it('says so when older records, the export or the copy fail, without the error text', async () => {
    const user = userEvent.setup()
    const { api } = withLongLog(createFakeApi({ now: NOW }))
    renderAt('#/audit', api)
    await screen.findByRole('button', { name: 'Show record 60' })
    api.fake.failNext('audit.page')
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    expect(await screen.findByText('Couldn’t load older records. Try again.')).toBeTruthy()

    api.fake.failNext('audit.exportJsonl')
    await user.click(screen.getByRole('button', { name: 'Export JSONL' }))
    expect(await screen.findByText('Couldn’t export the log. Try again.')).toBeTruthy()

    api.fake.failNext('app.copyText')
    await user.click(screen.getByRole('button', { name: 'Copy record' }))
    expect(await screen.findByText('Couldn’t copy the record. Try again.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('fake ')
  })

  it('never marks a record appended after the last verification as verified', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/audit', api)
    await user.click(await screen.findByRole('button', { name: 'Show record 4813' }))
    const inspector = () => screen.getByRole('complementary', { name: 'Record' })
    expect(within(inspector()).getByText('In verified chain')).toBeTruthy()

    act(() => {
      api.fake.appendAudit({ type: 'breaker-closed', host: 'www.coles.com.au' })
    })
    await user.click(await screen.findByRole('button', { name: 'Show record 4814' }))
    expect(within(inspector()).queryByText('In verified chain')).toBeNull()
    expect(within(inspector()).getByText('Appended since the last check')).toBeTruthy()
    expect(screen.getByText('Records after 4813 were appended since and aren’t checked yet.')).toBeTruthy()

    // The record at the head the check covered is still verified.
    await user.click(screen.getByRole('button', { name: 'Show record 4813' }))
    expect(within(inspector()).getByText('In verified chain')).toBeTruthy()
  })

  it('drops an earlier Verify result once a record is appended, and a new Verify covers it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/audit', api)
    await screen.findByText('Chain intact up to record 4813.')
    await user.click(screen.getByRole('button', { name: 'Verify chain' }))
    await waitFor(() => expect(api.fake.calls.some((c) => c.method === 'audit.verify')).toBe(true))

    act(() => {
      api.fake.appendAudit({ type: 'breaker-closed', host: 'www.coles.com.au' })
    })
    expect(
      await screen.findByText('Records after 4813 were appended since and aren’t checked yet.'),
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Verify chain' }))
    expect(await screen.findByText('Chain intact up to record 4814.')).toBeTruthy()
    expect(screen.queryByText(/were appended since/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show record 4814' }))
    expect(
      within(screen.getByRole('complementary', { name: 'Record' })).getByText('In verified chain'),
    ).toBeTruthy()
  })

  it('inspects a record, links to its adapter, and copies it through the main process', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/audit', api)
    await user.click(await screen.findByRole('button', { name: 'Show record 4433' }))
    const inspector = screen.getByRole('complementary', { name: 'Record' })
    expect(within(inspector).getByText('Record 4433')).toBeTruthy()
    expect(inspector.textContent).toContain('"type": "grant-made"')
    expect(within(inspector).getByRole('link', { name: 'Open adapter' }).getAttribute('href')).toBe(
      '#/adapters/woolworths',
    )
    await user.click(within(inspector).getByRole('button', { name: 'Copy record' }))
    const copied = api.fake.calls.find((c) => c.method === 'app.copyText')?.args[0] as string
    expect(JSON.parse(copied).seq).toBe(4433)
    await user.click(screen.getByRole('button', { name: 'Export JSONL' }))
    expect(api.fake.calls.some((c) => c.method === 'audit.exportJsonl')).toBe(true)
  })

  it('says so when the log can’t be read', async () => {
    const fake = createFakeApi({ now: NOW })
    fake.fake.failNext('audit.page')
    renderAt('#/audit', fake)
    expect(await screen.findByText('Couldn’t read the audit log.')).toBeTruthy()
  })
})
