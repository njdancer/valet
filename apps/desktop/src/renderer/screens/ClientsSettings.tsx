// Clients and settings (docs/mockups/clients-settings.html): the MCP endpoint, the clients that have
// connected, setup snippets, and app settings. The endpoint token never reaches this page: rotating
// it happens in the main process, and the snippets point at the bridge, which reads it itself.

import { useState } from 'react'
import type { ClientInfo, ClientKind, SettingsPatch, UpdateStatus } from '../../shared/api'
import { ActionFailed, Icon, LoadState, Segmented, Switch } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatAgo, formatDay, formatTime } from '../lib/format'
import { clientLabel, updatesOffWording } from '../lib/wording'

const SNIPPET_TITLES: Readonly<Record<ClientKind, { readonly title: string; readonly detail: string }>> = {
  'claude-code': { title: 'Add to Claude Code', detail: 'stdio bridge, bundled with the app' },
  'claude-desktop': { title: 'Add to Claude Desktop', detail: 'claude_desktop_config.json' },
}

export function ClientsSettingsPage() {
  const api = useApi()
  const now = useNow(60_000)
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const snippets = useLoad((a) => a.endpoint.snippets(), [], ['endpoint-changed'])
  const endpointAction = useAction()
  const copy = useAction()
  const [copied, setCopied] = useState<string | null>(null)

  const active = clients.status === 'ready' ? clients.data.filter((c) => c.revokedAt === null).length : 0
  const revoked = clients.status === 'ready' ? clients.data.length - active : 0

  const copyThen = async (key: string, action: () => Promise<void>) => {
    if (await copy.run(action)) setCopied(key)
  }

  return (
    <>
      <div className="titlebar">
        <div>
          <div className="title">Clients and settings</div>
          <div className="subtitle">Who can call your tools, how they connect, and how the app behaves</div>
        </div>
      </div>

      <div className="content scroll clients-page" style={{ paddingTop: 'var(--space-4)' }}>
        <div className="cols">
          <div className="stack gap-4">
            <div className="card" id="endpoint">
              <LoadState loaded={endpoint} what="the endpoint">
                {(status) => (
                  <>
                    <div className="card-head">
                      <span className="h3">MCP endpoint</span>
                      {status.listening ? (
                        <span className="pill ok">
                          <span className="dot ok" />
                          Listening
                        </span>
                      ) : (
                        <span className="pill">Off</span>
                      )}
                      <span className="actions">
                        <Switch
                          label="MCP endpoint on"
                          checked={status.listening}
                          disabled={endpointAction.busy}
                          onChange={(on) => endpointAction.run(() => api.endpoint.setListening(on))}
                        />
                      </span>
                    </div>
                    <div className="card-body" style={{ paddingTop: 2, paddingBottom: 2 }}>
                      <div className="setting">
                        <span>Address</span>
                        <span className="mono">{status.url ?? 'Not listening'}</span>
                        {status.url !== null ? (
                          <button
                            type="button"
                            className="btn ghost icon"
                            aria-label="Copy address"
                            onClick={() => copyThen('url', () => api.endpoint.copyUrl())}
                          >
                            <Icon name={copied === 'url' ? 'check' : 'copy'} size="sm" />
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                      <div className="setting">
                        <span>Transport</span>
                        <span>Streamable HTTP, this Mac only</span>
                        <span className="xs muted">stdio via bridge</span>
                      </div>
                      <div className="setting">
                        <span>Token</span>
                        <span>
                          One shared bearer token, kept by the app and the bridge
                          {status.tokenRotatedAt !== null
                            ? ` · rotated ${formatDay(status.tokenRotatedAt)}`
                            : ''}
                        </span>
                        <button
                          type="button"
                          className="btn"
                          disabled={endpointAction.busy}
                          onClick={() => endpointAction.run(() => api.endpoint.rotateToken())}
                        >
                          Rotate
                        </button>
                      </div>
                    </div>
                    <div className="card-body" style={{ paddingTop: 0 }}>
                      <ActionFailed failed={endpointAction.failed} what="change the endpoint" />
                    </div>
                  </>
                )}
              </LoadState>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="h3">Clients</span>
                <span className="muted">
                  {active} active · {revoked} revoked
                </span>
              </div>
              <LoadState loaded={clients} what="clients">
                {(list) =>
                  list.length === 0 ? (
                    <div className="empty">No client has connected yet.</div>
                  ) : (
                    <table className="table tight">
                      <thead>
                        <tr>
                          <th>Client</th>
                          <th>Last call</th>
                          <th className="num">Calls · 7d</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((client) => (
                          <ClientRow key={client.id} client={client} now={now} />
                        ))}
                      </tbody>
                    </table>
                  )
                }
              </LoadState>
              <div className="card-body xs muted" style={{ paddingTop: 6 }}>
                Names are what each client says it is, from MCP initialize: they prove nothing. Every client
                shares the endpoint token today, so revoking a client refuses its sessions, and rotating the
                token cuts off all of them.
              </div>
            </div>

            <LoadState loaded={snippets} what="setup snippets">
              {(list) => (
                <>
                  {list.map((snippet) => (
                    <div className="card" key={snippet.client}>
                      <div className="card-head">
                        <span className="h3">{SNIPPET_TITLES[snippet.client].title}</span>
                        <span className="muted">{SNIPPET_TITLES[snippet.client].detail}</span>
                        <span className="actions">
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              copyThen(snippet.client, () => api.endpoint.copyClientConfig(snippet.client))
                            }
                          >
                            <Icon name={copied === snippet.client ? 'check' : 'copy'} size="sm" />
                            {copied === snippet.client ? 'Copied' : 'Copy'}
                          </button>
                        </span>
                      </div>
                      <div className="card-body stack">
                        <pre className="code">{snippet.text}</pre>
                      </div>
                    </div>
                  ))}
                  <div className="row xs muted">
                    <Icon name="lock" size="sm" />
                    The bridge reads the endpoint token from its own config file (mode 0600), so it never sits
                    in a client’s config.
                  </div>
                  <ActionFailed failed={copy.failed} what="copy" />
                </>
              )}
            </LoadState>
          </div>

          <div className="stack gap-4">
            <SettingsCard />
            <UpdatesCard now={now} />
          </div>
        </div>
      </div>
    </>
  )
}

function ClientRow({ client, now }: { readonly client: ClientInfo; readonly now: number }) {
  const api = useApi()
  const action = useAction()
  const label = clientLabel(client.reportedName)
  const initials = label
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2)
  const icon = client.reportedName === 'claude-code' ? 'cc' : client.reportedName === 'claude-ai' ? 'cd' : ''
  const revoked = client.revokedAt !== null
  return (
    <tr>
      <td>
        <span className={`row${revoked ? ' tertiary' : ''}`}>
          <span className={`client-icon ${icon}`.trim()}>{initials || '?'}</span>
          <span>
            <span style={{ display: 'block' }}>{label}</span>
            <span className="xs muted">
              says “{client.reportedName}” · {client.transport === 'stdio' ? 'stdio' : 'HTTP'}
              {revoked
                ? ` · revoked ${formatDay(client.revokedAt)}`
                : ` · since ${formatDay(client.firstSeen)}`}
            </span>
          </span>
        </span>
      </td>
      <td className="xs">{revoked ? '—' : formatAgo(client.lastSeen, now)}</td>
      <td className="num">{client.calls7d}</td>
      <td className="num">
        {revoked ? (
          <span className="pill">Revoked</span>
        ) : (
          <button
            type="button"
            className="btn ghost"
            disabled={action.busy}
            onClick={() => action.run(() => api.clients.revoke(client.id))}
          >
            Revoke
          </button>
        )}
        <ActionFailed failed={action.failed} what="revoke" />
      </td>
    </tr>
  )
}

function SettingsCard() {
  const api = useApi()
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const action = useAction()
  const set = (patch: SettingsPatch) => action.run(() => api.settings.set(patch))
  return (
    <div className="card" id="settings">
      <div className="card-head">
        <span className="h3">Settings</span>
      </div>
      <div className="card-body" style={{ paddingTop: 2, paddingBottom: 2 }}>
        <LoadState loaded={settings} what="settings">
          {(s) => (
            <>
              <div className="setting">
                <span>Start</span>
                <span>Open Valet when you log in</span>
                <Switch
                  label="Launch at login"
                  checked={s.launchAtLogin}
                  onChange={(on) => set({ launchAtLogin: on })}
                />
              </div>
              <div className="setting">
                <span>SMS codes</span>
                <span>
                  Read one-time codes from Messages for senders you grant
                  <span className="xs muted" style={{ display: 'block' }}>
                    Needs Full Disk Access for Valet
                  </span>
                </span>
                <Switch
                  label="Read one-time codes from Messages"
                  checked={s.messagesOtpEnabled}
                  onChange={(on) => set({ messagesOtpEnabled: on })}
                />
              </div>
              <OpPathSetting value={s.opPath} />
            </>
          )}
        </LoadState>
        <ActionFailed failed={action.failed} what="save the setting" />
      </div>
    </div>
  )
}

/**
 * The 1Password CLI's path. The renderer can't type one: the main process shows a file dialog,
 * checks what was picked (absolute, not writable by others, 1Password's signature) and saves it.
 */
function OpPathSetting({ value }: { readonly value: string | null }) {
  const api = useApi()
  const action = useAction()
  return (
    <div className="setting">
      <span>1Password CLI</span>
      <span className="stack" style={{ gap: 2 }}>
        <span className="mono xs" data-testid="op-path">
          {value ?? 'Found automatically'}
        </span>
        <span className="xs muted">Valet checks the file is 1Password’s, signed, before using it.</span>
        <ActionFailed failed={action.failed} what="use that file" />
      </span>
      <span className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn"
          disabled={action.busy}
          onClick={() => action.run(() => api.settings.chooseOpPath())}
        >
          Choose…
        </button>
        {value !== null ? (
          <button
            type="button"
            className="btn ghost"
            disabled={action.busy}
            onClick={() => action.run(() => api.settings.clearOpPath())}
          >
            Find automatically
          </button>
        ) : null}
      </span>
    </div>
  )
}

function UpdatePill({ status }: { readonly status: UpdateStatus }) {
  switch (status.state) {
    case 'disabled':
      return <span className="pill">Off</span>
    case 'not-checked':
      return <span className="pill">Not checked yet</span>
    case 'up-to-date':
      return <span className="pill ok">Up to date</span>
    case 'available':
      return <span className="pill info">{status.available} available</span>
    case 'ready':
      return <span className="pill info">{status.available} downloaded</span>
    case 'downloading':
      return <span className="pill info">Downloading {status.available}</span>
    case 'error':
      return <span className="pill bad">Couldn’t check</span>
    case 'checking':
      return <span className="pill">Checking…</span>
  }
}

function UpdatesCard({ now }: { readonly now: number }) {
  const api = useApi()
  const status = useLoad((a) => a.updates.status(), [], ['settings-changed', 'app-changed'])
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const action = useAction()
  return (
    <div className="card" id="updates">
      <div className="card-head">
        <span className="h3">Updates</span>
        {status.status === 'ready' ? <UpdatePill status={status.data} /> : null}
      </div>
      <div className="card-body" style={{ paddingTop: 2, paddingBottom: 2 }}>
        {status.status === 'ready' ? (
          <div className="setting">
            <span>Version</span>
            <span>
              {status.data.current}
              {status.data.checkedAt !== null ? ` · checked ${formatTime(status.data.checkedAt, now)}` : ''}
            </span>
            {status.data.state === 'disabled' ? (
              <span />
            ) : (
              <button
                type="button"
                className="btn"
                disabled={action.busy}
                onClick={() => action.run(() => api.updates.check())}
              >
                Check now
              </button>
            )}
          </div>
        ) : null}
        {status.status === 'ready' && status.data.disabledReason !== null ? (
          <div className="setting">
            <span>Status</span>
            <span>{updatesOffWording(status.data.disabledReason)}</span>
            <span />
          </div>
        ) : null}
        {status.status === 'ready' && status.data.state === 'ready' && settings.status === 'ready' ? (
          // There is no install action: a downloaded update installs on quit, and only if that's on.
          <div className="setting">
            <span>Status</span>
            <span>
              {settings.data.autoInstallUpdates
                ? 'Downloaded. It installs when Valet quits.'
                : 'Downloaded. Turn on automatic installs to apply it.'}
            </span>
            <span />
          </div>
        ) : null}
        {settings.status === 'ready' ? (
          <>
            <div className="setting">
              <span>Channel</span>
              <span>
                <Segmented
                  label="Update channel"
                  value={settings.data.updateChannel}
                  onChange={(updateChannel) => action.run(() => api.settings.set({ updateChannel }))}
                  options={[
                    { value: 'stable', label: 'Stable' },
                    { value: 'beta', label: 'Beta' },
                  ]}
                />
              </span>
              <span />
            </div>
            <div className="setting">
              <span>Install</span>
              <span>Download in the background, install on quit</span>
              <Switch
                label="Install updates automatically"
                checked={settings.data.autoInstallUpdates}
                onChange={(on) => action.run(() => api.settings.set({ autoInstallUpdates: on }))}
              />
            </div>
          </>
        ) : null}
        {status.status === 'ready' ? (
          <div className="setting">
            <span>Signature</span>
            {status.data.signed ? (
              <span className="row">
                <Icon name="shield" size="sm" className="ok-text" />
                Developer ID
              </span>
            ) : (
              <span className="row danger-text">
                <Icon name="warn" size="sm" />
                Not signed with a Developer ID
              </span>
            )}
            <span />
          </div>
        ) : null}
        <ActionFailed failed={action.failed} what="update the setting" />
      </div>
    </div>
  )
}
