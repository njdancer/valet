// Remote sign-in: consent for remote clients, answered only here (relay.md, "Consent happens on the
// Mac"), and the remote clients the person has approved.
//
// The page never shows a request's code. The person's own browser shows it; typing it here selects
// the request it belongs to, so a request someone else started (from their own account, against
// the person's public URL) can't be approved by someone who never saw that browser. Every request
// is listed by its claimed host, never by its self-chosen name. Three wrong codes cancel them all.
//
// Above them, remote access itself: on or paused, the public names the person's tunnel forwards
// (Cloudflare Tunnel, D14, which they run), and which tools remote clients may use at all. Every
// tool starts off; only approved adapters' tools are listed.
//
// Like the confirmation panel, Approve stays disabled for CONFIRM_ARM_MS after the page mounts and
// whenever the window comes back, so a click already on its way can't land on it.

import { useState } from 'react'
import {
  CONFIRM_ARM_MS,
  type RemoteClientItem,
  type RemoteConsentAnswer,
  type RemoteConsentState,
  type RemoteConsentTool,
  type RemoteSetup,
  type RemoteSetupTool,
} from '../../../shared/api'
import { ActionFailed, Icon, LoadState, SideEffect } from '../../components/ui'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatAgo, formatCountdown, formatDay } from '../../lib/format'
import { useArmed } from './Confirmation'

/** Crockford base32 without separators: what a typed code must come to (mcp-server's normaliseCode). */
export function codeReady(typed: string): boolean {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)
}

const ANSWER_TEXT: Readonly<Record<Exclude<RemoteConsentAnswer, 'approved'>, string>> = {
  'wrong-code': 'That code doesn’t match any waiting request. Three wrong codes cancel every request.',
  cancelled: 'Too many wrong codes. Every waiting request was cancelled; start again from your browser.',
}

export function RemoteConsentPage({ armDelayMs = CONFIRM_ARM_MS }: { readonly armDelayMs?: number }) {
  const consents = useLoad((api) => api.remote.consents(), [], ['remote-changed'])
  const clients = useLoad((api) => api.remote.clients(), [], ['remote-changed'])
  const setup = useLoad((api) => api.remote.setup(), [], ['remote-changed', 'approvals-changed'])
  return (
    <>
      <div className="titlebar">
        <div className="stack" style={{ gap: 2 }}>
          <div className="title">Remote sign-in</div>
          <div className="subtitle">Connectors that reach your tools over the internet</div>
        </div>
      </div>
      <div className="content scroll" style={{ paddingTop: 'var(--space-4)' }}>
        <div className="stack gap-4" style={{ maxWidth: 720 }}>
          <LoadState loaded={setup} what="remote access">
            {(state) => <RemoteAccessSetup setup={state} />}
          </LoadState>
          <LoadState loaded={consents} what="sign-in requests">
            {(state) => <Consent state={state} armDelayMs={armDelayMs} />}
          </LoadState>
          <LoadState loaded={clients} what="remote clients">
            {(list) => <RemoteClients clients={list} />}
          </LoadState>
        </div>
      </div>
    </>
  )
}

function Consent({ state, armDelayMs }: { readonly state: RemoteConsentState; readonly armDelayMs: number }) {
  const api = useApi()
  const now = useNow(1000)
  const armed = useArmed(armDelayMs)
  const action = useAction()
  const [code, setCode] = useState('')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(state.tools.filter((t) => t.sideEffect === 'read').map((t) => t.ref)),
  )
  const [answer, setAnswer] = useState<RemoteConsentAnswer | null>(null)

  if (state.requests.length === 0) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="h3">No sign-in requests waiting</div>
          <div className="small muted">
            {answer === 'approved'
              ? 'Approved. Your browser carries on to the connector by itself.'
              : 'When you add Valet as a connector, its sign-in asks here for the code your browser shows.'}
          </div>
        </div>
      </div>
    )
  }

  const canApprove = armed && !action.busy && codeReady(code)
  const approve = async () => {
    if (!canApprove) return
    let result: RemoteConsentAnswer | null = null
    const ok = await action.run(async () => {
      result = await api.remote.approveConsent(code, [...ticked])
    })
    if (ok) {
      setAnswer(result)
      setCode('')
    }
  }
  const toggle = (tool: RemoteConsentTool) => {
    const next = new Set(ticked)
    if (next.has(tool.ref)) next.delete(tool.ref)
    else next.add(tool.ref)
    setTicked(next)
  }

  return (
    <section className="card" aria-label="Sign-in requests">
      <div className="card-head">
        <span className="h3">
          {state.requests.length === 1
            ? 'A connector wants access'
            : `${state.requests.length} connectors want access`}
        </span>
        <span className="actions">
          <button
            type="button"
            className="btn ghost"
            disabled={action.busy}
            onClick={() => void action.run(() => api.remote.declineAllConsents())}
          >
            Decline all
          </button>
        </span>
      </div>
      <div className="card-body stack gap-3">
        <div className="callout warn" role="note">
          <Icon name="shield" size="sm" />
          <div className="small">
            <strong>A request you didn’t just start was started by someone else. Decline it.</strong> Anyone
            can ask from your public address, and their request can look exactly like yours.
          </div>
        </div>

        <ul className="stack gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {state.requests.map((request) => (
            <li key={request.id} className="row between" data-testid="consent-request">
              <span className="stack" style={{ gap: 2 }}>
                <span className="mono">{request.clientHost}</span>
                <span className="xs muted">
                  {formatAgo(request.requestedAt, now)}
                  {request.source !== null ? ` from ${request.source}` : ''}
                  {request.clientName !== null ? ` · calls itself “${request.clientName}”` : ''} · ends in{' '}
                  {formatCountdown(request.expiresAt, now)}
                </span>
              </span>
              <button
                type="button"
                className="btn"
                disabled={action.busy}
                onClick={() => void action.run(() => api.remote.declineConsent(request.id))}
              >
                Decline
              </button>
            </li>
          ))}
        </ul>

        <label className="stack" style={{ gap: 4 }}>
          <span className="small">Type the code your browser shows</span>
          <input
            className="input mono"
            value={code}
            maxLength={12}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            aria-label="Code from your browser"
            onChange={(event) => {
              setCode(event.target.value)
              setAnswer(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void approve()
            }}
          />
        </label>

        <div className="stack" style={{ gap: 4 }}>
          <span className="small">Tools this connector may use</span>
          {state.tools.length === 0 ? (
            <span className="xs muted">
              No tools are on for remote clients yet. Approving now grants nothing until you turn tools on and
              approve the connector again.
            </span>
          ) : (
            state.tools.map((tool) => (
              <label key={tool.ref} className="row gap-2">
                <input type="checkbox" checked={ticked.has(tool.ref)} onChange={() => toggle(tool)} />
                <span>
                  {tool.adapterName}: {tool.toolTitle} <SideEffect purpose={tool.sideEffect} />
                  {tool.sideEffect === 'irreversible' ? (
                    <span className="xs muted">
                      {' '}
                      Every call still waits for you to confirm it on this Mac.
                    </span>
                  ) : null}
                </span>
              </label>
            ))
          )}
        </div>

        {answer !== null && answer !== 'approved' ? (
          <div className="small danger-text" role="alert">
            {ANSWER_TEXT[answer]}
          </div>
        ) : null}
      </div>
      <div className="dialog-foot">
        <span className="spacer" />
        <ActionFailed failed={action.failed} what="send your answer" />
        <button
          type="button"
          className="btn lg primary"
          disabled={!canApprove}
          onClick={() => void approve()}
        >
          Approve
        </button>
      </div>
    </section>
  )
}

function RemoteClients({ clients }: { readonly clients: readonly RemoteClientItem[] }) {
  const api = useApi()
  const action = useAction()
  const [confirmingAll, setConfirmingAll] = useState(false)
  const approved = clients.filter((c) => c.grant !== null)
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Remote clients</span>
        <span className="actions">
          {approved.length === 0 ? null : confirmingAll ? (
            <>
              <button type="button" className="btn ghost" onClick={() => setConfirmingAll(false)}>
                Keep them
              </button>
              <button
                type="button"
                className="btn destructive"
                disabled={action.busy}
                onClick={async () => {
                  if (await action.run(() => api.remote.revokeAllClients())) setConfirmingAll(false)
                }}
              >
                Revoke all {clients.length}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmingAll(true)}>
              Revoke all remote clients…
            </button>
          )}
        </span>
      </div>
      {approved.length === 0 ? (
        <div className="empty">No remote clients approved.</div>
      ) : (
        <table className="table tight">
          <thead>
            <tr>
              <th>Client</th>
              <th>Approved</th>
              <th>Tools</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {approved.map((client) => (
              <tr key={client.id}>
                <td>
                  <span className="mono">{client.host}</span>
                  {client.clientName !== null ? (
                    <span className="xs muted"> “{client.clientName}”</span>
                  ) : null}
                </td>
                <td className="xs">{formatDay(client.grant?.grantedAt ?? null)}</td>
                <td className="xs mono">{client.grant?.tools.join(', ') || 'none'}</td>
                <td className="num">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={action.busy}
                    onClick={() => void action.run(() => api.remote.revokeClient(client.id))}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="card-body xs muted" style={{ paddingTop: 6 }}>
        Revoking a client ends its sessions and tokens; adding it again needs your approval here. Pausing
        remote access from the menu bar keeps clients, which carry on when you resume.
      </div>
      <ActionFailed failed={action.failed} what="revoke" />
    </div>
  )
}

/** What the tunnel forwards to: the listener's origin, without its /mcp path. */
export function tunnelTarget(url: string): string {
  return url.replace(/\/mcp$/, '')
}

/** The connector URL a client is given for a public name. */
export function connectorUrl(host: string): string {
  return `https://${host}/mcp`
}

function RemoteAccessSetup({ setup }: { readonly setup: RemoteSetup }) {
  const api = useApi()
  const action = useAction()
  const [host, setHost] = useState('')
  const addHost = async () => {
    const name = host.trim()
    if (name.length === 0) return
    if (await action.run(() => api.remote.setHosts([...setup.hosts, name]))) setHost('')
  }
  const byAdapter = new Map<string, RemoteSetupTool[]>()
  for (const tool of setup.tools)
    byAdapter.set(tool.adapterName, [...(byAdapter.get(tool.adapterName) ?? []), tool])
  const canTurnOn = setup.hosts.length > 0
  return (
    <section className="card" aria-label="Remote access">
      <div className="card-head">
        <span className="h3">Remote access</span>
        <span className="actions">
          {setup.enabled ? (
            <button
              type="button"
              className="btn"
              disabled={action.busy}
              onClick={() => void action.run(() => api.remote.setEnabled(false))}
            >
              Pause remote access
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={action.busy || !canTurnOn}
              onClick={() => void action.run(() => api.remote.setEnabled(true))}
            >
              Turn on
            </button>
          )}
        </span>
      </div>
      <div className="card-body stack gap-3">
        <div className="small" data-testid="remote-state">
          {!setup.enabled ? (
            canTurnOn ? (
              'Off. Connectors can’t reach this Mac.'
            ) : (
              'Off. Add the public name your tunnel forwards, then turn it on.'
            )
          ) : setup.listening && setup.url !== null ? (
            <>
              On. Point your tunnel at <span className="mono">{tunnelTarget(setup.url)}</span>
            </>
          ) : (
            'On, but not listening: something else holds its port.'
          )}
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <span className="small">Public names</span>
          {setup.hosts.length === 0 ? <span className="xs muted">None yet.</span> : null}
          {setup.hosts.map((name) => (
            <div key={name} className="row between" data-testid="remote-host">
              <span className="stack" style={{ gap: 2 }}>
                <span className="mono">{name}</span>
                <span className="xs muted">
                  Connector URL: <span className="mono">{connectorUrl(name)}</span>
                </span>
              </span>
              <span className="row gap-2">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void action.run(() => api.app.copyText(connectorUrl(name)))}
                >
                  Copy URL
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() => api.remote.setHosts(setup.hosts.filter((h) => h !== name)))
                  }
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
          <div className="row gap-2">
            <input
              className="input mono"
              value={host}
              autoComplete="off"
              spellCheck={false}
              placeholder="valet.example.com"
              aria-label="Public name"
              onChange={(event) => setHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addHost()
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={action.busy || host.trim().length === 0}
              onClick={() => void addHost()}
            >
              Add
            </button>
          </div>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <span className="small">Tools remote clients may use</span>
          {setup.tools.length === 0 ? (
            <span className="xs muted">
              No approved adapters yet. Approve one on the Adapters page first.
            </span>
          ) : (
            [...byAdapter.entries()].map(([adapterName, tools]) => (
              <div key={adapterName} className="stack" style={{ gap: 2 }}>
                <span className="xs muted">{adapterName}</span>
                {tools.map((tool) => (
                  <label key={tool.ref} className="row gap-2">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={action.busy}
                      aria-label={`${adapterName}: ${tool.toolTitle}`}
                      onChange={() =>
                        void action.run(() => api.remote.setTool(tool.adapterId, tool.tool, !tool.enabled))
                      }
                    />
                    <span>
                      {tool.toolTitle} <SideEffect purpose={tool.sideEffect} />
                    </span>
                  </label>
                ))}
              </div>
            ))
          )}
          <span className="xs muted">
            Every tool starts off. A connector also gets only the tools you tick when you approve it below.
          </span>
        </div>
      </div>
      <ActionFailed failed={action.failed} what="change remote access" />
    </section>
  )
}
