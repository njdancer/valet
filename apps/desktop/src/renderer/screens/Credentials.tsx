// Every grant across adapters, and the credential providers. Grants are listed by item title and
// origin; the item reference and the values stay in the main process.

import type { GrantInfo } from '../../shared/api'
import { ActionFailed, Hash, LoadState, SecretBadge } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatTime, hostOf, plural } from '../lib/format'
import { href } from '../lib/router'
import { PROVIDER_WORDING } from '../lib/wording'

export function CredentialsPage() {
  const grants = useLoad((api) => api.grants.list(), [], ['grants-changed'])
  const providers = useLoad((api) => api.grants.providers(), [], ['grants-changed', 'settings-changed'])
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
            ? providers.data.map((p) => (
                <div className="card" key={p.kind}>
                  <div className="card-head">
                    <span className={`dot ${p.available ? 'ok' : 'warn'}`} />
                    <span className="h3">{PROVIDER_WORDING[p.kind].title}</span>
                    <span className="muted">{plural(p.grantCount, 'grant')}</span>
                  </div>
                  <div className="card-body xs muted">
                    {PROVIDER_WORDING[p.kind].detail}
                    {p.available
                      ? ''
                      : p.unavailableReason === 'disabled'
                        ? ' Turned off in Settings.'
                        : p.unavailableReason === 'not-installed'
                          ? ' Not installed.'
                          : ' Not set up yet.'}
                  </div>
                </div>
              ))
            : null}
        </div>
      </div>
    </>
  )
}

function GrantRow({ grant }: { readonly grant: GrantInfo }) {
  const api = useApi()
  const now = useNow(60_000)
  const action = useAction()
  return (
    <tr>
      <td>
        <a href={href.adapter(grant.adapterId)}>{grant.adapterId}</a>
      </td>
      <td>
        <SecretBadge name={grant.secret} />
      </td>
      <td>
        {PROVIDER_WORDING[grant.provider].title} “{grant.itemTitle}”
      </td>
      <td className="mono xs">{grant.origins.map(hostOf).join(', ')}</td>
      <td>
        <Hash hash={grant.adapterHash} />
      </td>
      <td className="xs">{grant.lastUsedAt === null ? 'Never' : formatTime(grant.lastUsedAt, now)}</td>
      <td className="num">
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
