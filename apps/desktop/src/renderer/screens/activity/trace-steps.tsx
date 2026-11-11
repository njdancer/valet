// A call's trace steps (docs/mockups/run-trace.html): ensure → probe → login with redacted fills →
// hand-off → probe again → tool code and every request decision → redacted output. Each step is a
// Timeline item; the selected one opens in the inspector with what Valet checked and decided.
// Steps are built by the runtime from structured fields, never from page text.

import {
  CheckItem,
  CheckList,
  Code,
  DescriptionList,
  Heading,
  ObjectLink,
  RiskBadge,
  Stack,
  Text,
  type TimelineItem,
  Value,
} from '@valet/ui'
import type { ReactNode } from 'react'
import type { RunTrace, TraceStep } from '../../../shared/api'
import { formatDuration, hostOf, plural } from '../../lib/format'
import { href } from '../../lib/router'
import {
  blockedExplanation,
  blockedWording,
  clientClaim,
  errorWording,
  FILL_CHECK_WORDING,
  needsUserWording,
  stageWording,
  waitWording,
} from '../../lib/wording'

export type RequestStep = Extract<TraceStep, { type: 'request' }>

export function isRequest(step: TraceStep): step is RequestStep {
  return step.type === 'request'
}

export function isBlocked(step: TraceStep): step is RequestStep {
  return step.type === 'request' && step.decision === 'blocked'
}

/** "4.122 s": where in the call a step happened. */
export function offset(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`
}

function confirmationWords(answer: 'approved' | 'declined' | 'timed-out'): string {
  return answer === 'approved' ? 'approved' : answer === 'declined' ? 'declined' : 'didn’t answer'
}

/** One step as a Timeline item. */
export function stepItem(step: TraceStep, id: string): TimelineItem {
  const time = step.durationMs === null ? undefined : formatDuration(step.durationMs)
  const base = { id, time }
  switch (step.type) {
    case 'called':
      return {
        ...base,
        tone: 'accent',
        title: (
          <>
            Tool called by {clientClaim(step.client, 'inline')}{' '}
            <RiskBadge purpose={step.sideEffect} className="align-middle" />
          </>
        ),
      }
    case 'probe':
      return {
        ...base,
        tone: step.loggedIn ? 'success' : 'neutral',
        title: (
          <>
            {step.afterHandoff ? 'Checked the login worked' : 'Checked whether you’re signed in'}:{' '}
            <span className="font-semibold">{step.loggedIn ? 'signed in' : 'not signed in'}</span>
          </>
        ),
      }
    case 'login-started':
      return {
        ...base,
        kind: 'secret',
        title: 'Logged in',
        detail: 'Declarative steps, no adapter code',
      }
    case 'auth-step':
      return {
        ...base,
        tone: 'neutral',
        title: <Code>{step.detail}</Code>,
        detail: step.skipped ? 'skipped' : step.op === 'goto' ? 'on the allowlist' : undefined,
      }
    case 'secret-fill':
      return {
        ...base,
        kind: 'secret',
        title: `Typed the ${step.field} at ${hostOf(step.origin)}`,
        detail: (
          <Code>
            fill({step.selector}, secret:{step.secret}.{step.field})
          </Code>
        ),
      }
    case 'handoff':
      return {
        ...base,
        tone: 'accent',
        title: 'Handed the session to the tool',
        detail: `${plural(step.cookies, 'cookie')}, ${plural(step.storageKeys, 'storage key')}. Nothing flows back.`,
      }
    case 'tool-code':
      return { ...base, tone: 'accent', title: 'Ran the adapter’s tool code', detail: 'In its own process' }
    case 'request':
      return {
        ...base,
        kind: step.decision === 'blocked' ? 'blocked' : 'ok',
        title: (
          <Code>
            {step.method} {step.target}
          </Code>
        ),
        detail:
          step.decision === 'blocked' ? (
            <span className="font-medium text-warning-fg">
              Blocked · {step.blockedReason !== null ? blockedWording(step.blockedReason) : 'refused'}
              {step.initiator === 'page' ? ' · page script' : ''}
            </span>
          ) : (
            <span className="text-success-fg">
              Allowed{step.purpose !== null ? ` · ${step.purpose}` : ''}
              {step.status !== null ? ` · ${step.status}` : ''}
            </span>
          ),
      }
    case 'waited':
      return { ...base, kind: 'waiting', title: waitWording(step.reason, step.waitedMs, step.ahead) }
    case 'confirmation':
      return {
        ...base,
        ...(step.answer === 'approved' ? { kind: 'ok' as const } : { tone: 'warning' as const }),
        title: `You ${confirmationWords(step.answer)} the confirmation`,
      }
    case 'needs-user':
      return {
        ...base,
        kind: 'handoff',
        title: `Needs you: ${needsUserWording(step.reason).short}`,
        detail: needsUserWording(step.reason).detail,
      }
    case 'failed':
      return {
        ...base,
        kind: 'failed',
        title: `Stopped at ${stageWording(step.stage)}: ${errorWording(step.errorClass)}`,
      }
    case 'output':
      return {
        ...base,
        kind: 'ok',
        title: 'Output redacted and returned',
        detail:
          step.redactions === 0
            ? 'nothing to replace'
            : `${plural(step.redactions, 'exact match', 'exact matches')} replaced`,
      }
  }
}

const STEP_HEADINGS: Readonly<Record<TraceStep['type'], string>> = {
  called: 'Tool called',
  probe: 'Login check',
  'login-started': 'Login',
  'auth-step': 'Login step',
  'secret-fill': 'Typed a login',
  handoff: 'Session hand-off',
  'tool-code': 'Tool code',
  request: 'Request',
  waited: 'Waited',
  confirmation: 'Confirmation',
  'needs-user': 'Needs you',
  failed: 'Stopped',
  output: 'Output',
}

function stepFacts(step: TraceStep, trace: RunTrace): readonly { term: ReactNode; value: ReactNode }[] {
  const site = trace.summary.adapterId
  switch (step.type) {
    case 'called':
      return [
        { term: 'App', value: clientClaim(step.client) },
        { term: 'Side effect', value: <RiskBadge purpose={step.sideEffect} /> },
      ]
    case 'probe':
      return [
        { term: 'Result', value: step.loggedIn ? 'Signed in' : 'Not signed in' },
        {
          term: 'Request',
          value: (
            <Value mono copy={step.path}>
              GET {step.path}
            </Value>
          ),
        },
        { term: 'Answer', value: step.status === null ? 'No answer' : String(step.status) },
        { term: 'Checked in', value: <Code>{step.partition}</Code> },
        { term: 'How', value: <Code>{step.afterHandoff ? 'assertLoggedIn' : 'session.ensure()'}</Code> },
      ]
    case 'login-started':
      return [
        { term: 'How', value: 'The manifest’s declarative login steps, run by Valet, with no adapter code' },
      ]
    case 'auth-step':
      return [
        { term: 'Step', value: <Code>{step.detail}</Code> },
        { term: 'Result', value: step.skipped ? 'Skipped' : 'Done' },
      ]
    case 'secret-fill':
      return [
        {
          term: 'Login',
          value: (
            <ObjectLink href={href.login(site, step.secret)}>
              {step.secret} · {step.field}
            </ObjectLink>
          ),
        },
        {
          term: 'Where',
          value: (
            <Value mono copy={step.origin}>
              {step.origin}
            </Value>
          ),
        },
        { term: 'Into', value: <Code>{step.selector}</Code> },
      ]
    case 'handoff':
      return [
        { term: 'Cookies', value: `${step.cookies} on ${step.cookieDomains.join(', ') || 'no domain'}` },
        { term: 'Storage keys', value: String(step.storageKeys) },
        { term: 'Direction', value: 'From the login to the tool only. Nothing flows back.' },
      ]
    case 'tool-code':
      return [
        {
          term: 'Where',
          value: 'A utility process with no network of its own; every request goes through Valet',
        },
      ]
    case 'request':
      return [
        {
          term: 'Request',
          value: (
            <Value mono copy={`${step.method} ${step.target}`}>
              {step.method} {step.target}
            </Value>
          ),
        },
        { term: 'Made by', value: step.initiator === 'page' ? 'The site’s own page scripts' : 'Tool code' },
        {
          term: 'Decision',
          value:
            step.decision === 'blocked'
              ? 'Blocked before it left Valet'
              : `Allowed${step.purpose !== null ? `, declared as ${step.purpose === 'read' ? 'a read' : step.purpose === 'write' ? 'a change' : 'irreversible'}` : ''}`,
        },
        ...(step.decision === 'blocked'
          ? [
              {
                term: 'Why',
                value:
                  step.blockedReason !== null ? blockedExplanation(step.blockedReason) : 'It was refused.',
              },
              { term: 'Sent', value: 'Nothing. No response.' },
              {
                term: 'Reported as',
                value: (
                  <Code>
                    {step.stage} / {step.blockedReason ?? 'blocked'}
                  </Code>
                ),
              },
            ]
          : [{ term: 'Answer', value: step.status === null ? 'No answer' : String(step.status) }]),
      ]
    case 'waited':
      return [
        { term: 'Waited', value: formatDuration(step.waitedMs) },
        {
          term: 'Why',
          value:
            step.reason === 'queue'
              ? 'Valet runs one call at a time for each site, in the order they arrive.'
              : 'Valet spaces requests to the site out, as a person browsing would.',
        },
      ]
    case 'confirmation':
      return [{ term: 'Answer', value: `You ${confirmationWords(step.answer)}` }]
    case 'needs-user':
      return [
        { term: 'Reason', value: needsUserWording(step.reason).short },
        { term: 'What it means', value: needsUserWording(step.reason).detail },
      ]
    case 'failed':
      return [
        { term: 'Stage', value: stageWording(step.stage) },
        { term: 'Error', value: errorWording(step.errorClass) },
        {
          term: 'Reported as',
          value: (
            <Code>
              {step.stage} / {step.errorClass}
            </Code>
          ),
        },
      ]
    case 'output':
      return [
        { term: 'Size', value: `${step.bytes} B` },
        {
          term: 'Replaced',
          value:
            step.redactions === 0
              ? 'Nothing to replace'
              : plural(step.redactions, 'exact match', 'exact matches'),
        },
      ]
  }
}

/** The selected step, in the inspector. */
export function StepDetails({ step, trace }: { readonly step: TraceStep; readonly trace: RunTrace }) {
  return (
    <Stack gap={3}>
      <div className="flex items-baseline gap-2">
        <Heading level={2} size="group" className="flex-1">
          {STEP_HEADINGS[step.type] ?? 'Step'}
        </Heading>
        <Text tone="subtle" size="sm">
          at {offset(step.atMs)}
        </Text>
      </div>
      <DescriptionList items={stepFacts(step, trace)} />
      {step.type === 'secret-fill' ? (
        <Stack gap={2}>
          <Heading level={3} size="group">
            Checked before typing
          </Heading>
          <CheckList label="Checked before typing">
            {step.checks.map((check) => (
              <CheckItem
                key={check}
                state="pass"
                title={`${FILL_CHECK_WORDING[check] ?? check}${check === 'frame-origin' ? ` ${hostOf(step.origin)}` : ''}`}
              />
            ))}
          </CheckList>
          <Text tone="subtle" size="sm">
            The value itself is never shown, kept in the trace or sent to the app.
          </Text>
        </Stack>
      ) : null}
    </Stack>
  )
}
