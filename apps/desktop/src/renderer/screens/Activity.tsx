// Activity and a run's trace (docs/mockups/run-trace.html): ensure → probe → login with redacted
// fills → hand-off → probe again → tool code and every request decision → redacted output.

import { useState } from 'react'
import type { RunTrace, TraceStep } from '../../shared/api'
import { Preview } from '../components/Preview'
import { Avatar, ClientName, Hash, Icon, LoadState, Segmented, SideEffect } from '../components/ui'
import { useLoad } from '../lib/api-context'
import { formatBytes, formatDuration, hostOf, plural } from '../lib/format'
import { href } from '../lib/router'
import {
  blockedExplanation,
  blockedWording,
  clientClaim,
  errorWording,
  FILL_CHECK_WORDING,
  needsUserWording,
  OUTCOME_WORDING,
  runTone,
  runWording,
  stageWording,
  waitWording,
} from '../lib/wording'

export function ActivityPage({ callId }: { readonly callId: string | null }) {
  const runs = useLoad((api) => api.runs.list({ limit: 1 }), [], ['runs-changed'])
  // With no call id, show the newest run.
  const selected = callId ?? (runs.status === 'ready' ? (runs.data[0]?.callId ?? null) : null)
  if (selected === null) {
    return (
      <>
        <div className="titlebar">
          <div className="title">Activity</div>
        </div>
        {runs.status === 'ready' ? (
          <div className="empty">No tool calls yet.</div>
        ) : (
          <LoadState loaded={runs} what="activity">
            {() => null}
          </LoadState>
        )}
      </>
    )
  }
  return <TraceView key={selected} callId={selected} />
}

function TraceView({ callId }: { readonly callId: string }) {
  const trace = useLoad((api) => api.runs.trace(callId), [callId], ['runs-changed'])
  const [view, setView] = useState<'timeline' | 'requests'>('timeline')
  const title =
    trace.status === 'ready' && trace.data !== null
      ? `${trace.data.summary.adapterId}.${trace.data.summary.tool}`
      : callId
  return (
    <>
      <div className="titlebar">
        <nav className="row" aria-label="Breadcrumb">
          <a className="muted" href={href.activity()}>
            Activity
          </a>
          <Icon name="chevron" size="sm" className="tertiary" />
          <span className="title mono">{title}</span>
        </nav>
        <div className="tools">
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'timeline', label: 'Timeline' },
              { value: 'requests', label: 'Requests' },
            ]}
          />
        </div>
      </div>
      <LoadState loaded={trace} what="this run">
        {(data) =>
          data === null ? (
            <div className="empty">No run with that call id.</div>
          ) : (
            <Trace trace={data} view={view} />
          )
        }
      </LoadState>
    </>
  )
}

function Trace({ trace, view }: { readonly trace: RunTrace; readonly view: 'timeline' | 'requests' }) {
  const { summary } = trace
  const steps =
    view === 'requests' ? trace.steps.filter((s) => s.type === 'request' || s.type === 'probe') : trace.steps
  const blocked = trace.steps.filter(
    (s): s is Extract<TraceStep, { type: 'request' }> => s.type === 'request' && s.decision === 'blocked',
  )
  const secrets = [...new Set(trace.secretsUsed.map((s) => s.secret))]
  return (
    <>
      <div className="run-head">
        <Avatar adapterId={summary.adapterId} name={summary.adapterName} />
        <div className="kpi">
          <span>Outcome</span>
          <strong className="row">
            <span className={`dot ${runTone(summary)}`} />
            {runWording(summary)}
          </strong>
        </div>
        <div className="kpi">
          <span>Client</span>
          <strong>
            <ClientName reported={summary.client} />
          </strong>
        </div>
        <div className="kpi">
          <span>Call</span>
          <strong className="mono small">{summary.callId}</strong>
        </div>
        <div className="kpi">
          <span>Adapter</span>
          <strong>
            {trace.adapterVersion} <Hash hash={trace.adapterHash} />
          </strong>
        </div>
        <div className="kpi">
          <span>Duration</span>
          <strong>{formatDuration(summary.durationMs)}</strong>
        </div>
        <div className="kpi">
          <span>Requests</span>
          <strong>
            {trace.requests.sent === null || trace.requests.probes === null
              ? `${trace.requests.blocked} blocked`
              : `${trace.requests.sent} sent (${plural(trace.requests.probes, 'probe')}) · ${trace.requests.blocked} blocked`}
          </strong>
        </div>
        <div className="kpi">
          <span>Secrets used</span>
          <strong className={secrets.length > 0 ? 'secret-text' : ''}>
            {secrets.length === 0
              ? 'none'
              : `${secrets.join(', ')} (${plural(trace.secretsUsed.length, 'field')})`}
          </strong>
        </div>
      </div>

      <div className="body">
        <div className="trace">
          <ol className="timeline" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {steps.map((step, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
              <Step key={i} step={step} />
            ))}
          </ol>
        </div>

        <aside
          className="inspector stack gap-3"
          style={{ alignContent: 'start', width: 360, overflowY: 'auto' }}
        >
          {blocked.length > 0 ? (
            <div>
              <div className="eyebrow">{blocked.length === 1 ? 'Blocked request' : 'Blocked requests'}</div>
              {blocked.map((b, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
                <div key={i} className="callout bad" style={{ marginTop: 6, padding: '9px 12px' }}>
                  <Icon name="shield" />
                  <div className="stack" style={{ gap: 3 }}>
                    <strong className="mono small">
                      {b.method} {b.target}
                    </strong>
                    <div className="xs">
                      {b.initiator === 'page' ? 'The site’s own page scripts' : 'Tool code'} asked for this.{' '}
                      {b.blockedReason !== null ? blockedExplanation(b.blockedReason) : ''} Reported as{' '}
                      <span className="mono">
                        {b.stage} / {b.blockedReason ?? 'blocked'}
                      </span>
                      .
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div>
            <div className="eyebrow">Input from the client</div>
            <Preview parts={trace.input} className="mono xs raw" />
          </div>
          <div>
            <div className="eyebrow row between">
              <span>Output sent to the client</span>
              {trace.outputBytes !== null ? (
                <span className="tertiary">{formatBytes(trace.outputBytes)}</span>
              ) : null}
            </div>
            {trace.output === null ? (
              <div className="xs muted" style={{ marginTop: 4 }}>
                No output:{' '}
                {summary.outcome === 'needsUser'
                  ? 'the call stopped to wait for you'
                  : `the call ended ${OUTCOME_WORDING[summary.outcome]}`}
                {summary.stage !== null && summary.errorClass !== null
                  ? ` (${stageWording(summary.stage)}: ${errorWording(summary.errorClass)})`
                  : ''}
                {summary.needsUser !== null ? ` (${needsUserWording(summary.needsUser).short})` : ''}. The
                client was told only the code.
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                <Preview parts={trace.output} />
              </div>
            )}
          </div>
          <div className="callout secret" style={{ padding: '9px 12px' }}>
            <Icon name="eye-off" />
            <div className="xs">
              Valet knows every secret it filled and the current cookie values, and replaces exact matches in
              results and traces before anything leaves the app.
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}

function Dur({ ms }: { readonly ms: number | null }) {
  return <span className="dur">{ms === null ? '' : formatDuration(ms)}</span>
}

function At({ ms }: { readonly ms: number }) {
  return <span className="t">{(ms / 1000).toFixed(3)}</span>
}

function Node({ tone }: { readonly tone: string }) {
  return (
    <span className="node">
      <span
        className={`dot ${tone}`}
        style={tone === 'secret' ? { background: 'var(--secret)' } : undefined}
      />
    </span>
  )
}

export function Step({ step }: { readonly step: TraceStep }) {
  switch (step.type) {
    case 'called':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="info" />
          <div className="label">
            Tool called by {clientClaim(step.client, 'inline')} <SideEffect purpose={step.sideEffect} />
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'probe':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone={step.loggedIn ? 'ok' : 'info'} />
          <div className="label">
            {step.afterHandoff ? 'Checked the login worked' : 'Checked whether you’re signed in'}:{' '}
            {step.loggedIn ? 'signed in' : 'not signed in'}
            <details className="tech">
              <summary className="xs muted">Details</summary>
              <div className="xs muted">
                {step.afterHandoff ? <code>assertLoggedIn</code> : <code>session.ensure()</code>}{' '}
                <span className={`partition ${step.partition}`}>{step.partition}</span>{' '}
                <code>GET {step.path}</code> → {step.status ?? 'no answer'}
              </div>
            </details>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'login-started':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="secret" />
          <div className="label">
            Login <span className="partition auth">auth</span>{' '}
            <span className="xs muted">declarative steps, no adapter code</span>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'auth-step':
      return (
        <li className="step sub">
          <At ms={step.atMs} />
          <Node tone="" />
          <div className="label">
            <code>{step.detail}</code>{' '}
            {step.skipped ? (
              <span className="xs muted">skipped</span>
            ) : step.op === 'goto' ? (
              <span className="xs ok-text">on allowlist</span>
            ) : null}
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'secret-fill':
      return (
        <li className="step sub">
          <At ms={step.atMs} />
          <Node tone="secret" />
          <div className="label">
            <code>
              fill({step.selector},{' '}
              <span className="redacted">
                secret:{step.secret}.{step.field}
              </span>
              )
            </code>
            <div className="checks">
              {step.checks.map((check) => (
                <span key={check}>
                  <Icon name="check" size="sm" />
                  {FILL_CHECK_WORDING[check]}
                  {check === 'frame-origin' ? ` ${hostOf(step.origin)}` : ''}
                </span>
              ))}
            </div>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'handoff':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="info" />
          <div className="label">
            Hand-off <span className="partition auth">auth</span> →{' '}
            <span className="partition tool">tool</span>{' '}
            <span className="xs muted">
              {plural(step.cookies, 'cookie')} on {step.cookieDomains.join(', ')},{' '}
              {plural(step.storageKeys, 'storage key')}. Nothing flows back.
            </span>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'tool-code':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="info" />
          <div className="label">
            Tool code <span className="partition tool">tool</span>{' '}
            <span className="xs muted">utility process</span>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'request':
      return (
        <li className={`step sub${step.decision === 'blocked' ? ' blocked' : ''}`}>
          <At ms={step.atMs} />
          <Node tone={step.decision === 'blocked' ? 'bad' : 'ok'} />
          <div className="label req">
            <span className="m">{step.method}</span>
            <code className="truncate">{step.target}</code>
            {step.decision === 'blocked' ? (
              <span className="xs danger-text">
                <strong>blocked</strong> ·{' '}
                {step.blockedReason !== null ? blockedWording(step.blockedReason) : 'refused'}
                {step.initiator === 'page' ? ' · page script' : ''}
              </span>
            ) : (
              <span className="xs ok-text">
                allowed{step.purpose !== null ? ` · ${step.purpose}` : ''}
                {step.status !== null ? ` · ${step.status}` : ''}
              </span>
            )}
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'waited':
      return (
        <li className="step sub">
          <At ms={step.atMs} />
          <Node tone="info" />
          <div className="label">
            {waitWording(step.reason, step.waitedMs, step.ahead)}
            <div className="xs muted">
              {step.reason === 'queue'
                ? 'Valet runs one call at a time for each shop, in the order they arrive.'
                : 'Valet spaces requests to the shop out, as a person browsing would.'}
            </div>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'confirmation':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone={step.answer === 'approved' ? 'ok' : 'warn'} />
          <div className="label">
            You{' '}
            {step.answer === 'approved'
              ? 'approved'
              : step.answer === 'declined'
                ? 'declined'
                : 'didn’t answer'}{' '}
            the confirmation
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'needs-user':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="warn" />
          <div className="label">
            Needs you: {needsUserWording(step.reason).short}
            <div className="xs muted">{needsUserWording(step.reason).detail}</div>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'failed':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="bad" />
          <div className="label">
            Stopped at {stageWording(step.stage)}: {errorWording(step.errorClass)}
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
    case 'output':
      return (
        <li className="step phase">
          <At ms={step.atMs} />
          <Node tone="ok" />
          <div className="label">
            Output redacted and returned{' '}
            <span className="xs muted">
              {step.redactions === 0
                ? 'nothing to replace'
                : `${plural(step.redactions, 'exact match', 'exact matches')} replaced`}
            </span>
          </div>
          <Dur ms={step.durationMs} />
        </li>
      )
  }
}
