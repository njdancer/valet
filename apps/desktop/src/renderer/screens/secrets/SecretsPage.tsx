// Secrets (#/secrets, "Passwords and one-time codes"): where passwords come from, where one-time
// codes come from, and every login Valet may use, each linking to its own page. Logins are listed
// by item title and origin; the item reference and the values stay in the main process.

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
  Field,
  HashChip,
  List,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  RowLink,
  Section,
  SiteAvatar,
  Stack,
  StatusDot,
  Switch,
  Table,
  TBody,
  TD,
  Text,
  TH,
  THead,
  TR,
} from '@valet/ui'
import { KeyRound } from 'lucide-react'
import type { AdapterSummary, GrantInfo, ProviderStatus } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatTime, hostOf, plural } from '../../lib/format'
import { href } from '../../lib/router'
import { PROVIDER_WORDING } from '../../lib/wording'
import { Failed, loginName } from '../connections/shared'
import { OnePasswordAccountSetting, OpPathSetting } from './OnePasswordSettings'

const PASSWORD_SOURCES = [
  'keychain-copy',
  'onepassword-desktop',
  'onepassword-cli',
  'onepassword-service-account',
]

export function SecretsPage() {
  const grants = useLoad((api) => api.grants.list(), [], ['grants-changed'])
  const providers = useLoad((api) => api.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed', 'approvals-changed'])
  const sites = adapters.status === 'ready' ? adapters.data : []
  return (
    <Page>
      <PageHeader
        title="Secrets"
        description="Passwords and one-time codes Valet may type for you. Valet never shows them, keeps them in traces or sends them to Claude."
      />
      <PageBody>
        <Section title="Logins Valet may use" id="logins">
          {grants.status === 'error' ? <Failed failed what="load the logins" /> : null}
          {grants.status === 'ready' ? <Logins grants={grants.data} sites={sites} /> : null}
        </Section>
        <div className="@container">
          <div className="grid grid-cols-1 items-start gap-6 @min-[760px]:grid-cols-2">
            <Section title="Where passwords come from" id="sources">
              {providers.status === 'error' ? <Failed failed what="load the password sources" /> : null}
              {providers.status === 'ready' ? (
                <List label="Where passwords come from">
                  {providers.data
                    .filter((p) => PASSWORD_SOURCES.includes(p.kind))
                    .map((p) => (
                      <SourceRow key={p.kind} provider={p} />
                    ))}
                </List>
              ) : null}
              <OnePasswordCard />
            </Section>
            <Section title="One-time codes" id="codes">
              <CodesCard providers={providers.status === 'ready' ? providers.data : []} />
            </Section>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}

function stateWords(p: ProviderStatus): string {
  if (p.available) return 'Ready'
  if (p.unavailableReason === 'disabled') return 'Turned off'
  if (p.unavailableReason === 'not-installed') return 'Not installed'
  return 'Not set up yet'
}

function SourceRow({ provider: p }: { readonly provider: ProviderStatus }) {
  const words = PROVIDER_WORDING[p.kind]
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="pt-1.5">
        <StatusDot tone={p.available ? 'success' : 'neutral'} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-fg">{words.title}</span>
          <span className="text-sm text-fg-muted">
            {stateWords(p)} · {plural(p.grantCount, 'login')}
          </span>
        </span>
        <span className="text-sm text-fg-muted text-pretty">{words.detail}</span>
      </span>
    </li>
  )
}

function OnePasswordCard() {
  const api = useApi()
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const action = useAction()
  return (
    <Card id="onepassword">
      <CardHeader>
        <CardTitle>1Password on this Mac</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {settings.status === 'error' ? <Failed failed what="load the settings" /> : null}
        {settings.status === 'ready' ? (
          <>
            <OnePasswordAccountSetting
              value={settings.data.onePasswordAccount}
              onSave={(account) => void action.run(() => api.settings.set({ onePasswordAccount: account }))}
            />
            <OpPathSetting value={settings.data.opPath} />
          </>
        ) : null}
        <Failed failed={action.failed} what="save the account" />
      </CardContent>
    </Card>
  )
}

function CodesCard({ providers }: { readonly providers: readonly ProviderStatus[] }) {
  const api = useApi()
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const action = useAction()
  const messages = providers.find((p) => p.kind === 'messages')
  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <Stack gap={0.5}>
          <Text weight="medium">From 1Password</Text>
          <Text size="sm" tone="muted">
            When a login’s 1Password item has a one-time password, Valet reads it from there, like the
            password.
          </Text>
        </Stack>
        {settings.status === 'ready' ? (
          <Field
            inline
            label="Read one-time codes from Messages"
            description={
              <>
                Reads codes that arrive by SMS, only from the sender you approve for each site. Needs Full
                Disk Access for Valet Messages Helper (or Valet, in a development build).
                {messages !== undefined && messages.grantCount > 0
                  ? ` ${plural(messages.grantCount, 'site')} use it.`
                  : null}
              </>
            }
          >
            <Switch
              checked={settings.data.messagesOtpEnabled}
              pending={action.busy}
              onCheckedChange={(on) => void action.run(() => api.settings.set({ messagesOtpEnabled: on }))}
            />
          </Field>
        ) : null}
        <Failed failed={action.failed} what="change that setting" />
      </CardContent>
    </Card>
  )
}

function sourceWords(grant: GrantInfo): string {
  if (grant.provider === 'messages') return `Texts from ${grant.itemTitle}`
  return `${PROVIDER_WORDING[grant.provider].title} “${grant.itemTitle}”`
}

function Logins({
  grants,
  sites,
}: {
  readonly grants: readonly GrantInfo[]
  readonly sites: readonly AdapterSummary[]
}) {
  const now = useNow(60_000)
  const resyncable = grants.some((g) => g.provider === 'keychain-copy')
  if (grants.length === 0)
    return (
      <Card>
        <EmptyState
          icon={<KeyRound />}
          title="No logins yet"
          action={
            <Button asChild>
              <a href={href.sites()}>Open Sites</a>
            </Button>
          }
        >
          Give a site your login from its page. Valet asks 1Password, and only types it where the site’s
          adapter says.
        </EmptyState>
      </Card>
    )
  return (
    <Table aria-label="Logins Valet may use">
      <THead>
        <TR>
          <TH>Login</TH>
          <TH>From</TH>
          <TH>Typed only at</TH>
          <TH>Version</TH>
          <TH>Last used</TH>
          {resyncable ? (
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          ) : null}
        </TR>
      </THead>
      <TBody>
        {grants.map((grant) => {
          const site = sites.find((s) => s.id === grant.adapterId)
          const name = site?.name ?? grant.adapterId
          return (
            <TR key={`${grant.adapterId}:${grant.adapterHash}:${grant.secret}`} interactive>
              <TD className="py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <SiteAvatar id={grant.adapterId} name={name} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <RowLink href={href.login(grant.adapterId, grant.secret)}>
                      {loginName(name, grant)}
                    </RowLink>
                    <span className="relative z-[1] text-sm">
                      <ObjectLink href={href.site(grant.adapterId)}>{name}</ObjectLink>
                    </span>
                  </span>
                </span>
              </TD>
              <TD className="text-sm">{sourceWords(grant)}</TD>
              <TD>
                <span className="flex flex-wrap gap-1">
                  {grant.origins.map((o) => (
                    <Code key={o}>{hostOf(o)}</Code>
                  ))}
                </span>
              </TD>
              <TD className="whitespace-nowrap text-sm">
                <span className="relative z-[1] inline-flex items-center gap-1.5">
                  {site !== undefined && site.hash === grant.adapterHash ? site.version : 'Older'}
                  <HashChip value={grant.adapterHash} href={href.site(grant.adapterId, 'versions')} />
                </span>
              </TD>
              <TD className="whitespace-nowrap text-sm">
                {grant.lastUsedAt === null ? 'Never' : formatTime(grant.lastUsedAt, now)}
              </TD>
              {resyncable ? (
                <TD align="right">
                  <span className="relative z-[1] inline-flex flex-col items-end gap-1">
                    <ResyncButton grant={grant} />
                  </span>
                </TD>
              ) : null}
            </TR>
          )
        })}
      </TBody>
    </Table>
  )
}

/** Re-sync sits beside the copy that can go stale; only a Keychain copy can. */
export function ResyncButton({
  grant,
  size = 'sm',
}: {
  readonly grant: GrantInfo
  readonly size?: 'sm' | 'md'
}) {
  const api = useApi()
  const resync = useAction()
  if (grant.provider !== 'keychain-copy') return null
  return (
    <>
      <Button
        size={size}
        loading={resync.busy}
        title="Copy the item again from 1Password, after you change its password there. 1Password asks you to approve."
        onClick={() => void resync.run(() => api.grants.resync(grant.adapterId, grant.secret))}
      >
        Re-sync from 1Password
      </Button>
      <Failed failed={resync.failed} what="re-sync from 1Password" />
    </>
  )
}
