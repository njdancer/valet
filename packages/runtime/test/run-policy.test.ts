// The driver's run policy: every request in the tool partition, from tool code or the site's own
// scripts, is held to it between beginRun() and endRun(), and what the driver refuses is reported
// back. Each test here is either the policy being set up wrongly, or something trying to get past it.

import { defineAdapter, type ToolContext, tool } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_BLOCKED_EVENTS_PER_CALL } from '../src/tool-host'
import { akamaiDenied, flush } from './fakes'
import { COOKIE, call, fixture, HOME, manifest } from './fixtures'

/** An adapter whose one tool runs `body` and returns whatever it returns. */
function adapterRunning(
  body: (ctx: ToolContext) => Promise<unknown>,
  sideEffect: 'read' | 'write' | 'irreversible' = 'read',
) {
  return defineAdapter({
    manifest: { ...manifest, tools: [{ ...manifest.tools[0]!, sideEffect }] },
    tools: { run_test: tool({ input: z.object({}), output: z.unknown(), run: (ctx) => body(ctx) }) },
  })
}

describe('beginRun and endRun', () => {
  it('holds the run to the manifest’s egress, request surface plus the probe, side effect and ceiling', async () => {
    const { host, driver } = fixture(adapterRunning(async () => 'ok', 'write'))
    await host.call(call)

    expect(driver.policies).toEqual([
      {
        egress: ['www.example.com', 'cdn.example.com'],
        requests: [...manifest.requests, { method: 'GET', path: '/api/session', purpose: 'read' }],
        maxPurpose: 'write',
        ceiling: 5,
      },
    ])
  })

  it('begins before the tool page opens and ends after the call', async () => {
    const order: string[] = []
    const { host, driver } = fixture(
      adapterRunning(async () => {
        order.push('tool')
        return 'ok'
      }),
    )
    const toolPage = driver.toolPage.bind(driver)
    driver.toolPage = async () => {
      order.push(`page:${driver.runEvents.join(',')}`)
      return toolPage()
    }
    await host.call(call)

    expect(order).toEqual(['page:begin', 'tool'])
    expect(driver.runEvents).toEqual(['begin', 'end'])
  })

  it('does not begin a run for a call refused before it starts', async () => {
    const { host, driver } = fixture(
      adapterRunning(async () => 'ok'),
      {
        approvals: { isApproved: async () => false },
      },
    )
    await host.call(call)
    expect(driver.runEvents).toEqual([])
  })

  it('collects the session values before the run begins, so refusals while the page opens are redacted', async () => {
    const { host, driver, audit } = fixture(adapterRunning(async () => 'ok'))
    const order: string[] = []
    const sessionSecrets = driver.sessionSecrets.bind(driver)
    driver.sessionSecrets = (domains, storage) => {
      order.push(`secrets:${driver.runEvents.join(',')}`)
      return sessionSecrets(domains, storage)
    }
    const toolPage = driver.toolPage.bind(driver)
    driver.toolPage = async () => {
      // The page loads home under the run policy; something on it is refused.
      driver.onBlocked?.({
        method: 'GET',
        target: `https://t.example.net/${COOKIE}`,
        reason: 'host-not-allowed',
        initiator: 'page',
      })
      return toolPage()
    }
    await host.call(call)

    expect(order[0]).toBe('secrets:')
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'request-blocked', target: '[redacted]' }),
    )
    expect(JSON.stringify(audit.events)).not.toContain(COOKIE)
  })

  it('does not begin a run when the session values cannot be read', async () => {
    const { host, driver } = fixture(adapterRunning(async () => 'ok'))
    driver.sessionSecrets = async () => {
      throw new Error('partition gone')
    }
    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
    expect(driver.runEvents).toEqual([])
  })

  it('does not run the tool when the driver cannot start the run, and never ends what never began', async () => {
    let ran = false
    const { host, driver } = fixture(
      adapterRunning(async () => {
        ran = true
        return 'ok'
      }),
    )
    driver.beginRun = () => {
      throw new Error('session gone https://www.example.com/?token=abc')
    }

    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'egress', errorClass: 'internal' })
    expect(ran).toBe(false)
    expect(driver.runEvents).toEqual([])
  })

  it('does not run an irreversible tool when the unlock fails, and still ends the run', async () => {
    let ran = false
    const { host, driver } = fixture(
      adapterRunning(async () => {
        ran = true
        return 'ok'
      }, 'irreversible'),
    )
    driver.unlockIrreversible = () => {
      throw new Error('no such run')
    }

    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'egress', errorClass: 'internal' })
    expect(ran).toBe(false)
    expect(driver.runEvents).toEqual(['begin', 'end'])
  })

  it('returns the result even when ending the run throws', async () => {
    const { host, driver } = fixture(adapterRunning(async () => 'ok'))
    driver.endRun = () => {
      throw new Error('already ended')
    }
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ok' })
  })

  it('keeps the run (and its policy) going until a timed-out call’s page work settles', async () => {
    let finishGoto: () => void = () => {}
    const { host, driver, page, clock } = fixture(
      adapterRunning((ctx) => ctx.page.goto('/slow')),
      {
        timeoutMs: 1_000,
        settleTimeoutMs: 60_000,
      },
    )
    page.goto = (url: string) => {
      page.gotos.push(url)
      return new Promise<void>((resolve) => {
        finishGoto = resolve
      })
    }

    const running = host.call(call)
    await flush()
    await clock.advance(1_000)
    expect(await running).toMatchObject({ stage: 'timeout' })
    expect(driver.runEvents).toEqual(['begin'])

    finishGoto()
    await flush()
    expect(driver.runEvents).toEqual(['begin', 'end'])
  })
})

describe('what the driver refuses', () => {
  it('fails the call when a raw capability call of tool code was refused, even if it carries on', async () => {
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        // Only the requests the driver is handed through ToolPage.fetch/goto are initiator 'tool'.
        driver.onBlocked?.({
          method: 'GET',
          target: 'https://evil.test/collect',
          reason: 'host-not-allowed',
          initiator: 'tool',
        })
        return 'looks fine'
      }),
    )

    expect(await host.call(call)).toEqual({
      status: 'failed',
      stage: 'egress',
      errorClass: 'host-not-allowed',
    })
    expect(audit.events).toContainEqual({
      type: 'request-blocked',
      adapterId: 'example-shop',
      method: 'GET',
      target: 'https://evil.test/collect',
      reason: 'host-not-allowed',
      initiator: 'tool',
      partition: 'tool',
      callId: 'call-1',
    })
  })

  it('makes every capability refuse once the driver has refused tool code', async () => {
    const { host, driver, page } = fixture(
      adapterRunning(async (ctx) => {
        driver.onBlocked?.({
          method: 'POST',
          target: `${HOME}/api/trolley/update`,
          reason: 'purpose-exceeded',
          initiator: 'tool',
        })
        return ctx.page.fetch('/api/trolley').catch((error: { errorClass: string }) => error.errorClass)
      }),
    )

    expect(await host.call(call)).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'denied-path',
    })
    expect(page.toolFetches()).toEqual([])
  })

  it('fails the call when evaluate()d code fetches a denied path, which the driver reports as the page’s', async () => {
    const { host, driver, page } = fixture(
      adapterRunning(async (ctx) => {
        await ctx.page.evaluate("fetch('/api/checkout/place', { method: 'POST' })")
        return 'looks fine'
      }),
    )
    // The driver sees evaluate()d code's fetch exactly as it sees the site's own scripts'.
    page.evaluate = async (source: string) => {
      page.evaluated.push(source)
      driver.onBlocked?.({
        method: 'POST',
        target: `${HOME}/api/checkout/place`,
        reason: 'denied-path',
        initiator: 'page',
      })
      return null
    }

    expect(await host.call(call)).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'denied-path',
    })
  })

  for (const [reason, errorClass] of [
    ['denied-path', 'denied-path'],
    ['ambiguous-path', 'ambiguous-path'],
    ['purpose-exceeded', 'denied-path'],
  ] as const) {
    it(`fails the call for a page-initiated ${reason}: the site’s own scripts have no reason to cause one`, async () => {
      const { host, driver } = fixture(
        adapterRunning(async () => {
          driver.onBlocked?.({ method: 'POST', target: `${HOME}/api/x`, reason, initiator: 'page' })
          return 'ok'
        }),
      )
      expect(await host.call(call)).toEqual({ status: 'failed', stage: 'request-surface', errorClass })
    })
  }

  it('makes every capability refuse after a page-initiated denied path, so the code can’t keep probing', async () => {
    const { host, driver, page } = fixture(
      adapterRunning(async (ctx) => {
        driver.onBlocked?.({
          method: 'GET',
          target: `${HOME}/%2e%2e/payees/add`,
          reason: 'ambiguous-path',
          initiator: 'page',
        })
        const tries: string[] = []
        for (const path of ['/api/trolley', '/api/session']) {
          tries.push(
            await ctx.page.fetch(path).then(
              () => 'sent',
              (error: { errorClass: string }) => error.errorClass,
            ),
          )
        }
        return tries
      }),
    )

    expect(await host.call(call)).toMatchObject({ status: 'failed', errorClass: 'ambiguous-path' })
    expect(page.toolFetches()).toEqual([])
  })

  it('only records the site’s own refused requests to other hosts or undeclared endpoints', async () => {
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        driver.onBlocked?.({
          method: 'POST',
          target: 'https://analytics.tiktok.com/api/v2/pixel',
          reason: 'host-not-allowed',
          initiator: 'page',
        })
        driver.onBlocked?.({
          method: 'POST',
          target: `${HOME}/apis/ui/telemetry`,
          reason: 'undeclared',
          initiator: 'page',
        })
        driver.onBlocked?.({ method: 'GET', target: '(unparseable)', reason: 'bad-url', initiator: 'page' })
        return 'ok'
      }),
    )

    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ok' })
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'request-blocked', initiator: 'page', reason: 'host-not-allowed' }),
    )
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'request-blocked', initiator: 'page', reason: 'undeclared-request' }),
    )
  })

  it('ends the run when the page takes it over its ceiling', async () => {
    const { host, driver } = fixture(
      adapterRunning(async () => {
        driver.onBlocked?.({
          method: 'GET',
          target: `${HOME}/apis/ui/x`,
          reason: 'request-ceiling',
          initiator: 'page',
        })
        return 'ok'
      }),
    )
    expect(await host.call(call)).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'request-ceiling',
    })
  })

  it('never touches the site’s breaker: these are our refusals, not the site’s', async () => {
    let calls = 0
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        if (calls++ > 0) return 'ok'
        for (const reason of ['host-not-allowed', 'undeclared', 'denied-path', 'ambiguous-path'] as const) {
          driver.onBlocked?.({ method: 'GET', target: `${HOME}/${reason}`, reason, initiator: 'page' })
        }
        return 'ok'
      }),
    )
    await host.call(call)

    expect(audit.types()).not.toContain('breaker-opened')
    expect(await host.call({ ...call, callId: 'call-2' })).toEqual({ status: 'ok', output: 'ok' })
  })

  it('maps each refusal reason onto the error vocabulary', async () => {
    const reasons = [
      ['undeclared', 'undeclared-request'],
      ['denied-path', 'denied-path'],
      ['ambiguous-path', 'ambiguous-path'],
      ['purpose-exceeded', 'denied-path'],
      ['request-ceiling', 'request-ceiling'],
      ['bad-url', 'invalid'],
      ['something new', 'invalid'],
    ] as const
    for (const [reason, errorClass] of reasons) {
      const { host, driver } = fixture(
        adapterRunning(async () => {
          driver.onBlocked?.({
            method: 'GET',
            target: `${HOME}/x`,
            reason: reason as never,
            initiator: 'tool',
          })
          return 'ok'
        }),
      )
      expect(await host.call(call)).toMatchObject({ status: 'failed', errorClass })
    }
  })

  it('treats an initiator it does not recognise as tool code', async () => {
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        driver.onBlocked?.({
          method: 'GET',
          target: `${HOME}/x`,
          reason: 'undeclared',
          initiator: 'worker' as never,
        })
        return 'ok'
      }),
    )
    expect(await host.call(call)).toMatchObject({ status: 'failed', errorClass: 'undeclared-request' })
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'request-blocked', initiator: 'tool' }),
    )
  })

  it('redacts a session value in a reported target, whatever its case, and never echoes a bad method', async () => {
    const mixedCase = 'Sess-7D1F0c9A4b2E'
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        driver.onBlocked?.({
          method: `GET ${COOKIE}`,
          target: `https://${mixedCase.toLowerCase()}.evil.test/x`,
          reason: 'host-not-allowed',
          initiator: 'tool',
        })
        return 'ok'
      }),
    )
    driver.cookieValues = [COOKIE, mixedCase]
    await host.call(call)

    const blocked = audit.events.find((e) => e.type === 'request-blocked')
    expect(blocked).toMatchObject({ method: 'INVALID', target: '[redacted]' })
    expect(JSON.stringify(audit.events).toLowerCase()).not.toContain(mixedCase.toLowerCase())
  })

  it('caps how long a reported target can be', async () => {
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        driver.onBlocked?.({
          method: 'GET',
          target: `${HOME}/${'a'.repeat(1_000)}`,
          reason: 'undeclared',
          initiator: 'page',
        })
        return 'ok'
      }),
    )
    await host.call(call)
    const blocked = audit.events.find((e) => e.type === 'request-blocked') as { target: string }
    expect(blocked.target).toHaveLength(300)
  })

  it('records each distinct refusal once per call', async () => {
    const { host, driver, audit } = fixture(
      adapterRunning(async () => {
        for (let i = 0; i < 10; i++) {
          driver.onBlocked?.({
            method: 'GET',
            target: 'https://bat.bing.com/action',
            reason: 'host-not-allowed',
            initiator: 'page',
          })
        }
        return 'ok'
      }),
    )
    await host.call(call)
    expect(audit.types().filter((t) => t === 'request-blocked')).toHaveLength(1)
  })

  it('caps the refusals recorded per call, and says so once', async () => {
    const { host, driver, audit, diagnostics } = fixture(
      adapterRunning(async () => {
        for (let i = 0; i < MAX_BLOCKED_EVENTS_PER_CALL + 20; i++) {
          driver.onBlocked?.({
            method: 'GET',
            target: `https://t${i}.example.net/p`,
            reason: 'host-not-allowed',
            initiator: 'page',
          })
        }
        return 'ok'
      }),
    )
    await host.call(call)

    expect(audit.types().filter((t) => t === 'request-blocked')).toHaveLength(MAX_BLOCKED_EVENTS_PER_CALL)
    expect(diagnostics.mock.calls.filter(([d]) => d.type === 'request-blocked-capped')).toEqual([
      [{ type: 'request-blocked-capped', adapterId: 'example-shop', callId: 'call-1' }],
    ])
  })

  it('still records a refusal whose audit write fails as a diagnostic, not a thrown error', async () => {
    const { host, driver, audit, diagnostics } = fixture(
      adapterRunning(async () => {
        driver.onBlocked?.({ method: 'GET', target: `${HOME}/x`, reason: 'undeclared', initiator: 'page' })
        return 'ok'
      }),
    )
    audit.failNext = 'request-blocked'
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ok' })
    expect(diagnostics).toHaveBeenCalledWith({ type: 'audit-write-failed', event: 'request-blocked' })
  })
})

describe('the site refusing us during a run', () => {
  it('still trips the breaker through the guarded page, which the driver does not see', async () => {
    const { host, page } = fixture(adapterRunning(async (ctx) => ctx.page.fetch('/api/trolley')))
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)
    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 60_000 })
  })
})
