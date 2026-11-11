// One login a site may use (#/secrets/<site>/<secret>): which site and versions it is given to,
// where it can be typed, what can cause it to be typed, and the calls that used it. The item's
// title is shown, never its reference, fields' values or anything else from the vault.

import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DescriptionList,
  HashChip,
  Inline,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  SiteAvatar,
  Stack,
  Text,
  TextLink,
  toast,
  Value,
} from '@valet/ui'
import { useState } from 'react'
import type { AdapterDetail, GrantInfo } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatDay, formatTime, plural } from '../../lib/format'
import { href } from '../../lib/router'
import { FIELD_WORDING, PROVIDER_WORDING } from '../../lib/wording'
import { activeClients, Failed, loginName } from '../connections/shared'
import { ResyncButton } from './SecretsPage'

export function LoginPage({ adapterId, secret }: { readonly adapterId: string; readonly secret: string }) {
  const grants = useLoad((a) => a.grants.list(), [], ['grants-changed'])
  const detail = useLoad(
    (a) => a.adapters.get(adapterId),
    [adapterId],
    ['adapters-changed', 'approvals-changed', 'grants-changed'],
  )
  if (grants.status === 'loading' || detail.status === 'loading') return <Page />
  const mine =
    grants.status === 'ready'
      ? grants.data.filter((g) => g.adapterId === adapterId && g.secret === secret)
      : []
  const site = detail.status === 'ready' ? detail.data : null
  const request = site?.secretRequests.find((s) => s.name === secret) ?? null
  const messages = site?.messages.some((m) => m.grant !== null && m.grant.secret === secret) === true
  if (mine.length === 0 && request === null && !messages) {
    return (
      <Page>
        <PageHeader
          breadcrumb={<Breadcrumb items={[{ label: 'Secrets', href: href.secrets() }]} />}
          title="Not found"
        />
        <PageBody width="form">
          {grants.status === 'error' || detail.status === 'error' ? (
            <Failed failed what="load the login" />
          ) : (
            <Stack gap={3} align="start">
              <Text tone="muted">No site asks for a login by that name. It may have been removed.</Text>
              <Button asChild>
                <a href={href.secrets()}>Back to Secrets</a>
              </Button>
            </Stack>
          )}
        </PageBody>
      </Page>
    )
  }
  return <Login adapterId={adapterId} secret={secret} grants={mine} site={site} />
}

function Login({
  adapterId,
  secret,
  grants,
  site,
}: {
  readonly adapterId: string
  readonly secret: string
  readonly grants: readonly GrantInfo[]
  readonly site: AdapterDetail | null
}) {
  const api = useApi()
  const now = useNow(60_000)
  const revoke = useAction()
  const [asking, setAsking] = useState(false)
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const agents = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const siteName = site?.name ?? adapterId
  const current = site === null ? null : (grants.find((g) => g.adapterHash === site.hash) ?? null)
  const shown = current ?? grants[0] ?? null
  const request = site?.secretRequests.find((s) => s.name === secret) ?? null
  const name = loginName(siteName, shown ?? { secret, provider: 'keychain-copy' })
  const tools = site?.tools.filter((t) => !t.internal).length ?? 0
  const apps = clients.status === 'ready' ? activeClients(clients.data) : []
  const cloud =
    agents.status === 'ready'
      ? agents.data.filter((c) => c.grant?.tools.some((t) => t.startsWith(`${adapterId}.`)) === true)
      : []

  const doRevoke = async () => {
    if (await revoke.run(() => api.grants.revoke(adapterId, secret))) toast(`${name} revoked`)
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[{ label: 'Secrets', href: href.secrets() }, { label: 'Logins Valet may use' }]}
          />
        }
        leading={<SiteAvatar id={adapterId} name={siteName} size="lg" />}
        title={name}
        status={
          current !== null ? (
            <Badge tone="success">Given</Badge>
          ) : grants.length > 0 ? (
            <Badge tone="warning">Not given to the installed version</Badge>
          ) : (
            <Badge>Not given</Badge>
          )
        }
        actions={
          <>
            {shown !== null ? <ResyncButton grant={shown} size="md" /> : null}
            <Button asChild>
              <a href={href.grant(adapterId, secret)}>{grants.length === 0 ? 'Choose login…' : 'Change…'}</a>
            </Button>
            {grants.length > 0 ? (
              <Button variant="danger-soft" onClick={() => setAsking(true)}>
                Revoke…
              </Button>
            ) : null}
          </>
        }
      />
      <PageBody width="form">
        <Failed failed={revoke.failed} what="revoke the login" />
        <Card>
          <CardHeader>
            <CardTitle>What it is</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: 'Site',
                  value: (
                    <ObjectLink
                      href={href.site(adapterId)}
                      icon={<SiteAvatar id={adapterId} name={siteName} size="xs" />}
                    >
                      {siteName}
                    </ObjectLink>
                  ),
                },
                ...(request !== null && request.fields.length > 0
                  ? [
                      {
                        term: 'Fields',
                        value: request.fields
                          .map((f) => FIELD_WORDING[f as keyof typeof FIELD_WORDING] ?? f)
                          .join(', '),
                      },
                    ]
                  : []),
                ...(shown !== null
                  ? [
                      {
                        term: 'From',
                        value:
                          shown.provider === 'messages'
                            ? `Texts from ${shown.itemTitle}`
                            : `${PROVIDER_WORDING[shown.provider].title} “${shown.itemTitle}”`,
                      },
                      { term: 'Given', value: formatDay(shown.grantedAt) },
                      {
                        term: 'Last used',
                        value: shown.lastUsedAt === null ? 'Never' : formatTime(shown.lastUsedAt, now),
                      },
                    ]
                  : [{ term: 'From', value: <Text tone="muted">Nothing yet. Choose a login for it.</Text> }]),
                {
                  term: 'Calls',
                  value: (
                    <Inline gap={3}>
                      <TextLink href={href.calls({ login: `${adapterId}/${secret}` })}>
                        Calls that used it
                      </TextLink>
                      <TextLink href={href.audit({ category: 'secret-use', site: adapterId })}>
                        Login use in the audit log
                      </TextLink>
                    </Inline>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where it can be typed</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {shown === null || shown.origins.length === 0 ? (
              <Text tone="muted">Nowhere yet.</Text>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {shown.origins.map((o) => (
                  <li key={o}>
                    <Value mono>{o}</Value>
                  </li>
                ))}
              </ul>
            )}
            <Text size="sm" tone="muted">
              Only into a field on these pages, in the site’s own login window. Valet checks the frame, the
              field and where the form sends it before every field.
            </Text>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What can cause it to be typed</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: 'Tools',
                  value: (
                    <>
                      <TextLink href={href.site(adapterId, 'tools')}>
                        All {plural(tools, `${siteName} tool`)}
                      </TextLink>
                      , when the site is logged out
                    </>
                  ),
                },
                {
                  term: 'Apps',
                  value:
                    apps.length === 0 ? (
                      'None'
                    ) : (
                      <Inline gap={2}>
                        {apps.map((c) => (
                          <ObjectLink key={c.id} href={href.client(c.id)}>
                            {c.name}
                          </ObjectLink>
                        ))}
                      </Inline>
                    ),
                },
                {
                  term: 'Cloud agents',
                  value:
                    cloud.length === 0 ? (
                      'None'
                    ) : (
                      <Inline gap={2}>
                        {cloud.map((c) => (
                          <ObjectLink key={c.id} href={href.client(c.id)} mono>
                            {c.host}
                          </ObjectLink>
                        ))}
                      </Inline>
                    ),
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Versions it is given to</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {site !== null && current === null ? (
                <li className="flex flex-wrap items-center gap-2">
                  <span>{site.version} (installed)</span>
                  <HashChip value={site.hash} href={href.site(adapterId, 'versions')} />
                  <Badge>Not given yet</Badge>
                  <span className="flex-1" />
                  <Button size="sm" asChild>
                    <a href={href.grant(adapterId, secret)}>Give it to {site.version}…</a>
                  </Button>
                </li>
              ) : null}
              {grants.map((g) => (
                <li key={g.adapterHash} className="flex flex-wrap items-center gap-2">
                  <span>
                    {site !== null && g.adapterHash === site.hash
                      ? `${site.version} (installed)`
                      : 'An older version'}
                  </span>
                  <HashChip value={g.adapterHash} href={href.site(adapterId, 'versions')} />
                  <Text size="sm" tone="muted">
                    given {formatDay(g.grantedAt)}
                  </Text>
                </li>
              ))}
              {site?.pendingUpdate != null ? (
                <li className="flex flex-wrap items-center gap-2">
                  <span>{site.pendingUpdate.version} (waiting for review)</span>
                  <HashChip value={site.pendingUpdate.hash} href={href.site(adapterId, 'versions')} />
                  <Badge>Not given yet</Badge>
                  <span className="flex-1" />
                  <Button size="sm" asChild>
                    <a href={href.review(adapterId)}>Review {siteName} update</a>
                  </Button>
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      </PageBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive
        title={`Revoke the ${name}?`}
        description={`Valet stops typing it on ${siteName} at once. Your 1Password item isn’t touched.`}
        confirmLabel="Revoke login"
        onConfirm={() => void doRevoke()}
      >
        <Text size="sm" tone="muted">
          The next call that needs it asks you in Needs you: “Give Valet your {siteName} login”.
        </Text>
      </ConfirmDialog>
    </Page>
  )
}
