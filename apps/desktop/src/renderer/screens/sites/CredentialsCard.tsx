// A site's credentials (secrets v2, docs/adapter-kinds.md#f2-secrets-version-2): each credential the
// adapter's code uses outside a browser login, in Valet's own words for who holds it and where it
// may go, what it is granted, and the way to grant or revoke it. Granting asks for Touch ID in the
// main process; nothing here ever sees a value. A Valet-made SSH key shows only its public half.

import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  DescriptionList,
  Inline,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spacer,
  Stack,
  Text,
  Value,
} from '@valet/ui'
import { useState } from 'react'
import type {
  AdapterDetail,
  CredentialGrantInfo,
  CredentialGrantProvider,
  CredentialRequestInfo,
  ValetKeyView,
} from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'

const KIND_WORDING: Readonly<Record<CredentialRequestInfo['kind'], string>> = {
  password: 'Password',
  token: 'Token',
  'ssh-key': 'SSH key',
}

const PROVIDER_LABEL: Readonly<Record<CredentialGrantProvider, string>> = {
  'keychain-copy': 'Copy in your Keychain, from your 1Password',
  'onepassword-service-account': '1Password service account',
  'onepassword-desktop': '1Password, approved each time',
  'valet-key': 'A key Valet makes',
}

export function CredentialsCard({
  adapter,
  card,
}: {
  readonly adapter: AdapterDetail
  /** The site page's card frame. */
  readonly card: (props: { readonly title: string; readonly children: React.ReactNode }) => React.ReactNode
}) {
  const grants = useLoad((api) => api.credentials.list(), [], ['grants-changed', 'adapters-changed'])
  if (adapter.credentials.length === 0) return null
  const approved = adapter.approval === 'approved'
  const mine = grants.status === 'ready' ? grants.data.filter((g) => g.adapterId === adapter.id) : []
  return card({
    title: 'Credentials',
    children: (
      <Stack gap={4}>
        {adapter.credentials.map((c) => (
          <CredentialBlock
            key={c.name}
            adapter={adapter}
            request={c}
            approved={approved}
            grant={mine.find((g) => g.credential === c.name && g.adapterHash === adapter.hash) ?? null}
          />
        ))}
      </Stack>
    ),
  })
}

function CredentialBlock({
  adapter,
  request,
  approved,
  grant,
}: {
  readonly adapter: AdapterDetail
  readonly request: CredentialRequestInfo
  readonly approved: boolean
  readonly grant: CredentialGrantInfo | null
}) {
  const api = useApi()
  const revoke = useAction()
  const [choosing, setChoosing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <Text weight="medium">
          {KIND_WORDING[request.kind]} <Value mono>{request.name}</Value>
        </Text>
        {request.custody === 'entrusted' ? <Badge tone="warning">Handed to the adapter’s code</Badge> : null}
        <Spacer />
        {approved && !choosing ? (
          <Button
            size="sm"
            variant={grant === null ? 'primary' : 'secondary'}
            onClick={() => setChoosing(true)}
          >
            {grant === null ? 'Grant…' : 'Change…'}
          </Button>
        ) : null}
      </Inline>
      <Text size="sm">{request.sentence}</Text>
      <Text size="sm" tone="muted">
        The adapter says: “{request.description}”
      </Text>
      {request.targets.length > 1 ? (
        <Text size="sm" tone="muted">
          {request.targets.join(', ')}
        </Text>
      ) : null}
      {!approved ? (
        <Text size="sm" tone="subtle">
          You grant it after approving this version.
        </Text>
      ) : grant !== null ? (
        <>
          <DescriptionList
            items={[
              { term: 'Uses', value: `${PROVIDER_LABEL[grant.provider]}: ${grant.itemTitle}` },
              { term: 'For', value: grant.targets.join(', ') },
              {
                term: 'Valet may use it',
                value: grant.signed ? (
                  <Badge tone="success">Yes</Badge>
                ) : (
                  <Badge tone="warning">Not now: what you allowed before no longer counts</Badge>
                ),
              },
            ]}
          />
          {grant.publicKey !== null ? (
            <PublicKey publicKey={grant.publicKey} fingerprint={grant.fingerprint} />
          ) : null}
          <Inline gap={2}>
            <Button size="sm" variant="ghost" disabled={revoke.busy} onClick={() => setConfirming(true)}>
              Revoke
            </Button>
            {revoke.failed ? <Text tone="danger">Couldn’t revoke it. Try again.</Text> : null}
          </Inline>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Revoke ${request.name}?`}
            description={`${adapter.name} can’t use it again until you grant it again.${
              grant.provider === 'valet-key' ? ' Valet deletes the key it made.' : ''
            }`}
            confirmLabel="Revoke"
            destructive
            onConfirm={() => void revoke.run(() => api.credentials.revoke(adapter.id, request.name))}
          />
        </>
      ) : (
        <Text size="sm" tone="subtle">
          Not granted. Calls that need it are refused.
        </Text>
      )}
      {choosing ? <Chooser adapter={adapter} request={request} onDone={() => setChoosing(false)} /> : null}
    </Stack>
  )
}

function Chooser({
  adapter,
  request,
  onDone,
}: {
  readonly adapter: AdapterDetail
  readonly request: CredentialRequestInfo
  readonly onDone: () => void
}) {
  const api = useApi()
  const action = useAction()
  const providers = useLoad((a) => a.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const available: CredentialGrantProvider[] = [
    ...(request.kind === 'ssh-key' ? (['valet-key'] as const) : []),
    ...(providers.status === 'ready'
      ? providers.data
          .filter(
            (p) => p.available && (p.kind === 'keychain-copy' || p.kind === 'onepassword-service-account'),
          )
          .map((p) => p.kind as CredentialGrantProvider)
      : []),
  ]
  const [provider, setProvider] = useState<CredentialGrantProvider | null>(null)
  const [itemId, setItemId] = useState<string | null>(null)
  const [key, setKey] = useState<ValetKeyView | null>(null)
  const chosen = provider ?? available[0] ?? null
  const items = useLoad(
    (a) =>
      chosen === null || chosen === 'valet-key'
        ? Promise.resolve({ status: 'ok' as const, items: [] })
        : a.grants.vaultItems(chosen),
    [chosen],
    [],
  )
  const listed = items.status === 'ready' && items.data.status === 'ok' ? items.data.items : []
  const grant = (id: string) =>
    action.run(async () => {
      if (chosen === null) return
      await api.credentials.make({
        adapterId: adapter.id,
        adapterHash: adapter.hash,
        credential: request.name,
        provider: chosen,
        itemId: id,
      })
      onDone()
    })
  if (available.length === 0)
    return (
      <Stack gap={2}>
        <Text size="sm" tone="subtle">
          No way to keep it is set up. Set up 1Password in Settings first.
        </Text>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </Stack>
    )
  return (
    <Stack gap={2}>
      <Select
        value={chosen ?? undefined}
        onValueChange={(v) => {
          setProvider(v as CredentialGrantProvider)
          setItemId(null)
        }}
      >
        <SelectTrigger aria-label="Where it comes from">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {available.map((p) => (
            <SelectItem key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen === 'valet-key' ? (
        key === null ? (
          <Button
            size="sm"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => setKey(await api.credentials.generateKey(adapter.id, request.name)))
            }
          >
            Make a key
          </Button>
        ) : (
          <>
            <PublicKey publicKey={key.publicKey} fingerprint={key.fingerprint} />
            <Text size="sm" tone="muted">
              Add this line to the server’s authorized_keys, then grant it.
            </Text>
          </>
        )
      ) : (
        <Select value={itemId ?? undefined} onValueChange={setItemId}>
          <SelectTrigger aria-label="Item">
            <SelectValue placeholder={items.status === 'loading' ? 'Loading items…' : 'Choose an item'} />
          </SelectTrigger>
          <SelectContent>
            {listed.map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Inline gap={2}>
        <Button
          size="sm"
          disabled={action.busy || (chosen === 'valet-key' ? key === null : itemId === null)}
          onClick={() => void grant(chosen === 'valet-key' ? (key?.itemRef ?? '') : (itemId ?? ''))}
        >
          Grant with Touch ID
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {action.failed ? <Text tone="danger">Not granted.</Text> : null}
      </Inline>
    </Stack>
  )
}

function PublicKey({
  publicKey,
  fingerprint,
}: {
  readonly publicKey: string
  readonly fingerprint: string | null
}) {
  return (
    <Stack gap={1}>
      <Inline gap={2}>
        <Value mono className="break-all">
          {publicKey}
        </Value>
        <CopyButton value={publicKey} label="Copy public key" />
      </Inline>
      {fingerprint !== null ? (
        <Text size="sm" tone="muted">
          Fingerprint <Value mono>{fingerprint}</Value>
        </Text>
      ) : null}
    </Stack>
  )
}
