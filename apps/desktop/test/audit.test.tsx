import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuditEvent, AuditRecord } from '@valet/core'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { AuditQuery, ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: ValetApi) {
  window.location.hash = hash
  render(
    <TooltipProvider>
      <ApiProvider api={api} clock={{ now: () => NOW }}>
        <ControlPanel />
      </ApiProvider>
    </TooltipProvider>,
  )
}

function queries(api: FakeApi): AuditQuery[] {
  return api.fake.calls.filter((c) => c.method === 'audit.page').map((c) => c.args[0] as AuditQuery)
}

const inspector = () => screen.getByRole('region', { name: 'Record' })
// Role queries over a 50-row table are slow in jsdom; the row links carry data-row-link.
const rowAnchors = () => [...document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]')]
const rowLink = (seq: number) =>
  waitFor(
    () => {
      const link = rowAnchors().find((a) => a.textContent === `Record ${seq}`)
      if (link === undefined) throw new Error(`no row link for record ${seq}`)
      return link
    },
    { timeout: 3000 },
  )
const rowLinks = () => rowAnchors().map((a) => a.textContent?.replace('Record ', ''))

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
  { type: 'grant-copied', adapterId: 'woolworths', secret: 'login', fields: ['password'] },
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
  { type: 'call-waited', adapterId: 'woolworths', callId: 'c_1', reason: 'queue', waitedMs: 2000, ahead: 1 },
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
  { type: 'update-downloaded', from: '0.9.0', to: '0.9.1' },
  { type: 'update-installed', from: '0.9.0', to: '0.9.1' },
  { type: 'remote-state', state: 'paused', revokedTokens: 2 },
  { type: 'remote-tool', adapterId: 'woolworths', tool: 'get_cart', enabled: true, sideEffect: 'read' },
  { type: 'setting-changed', adapterId: 'woolworths', setting: 'store', cleared: false },
  {
    type: 'remote-consent',
    clientId: 'remote:abc',
    clientHost: 'claude.ai',
    source: null,
    tools: [],
    answer: 'declined',
  },
  { type: 'remote-revoked', clientId: null, clients: 3 },
  { type: 'remote-token-reuse', clientId: 'remote:abc', token: 'refresh' },
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

function withRecords(fake: FakeApi, records: readonly AuditRecord[]): FakeApi {
  return {
    ...fake,
    audit: {
      ...fake.audit,
      page: async () => ({ records, total: records.length, nextBeforeSeq: null }),
    },
  }
}

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
  it('is the Activity tab with its own address, heading and shortcut', async () => {
    renderAt('#/activity/audit', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' })).toBeTruthy()
    const tabs = screen.getByRole('navigation', { name: 'Activity' })
    expect(
      within(tabs)
        .getByRole('link', { name: /^Audit log/ })
        .getAttribute('aria-current'),
    ).toBe('page')
    expect(
      within(tabs)
        .getByRole('link', { name: /^Calls/ })
        .getAttribute('href'),
    ).toBe('#/activity/calls')
  })

  it('checks the chain now, and shows a broken chain with the way to where it broke', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit', api)
    expect(await screen.findByText('The audit log checks out up to record 4813.')).toBeTruthy()
    expect(screen.getByText('Checks out')).toBeTruthy()
    api.fake.breakChainAt(4799)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('The audit log doesn’t check out from record 4799.')).toBeTruthy()
    expect(screen.getByText('Doesn’t check out')).toBeTruthy()
    // Every record from the break on says so in words.
    expect(screen.getAllByText('Can’t be proved').length).toBeGreaterThan(0)
    const seeWhere = screen.getByRole('link', { name: 'See where' })
    expect(seeWhere.getAttribute('href')).toBe('#/activity/audit/4799')
    await user.click(seeWhere)
    expect(await within(inspector()).findByText('Record 4799')).toBeTruthy()
    expect(within(inspector()).getByText('Can’t be proved')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(api.fake.calls.filter((c) => c.method === 'audit.verify')).toHaveLength(2))
  })

  it('explains what the check proves', async () => {
    const user = userEvent.setup()
    renderAt('#/activity/audit', createFakeApi({ now: NOW }))
    await user.click(await screen.findByRole('button', { name: 'What this proves' }))
    expect(await screen.findByText(/needs an outside anchor/)).toBeTruthy()
  })

  it('reports a check that fails without its message', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit', api)
    await screen.findByText('The audit log checks out up to record 4813.')
    api.fake.failNext('audit.verify')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t check the chain. Try again.')
  })

  it('shows an unchecked chain as such, with Check now beside it', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt('#/activity/audit', {
      ...fake,
      audit: { ...fake.audit, chainStatus: async () => ({ state: 'unverified' }) },
    })
    expect(await screen.findByText('Not checked yet.')).toBeTruthy()
    expect(screen.getByText('Not checked yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy()
  })

  it('filters by category and site through the address, and by search', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit', api)
    await screen.findByText('The audit log checks out up to record 4813.')
    await user.click(screen.getByRole('button', { name: /^Category:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Login use' }))
    await waitFor(() => expect(window.location.hash).toBe('#/activity/audit?category=secret-use'))
    expect(await screen.findAllByText('Login typed')).toHaveLength(2)
    expect(screen.queryByText('Call started')).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Site:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Woolworths' }))
    await waitFor(() =>
      expect(window.location.hash).toBe('#/activity/audit?category=secret-use&site=woolworths'),
    )
    await user.type(screen.getByRole('searchbox', { name: 'Search the audit log' }), 'nothing-like-this')
    await waitFor(() =>
      expect(queries(api).at(-1)).toEqual({
        category: 'secret-use',
        adapterId: 'woolworths',
        search: 'nothing-like-this',
        limit: 50,
      }),
    )
    expect(await screen.findByText('No records match')).toBeTruthy()
    await user.click(screen.getAllByRole('link', { name: 'Clear filters' })[0] as HTMLElement)
    await waitFor(() => expect(window.location.hash).toBe('#/activity/audit'))
  })

  it('shows one call’s records from a call link, and links back to the call', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit?call=c_8f2e1b', api)
    await rowLink(4801)
    const calls = screen.getAllByRole('link', { name: 'Call C8F2' })
    expect(calls.length).toBe(rowLinks().length)
    expect(calls[0]?.getAttribute('href')).toBe('#/activity/calls/c_8f2e1b')
    expect(queries(api).at(-1)?.search).toBe('c_8f2e1b')
    expect(screen.getByRole('searchbox', { name: 'Search the audit log' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: 'Remove filter Call' }))
    await waitFor(() => expect(window.location.hash).toBe('#/activity/audit'))
  })

  it('describes every event type from its fields', async () => {
    renderAt('#/activity/audit', withRecords(createFakeApi({ now: NOW }), RECORDS))
    const table = await screen.findByRole('table', { name: 'Audit records' })
    const text = table.textContent ?? ''
    for (const expected of [
      'woolworths 0.4.0',
      'rejected',
      'login → 1Password app',
      'login → some-future-provider',
      'revoked',
      'copied from 1Password',
      'get_cart · “Claude Desktop”',
      '1Password / 1Password is locked',
      'Waited 2.0 s for its turn, 1 call ahead',
      'Started from the app',
      'Filling a secret / Wrong origin',
      'login.otp · auth.woolworths.com.au',
      'beyond the tool’s side effect',
      'page · blocked',
      'rate limited · until 10:00 pm',
      'calls allowed again',
      '0.9.0 → 0.9.1',
      'Paused · 2 tokens revoked',
      'get_cart allowed',
      'store chosen',
      'claude.ai declined',
      'All 3 removed',
      'A used refresh token came back; access revoked',
      'approved',
      // Plain words for the kinds.
      'Version approved',
      'Call failed',
      'Login failed',
      'Request blocked',
      'Stolen token refused',
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
    renderAt('#/activity/audit', api)
    await rowLink(900)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    expect(await rowLink(893)).toBeTruthy()
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
    renderAt('#/activity/audit', api)
    await rowLink(900)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await rowLink(895)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await rowLink(892)
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
    renderAt('#/activity/audit', api)
    const load = await screen.findByRole('button', { name: 'Load older records' })
    // Two clicks in the same frame, before React has re-rendered the button as busy.
    act(() => {
      load.click()
      load.click()
    })
    await act(async () => release())
    await rowLink(893)
    expect(older).toHaveLength(1)
    expect(rowAnchors().filter((a) => a.textContent === 'Record 896')).toHaveLength(1)
    expect(rowLinks()).toEqual(['900', '899', '898', '897', '896', '895', '894', '893'])
  })

  it('starts paging again from the new head when a record is appended, so none drops out of view', async () => {
    const user = userEvent.setup()
    const { api, append } = withLongLog(createFakeApi({ now: NOW }))
    renderAt('#/activity/audit', api)
    await rowLink(60)
    expect(rowLinks()).toHaveLength(50)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await waitFor(() => expect(rowLinks()).toHaveLength(60))

    // Record 61 arrives: the newest page is now 61..12. Record 11, which was the first older
    // record, must not vanish between the two lists.
    act(() => append())
    await rowLink(61)
    expect(rowLinks()).toHaveLength(50)
    expect(new Set(rowLinks()).size).toBe(50)
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await rowLink(11)
    expect(rowLinks()).toEqual(Array.from({ length: 61 }, (_, i) => String(61 - i)))
  })

  it('says so when older records, the export or the copy fail, without the error text', async () => {
    const user = userEvent.setup()
    const { api } = withLongLog(createFakeApi({ now: NOW }))
    renderAt('#/activity/audit/60', api)
    await rowLink(60)
    api.fake.failNext('audit.page')
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    expect(await screen.findByText('Couldn’t load older records. Try again.')).toBeTruthy()

    api.fake.failNext('audit.exportJsonl')
    await user.click(screen.getByRole('button', { name: 'Export…' }))
    expect(await screen.findByText('Couldn’t export the log. Try again.')).toBeTruthy()

    api.fake.failNext('app.copyText')
    await user.click(within(inspector()).getByRole('button', { name: 'Copy record' }))
    expect(await screen.findByText('Couldn’t copy the record. Try again.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('fake ')
  })

  it('never marks a record appended after the last check as verified', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit', api)
    await user.click(await rowLink(4813))
    expect(await within(inspector()).findByText('In the verified chain')).toBeTruthy()

    act(() => {
      api.fake.appendAudit({ type: 'breaker-closed', host: 'www.coles.com.au' })
    })
    await user.click(await rowLink(4814))
    await within(inspector()).findByText('Record 4814')
    expect(within(inspector()).queryByText('In the verified chain')).toBeNull()
    expect(within(inspector()).getByText('Appended since the last check')).toBeTruthy()
    expect(screen.getByText('Records after 4813 were appended since and aren’t checked yet.')).toBeTruthy()

    // The record at the head the check covered is still verified.
    await user.click(within(inspector()).getByRole('link', { name: 'Previous record, 4813' }))
    expect(await within(inspector()).findByText('In the verified chain')).toBeTruthy()
  })

  it('drops an earlier check once a record is appended, and a new check covers it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit', api)
    await screen.findByText('The audit log checks out up to record 4813.')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(api.fake.calls.some((c) => c.method === 'audit.verify')).toBe(true))

    act(() => {
      api.fake.appendAudit({ type: 'breaker-closed', host: 'www.coles.com.au' })
    })
    expect(
      await screen.findByText('Records after 4813 were appended since and aren’t checked yet.'),
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('The audit log checks out up to record 4814.')).toBeTruthy()
    expect(screen.queryByText(/were appended since/)).toBeNull()
    await user.click(await rowLink(4814))
    expect(await within(inspector()).findByText('In the verified chain')).toBeTruthy()
  })

  it('inspects a record, links to its site and call, walks the chain, and copies it through the main process', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit/4433', api)
    expect(await within(inspector()).findByText('Record 4433')).toBeTruthy()
    expect(within(inspector()).getByRole('link', { name: 'Open Woolworths' }).getAttribute('href')).toBe(
      '#/sites/woolworths',
    )
    expect(
      within(inspector()).getByRole('link', { name: 'Previous record, 4432' }).getAttribute('href'),
    ).toBe('#/activity/audit/4432')
    expect(within(inspector()).getByRole('link', { name: 'Next record, 4434' }).getAttribute('href')).toBe(
      '#/activity/audit/4434',
    )
    await user.click(within(inspector()).getByRole('button', { name: 'Record as JSON' }))
    expect(inspector().textContent).toContain('"type": "grant-made"')
    await user.click(within(inspector()).getByRole('button', { name: 'Copy record' }))
    const copied = api.fake.calls.find((c) => c.method === 'app.copyText')?.args[0] as string
    expect(JSON.parse(copied).seq).toBe(4433)
    await user.click(screen.getByRole('button', { name: 'Export…' }))
    expect(api.fake.calls.some((c) => c.method === 'audit.exportJsonl')).toBe(true)
  })

  it('opens the call a record belongs to', async () => {
    renderAt('#/activity/audit/4801', createFakeApi({ now: NOW }))
    const open = await within(await screen.findByRole('region', { name: 'Record' })).findByRole('link', {
      name: 'Open call C8F2',
    })
    expect(open.getAttribute('href')).toBe('#/activity/calls/c_8f2e1b')
  })

  it('loads a selected record that isn’t on the loaded page, and says so when there is none', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/audit/4612?category=logins', api)
    expect(await within(inspector()).findByText('Record 4612')).toBeTruthy()
    expect(queries(api).some((q) => q.beforeSeq === 4613 && q.limit === 1)).toBe(true)
    document.body.innerHTML = ''
    renderAt('#/activity/audit/2', createFakeApi({ now: NOW }))
    expect(await screen.findByText('The audit log has no record 2.')).toBeTruthy()
  })

  it('says so when the log can’t be read', async () => {
    const fake = createFakeApi({ now: NOW })
    fake.fake.failNext('audit.page')
    renderAt('#/activity/audit', fake)
    expect(await screen.findByText('Couldn’t read the audit log.')).toBeTruthy()
  })

  it('shows and copies only the audit fields core defines, even when a record carries more', async () => {
    const user = userEvent.setup()
    const CANARY = 'canary-7f3a91-SECRET'
    const fake = createFakeApi({ now: NOW })
    const leaky = RECORDS.map(
      (r) =>
        ({
          ...r,
          token: CANARY,
          event: { ...r.event, password: CANARY, value: CANARY },
        }) as unknown as AuditRecord,
    )
    renderAt('#/activity/audit', withRecords(fake, leaky))
    for (const record of leaky) {
      await user.click(await rowLink(record.seq))
      await within(inspector()).findByText(`Record ${record.seq}`)
      const json = within(inspector()).getByRole('button', { name: 'Record as JSON' })
      if (json.getAttribute('aria-expanded') !== 'true') await user.click(json)
      expect(inspector().textContent).toContain(`"type": "${record.event.type}"`)
      await user.click(within(inspector()).getByRole('button', { name: 'Copy record' }))
    }
    expect(document.documentElement.innerHTML).not.toContain(CANARY)
    const copies = fake.fake.calls.filter((c) => c.method === 'app.copyText').map((c) => c.args[0])
    expect(copies).toHaveLength(leaky.length)
    for (const copy of copies) expect(copy).not.toContain(CANARY)
  })

  it('shows a defined audit field only if it holds the kind of value core writes there', async () => {
    const user = userEvent.setup()
    const CANARY = 'canary-7f3a91-SECRET'
    const fake = createFakeApi({ now: NOW })
    const odd = {
      seq: 7001,
      at: new Date(NOW).toISOString(),
      event: {
        type: 'grant-made',
        adapterId: 'woolworths',
        adapterHash: 'aa'.repeat(32),
        secret: 'login',
        provider: 'onepassword-cli',
        origins: [{ password: CANARY }],
      },
      prev: { value: CANARY },
      hash: 'cc'.repeat(32),
    } as unknown as AuditRecord
    renderAt('#/activity/audit/7001', withRecords(fake, [odd]))
    await within(inspector()).findByText('Record 7001')
    await user.click(within(inspector()).getByRole('button', { name: 'Record as JSON' }))
    expect(inspector().textContent).toContain('"origins": "[not shown]"')
    expect(inspector().textContent).toContain('"prev": "[not shown]"')
    await user.click(within(inspector()).getByRole('button', { name: 'Copy record' }))
    expect(JSON.stringify(fake.fake.calls)).not.toContain(CANARY)
    expect(document.documentElement.innerHTML).not.toContain(CANARY)
  })
})
