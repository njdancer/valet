// Every grant across adapters, and the credential providers. Grants are listed by item title and
// origin; the item reference and the values stay in the main process.

import type { GrantInfo, ProviderStatus } from '../../shared/api'
import { ActionFailed, Hash, LoadState, SecretBadge } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatTime, hostOf, plural } from '../lib/format'
import { href } from '../lib/router'
import { PROVIDER_WORDING } from '../lib/wording'

export function CredentialsPage() {
  const grants = useLoad((api) => api.grants.list(), [], ['grants-changed'])
  const providers = useLoad((api) => api.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed'])
  const nameOf = (id: string) =>
    adapters.status === 'ready' ? (adapters.data.find((a) => a.id === id)?.name ?? id) : id
  return (
    <>
      <div className="titlebar">
        <div>
          <div className="title">Credentials</div>
          <div className="subtitle">
            {grants.status === 'ready' ? plural(grants.data.length, 'grant') : 'Grants'} · 1Password and
            Messages
          </div>
        </div>
      </div>
      <div className="content scroll stack gap-4" style={{ alignContent: 'start' }}>
        <div className="card">
          <LoadState loaded={grants} what="grants">
            {(list) =>
              list.length === 0 ? (
                <div className="empty">No grants yet. Grant a secret from an adapter’s page.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Adapter</th>
                      <th>Secret</th>
                      <th>Bound to</th>
                      <th>Allowed on</th>
                      <th>Valid for</th>
                      <th>Last used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((grant) => (
                      <GrantRow
                        key={`${grant.adapterId}:${grant.adapterHash}:${grant.secret}`}
                        grant={grant}
                        adapterName={nameOf(grant.adapterId)}
                      />
                    ))}
                  </tbody>
                </table>
              )
            }
          </LoadState>
        </div>
        <div className="grid-3">
          {providers.status === 'ready'
            ? providers.data.map((p) => <ProviderCard key={p.kind} provider={p} />)
            : null}
        </div>
      </div>
    </>
  )
}

// F20: what to do about a source that isn't ready, and where in Settings to do it. The service
// account's token is stored outside the app, so it gets no button.
function setupAction(p: ProviderStatus): string | null {
  if (p.available || p.kind === 'onepassword-service-account' || p.kind === 'fake') return null
  if (p.unavailableReason === 'disabled') return 'Turn on in Settings'
  return 'Set up in Settings'
}

function ProviderCard({ provider: p }: { readonly provider: ProviderStatus }) {
  const action = setupAction(p)
  return (
    <div className="card">
      <div className="card-head">
        <span className={`dot ${p.available ? 'ok' : 'warn'}`} />
        <span className="h3">{PROVIDER_WORDING[p.kind].title}</span>
        <span className="muted">{plural(p.grantCount, 'grant')}</span>
      </div>
      <div className="card-body stack gap-2">
        <div className="xs muted">
          {PROVIDER_WORDING[p.kind].detail}
          {p.available
            ? ''
            : p.unavailableReason === 'disabled'
              ? ' Turned off in Settings.'
              : p.unavailableReason === 'not-installed'
                ? ' Not installed.'
                : ' Not set up yet.'}
        </div>
        {action === null ? null : (
          <div>
            <a className="btn" href={href.settings()}>
              {action}
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

function GrantRow({ grant, adapterName }: { readonly grant: GrantInfo; readonly adapterName: string }) {
  const api = useApi()
  const now = useNow(60_000)
  const action = useAction()
  return (
    <tr>
      <td>
        <a href={href.adapter(grant.adapterId)}>{adapterName}</a>
      </td>
      <td>{grant.provider === 'messages' ? 'SMS codes' : <SecretBadge name={grant.secret} />}</td>
      <td>
        {grant.provider === 'messages'
          ? `Texts from ${grant.itemTitle}`
          : `${PROVIDER_WORDING[grant.provider].title} “${grant.itemTitle}”`}
      </td>
      <td className="mono xs">{grant.origins.map(hostOf).join(', ')}</td>
      <td>
        <Hash hash={grant.adapterHash} />
      </td>
      <td className="xs">{grant.lastUsedAt === null ? 'Never' : formatTime(grant.lastUsedAt, now)}</td>
      <td className="num">
        {grant.provider === 'keychain-copy' ? (
          <button
            type="button"
            className="btn ghost"
            disabled={action.busy}
            title="Copy the item again from 1Password, after you change its password there. 1Password asks you to approve."
            onClick={() => action.run(() => api.grants.resync(grant.adapterId, grant.secret))}
          >
            Re-sync from 1Password
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          disabled={action.busy}
          onClick={() => action.run(() => api.grants.revoke(grant.adapterId, grant.secret))}
        >
          Revoke
        </button>
        <ActionFailed failed={action.failed} what="revoke" />
      </td>
    </tr>
  )
}
