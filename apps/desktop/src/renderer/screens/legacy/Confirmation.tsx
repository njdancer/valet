// The confirmation panel (docs/mockups/confirm-irreversible.html), opened by the main process in its
// own window at #/confirm/<id>. What Valet checked itself comes first and is worded by the app;
// the adapter's own text comes second, quieter, attributed and marked unverified. Only the person
// can answer: MCP clients have no way to reach this window.
//
// A client can time a call so this window appears under a click the person was already making in
// another app. So Decline has the focus (Return and Escape decline), and Approve stays disabled for
// CONFIRM_ARM_MS after the panel mounts and again whenever the window regains focus or visibility,
// as browser permission prompts do. The main process enforces the same delay on its side.

import { useEffect, useRef, useState } from 'react'
import { CONFIRM_ARM_MS, type ConfirmationItem } from '../../../shared/api'
import { Preview } from '../../components/Preview'
import { ActionFailed, Avatar, capText, Hash, Icon, LoadState, SideEffect } from '../../components/ui'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatCountdown, formatDay } from '../../lib/format'
import { clientClaim, TRANSPORT_WORDING } from '../../lib/wording'

/**
 * False until `delayMs` has passed since mount, and false again from the moment the window loses
 * focus or is hidden until `delayMs` after it comes back.
 */
export function useArmed(delayMs: number): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const disarm = () => {
      clearTimeout(timer)
      setArmed(false)
    }
    const restart = () => {
      disarm()
      timer = setTimeout(() => setArmed(true), delayMs)
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? restart() : disarm())
    restart()
    window.addEventListener('focus', restart)
    window.addEventListener('blur', disarm)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', restart)
      window.removeEventListener('blur', disarm)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [delayMs])
  return armed
}

export function ConfirmationPanel({
  confirmationId,
  armDelayMs = CONFIRM_ARM_MS,
}: {
  readonly confirmationId: string
  /** Tests shorten it; the window always uses CONFIRM_ARM_MS. */
  readonly armDelayMs?: number
}) {
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
                <Confirm item={item} onAnswered={setAnswered} armDelayMs={armDelayMs} />
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
  armDelayMs,
}: {
  readonly item: ConfirmationItem
  readonly onAnswered: (approved: boolean) => void
  readonly armDelayMs: number
}) {
  const api = useApi()
  const now = useNow(1000)
  const action = useAction()
  const armed = useArmed(armDelayMs)
  const decline = useRef<HTMLButtonElement>(null)
  const expired = Date.parse(item.expiresAt) <= now
  const irreversible = item.sideEffect === 'irreversible'
  const canApprove = armed && !action.busy && !expired

  const answer = async (approved: boolean) => {
    // The button is disabled too; this also stops a click queued before the render that disabled it.
    if (approved && !canApprove) return
    if (await action.run(() => api.answerConfirmation(item.id, approved))) onAnswered(approved)
  }

  // Decline is the default: it has the focus, so Return declines, and so does Escape.
  useEffect(() => {
    decline.current?.focus()
  }, [])
  const answerRef = useRef(answer)
  answerRef.current = answer
  const declinable = !action.busy && !expired
  useEffect(() => {
    if (!declinable) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void answerRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [declinable])

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
              <strong style={{ color: 'var(--text)' }}>{clientClaim(item.client)}</strong>, connected over{' '}
              {TRANSPORT_WORDING[item.clientTransport]}, asked to run{' '}
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
            Checked by Valet
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
            {item.requests.length > 0 ? (
              <>
                <Icon name="check" size="sm" />
                <span data-testid="confirm-requests">
                  If you allow it, the tool says it will make:{' '}
                  {item.requests.map((r) => (
                    <span key={`${r.method} ${r.path}`}>
                      <span className="mono xs">
                        {r.method} {r.path}
                      </span>{' '}
                      <SideEffect purpose={r.purpose} />{' '}
                    </span>
                  ))}
                  Each is declared in the manifest and allowed for this tool. Approving doesn’t unlock them.
                </span>
              </>
            ) : null}
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
          <div className="source">Input from the client</div>
          <Preview parts={item.input} className="mono xs raw" />
        </div>

        {item.adapterNote !== null ? (
          <div className="unverified">
            <div className="source row between">
              <span className="row" style={{ gap: 6 }}>
                <Icon name="adapter" size="sm" />
                Shown by the {item.adapterName} adapter
              </span>
              <span className="pill warn">Not verified by Valet</span>
            </div>
            <div className="note" data-testid="adapter-note">
              {capText(item.adapterNote, 600)}
            </div>
            <div className="xs tertiary" style={{ marginTop: 6 }}>
              The adapter wrote this. Valet can’t check what it says.
            </div>
          </div>
        ) : null}

        <div className="callout" style={{ padding: '8px 12px' }}>
          <Icon name="clients" size="sm" className="muted" />
          <div className="xs muted">
            The AI app can’t answer this for you. If nobody does, it times out and the app is told so.
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
          ref={decline}
          type="button"
          className="btn lg default-ring"
          disabled={!declinable}
          onClick={() => answer(false)}
        >
          Decline
        </button>
        {/* No Touch ID glyph: nothing gates approval on LocalAuthentication yet (README). */}
        <button
          type="button"
          className={`btn lg ${irreversible ? 'destructive' : 'primary'}`}
          disabled={!canApprove}
          onClick={() => answer(true)}
        >
          {irreversible ? `Approve ${item.toolTitle}` : 'Allow'}
        </button>
      </div>
    </>
  )
}
