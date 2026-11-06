// Binding a credential to a manifest's secret request (docs/mockups/grant-secret.html). The sheet
// only ever offers origins the manifest asked for, for the adapter's installed hash; it can narrow
// them, never widen. Items are listed by title: the renderer never sees an item's fields.

import type { ProviderKind } from '@siteadapter/core'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AdapterDetail, GrantInfo, ProviderStatus, VaultItem } from '../../shared/api'
import { ActionFailed, Avatar, Icon, SecretBadge } from '../components/ui'
import { useAction, useApi, useLoad } from '../lib/api-context'
import { hostOf, plural, shortHash } from '../lib/format'
import { href, navigate } from '../lib/router'
import { FIELD_WORDING, PROVIDER_WORDING } from '../lib/wording'

/** Core's MESSAGES_SECRET. Not imported: core's index pulls in Node modules the renderer can't load. */
export const MESSAGES_SECRET = 'messages'

/** Vault providers. The test provider is offered only when the main process reports it (demo mode). */
const ONEPASSWORD: readonly ProviderKind[] = ['onepassword-service-account', 'onepassword-cli', 'fake']

/** What the sheet is granting, resolved from the manifest. Null when the manifest asks for no such secret. */
interface Target {
  readonly title: string
  readonly fields: string
  readonly requestedOrigins: readonly string[]
  readonly existing: GrantInfo | null
  readonly kind: 'onepassword' | 'messages'
  readonly senders: readonly string[]
}

export function targetFor(adapter: AdapterDetail, secret: string): Target | null {
  if (secret === MESSAGES_SECRET) {
    if (adapter.messages.length === 0) return null
    const origins = [...new Set(adapter.messages.flatMap((m) => m.requestedOrigins))]
    return {
      title: `Let ${adapter.name} read one-time codes from Messages`,
      fields: 'one-time code',
      requestedOrigins: origins,
      existing: adapter.messages.find((m) => m.grant !== null)?.grant ?? null,
      kind: 'messages',
      senders: adapter.messages.map((m) => m.sender),
    }
  }
  // find() on an array, so names like "__proto__" or "constructor" can't resolve to anything.
  const request = adapter.secretRequests.find((s) => s.name === secret)
  if (request === undefined) return null
  return {
    title: `Let ${adapter.name} log in with your 1Password item`,
    fields: request.fields.map((f) => FIELD_WORDING[f]).join(' and '),
    requestedOrigins: request.origins,
    existing: request.grant,
    kind: 'onepassword',
    senders: [],
  }
}

export function GrantSheet({ adapterId, secret }: { readonly adapterId: string; readonly secret: string }) {
  const detail = useLoad((api) => api.adapters.get(adapterId), [adapterId], ['adapters-changed'])
  const providers = useLoad((api) => api.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const close = () => navigate(href.adapter(adapterId))
  const sheet = useRef<HTMLDivElement>(null)

  // Focus moves into the sheet when it opens and back to whatever opened it (the Grant… link) when
  // it closes. The rest of the window is inert meanwhile (control/App.tsx), so Tab stays in here.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet.current?.focus()
    return () => {
      // After the commit that removes `inert` from the window behind.
      queueMicrotask(() => {
        if (opener?.isConnected === true) opener.focus()
      })
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') navigate(href.adapter(adapterId))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [adapterId])

  let body: ReactNode
  if (detail.status !== 'ready' || providers.status !== 'ready') {
    body =
      detail.status === 'error' || providers.status === 'error' ? (
        <SheetMessage onClose={close}>Couldn’t load this adapter’s secrets.</SheetMessage>
      ) : (
        <div className="empty">Loading…</div>
      )
  } else if (detail.data === null) {
    body = <SheetMessage onClose={close}>No adapter with that id is installed.</SheetMessage>
  } else {
    const target = targetFor(detail.data, secret)
    body =
      target === null ? (
        <SheetMessage onClose={close}>
          This adapter’s manifest doesn’t ask for a secret with that name.
        </SheetMessage>
      ) : (
        <GrantForm
          key={`${detail.data.hash}:${secret}`}
          adapter={detail.data}
          secret={secret}
          target={target}
          providers={providers.data}
          onDone={close}
        />
      )
  }

  return (
    <>
      <div className="sheet-scrim" />
      <div
        ref={sheet}
        className="sheet grant-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Grant a secret"
        tabIndex={-1}
      >
        {body}
      </div>
    </>
  )
}

function SheetMessage({ children, onClose }: { readonly children: ReactNode; readonly onClose: () => void }) {
  return (
    <>
      <div className="sheet-head">
        <div className="grow small">{children}</div>
      </div>
      <div className="dialog-foot">
        <span className="spacer" />
        <button type="button" className="btn lg" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  )
}

function GrantForm({
  adapter,
  secret,
  target,
  providers,
  onDone,
}: {
  readonly adapter: AdapterDetail
  readonly secret: string
  readonly target: Target
  readonly providers: readonly ProviderStatus[]
  readonly onDone: () => void
}) {
  const api = useApi()
  const action = useAction()
  const available = (kind: ProviderKind) => providers.some((p) => p.kind === kind && p.available)
  const initialProvider: ProviderKind =
    target.kind === 'messages'
      ? 'messages'
      : target.existing !== null &&
          ONEPASSWORD.includes(target.existing.provider) &&
          available(target.existing.provider)
        ? target.existing.provider
        : (ONEPASSWORD.find(available) ?? 'onepassword-service-account')
  const [provider, setProvider] = useState<ProviderKind>(initialProvider)
  const [query, setQuery] = useState('')
  const [item, setItem] = useState<string | null>(
    target.kind === 'messages' ? (target.existing?.itemId ?? target.senders[0] ?? null) : null,
  )
  // Pre-tick what an earlier grant allowed, but only where the manifest still asks for it.
  const [origins, setOrigins] = useState<readonly string[]>(() => {
    const previous = target.existing?.origins.filter((o) => target.requestedOrigins.includes(o)) ?? []
    if (previous.length > 0) return previous
    const first = target.requestedOrigins[0]
    return first === undefined ? [] : [first]
  })

  const items = useLoad(
    (a) =>
      target.kind === 'messages'
        ? Promise.resolve([] as readonly VaultItem[])
        : a.grants.vaultItems(provider),
    [provider, target.kind],
    ['grants-changed'],
  )
  const vaultItems = items.status === 'ready' ? items.data : []
  const matching = vaultItems.filter((v) => v.title.toLowerCase().includes(query.trim().toLowerCase()))

  // Once items load, re-select the item an earlier grant used, by id: titles needn't be unique.
  useEffect(() => {
    if (target.kind !== 'onepassword' || item !== null || target.existing?.provider !== provider) return
    const previous = vaultItems.find((v) => v.id === target.existing?.itemId)
    if (previous !== undefined) setItem(previous.id)
  }, [vaultItems, item, target, provider])

  const toggle = (origin: string, on: boolean) =>
    setOrigins((current) =>
      on ? [...current.filter((o) => o !== origin), origin] : current.filter((o) => o !== origin),
    )

  // Only requested origins ever leave the sheet, in the manifest's order.
  const chosen = target.requestedOrigins.filter((o) => origins.includes(o))
  const ready = item !== null && chosen.length > 0 && !action.busy

  const grant = async () => {
    if (item === null || chosen.length === 0) return
    const ok = await action.run(() =>
      api.grants.make({
        adapterId: adapter.id,
        adapterHash: adapter.hash,
        secret: target.kind === 'messages' ? MESSAGES_SECRET : secret,
        provider,
        itemRef: item,
        origins: chosen,
      }),
    )
    if (ok) onDone()
  }

  return (
    <>
      <div className="sheet-head">
        <Avatar adapterId={adapter.id} name={adapter.name} size="lg" />
        <div className="grow">
          <div className="h2">{target.title}</div>
          <div className="small muted">
            The adapter’s manifest asks for {target.kind === 'messages' ? 'codes' : 'a secret named'}{' '}
            {target.kind === 'messages' ? null : <SecretBadge name={secret} />} with a{' '}
            <strong>{target.fields}</strong>, to sign in to {adapter.site}.
          </div>
        </div>
        <span className="hash" title={adapter.hash}>
          for {shortHash(adapter.hash)}
        </span>
      </div>

      <div className="sheet-body">
        <div className="stack gap-4" style={{ alignContent: 'start' }}>
          {target.kind === 'onepassword' ? (
            <>
              <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
                <legend className="label">Where siteadapter gets it</legend>
                {ONEPASSWORD.filter(
                  (kind) => kind !== 'fake' || providers.some((p) => p.kind === 'fake'),
                ).map((kind) => {
                  const on = provider === kind
                  const usable = available(kind)
                  return (
                    <label key={kind} className={`choice${on ? ' on' : ''}${usable ? '' : ' off'}`}>
                      <input
                        type="radio"
                        className="radio"
                        name="provider"
                        checked={on}
                        disabled={!usable}
                        onChange={() => {
                          setProvider(kind)
                          setItem(null)
                        }}
                      />
                      <div className="row between">
                        <strong>{PROVIDER_WORDING[kind].title}</strong>
                        {kind === 'onepassword-service-account' ? (
                          <span className="pill ok">Recommended</span>
                        ) : null}
                        {usable ? null : <span className="pill">Not set up</span>}
                      </div>
                      <span />
                      <span className="muted">{PROVIDER_WORDING[kind].detail}</span>
                    </label>
                  )
                })}
              </fieldset>

              <div>
                <div className="label row between">
                  <span>Item in “siteadapter”</span>
                  <span className="xs muted">{plural(matching.length, 'item matches', 'items match')}</span>
                </div>
                <label className="field" style={{ marginBottom: 6 }}>
                  <Icon name="search" size="sm" className="muted" />
                  <span className="sr-only">Search items</span>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={adapter.name}
                  />
                </label>
                {/* A native radio group: arrow keys move the choice, and a reader announces it. */}
                <div className="items" role="radiogroup" aria-label="1Password items">
                  {items.status === 'error' ? (
                    <div className="empty">Couldn’t list the vault. Is 1Password set up?</div>
                  ) : matching.length === 0 ? (
                    <div className="empty">{items.status === 'loading' ? 'Loading…' : 'No items match.'}</div>
                  ) : (
                    matching.map((v) => (
                      <label key={v.id} className={`item${item === v.id ? ' on' : ''}`}>
                        <input
                          type="radio"
                          className="sr-only"
                          name="vault-item"
                          checked={item === v.id}
                          onChange={() => setItem(v.id)}
                        />
                        <span className="op" aria-hidden="true">
                          {v.title.trim().charAt(0).toUpperCase() || '?'}
                        </span>
                        <span>{v.title}</span>
                        {item === v.id ? <Icon name="check" /> : <span />}
                      </label>
                    ))
                  )}
                </div>
                <div className="xs muted" style={{ marginTop: 6 }}>
                  Uses the item’s {target.fields} fields. siteadapter reads them only at the moment of login.
                </div>
              </div>
            </>
          ) : (
            <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="label">Sender the manifest declared</legend>
              {target.senders.map((sender) => (
                <label key={sender} className={`choice${item === sender ? ' on' : ''}`}>
                  <input
                    type="radio"
                    className="radio"
                    name="sender"
                    checked={item === sender}
                    onChange={() => setItem(sender)}
                  />
                  <strong className="mono">{sender}</strong>
                  <span />
                  <span className="muted">
                    Only codes from this sender are read, and only during a login.
                  </span>
                </label>
              ))}
              {providers.some((p) => p.kind === 'messages' && p.available) ? null : (
                <div className="callout warn xs">
                  <Icon name="warn" />
                  <div>
                    Messages codes are off in Settings. The grant is kept, but no code is read until you turn
                    them on.
                  </div>
                </div>
              )}
            </fieldset>
          )}
        </div>

        <div className="stack gap-4" style={{ alignContent: 'start' }}>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label">Fill it only on</legend>
            <div className="card" style={{ padding: '2px 12px' }}>
              {target.requestedOrigins.map((origin, index) => (
                <label className="origin-row" key={origin}>
                  <input
                    type="checkbox"
                    className="check"
                    checked={origins.includes(origin)}
                    onChange={(e) => toggle(origin, e.target.checked)}
                  />
                  <span className="mono xs">{origin}</span>
                  <span />
                  <span className="xs muted">
                    {index === 0
                      ? 'Requested by the manifest'
                      : 'Also requested. Leave off unless sign-in moves here.'}
                  </span>
                </label>
              ))}
            </div>
            <div className="xs muted" style={{ marginTop: 6 }}>
              Before every fill, siteadapter checks the page’s origin, the field type and where the form
              submits. Only {plural(target.requestedOrigins.length, 'origin')} the manifest asked for can be
              chosen.
            </div>
          </fieldset>

          <div className="grid-2" style={{ gap: 'var(--space-3)' }}>
            <div className="callout ok" style={{ display: 'block', padding: '10px 12px' }}>
              <div className="h3">The adapter can</div>
              <ul className="can">
                <li>
                  <Icon name="check" size="sm" className="ok-text" />
                  have siteadapter type it into the sign-in form on{' '}
                  {chosen.map(hostOf).join(', ') || 'no origin yet'}
                </li>
                <li>
                  <Icon name="check" size="sm" className="ok-text" />
                  start a login when a tool needs one
                </li>
                <li>
                  <Icon name="check" size="sm" className="ok-text" />
                  learn whether the login worked
                </li>
              </ul>
            </div>
            <div className="callout bad" style={{ display: 'block', padding: '10px 12px' }}>
              <div className="h3">It can’t</div>
              <ul className="can">
                <li>
                  <Icon name="x" size="sm" className="danger-text" />
                  read, copy or log the values
                </li>
                <li>
                  <Icon name="x" size="sm" className="danger-text" />
                  get them back in tool results
                </li>
                <li>
                  <Icon name="x" size="sm" className="danger-text" />
                  use them on any other page
                </li>
                <li>
                  <Icon name="x" size="sm" className="danger-text" />
                  keep this grant if its code changes; you choose again on each update
                </li>
              </ul>
            </div>
          </div>

          <div className="callout secret" style={{ padding: '9px 12px' }}>
            <Icon name="lock" />
            <div>
              Logins run in a separate browser session that adapter code never touches. Only the cookies move
              across afterwards.
            </div>
          </div>
        </div>
      </div>

      <div className="dialog-foot">
        <Icon name="audit" size="sm" className="muted" />
        <span className="xs muted">
          Every use is recorded in the audit log with the tool call that caused it.
        </span>
        <span className="spacer" />
        <ActionFailed failed={action.failed} what="save the grant" />
        <button type="button" className="btn lg" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn lg primary default-ring" disabled={!ready} onClick={grant}>
          Grant
        </button>
      </div>
    </>
  )
}
