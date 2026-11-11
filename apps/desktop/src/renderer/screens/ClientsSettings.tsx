// Clients and settings (docs/mockups/clients-settings.html): the MCP endpoint, the clients the person
// has added (each with its own token, D42), each client's setup snippets, and app settings. No token
// ever reaches this page: resetting one happens in the main process, and the snippets point at the
// bridge, which reads its client's token itself.

import { useState } from 'react'
import type { ClientInfo, ClientKind, SettingsPatch, UpdateStatus } from '../../shared/api'
import { AddToClaudeDesktop } from '../components/AddToClaudeDesktop'
import { ActionFailed, Icon, LoadState, Segmented, Switch } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatAgo, formatDay, formatTime } from '../lib/format'
import { updatesOffWording } from '../lib/wording'

const SNIPPET_TITLES: Readonly<Record<ClientKind, { readonly title: string; readonly detail: string }>> = {
  'claude-code': { title: 'Add to Claude Code', detail: 'stdio bridge, bundled with the app' },
  'claude-desktop': { title: 'Add to Claude Desktop', detail: 'claude_desktop_config.json' },
}

/**
 * Clients and Settings share one page. Opened from Settings, the settings column comes first, so
 * the two sidebar items don't land on the same view.
 */
export function ClientsSettingsPage({ focus = 'clients' }: { readonly focus?: 'clients' | 'settings' }) {
  const api = useApi()
  const now = useNow(60_000)
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const endpointAction = useAction()
  const copy = useAction()
  const add = useAction()
  const [copied, setCopied] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState(DEFAULT_CLIENT_NAME)
  // The client whose setup snippets are open: the one just added, or the one the person picked.
  const [open, setOpen] = useState<string | null>(null)

  const active = clients.status === 'ready' ? clients.data.filter((c) => c.revokedAt === null).length : 0
  const revoked = clients.status === 'ready' ? clients.data.length - active : 0

  const copyThen = async (key: string, action: () => Promise<void>) => {
    if (await copy.run(action)) setCopied(key)
  }
  const addClient = async () => {
    let added: ClientInfo | null = null
    const ok = await add.run(async () => {
      added = await api.clients.add(name)
    })
    if (ok && added !== null) {
      setOpen((added as ClientInfo).id)
      setAdding(false)
      setName(DEFAULT_CLIENT_NAME)
    }
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
        <div className={`cols${focus === 'settings' ? ' settings-first' : ''}`}>
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
                        <span>Tokens</span>
                        <span>One per client, new at every launch</span>
                        <span className="xs muted">reset each below</span>
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
                <span className="actions">
                  {adding ? null : (
                    <button type="button" className="btn" onClick={() => setAdding(true)}>
                      <Icon name="plus" size="sm" />
                      Add a client…
                    </button>
                  )}
                </span>
              </div>
              {adding ? (
                <form
                  className="card-body row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void addClient()
                  }}
                >
                  <label className="search" style={{ flex: 1 }}>
                    <span className="sr-only">Name for the new client</span>
                    <input
                      value={name}
                      maxLength={60}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Claude Code on this Mac"
                    />
                  </label>
                  <button type="submit" className="btn primary" disabled={add.busy || name.trim() === ''}>
                    Add
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                  <ActionFailed failed={add.failed} what="add the client" />
                </form>
              ) : null}
              <LoadState loaded={clients} what="clients">
                {(list) =>
                  list.length === 0 ? (
                    <div className="empty">No clients yet. Add one to get its setup command.</div>
                  ) : (
                    <div className="table-scroll">
                      <table className="table tight clients-table">
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
                            <ClientRow
                              key={client.id}
                              client={client}
                              now={now}
                              open={open === client.id}
                              onToggle={() => setOpen(open === client.id ? null : client.id)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </LoadState>
              <div className="card-body xs muted" style={{ paddingTop: 6 }}>
                Each client has its own token, so calls are attributed to the client you added, not to the
                name it reports (shown in grey, which proves nothing). Reset access gives one client a new
                token and ends its sessions; its bridge picks the new one up by itself. Revoke cuts it off for
                good.
              </div>
            </div>

            {open !== null &&
            clients.status === 'ready' &&
            clients.data.some((c) => c.id === open && c.revokedAt === null) ? (
              <ClientSetup
                client={clients.data.find((c) => c.id === open) as ClientInfo}
                copied={copied}
                onCopy={copyThen}
              />
            ) : null}
            <ActionFailed failed={copy.failed} what="copy" />
          </div>

          <div className="stack gap-4">
            <SettingsCard />
            <UpdatesCard now={now} />
            <EraseCard />
          </div>
        </div>
      </div>
    </>
  )
}

const DEFAULT_CLIENT_NAME = 'Claude Code'

function ClientSetup({
  client,
  copied,
  onCopy,
}: {
  readonly client: ClientInfo
  readonly copied: string | null
  readonly onCopy: (key: string, action: () => Promise<void>) => Promise<void>
}) {
  const api = useApi()
  const snippets = useLoad((a) => a.clients.snippets(client.id), [client.id], ['clients-changed'])
  return (
    <LoadState loaded={snippets} what="setup snippets">
      {(list) => (
        <>
          {list.length === 0 ? (
            <div className="card">
              <div className="card-body muted">This build has no bridge to set {client.name} up with.</div>
            </div>
          ) : null}
          {list.map((snippet) => {
            const key = `${client.id}:${snippet.client}`
            return (
              <div className="card" key={snippet.client}>
                <div className="card-head">
                  <span className="h3">
                    {SNIPPET_TITLES[snippet.client].title}: {client.name}
                  </span>
                  <span className="muted">{SNIPPET_TITLES[snippet.client].detail}</span>
                  <span className="actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onCopy(key, () => api.clients.copyConfig(client.id, snippet.client))}
                    >
                      <Icon name={copied === key ? 'check' : 'copy'} size="sm" />
                      {copied === key ? 'Copied' : 'Copy'}
                    </button>
                  </span>
                </div>
                <div className="card-body stack">
                  {snippet.client === 'claude-desktop' ? <AddToClaudeDesktop clientId={client.id} /> : null}
                  <pre className="code">{snippet.text}</pre>
                </div>
              </div>
            )
          })}
          <div className="row xs muted">
            <Icon name="lock" size="sm" />
            The bridge reads {client.name}’s token from its own config file (mode 0600), so it never sits in
            the client’s config.
          </div>
        </>
      )}
    </LoadState>
  )
}

function ClientRow({
  client,
  now,
  open,
  onToggle,
}: {
  readonly client: ClientInfo
  readonly now: number
  readonly open: boolean
  readonly onToggle: () => void
}) {
  const api = useApi()
  const action = useAction()
  const initials = client.name
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2)
  const icon = client.reportedName === 'claude-code' ? 'cc' : client.reportedName === 'claude-ai' ? 'cd' : ''
  const revoked = client.revokedAt !== null
  const claim =
    client.reportedName === null
      ? 'no calls yet'
      : `says “${client.reportedName}” · ${client.transport === 'stdio' ? 'stdio' : 'HTTP'}`
  const since = revoked
    ? `revoked ${formatDay(client.revokedAt)}`
    : client.accessResetAt !== null
      ? `access reset ${formatDay(client.accessResetAt)}`
      : `added ${formatDay(client.addedAt)}`
  return (
    <tr>
      <td>
        <span className={`row${revoked ? ' tertiary' : ''}`}>
          <span className={`client-icon ${icon}`.trim()}>{initials || '?'}</span>
          <span>
            <span style={{ display: 'block' }}>{client.name}</span>
            <span className="xs muted">
              {claim} · {since}
            </span>
          </span>
        </span>
      </td>
      <td className="xs">{revoked || client.lastSeen === null ? '—' : formatAgo(client.lastSeen, now)}</td>
      <td className="num">{client.calls7d}</td>
      <td className="num">
        {revoked ? (
          <span className="pill">Revoked</span>
        ) : (
          <span className="row client-actions">
            <button type="button" className="btn ghost" aria-expanded={open} onClick={onToggle}>
              Set up
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy}
              onClick={() => action.run(() => api.clients.resetAccess(client.id))}
            >
              Reset access
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy}
              onClick={() => action.run(() => api.clients.revoke(client.id))}
            >
              Revoke
            </button>
          </span>
        )}
        <ActionFailed failed={action.failed} what="change this client" />
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
                <span>Notifications</span>
                <span>
                  Tell me when Valet needs me
                  <span className="xs muted" style={{ display: 'block' }}>
                    An approval, a sign-in, a site Valet stopped calling, or a downloaded update. A
                    notification only opens Valet; nothing is approved from it.
                  </span>
                </span>
                <Switch
                  label="Notify me when Valet needs me"
                  checked={s.notifications}
                  onChange={(on) => set({ notifications: on })}
                />
              </div>
              <div className="setting">
                <span>SMS codes</span>
                <span>
                  Read one-time codes from Messages for senders you grant
                  <span className="xs muted" style={{ display: 'block' }}>
                    Needs Full Disk Access for Valet Messages Helper (or Valet, in a development build)
                  </span>
                </span>
                <Switch
                  label="Read one-time codes from Messages"
                  checked={s.messagesOtpEnabled}
                  onChange={(on) => set({ messagesOtpEnabled: on })}
                />
              </div>
              <div className="setting">
                <span>Traces</span>
                <span>
                  Keep run traces and screenshots for
                  <span className="xs muted" style={{ display: 'block' }}>
                    Older ones are deleted. The audit log is always kept.
                  </span>
                </span>
                <select
                  className="select"
                  aria-label="Keep traces and screenshots for"
                  value={s.traceRetentionDays}
                  onChange={(e) => set({ traceRetentionDays: Number(e.target.value) })}
                >
                  {retentionChoices(s.traceRetentionDays).map((days) => (
                    <option key={days} value={days}>
                      {days === 1 ? '1 day' : `${days} days`}
                    </option>
                  ))}
                </select>
              </div>
              <OnePasswordAccountSetting
                value={s.onePasswordAccount}
                onSave={(account) => set({ onePasswordAccount: account })}
              />
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
 * The 1Password account Keychain copies come from (D6). It names an account, never a secret: the
 * person approves each copy in 1Password itself.
 */
export function OnePasswordAccountSetting({
  value,
  onSave,
}: {
  readonly value: string | null
  readonly onSave: (account: string | null) => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  const trimmed = draft.trim()
  const changed = (trimmed === '' ? null : trimmed) !== value
  return (
    <div className="setting">
      <span>1Password</span>
      <span className="stack" style={{ gap: 2 }}>
        <input
          className="input"
          aria-label="1Password account"
          placeholder="my.1password.com"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <span className="xs muted">
          The account name at the top of 1Password’s sidebar. Valet copies the items you grant into your
          Keychain, with your approval in 1Password each time.
        </span>
      </span>
      <span className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn"
          disabled={!changed}
          onClick={() => onSave(trimmed === '' ? null : trimmed)}
        >
          Save
        </button>
      </span>
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

/**
 * Reset and uninstall. The buttons only ask the main process for its own dialog, which says what
 * goes and is the one place the person agrees; nothing is erased from this page.
 */
function EraseCard() {
  const api = useApi()
  const action = useAction()
  return (
    <div className="card" id="erase">
      <div className="card-head">
        <span className="h3">Reset or uninstall</span>
      </div>
      <div className="card-body" style={{ paddingTop: 2, paddingBottom: 2 }}>
        <div className="setting">
          <span>Reset</span>
          <span>
            Erase everything Valet keeps and start again
            <span className="xs muted" style={{ display: 'block' }}>
              Keychain items, grants, approvals, clients, site sessions, the audit log and settings. Valet
              asks once more before anything is removed.
            </span>
          </span>
          <button
            type="button"
            className="btn"
            disabled={action.busy}
            onClick={() => action.run(() => api.app.erase('reset'))}
          >
            Reset Valet…
          </button>
        </div>
        <div className="setting">
          <span>Uninstall</span>
          <span>
            Erase the same things, then move Valet to the Trash
            <span className="xs muted" style={{ display: 'block' }}>
              Valet lists what you have to remove yourself, such as its entry in Claude’s config.
            </span>
          </span>
          <button
            type="button"
            className="btn"
            disabled={action.busy}
            onClick={() => action.run(() => api.app.erase('uninstall'))}
          >
            Uninstall Valet…
          </button>
        </div>
        <ActionFailed failed={action.failed} what="start that" />
      </div>
    </div>
  )
}

/** The retention choices offered, plus the current value if a settings file holds another. */
function retentionChoices(current: number): number[] {
  const choices = [1, 7, 14, 30, 90, 365]
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
}
