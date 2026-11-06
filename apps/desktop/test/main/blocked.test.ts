// @vitest-environment node
// The driver's refusals outside a run, written to the audit: each target through the runtime's
// redaction for targets, the login secrets kept for it, and the cap between runs.

import {
  type AuditEvent,
  type AuditRecord,
  type BlockedRequest,
  parseManifest,
  SecretValue,
} from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import {
  BETWEEN_RUNS_CAP,
  BETWEEN_RUNS_WINDOW_MS,
  BlockedAudit,
  LoginSecrets,
  MAX_SESSION_VALUES,
} from '../../src/main/core/blocked'
import { SHOP } from './fixtures'

const manifest = parseManifest(SHOP)
const report = (target: string, extra: Partial<BlockedRequest> = {}): BlockedRequest => ({
  method: 'GET',
  target,
  reason: 'host-not-allowed',
  initiator: 'page',
  ...extra,
})

function setup(options: { values?: () => Promise<readonly string[]>; failAppend?: boolean } = {}) {
  const events: AuditEvent[] = []
  const diagnostics: { type: string; adapterId: string }[] = []
  let now = 0
  const secrets = new LoginSecrets()
  const audit = new BlockedAudit({
    audit: {
      async append(event): Promise<AuditRecord> {
        if (options.failAppend === true) throw new Error('disk full')
        events.push(event)
        return { seq: events.length, at: '', event, prev: '', hash: '' }
      },
    },
    secrets,
    adapter: (id) =>
      id === 'shop'
        ? { manifest, sessionValues: options.values ?? (async () => ['CookieValue12345']) }
        : null,
    now: () => now,
    diagnostics: (d) => diagnostics.push(d),
  })
  return { events, diagnostics, secrets, audit, advance: (ms: number) => (now += ms) }
}

describe('LoginSecrets', () => {
  it('counts a login’s secrets at once, and keeps a successful one’s in place of the earlier', () => {
    const secrets = new LoginSecrets()
    const first = secrets.begin('shop')
    const password = SecretValue.fromString('hunter2-password')
    first.register(password)
    password.dispose()
    expect(secrets.occursIn('shop', 'x hunter2-password y')).toBe(true)
    expect(secrets.occursIn('other', 'hunter2-password')).toBe(false)
    first.finish('ok')
    const second = secrets.begin('shop')
    second.register(SecretValue.fromString('second-password'))
    expect(secrets.occursIn('shop', 'hunter2-password')).toBe(true)
    second.finish('ok')
    expect(secrets.occursIn('shop', 'hunter2-password')).toBe(false)
    expect(secrets.occursIn('shop', 'second-password')).toBe(true)
    // A second finish changes nothing.
    first.finish('ok')
    expect(secrets.occursIn('shop', 'second-password')).toBe(true)
  })

  it('forgets a failed login that filled nothing, and keeps one handed to the person', () => {
    const secrets = new LoginSecrets()
    const failed = secrets.begin('shop')
    failed.finish('failed')
    const handed = secrets.begin('shop')
    handed.register(SecretValue.fromString('typed-before-captcha'))
    handed.finish('needs-user')
    const failedAfterTyping = secrets.begin('shop')
    failedAfterTyping.register(SecretValue.fromString('typed-then-refused'))
    failedAfterTyping.finish('failed')
    expect(secrets.occursIn('shop', 'typed-before-captcha')).toBe(true)
    expect(secrets.occursIn('shop', 'typed-then-refused')).toBe(true)
  })

  it('keeps a bounded number of sets, and disposes all of them at the end', () => {
    const secrets = new LoginSecrets()
    const first = secrets.begin('shop')
    first.register(SecretValue.fromString('oldest-secret'))
    for (let i = 0; i < 4; i++) secrets.begin('shop').register(SecretValue.fromString(`later-${i}-secret`))
    expect(secrets.occursIn('shop', 'oldest-secret')).toBe(false)
    expect(secrets.occursIn('shop', 'later-3-secret')).toBe(true)
    // A set that was dropped can no longer finish into place.
    first.finish('ok')
    expect(secrets.occursIn('shop', 'later-3-secret')).toBe(true)
    secrets.dispose()
    expect(secrets.occursIn('shop', 'later-3-secret')).toBe(false)
  })

  it('never drops the latest successful login’s set for pending ones', () => {
    const secrets = new LoginSecrets()
    const ok = secrets.begin('shop')
    ok.register(SecretValue.fromString('session-login-secret'))
    ok.finish('ok')
    for (let i = 0; i < 6; i++) {
      const pending = secrets.begin('shop')
      pending.register(SecretValue.fromString(`handed-${i}-secret`))
      pending.finish('needs-user')
    }
    expect(secrets.occursIn('shop', 'session-login-secret')).toBe(true)
    expect(secrets.occursIn('shop', 'handed-5-secret')).toBe(true)
    // The oldest pending ones went instead.
    expect(secrets.occursIn('shop', 'handed-0-secret')).toBe(false)
    // A later success replaces it as the one kept.
    const next = secrets.begin('shop')
    next.register(SecretValue.fromString('next-login-secret'))
    next.finish('ok')
    expect(secrets.occursIn('shop', 'session-login-secret')).toBe(false)
    expect(secrets.occursIn('shop', 'next-login-secret')).toBe(true)
  })
})

describe('BlockedAudit', () => {
  it('writes an auth page’s refusals with its call, and reports a dropped budget as a diagnostic', async () => {
    const s = setup()
    const options = s.audit.authPage('shop', 'call_1')
    options.onBlocked?.(report('https://frames.example'))
    options.onReportsDropped?.()
    await s.audit.settled()
    expect(s.events).toEqual([
      {
        type: 'request-blocked',
        adapterId: 'shop',
        method: 'GET',
        target: 'https://frames.example',
        reason: 'host-not-allowed',
        initiator: 'page',
        partition: 'auth',
        callId: 'call_1',
      },
    ])
    expect(s.diagnostics).toEqual([{ type: 'auth-reports-dropped', adapterId: 'shop' }])
  })

  it('redacts a target holding a session value (in any case) or a login secret, whole', async () => {
    const s = setup()
    const run = s.secrets.begin('shop')
    run.register(SecretValue.fromString('S3cretPassword'))
    const auth = s.audit.authPartition('shop')
    auth(report('https://cookievalue12345.evil.test'))
    auth(report('https://evil.test/S3cretPassword'))
    // A secret lower-cased into a hostname isn't caught (the runtime's limit too).
    auth(report('https://s3cretpassword.evil.test'))
    auth(report('https://evil.test/fine'))
    await s.audit.settled()
    expect(s.events.map((e) => (e.type === 'request-blocked' ? e.target : null))).toEqual([
      '[redacted]',
      '[redacted]',
      'https://s3cretpassword.evil.test',
      'https://evil.test/fine',
    ])
  })

  it('withholds the target when the session values can’t be read, or it isn’t text', async () => {
    const s = setup({
      values: async () => {
        throw new Error('driver closed')
      },
    })
    s.audit.betweenRuns('shop')(report('https://evil.test'))
    s.audit.betweenRuns('shop')({ ...report('x'), target: 42 as unknown as string })
    await s.audit.settled()
    expect(
      s.events.map((e) => (e.type === 'request-blocked' ? [e.target, e.partition, e.callId] : null)),
    ).toEqual([
      ['[redacted]', 'tool', null],
      ['[redacted]', 'tool', null],
    ])
  })

  it('keeps method, reason and initiator to printable codes', async () => {
    const s = setup()
    s.audit.betweenRuns('shop')({
      method: 'P\u0000OST',
      target: 'https://evil.test',
      reason: '‮' as BlockedRequest['reason'],
      initiator: 'other' as BlockedRequest['initiator'],
    })
    s.audit.betweenRuns('shop')({ ...report('https://evil.test'), method: 7 as unknown as string })
    s.audit.betweenRuns('shop')(report('https://evil.test', { initiator: 'tool' }))
    await s.audit.settled()
    expect(
      s.events.map((e) => (e.type === 'request-blocked' ? [e.method, e.reason, e.initiator] : null)),
    ).toEqual([
      ['POST', '(invalid)', 'page'],
      ['(invalid)', 'host-not-allowed', 'page'],
      ['GET', 'host-not-allowed', 'tool'],
    ])
  })

  it('caps the tool partition between runs per window, saying so once', async () => {
    const s = setup()
    const report1 = s.audit.betweenRuns('shop')
    for (let i = 0; i < BETWEEN_RUNS_CAP + 5; i++) report1(report(`https://evil.test/${i}`))
    await s.audit.settled()
    expect(s.events).toHaveLength(BETWEEN_RUNS_CAP)
    expect(s.diagnostics).toEqual([{ type: 'request-blocked-capped', adapterId: 'shop' }])
    s.advance(BETWEEN_RUNS_WINDOW_MS)
    report1(report('https://evil.test/later'))
    await s.audit.settled()
    expect(s.events).toHaveLength(BETWEEN_RUNS_CAP + 1)
  })

  it('reads the session values when the refusal is reported, and keeps every value it read', async () => {
    let cookie = 'FirstCookieValue1'
    let reads = 0
    const s = setup({
      values: async () => {
        reads++
        return [cookie]
      },
    })
    const between = s.audit.betweenRuns('shop')
    between(report('https://firstcookievalue1.evil.test'))
    expect(reads).toBe(1)
    // Rotated before the write's turn, and again before the next report.
    cookie = 'SecondCookieValue2'
    between(report('https://evil.test/FirstCookieValue1'))
    between(report('https://evil.test/SecondCookieValue2'))
    await s.audit.settled()
    expect(s.events.map((e) => (e.type === 'request-blocked' ? e.target : null))).toEqual([
      '[redacted]',
      '[redacted]',
      '[redacted]',
    ])
  })

  it('keeps a bounded number of session values, dropping the oldest', async () => {
    let batch = 0
    const s = setup({
      values: async () => {
        batch++
        return batch > 2
          ? []
          : Array.from({ length: 200 }, (_, i) => `Value${batch}x${String(i).padStart(4, '0')}`)
      },
    })
    const between = s.audit.betweenRuns('shop')
    for (const target of ['a', 'Value1x0001', 'Value1x0199', 'Value2x0001']) {
      between(report(`https://evil.test/${target}`))
      await s.audit.settled()
    }
    expect(MAX_SESSION_VALUES).toBe(256)
    expect(s.events.map((e) => (e.type === 'request-blocked' ? e.target : null))).toEqual([
      'https://evil.test/a',
      // The second batch pushed the first one's oldest 144 out.
      'https://evil.test/Value1x0001',
      '[redacted]',
      '[redacted]',
    ])
  })

  it('writes nothing for an adapter it doesn’t know, saying so, and survives a failed append', async () => {
    const s = setup()
    s.audit.authPartition('gone')(report('https://evil.test'))
    await s.audit.settled()
    expect(s.events).toEqual([])
    expect(s.diagnostics).toEqual([{ type: 'request-blocked-unattributed', adapterId: 'gone' }])
    const failing = setup({ failAppend: true })
    failing.audit.authPartition('shop')(report('https://evil.test'))
    failing.audit.authPartition('shop')(report('https://evil.test/2'))
    await failing.audit.settled()
    expect(failing.diagnostics).toEqual([
      { type: 'audit-write-failed', adapterId: 'shop' },
      { type: 'audit-write-failed', adapterId: 'shop' },
    ])
  })
})
