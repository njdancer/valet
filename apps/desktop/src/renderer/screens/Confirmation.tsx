// The confirmation panel (docs/mockups/confirm-irreversible.html), opened by the main process in its
// own window at #/confirm/<id>. What siteadapter checked itself comes first and is worded by the app;
// the adapter's own text comes second, quieter, attributed and marked unverified. Only the person
// can answer: MCP clients have no way to reach this window.

import { useState } from 'react'
import type { ConfirmationItem } from '../../shared/api'
import { Preview } from '../components/Preview'
import { ActionFailed, Avatar, Hash, Icon, LoadState, SideEffect } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatCountdown, formatDay } from '../lib/format'
import { clientLabel } from '../lib/wording'

export function ConfirmationPanel({ confirmationId }: { readonly confirmationId: string }) {
  const attention = useLoad((api) => api.attention.list(), [], ['attention-changed'])
  const [answered, setAnswered] = useState<boolean | null>(null)
  return (
    <div className="confirm-window">
      <div className="confirm-panel" role="dialog" aria-label="Confirm a tool action">
        {answered !== null ? (
          <div className="panel-body">
            <div className="h2">{answered ? 'Approved' : 'Declined'}</div>
            <div className="small muted">The tool call has been told. You can close this window.</div>
          </div>
        ) : (
          <LoadState loaded={attention} what="the confirmation">
            {(items) => {
              const item = items.find(
                (i): i is ConfirmationItem => i.kind === 'confirmation' && i.id === confirmationId,
              )
              return item === undefined ? (
                <div className="panel-body">
                  <div className="h2">Nothing to confirm</div>
                  <div className="small muted">This confirmation was answered or has timed out.</div>
                </div>
              ) : (
                <Confirm item={item} onAnswered={setAnswered} />
              )
            }}
          </LoadState>
        )}
      </div>
    </div>
  )
}

function Confirm({
  item,
  onAnswered,
}: {
  readonly item: ConfirmationItem
  readonly onAnswered: (approved: boolean) => void
}) {
  const api = useApi()
  const now = useNow(1000)
  const action = useAction()
  const expired = Date.parse(item.expiresAt) <= now
  const client = clientLabel(item.client)
  const irreversible = item.sideEffect === 'irreversible'

  const answer = async (approved: boolean) => {
    if (await action.run(() => api.answerConfirmation(item.id, approved))) onAnswered(approved)
  }

  return (
    <>
      <div className="panel-body stack gap-4">
        <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
          <div className="app-icon">
            <div className="main-icon">
              <Icon name="logo" size="xl" />
            </div>
            <Avatar adapterId={item.adapterId} name={item.adapterName} />
          </div>
          <div className="stack" style={{ gap: 4, paddingLeft: 4 }}>
            <div className="h2">
              {irreversible
                ? `Run ${item.toolTitle} on ${item.adapterName}?`
                : `Let ${item.adapterName} continue: ${item.toolTitle}?`}
            </div>
            <div className="small muted">
              <strong style={{ color: 'var(--text)' }}>{client}</strong> asked to run{' '}
              <span className="mono">{item.tool}</span>.{' '}
              {irreversible
                ? 'This can’t be undone.'
                : item.trigger === 'tool-request'
                  ? 'The tool stopped to ask you before it goes on.'
                  : 'It changes your account.'}
            </div>
          </div>
        </div>

        <div>
          <div className="source">
            <Icon name="shield" size="sm" />
            Checked by siteadapter
          </div>
          <div className="verified">
            <Icon name="check" size="sm" />
            <span>
              {item.adapterName} {item.adapterVersion}
              {item.approvedAt !== null ? `, approved ${formatDay(item.approvedAt)}` : ''} ·{' '}
              <Hash hash={item.adapterHash} />
            </span>
            <Icon name="check" size="sm" />
            <span>
              Tool declared <SideEffect purpose={item.sideEffect} />
              {irreversible ? ', so only you can approve it' : ''}
            </span>
            <Icon name="check" size="sm" />
            <span>
              Its requests stay within the manifest’s declared paths, at most {item.requestCeiling} this run
            </span>
            <Icon name="check" size="sm" />
            <span>
              {item.unlocks.length === 0 ? (
                'Approving unlocks no irreversible request'
              ) : (
                <>
                  Approving unlocks, for this run only:{' '}
                  {item.unlocks.map((u) => (
                    <span key={`${u.method} ${u.path}`} className="mono xs">
                      {u.method} {u.path}{' '}
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
        </div>

        <div>
          <div className="source">Input from {client}</div>
          <Preview parts={item.input} className="mono xs raw" />
        </div>

        {item.adapterNote !== null ? (
          <div className="unverified">
            <div className="source row between">
              <span className="row" style={{ gap: 6 }}>
                <Icon name="adapter" size="sm" />
                Shown by the {item.adapterName} adapter
              </span>
              <span className="pill warn">Not verified by siteadapter</span>
            </div>
            <div className="note" data-testid="adapter-note">
              {item.adapterNote}
            </div>
            <div className="xs tertiary" style={{ marginTop: 6 }}>
              The adapter wrote this. siteadapter can’t check what it says.
            </div>
          </div>
        ) : null}

        <div className="callout" style={{ padding: '8px 12px' }}>
          <Icon name="clients" size="sm" className="muted" />
          <div className="xs muted">
            MCP clients can’t answer this prompt. If nobody does, it times out and {client} is told
            “timed-out”.
          </div>
        </div>
      </div>

      <div className="dialog-foot">
        <span className="timer">
          <Icon name="clock" size="sm" />
          {expired ? 'Timed out' : `Times out in ${formatCountdown(item.expiresAt, now)}`}
        </span>
        <span className="spacer" />
        <ActionFailed failed={action.failed} what="send your answer" />
        <button
          type="button"
          className="btn lg default-ring"
          disabled={action.busy || expired}
          onClick={() => answer(false)}
        >
          Decline
        </button>
        <button
          type="button"
          className={`btn lg ${irreversible ? 'destructive' : 'primary'}`}
          disabled={action.busy || expired}
          onClick={() => answer(true)}
        >
          {irreversible ? <Icon name="touchid" size="sm" /> : null}
          {irreversible ? `Approve ${item.toolTitle}` : 'Allow'}
        </button>
      </div>
    </>
  )
}
