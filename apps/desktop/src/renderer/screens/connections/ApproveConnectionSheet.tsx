// "Approve a connection" (#/connections/approve, over Needs you): consent for a cloud agent,
// answered only here, on the Mac (relay.md, "Consent happens on the Mac").
//
// The sheet never shows a request's code. The person's own browser shows it; typing it here selects
// the request it belongs to, so a request someone else started (from their own account, against
// the person's public URL) can't be approved by someone who never saw that browser. Every request
// is headed by its claimed host, never by its self-chosen name, which is shown as a claim. Three
// wrong codes cancel them all. No tool is ticked to begin with: the person chooses each one.
//
// Like the confirmation panel, Approve stays disabled for CONFIRM_ARM_MS after the sheet opens and
// whenever the window comes back, so a click already on its way can't land on it.

import {
  ApprovalSeal,
  Badge,
  Banner,
  Button,
  Checkbox,
  DeadlineChip,
  DescriptionList,
  Dialog,
  Field,
  Input,
  Label,
  RiskBadge,
  SheetContent,
  Spacer,
  Stack,
  Text,
  TextLink,
  Value,
} from '@valet/ui'
import { useId, useState } from 'react'
import {
  CONFIRM_ARM_MS,
  type RemoteConsentAnswer,
  type RemoteConsentRequest,
  type RemoteConsentState,
} from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatAgo, formatClock } from '../../lib/format'
import { href, navigate } from '../../lib/router'
import { clientLabel } from '../../lib/wording'
import { ANSWER_TEXT, codeReady } from './consent'
import { CopyThrough, Failed } from './shared'
import { useArmed } from './use-armed'

export function ApproveConnectionSheet({ armDelayMs = CONFIRM_ARM_MS }: { readonly armDelayMs?: number }) {
  const consents = useLoad((a) => a.remote.consents(), [], ['remote-changed'])
  const close = () => navigate(href.needsYou())
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <Consent
        state={consents.status === 'ready' ? consents.data : NO_REQUESTS}
        loaded={consents.status}
        armDelayMs={armDelayMs}
        onClose={close}
      />
    </Dialog>
  )
}

const NO_REQUESTS: RemoteConsentState = { requests: [], tools: [] }

function Consent({
  state,
  loaded,
  armDelayMs,
  onClose,
}: {
  readonly state: RemoteConsentState
  readonly loaded: 'loading' | 'error' | 'ready'
  readonly armDelayMs: number
  readonly onClose: () => void
}) {
  const api = useApi()
  const now = useNow(1000)
  const armed = useArmed(armDelayMs)
  const action = useAction()
  const toolsId = useId()
  const [code, setCode] = useState('')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())
  const [answer, setAnswer] = useState<RemoteConsentAnswer | null>(null)
  const [approvedAgent, setApprovedAgent] = useState<RemoteConsentRequest | null>(null)

  if (state.requests.length === 0) {
    return (
      <SheetContent
        title="Approve a connection"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        {loaded === 'error' ? (
          <Failed failed what="load the requests" />
        ) : loaded === 'loading' ? null : answer === 'approved' ? (
          <Stack gap={3} align="center" className="py-4 text-center">
            <ApprovalSeal />
            <Text weight="semibold">Approved. Your browser carries on to the connector by itself.</Text>
            {approvedAgent !== null ? (
              <TextLink href={href.client(approvedAgent.clientId)}>
                Open {approvedAgent.clientHost}’s page
              </TextLink>
            ) : null}
          </Stack>
        ) : (
          <Stack gap={2}>
            <Text weight="semibold">No connection is waiting</Text>
            <Text tone="muted">
              When you add Valet as a connector, its sign-in asks here for the code your browser shows.
            </Text>
          </Stack>
        )}
      </SheetContent>
    )
  }

  const ready = codeReady(code)
  const canApprove = armed && !action.busy && ready
  const approve = async () => {
    if (!canApprove) return
    // A single request is the one the code belongs to; with several, the code decides which.
    const only = state.requests.length === 1 ? (state.requests[0] ?? null) : null
    let result: RemoteConsentAnswer | null = null
    const ok = await action.run(async () => {
      result = await api.remote.approveConsent(code, [...ticked])
    })
    if (ok) {
      setAnswer(result)
      setCode('')
      if (result === 'approved') setApprovedAgent(only)
    }
  }
  const toggle = (ref: string) => {
    const next = new Set(ticked)
    if (next.has(ref)) next.delete(ref)
    else next.add(ref)
    setTicked(next)
  }
  const many = state.requests.length > 1

  return (
    <SheetContent
      title="Approve a connection"
      description={
        many ? `${state.requests.length} cloud agents are asking. Your code picks yours.` : undefined
      }
      footer={
        <>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(() =>
                many
                  ? api.remote.declineAllConsents()
                  : api.remote.declineConsent((state.requests[0] as RemoteConsentRequest).id),
              )
            }
          >
            {many ? 'Decline all' : 'Decline'}
          </Button>
          <Spacer />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canApprove}
            disabledReason={!ready ? 'Type the code first' : !armed ? 'Just a moment' : undefined}
            loading={action.busy}
            onClick={() => void approve()}
          >
            Approve
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        <div role="note">
          <Banner
            tone="warning"
            title="A request you didn’t just start was started by someone else. Decline it."
          >
            Anyone can ask from your public address, and their request can look exactly like yours.
          </Banner>
        </div>

        <Stack gap={3}>
          {state.requests.map((request) => (
            <RequestFacts
              key={request.id}
              request={request}
              now={now}
              onDecline={
                many ? () => void action.run(() => api.remote.declineConsent(request.id)) : undefined
              }
            />
          ))}
        </Stack>

        <Field
          label="Code from your browser"
          description="Type the code your browser shows. It picks the request it belongs to."
        >
          <Input
            value={code}
            maxLength={12}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            className="max-w-56 font-mono"
            onChange={(e) => {
              setCode(e.target.value)
              setAnswer(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void approve()
              }
            }}
          />
        </Field>

        {answer !== null && answer !== 'approved' ? (
          <Text role="alert" tone="danger" size="sm" weight="medium">
            {ANSWER_TEXT[answer]}
          </Text>
        ) : null}

        <fieldset aria-labelledby={toolsId} className="m-0 flex flex-col gap-2 border-0 p-0">
          <Text id={toolsId} weight="semibold">
            Tools it may use
          </Text>
          {state.tools.length === 0 ? (
            <Text size="sm" tone="muted">
              No tools are on for cloud agents yet. Approving now grants nothing until you turn tools on in{' '}
              <TextLink href={href.remote()}>Remote access</TextLink> and approve the connector again.
            </Text>
          ) : (
            <>
              <Text size="sm" tone="muted">
                None is ticked. Tick only what you want it to do. Even a tool that only reads can make Valet
                log in to the site with your login.
              </Text>
              {state.tools.map((tool) => {
                const id = `${toolsId}-${tool.ref}`
                return (
                  <div key={tool.ref} className="flex items-start gap-2.5">
                    <Checkbox
                      id={id}
                      className="mt-0.5"
                      checked={ticked.has(tool.ref)}
                      onCheckedChange={() => toggle(tool.ref)}
                    />
                    <Stack gap={0.5}>
                      <span className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={id}>
                          {tool.adapterName}: {tool.toolTitle}
                        </Label>
                        <RiskBadge purpose={tool.sideEffect} />
                      </span>
                      {tool.sideEffect === 'irreversible' ? (
                        <Text size="sm" tone="muted">
                          Every call still waits for you to confirm it on this Mac.
                        </Text>
                      ) : null}
                    </Stack>
                  </div>
                )
              })}
            </>
          )}
        </fieldset>
        <Failed failed={action.failed} what="send your answer" />
      </Stack>
    </SheetContent>
  )
}

function RequestFacts({
  request,
  now,
  onDecline,
}: {
  readonly request: RemoteConsentRequest
  readonly now: number
  readonly onDecline: (() => void) | undefined
}) {
  const api = useApi()
  return (
    <div data-testid="consent-request" className="flex flex-col gap-3 rounded-md bg-inset p-3">
      <DescriptionList
        items={[
          { term: 'Asks as', value: <Value mono>{request.clientHost}</Value> },
          {
            term: 'Asked',
            value: `${formatClock(request.requestedAt)} · ${formatAgo(request.requestedAt, now)}`,
          },
          {
            term: 'Ends',
            value: (
              <DeadlineChip until={Date.parse(request.expiresAt)} now={now} subject="Approve a connection" />
            ),
          },
          ...(request.source !== null
            ? [
                {
                  term: 'From IP',
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <Value mono>{request.source}</Value>
                      <CopyThrough
                        label="Copy the IP address"
                        copy={() => api.app.copyText(request.source as string)}
                      />
                    </span>
                  ),
                },
              ]
            : []),
          ...(request.clientName !== null
            ? [
                {
                  term: 'Calls itself',
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Value>“{clientLabel(request.clientName)}”</Value>
                      <Badge size="sm">not verified</Badge>
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {onDecline !== undefined ? (
        <div>
          <Button size="sm" onClick={onDecline}>
            Decline {request.clientHost}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
