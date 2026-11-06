// The login hand-off banner (docs/mockups/needs-user.html). The main process shows it in app chrome
// above the auth window's web view, at #/needs-user/<adapterId>: trust signals live here, outside
// the page, because anything drawn inside the page the site could imitate.

import type { NeedsUserItem } from '../../shared/api'
import { ActionFailed, Avatar, capText, Icon, LoadState } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatCountdown, formatTime, hostOf } from '../lib/format'
import { clientClaim, needsUserWording } from '../lib/wording'

export function NeedsUserBanner({ adapterId }: { readonly adapterId: string }) {
  const attention = useLoad((api) => api.attention.list(), [], ['attention-changed'])
  return (
    <div className="handoff">
      <LoadState loaded={attention} what="the login hand-off">
        {(items) => {
          const item = items.find(
            (i): i is NeedsUserItem => i.kind === 'needs-user' && i.adapterId === adapterId,
          )
          return item === undefined ? (
            <div className="handoff-banner">
              <div className="grow">
                <strong>Nothing is waiting for you here.</strong>{' '}
                <span className="muted">The login finished or was closed.</span>
              </div>
            </div>
          ) : (
            <Banner item={item} />
          )
        }}
      </LoadState>
    </div>
  )
}

function Banner({ item }: { readonly item: NeedsUserItem }) {
  const api = useApi()
  const now = useNow(1000)
  const action = useAction()
  const wording = needsUserWording(item.reason)
  return (
    <>
      <section className="handoff-banner" aria-label="Login hand-off">
        <Avatar adapterId={item.adapterId} name={item.adapterName} />
        <div className="grow">
          <div>
            <strong>{item.adapterName} needs you to finish logging in.</strong> {wording.detail}
          </div>
          <div className="xs muted">
            {item.tool !== null ? (
              <>
                <span className="mono">{item.tool}</span>
                {item.client !== null ? ` from ${clientClaim(item.client, 'inline')}` : ''} ended at{' '}
                {formatTime(item.at, now)} with <span className="mono">needsUser</span>.{' '}
              </>
            ) : null}
            Once you’re signed in, the session is handed to tools and the next call goes through.
          </div>
          {item.filled.length > 0 ? (
            <div className="filled-list">
              <Icon name="key" size="sm" className="secret-text" />
              Filled by siteadapter:
              {item.filled.map((f) => (
                <span key={`${f.secret}.${f.field}`} className="badge secret">
                  {f.secret}.{f.field}
                </span>
              ))}
              {item.filledOrigin !== null ? (
                <>
                  on <span className="mono">{hostOf(item.filledOrigin)}</span>
                </>
              ) : null}
              <span className="tertiary">
                · nothing is marked inside the page, where the site could fake it
              </span>
            </div>
          ) : null}
          {item.note !== null ? (
            <div className="xs tertiary" style={{ marginTop: 2 }}>
              Adapter’s note: <span data-testid="manifest-note">“{capText(item.note)}”</span>
            </div>
          ) : null}
        </div>
        <ActionFailed failed={action.failed} what="reach the login window" />
        {item.windowOpen ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={action.busy}
              onClick={() => action.run(() => api.closeLoginWindow(item.adapterId))}
            >
              Give up
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={action.busy}
              onClick={() => action.run(() => api.finishLogin(item.adapterId))}
            >
              I’m done
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={action.busy}
            onClick={() => action.run(() => api.openLoginWindow(item.adapterId))}
          >
            Show login
          </button>
        )}
      </section>
      <div className="statusbar">
        <span>
          <Icon name="lock" size="sm" />
          Private login session. No adapter code runs in this window.
        </span>
        <span>
          <Icon name="globe" size="sm" />
          Can only visit {item.navigation.map(hostOf).join(', ')}
        </span>
        {item.closesAt !== null ? (
          <span style={{ marginLeft: 'auto' }}>
            <Icon name="clock" size="sm" />
            Closes in {formatCountdown(item.closesAt, now)}
          </span>
        ) : null}
      </div>
    </>
  )
}
