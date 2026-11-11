// "Give Valet your <Site> login" (IA: #/sites/<id>/login/<secret>; wireframe site-grant-sheet): a
// sheet over the site's page that binds a 1Password item, or a Messages sender, to one secret the
// manifest asks for, for the adapter's installed hash.
//
// Safety, kept from the sheet this replaces:
// - Only origins the manifest requested can be ticked, in the manifest's order; an earlier grant's
//   origins are pre-ticked only where the manifest still asks for them. Narrow, never widen.
// - Items are listed by title only: the renderer never sees an item's fields, and renders nothing
//   from an item but its title.
// - The grant names the hash the sheet was opened for, so it can't land on a different bundle.
// - A failed grant says so without the error's text.
// The Grant button is in the sheet's footer, which is always in view.

import type { ProviderKind } from '@valet/core'
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Code,
  Dialog,
  HashChip,
  RadioGroup,
  RadioOption,
  SearchInput,
  SheetContent,
  Skeleton,
  Spacer,
  Stack,
  Text,
  TextLink,
} from '@valet/ui'
import { Check, LockKeyhole, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useLayoutEffect, useState } from 'react'
import type { AdapterDetail, HashRoute, ProviderStatus, VaultItem } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { hostOf, plural } from '../../lib/format'
import { href, navigate } from '../../lib/router'
import { PROVIDER_WORDING } from '../../lib/wording'
import { MESSAGES_SECRET, type Target, targetFor } from './grant/target'

export { MESSAGES_SECRET, targetFor }

/** Vault providers. The test provider is offered only when the main process reports it (demo mode). */
// The Keychain copy first: D6 made it the way Valet gets the person's own 1Password item.
const ONEPASSWORD: readonly ProviderKind[] = [
  'keychain-copy',
  'onepassword-service-account',
  'onepassword-cli',
  'fake',
]

export function GrantSheet({
  adapterId,
  secret,
  closeTo,
}: {
  readonly adapterId: string
  readonly secret: string
  /** Where closing the sheet goes: the site's page unless the sheet was opened from setup. */
  readonly closeTo?: HashRoute
}) {
  const detail = useLoad((api) => api.adapters.get(adapterId), [adapterId], ['adapters-changed'])
  const providers = useLoad((api) => api.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const back = closeTo ?? href.site(adapterId)
  const close = () => navigate(back)

  // Focus goes back to whatever opened the sheet (the "Choose login…" button) when it closes. The
  // sheet closes by a route change, which unmounts it, so this runs on unmount.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      queueMicrotask(() => {
        if (opener?.isConnected === true && opener !== document.body) opener.focus()
      })
    }
  }, [])

  let content: ReactNode
  if (detail.status !== 'ready' || providers.status !== 'ready') {
    content =
      detail.status === 'error' || providers.status === 'error' ? (
        <Message onClose={close}>Couldn’t load this site’s logins. Try again in a moment.</Message>
      ) : (
        <SheetContent title="Give Valet your login" aria-busy="true">
          <Stack gap={2} aria-hidden="true">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </Stack>
        </SheetContent>
      )
  } else if (detail.data === null) {
    content = <Message onClose={close}>No adapter with that id is installed.</Message>
  } else {
    const target = targetFor(detail.data, secret)
    content =
      target === null ? (
        <Message onClose={close}>This adapter’s manifest doesn’t ask for a secret with that name.</Message>
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      {content}
    </Dialog>
  )
}

function Message({ children, onClose }: { readonly children: ReactNode; readonly onClose: () => void }) {
  return (
    <SheetContent
      title="Can’t choose a login here"
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <Text tone="muted">{children}</Text>
    </SheetContent>
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
    return previous.length > 0 ? previous : target.suggestedOrigins
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
  const why =
    item === null
      ? target.kind === 'messages'
        ? 'Choose the sender first'
        : 'Choose a 1Password item first'
      : chosen.length === 0
        ? 'Tick at least one web address'
        : undefined

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

  const messagesOn = providers.some((p) => p.kind === 'messages' && p.available)
  const where = chosen.map(hostOf).join(', ') || 'no web address yet'

  return (
    <SheetContent
      title={target.title}
      description={
        target.kind === 'messages' ? (
          <>
            {adapter.name}’s login may ask for a one-time code. Valet reads it from Messages, only from the
            sender below and only during a login, and types it on the web addresses you tick.
          </>
        ) : (
          <>
            {adapter.name} asks for a <strong className="font-semibold text-fg">{target.fields}</strong> (its
            secret <Code>{secret}</Code>). Valet fills it only on the web addresses you tick, and never shows
            it to Claude.
          </>
        )
      }
      footer={
        <>
          {action.failed ? (
            <Text role="alert" size="sm" tone="danger">
              Couldn’t save the grant. Try again.
            </Text>
          ) : (
            <Text size="sm" tone="subtle">
              Every use is recorded in the{' '}
              <TextLink href={href.audit({ category: 'secret-use', site: adapter.id })}>audit log</TextLink>.
            </Text>
          )}
          <Spacer />
          <Button onClick={onDone}>Cancel</Button>
          <Button
            variant="primary"
            onClick={grant}
            loading={action.busy}
            disabled={why !== undefined}
            disabledReason={why}
          >
            {target.kind === 'messages' ? 'Allow these codes' : 'Use this login'}
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        {target.kind === 'onepassword' ? (
          <>
            <Group title="Where Valet gets it">
              <RadioGroup
                aria-label="Where Valet gets it"
                value={provider}
                onValueChange={(value) => {
                  setProvider(value as ProviderKind)
                  setItem(null)
                }}
              >
                {ONEPASSWORD.filter(
                  (kind) => kind !== 'fake' || providers.some((p) => p.kind === 'fake'),
                ).map((kind) => {
                  const usable = available(kind)
                  return (
                    <RadioOption
                      key={kind}
                      value={kind}
                      disabled={!usable}
                      label={
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{PROVIDER_WORDING[kind].title}</span>
                          {kind === 'keychain-copy' ? <Badge tone="success">Recommended</Badge> : null}
                          {usable ? null : <Badge>Not set up</Badge>}
                        </span>
                      }
                      description={PROVIDER_WORDING[kind].detail}
                    />
                  )
                })}
              </RadioGroup>
              {ONEPASSWORD.some((kind) => kind !== 'fake' && !available(kind)) ? (
                <Text size="sm" tone="muted">
                  Ways not set up yet are set up in <TextLink href={href.secrets()}>Secrets</TextLink>.
                </Text>
              ) : null}
            </Group>

            <Group
              title={provider === 'keychain-copy' ? 'Item in your 1Password' : 'Item in “Valet”'}
              meta={
                items.status === 'ready' ? plural(matching.length, 'item matches', 'items match') : undefined
              }
            >
              <SearchInput
                aria-label="Search items"
                placeholder="Search 1Password"
                value={query}
                onValueChange={setQuery}
              />
              {items.status === 'error' ? (
                <Banner
                  tone="warning"
                  title="Couldn’t list the vault. Is 1Password set up?"
                  action={
                    <Button size="sm" asChild>
                      <a href={href.secrets()}>Open Secrets</a>
                    </Button>
                  }
                />
              ) : items.status === 'loading' ? (
                <Stack gap={2} aria-hidden="true">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-5 w-1/2" />
                </Stack>
              ) : matching.length === 0 ? (
                <Text tone="muted">No items match.</Text>
              ) : (
                <RadioGroup
                  aria-label="1Password items"
                  value={item ?? ''}
                  onValueChange={setItem}
                  className="gap-0 rounded-md ring-[0.5px] ring-line ring-inset [&>div]:px-3 [&>div]:py-2 [&>div+div]:border-t [&>div+div]:border-line-subtle"
                >
                  {matching.map((v) => (
                    <RadioOption key={v.id} value={v.id} label={v.title} />
                  ))}
                </RadioGroup>
              )}
              <Text size="sm" tone="muted">
                Uses the item’s {target.fields}. Valet reads them only at the moment of login.
              </Text>
            </Group>
          </>
        ) : (
          <Group title="Sender the manifest declared">
            <RadioGroup aria-label="Sender" value={item ?? ''} onValueChange={setItem}>
              {target.senders.map((sender) => (
                <RadioOption
                  key={sender}
                  value={sender}
                  label={<span className="font-mono">{sender}</span>}
                  description="Only codes from this sender are read, and only during a login."
                />
              ))}
            </RadioGroup>
            {messagesOn ? null : (
              <Banner
                tone="warning"
                title="Messages codes are off in Secrets"
                action={
                  <Button size="sm" asChild>
                    <a href={href.secrets()}>Turn on in Secrets</a>
                  </Button>
                }
              >
                The grant is kept, but no code is read until you turn them on.
              </Banner>
            )}
          </Group>
        )}

        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-md font-semibold text-fg">Fill it only on</legend>
          <div className="flex flex-col rounded-md ring-[0.5px] ring-line ring-inset [&>div]:px-3 [&>div]:py-2 [&>div+div]:border-t [&>div+div]:border-line-subtle">
            {target.requestedOrigins.map((origin, index) => (
              <OriginOption
                key={origin}
                origin={origin}
                checked={origins.includes(origin)}
                onChange={(on) => toggle(origin, on)}
                hint={
                  target.kind === 'messages'
                    ? target.suggestedOrigins.includes(origin)
                      ? 'Where the sign-in form is'
                      : 'Visited during sign-in. Leave off unless codes are typed here.'
                    : index === 0
                      ? 'Requested by the manifest'
                      : 'Also requested. Leave off unless sign-in moves here.'
                }
              />
            ))}
          </div>
          <Text size="sm" tone="muted">
            Before every fill, Valet checks the page’s web address, the field and where the form sends it.
            Only {plural(target.requestedOrigins.length, 'web address', 'web addresses')} the manifest asked
            for can be chosen.
          </Text>
        </fieldset>

        <div className="grid grid-cols-2 gap-4 rounded-md bg-sunken p-3 ring-[0.5px] ring-line-subtle ring-inset max-[520px]:grid-cols-1">
          <Facts
            title={target.kind === 'messages' ? 'With these codes, it can' : 'With this login, it can'}
            ok
            items={[
              `have Valet type it into the sign-in form on ${where}`,
              'start a login when a tool needs one',
              'learn whether the login worked',
            ]}
          />
          <Facts
            title="It can’t"
            ok={false}
            items={[
              'read, copy or log the values',
              'get them back in tool results',
              'use them on any other page',
              'keep this grant when its code changes: you choose again on each update',
            ]}
          />
        </div>

        <div className="flex items-start gap-2 text-sm text-fg-muted">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Logins run in a separate browser session that the adapter’s code never touches. Only the cookies
            move across afterwards.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
          <span>
            For {adapter.name} {adapter.version}
          </span>
          <HashChip value={adapter.hash} label={`${adapter.version} hash`} />
          <span>A new version asks again.</span>
        </div>
      </Stack>
    </SheetContent>
  )
}

function Group({
  title,
  meta,
  children,
}: {
  readonly title: string
  readonly meta?: string
  readonly children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 id={id} className="m-0 text-md font-semibold text-fg">
          {title}
        </h3>
        <Spacer />
        {meta !== undefined ? (
          <span aria-live="polite" className="text-sm text-fg-subtle">
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function OriginOption({
  origin,
  checked,
  onChange,
  hint,
}: {
  readonly origin: string
  readonly checked: boolean
  readonly onChange: (on: boolean) => void
  readonly hint: string
}) {
  const id = useId()
  return (
    <div data-origin={origin} className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="break-all font-mono text-sm text-fg">
          {origin}
        </label>
        <span id={`${id}-hint`} className="text-sm text-fg-muted">
          {hint}
        </span>
      </div>
    </div>
  )
}

function Facts({
  title,
  ok,
  items,
}: {
  readonly title: string
  readonly ok: boolean
  readonly items: readonly string[]
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 id={id} className="m-0 text-sm font-semibold text-fg">
        {title}
      </h3>
      <ul aria-labelledby={id} className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((text) => (
          <li key={text} className="flex items-start gap-1.5 text-sm text-fg">
            {ok ? (
              <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success-solid" />
            ) : (
              <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
            )}
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
