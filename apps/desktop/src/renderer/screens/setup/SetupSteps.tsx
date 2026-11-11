// The body of each setup step (wireframes 90-setup). Each reads its state from the same API as the
// rest of the app. Approving and granting happen in the app's own review page and grant sheet,
// opened from here and returning here, so setup can't approve or grant anything they wouldn't.

import { MESSAGES_SECRET } from '@valet/core/vocab'
import {
  ApprovalSeal,
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CheckItem,
  CheckList,
  CodeBlock,
  DescriptionList,
  Field,
  Heading,
  Input,
  RiskBadge,
  SecretBadge,
  Spinner,
  Stack,
  Text,
  TextLink,
  Value,
} from '@valet/ui'
import { Check, Copy, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type {
  AdapterDetail,
  ClientInfo,
  ClientKind,
  DesktopConfigWritten,
  EndpointStatus,
  PendingReview,
  ProviderStatus,
  Settings,
} from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { hostOf, plural } from '../../lib/format'
import { href } from '../../lib/routes'
import { FIELD_WORDING, PROVIDER_WORDING } from '../../lib/wording'
import { StoreChooser } from './StoreChooser'
import { SETUP_CLIENTS, setupClient, vaultProviders } from './setup-logic'

/** The heading and lede every step starts with: same place, same size, so nothing jumps. */
export function StepHeading({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <Stack gap={1.5}>
      <Heading level={1} size="page" id="setup-title">
        {title}
      </Heading>
      {children ? (
        <Text tone="muted" className="max-w-[620px]">
          {children}
        </Text>
      ) : null}
    </Stack>
  )
}

export function Failed({ failed, what }: { readonly failed: boolean; readonly what: string }) {
  if (!failed) return null
  return (
    <Text role="alert" size="sm" tone="danger" weight="medium">
      Couldn’t {what}. Try again.
    </Text>
  )
}

// ---------- Welcome ----------

export function WelcomeStep({ siteName }: { readonly siteName: string }) {
  return (
    <>
      <StepHeading title={`Let Claude shop at ${siteName} for you`}>
        Valet logs in to {siteName} on this Mac, as you, when Claude asks. Anything that can’t be undone waits
        for you to confirm. It runs on this Mac only: no account, no cloud.
      </StepHeading>
      <div className="grid grid-cols-1 gap-3 min-[720px]:grid-cols-3">
        <WelcomeCard title="1. You ask Claude">“Add milk and bread to my cart.”</WelcomeCard>
        <WelcomeCard title={`2. Valet does it on ${siteName}`}>
          Logged in as you, with your 1Password login. Only on the hosts you approve.
        </WelcomeCard>
        <WelcomeCard title="3. You check and pay">
          Removing things asks you first. Paying is always you.
        </WelcomeCard>
      </div>
      <Banner tone="success" title="Valet never pays.">
        It can’t check out or use your card. Checkout is always you, on the site itself.
      </Banner>
      <Stack gap={3}>
        <Heading level={2} size="group">
          What you’ll need
        </Heading>
        <CheckList label="What you’ll need">
          <CheckItem state="info" title={`Your ${siteName} email and password, ideally in 1Password`} />
          <CheckItem state="info" title="Claude Desktop or Claude Code on this Mac" />
          <CheckItem
            state="info"
            title="About 5 minutes for five short steps. You can stop and come back: Valet remembers where you were."
          />
        </CheckList>
      </Stack>
    </>
  )
}

function WelcomeCard({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription>{children}</CardDescription>
      </CardContent>
    </Card>
  )
}

// ---------- 1Password ----------

function providerState(p: ProviderStatus): { readonly label: string; readonly tone: 'success' | 'neutral' } {
  if (p.available) return { label: 'Ready', tone: 'success' }
  switch (p.unavailableReason) {
    case 'not-installed':
      return { label: 'Not installed', tone: 'neutral' }
    case 'disabled':
      return { label: 'Off', tone: 'neutral' }
    default:
      return { label: 'Not set up', tone: 'neutral' }
  }
}

export function OnePasswordStep({
  providers,
  settings,
  siteName,
}: {
  readonly providers: readonly ProviderStatus[]
  readonly settings: Settings
  readonly siteName: string
}) {
  const vaults = vaultProviders(providers)
  const ready = vaults.filter((p) => p.available)
  const copy = vaults.find((p) => p.kind === 'keychain-copy') ?? null
  // Beside the Keychain copy (D6), only providers this launch can actually use: the rest are
  // alternatives the person hasn't chosen, and listing them unset would read as steps to do.
  const others = vaults.filter((p) => p.kind !== 'keychain-copy' && p.available)
  const first = ready[0]
  return (
    <>
      <StepHeading title={`Where your ${siteName} password comes from`}>
        Valet types a login from your own 1Password into the site’s sign-in page. The site’s adapter never
        sees it, and you pick the item each site may use.
      </StepHeading>
      {first !== undefined ? (
        <Banner tone="success" title={`${PROVIDER_WORDING[first.kind].title} is ready.`}>
          You’ll pick the item in a later step
          {first.kind === 'keychain-copy' ? ', and approve the copy in 1Password' : ''}.
        </Banner>
      ) : (
        // A note, not a warning: on arrival nothing has failed, the person just hasn't set it up yet.
        <Banner tone="info" title="Valet can’t reach 1Password yet.">
          Until it can, a login stops and shows you the site’s sign-in window instead. You can carry on with
          setup and come back to this.
        </Banner>
      )}
      {copy !== null ? <KeychainCopyCard provider={copy} settings={settings} /> : null}
      {others.map((p) => (
        <Card key={p.kind}>
          <ProviderHeader provider={p} />
          <CardContent>
            <CardDescription>{PROVIDER_WORDING[p.kind].detail}</CardDescription>
          </CardContent>
        </Card>
      ))}
    </>
  )
}

function ProviderHeader({ provider }: { readonly provider: ProviderStatus }) {
  const state = providerState(provider)
  return (
    <CardHeader className="items-center">
      <CardTitle className="flex-1">{PROVIDER_WORDING[provider.kind].title}</CardTitle>
      <Badge tone={state.tone}>{state.label}</Badge>
    </CardHeader>
  )
}

function KeychainCopyCard({
  provider,
  settings,
}: {
  readonly provider: ProviderStatus
  readonly settings: Settings
}) {
  const api = useApi()
  const save = useAction()
  const [draft, setDraft] = useState(settings.onePasswordAccount ?? '')
  const trimmed = draft.trim()
  const value = trimmed === '' ? null : trimmed
  const changed = value !== settings.onePasswordAccount
  return (
    <Card>
      <ProviderHeader provider={provider} />
      <CardContent>
        <Stack gap={3}>
          <CardDescription>
            {PROVIDER_WORDING[provider.kind].detail} Turn on “Integrate with other apps” in 1Password’s
            Developer settings first.
          </CardDescription>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (changed) void save.run(() => api.settings.set({ onePasswordAccount: value }))
            }}
          >
            <Field
              label="1Password account"
              description="The account name at the top of 1Password’s sidebar."
              className="min-w-[min(100%,18rem)] flex-1"
            >
              <Input
                placeholder="my.1password.com"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={!changed}
              disabledReason="Type the account name first"
              loading={save.busy}
              className="mb-6"
            >
              Save
            </Button>
          </form>
          <Failed failed={save.failed} what="save the account" />
        </Stack>
      </CardContent>
    </Card>
  )
}

// ---------- Approve ----------

export function NoAdapter() {
  return (
    <StepHeading title="No site to set up">
      This build has no bundled site adapter. You can finish setup and add one later.
    </StepHeading>
  )
}

export function ApproveStep({
  adapter,
  review,
}: {
  readonly adapter: AdapterDetail | null
  readonly review: PendingReview | null
}) {
  if (adapter === null) return <NoAdapter />
  const approved = adapter.approval === 'approved'
  return (
    <>
      <StepHeading title={`Approve ${adapter.name}`}>
        Approving lets this exact version of the {adapter.name} adapter offer its tools to Claude. It can only
        reach what it declares below, and any later version waits for you to review it again.
      </StepHeading>
      <AdapterFacts adapter={adapter} review={review} />
      {approved && review === null ? (
        <Banner
          tone="success"
          title={`${adapter.name} ${adapter.version} is approved. Its tools are on MCP.`}
          icon={<ApprovalSeal size={20} label="Approved" />}
        />
      ) : review !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" asChild>
            <a href={href.setupReview()}>
              Review {review.name} {review.to.version}…
            </a>
          </Button>
          <Text size="sm" tone="muted">
            {approved
              ? `${adapter.version} stays approved until you decide on ${review.to.version}.`
              : 'Until you approve, its tools stay off MCP.'}
          </Text>
        </div>
      ) : (
        <Text tone="muted">
          {adapter.approval === 'rejected'
            ? `You turned down ${adapter.name} ${adapter.version}. Its tools stay off MCP.`
            : 'Nothing is waiting for review.'}
        </Text>
      )}
    </>
  )
}

function AdapterFacts({
  adapter,
  review,
}: {
  readonly adapter: AdapterDetail
  readonly review: PendingReview | null
}) {
  // A first install's review is the whole manifest; otherwise the installed one is what runs.
  const firstInstall = review !== null && review.from === null
  const version = firstInstall ? review.to.version : adapter.version
  const hosts = (origins: readonly string[]) => (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
      {origins.map((o) => (
        <Value key={o} mono>
          {hostOf(o)}
        </Value>
      ))}
    </span>
  )
  return (
    <Card data-testid="setup-perms">
      <CardHeader className="items-center">
        <CardTitle className="flex-1">
          {adapter.name} {version}
        </CardTitle>
        <Text size="sm" tone="muted">
          Comes with Valet
        </Text>
      </CardHeader>
      <CardContent>
        <DescriptionList
          items={[
            { term: 'Opens pages on', value: hosts(adapter.navigation) },
            { term: 'Contacts', value: hosts(adapter.egress) },
            { term: 'API requests', value: plural(adapter.requests.length, 'declared request') },
            {
              term: 'Tools',
              value: (
                <span className="inline-flex flex-wrap gap-1.5">
                  <RiskBadge purpose="read">{adapter.toolCounts.read} read</RiskBadge>
                  <RiskBadge purpose="write">{adapter.toolCounts.write} write</RiskBadge>
                  <RiskBadge purpose="irreversible">{adapter.toolCounts.irreversible} irreversible</RiskBadge>
                </span>
              ),
            },
            {
              term: 'Asks for',
              value:
                adapter.secretRequests.length === 0 ? (
                  'No secrets'
                ) : (
                  <Stack gap={1}>
                    {adapter.secretRequests.map((s) => (
                      <span key={s.name} className="inline-flex flex-wrap items-center gap-1.5">
                        <SecretBadge name={s.name} />
                        {s.fields.map((f) => FIELD_WORDING[f]).join(', ')}, typed only on {hosts(s.origins)}
                      </span>
                    ))}
                  </Stack>
                ),
            },
          ]}
        />
      </CardContent>
    </Card>
  )
}

// ---------- Login ----------

function ApproveFirst({ adapter, why }: { readonly adapter: AdapterDetail; readonly why: string }) {
  return (
    <Banner
      tone="info"
      title={`Approve ${adapter.name} first`}
      action={
        <Button variant="primary" asChild>
          <a href={href.setup('approve')}>Go to approval</a>
        </Button>
      }
    >
      {why}
    </Banner>
  )
}

export function GrantStep({ adapter }: { readonly adapter: AdapterDetail | null }) {
  if (adapter === null) return <NoAdapter />
  const approved = adapter.approval === 'approved'
  const codes = adapter.messages.find((m) => m.grant !== null)?.grant ?? null
  return (
    <>
      <StepHeading title={`Your ${adapter.name} login`}>
        Pick the 1Password item {adapter.name} may use. Valet types it only on the sign-in pages listed here,
        and only for this exact version: an update needs to be given it again.
      </StepHeading>
      {!approved ? (
        <ApproveFirst adapter={adapter} why="A login is tied to the version you approved." />
      ) : adapter.secretRequests.length === 0 && adapter.messages.length === 0 ? (
        <Text tone="muted">{adapter.name} doesn’t ask for any secrets.</Text>
      ) : (
        <Card>
          <CardContent>
            <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
              {adapter.secretRequests.map((s) => (
                <GrantRow
                  key={s.name}
                  badge={<SecretBadge name={s.name} />}
                  granted={s.grant !== null}
                  text={
                    s.grant === null ? (
                      <>
                        Not given yet. Typed only on <Hosts origins={s.origins} />
                      </>
                    ) : (
                      <>
                        Uses “{s.grant.itemTitle}” from {PROVIDER_WORDING[s.grant.provider].title}, typed only
                        on <Hosts origins={s.grant.origins} />
                      </>
                    )
                  }
                  to={href.setupGrant(s.name)}
                  verb={s.grant === null ? 'Choose an item…' : 'Change…'}
                />
              ))}
              {adapter.messages.length === 0 ? null : (
                <GrantRow
                  badge={<SecretBadge name="SMS code" />}
                  granted={codes !== null}
                  text={
                    codes !== null ? (
                      `Reads one-time codes from ${codes.itemTitle} in Messages, typed only where the login asks for them`
                    ) : (
                      <>
                        Not given yet. The login asks for a one-time code sent by{' '}
                        {adapter.messages.map((m) => (
                          <Value key={m.sender} mono>
                            {m.sender}
                          </Value>
                        ))}
                      </>
                    )
                  }
                  to={href.setupGrant(MESSAGES_SECRET)}
                  verb={codes !== null ? 'Change…' : 'Allow codes…'}
                />
              )}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  )
}

function Hosts({ origins }: { readonly origins: readonly string[] }) {
  return (
    <>
      {origins.map((o, i) => (
        <span key={o}>
          {i > 0 ? ', ' : null}
          <Value mono>{o}</Value>
        </span>
      ))}
    </>
  )
}

function GrantRow({
  badge,
  granted,
  text,
  to,
  verb,
}: {
  readonly badge: ReactNode
  readonly granted: boolean
  readonly text: ReactNode
  readonly to: string
  readonly verb: string
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      {badge}
      <span className="min-w-[min(100%,16rem)] flex-1 text-md text-fg-muted">{text}</span>
      <Button variant={granted ? 'secondary' : 'primary'} asChild>
        <a href={to}>{verb}</a>
      </Button>
    </li>
  )
}

// ---------- Store ----------

/** The adapter's required settings: for Woolworths, the store its prices and stock come from (D69). */
export function StoreStep({ adapter }: { readonly adapter: AdapterDetail | null }) {
  const now = useNow(30_000)
  if (adapter === null) return <NoAdapter />
  const approved = adapter.approval === 'approved'
  const required = adapter.settings.filter((s) => s.required)
  return (
    <>
      <StepHeading title={`Your ${adapter.name} store`}>
        Prices, specials and what’s in stock follow the store, and {adapter.name}’s tools wait until one is
        chosen. You can change it later on the {adapter.name} page.
      </StepHeading>
      {!approved ? (
        <ApproveFirst adapter={adapter} why="The store is found through its tools." />
      ) : required.length === 0 ? (
        <Text tone="muted">{adapter.name} doesn’t need a store or any other setting.</Text>
      ) : (
        <Card data-testid="setup-settings">
          <CardContent>
            <Stack gap={4}>
              {required.map((s) => (
                <StoreChooser key={s.name} adapter={adapter} setting={s} now={now} />
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
    </>
  )
}

// ---------- Connect Claude ----------

export function ClientsStep({
  clients,
  endpoint,
}: {
  readonly clients: readonly ClientInfo[]
  readonly endpoint: EndpointStatus
}) {
  return (
    <>
      <StepHeading title="Connect Claude">
        Each app gets its own token, which only Valet’s bridge reads: no token sits in Claude’s config, and
        you can cut one app off without touching the other.
      </StepHeading>
      {SETUP_CLIENTS.map((c) => (
        <ClientCard key={c.kind} kind={c.kind} name={c.name} client={setupClient(clients, c.kind)} />
      ))}
      {endpoint.listening && endpoint.url !== null ? (
        <Banner tone="info" title="Valet listens on this Mac only.">
          At <Value mono>{endpoint.url}</Value>. Other apps can be added under{' '}
          <TextLink href={href.connections()}>Connections</TextLink>, each with its own token.
        </Banner>
      ) : (
        <Banner
          tone="warning"
          title="The MCP endpoint is off."
          action={
            <Button asChild>
              <a href={href.connections()}>Open Connections</a>
            </Button>
          }
        >
          Turn it on under Connections before Claude can call a tool.
        </Banner>
      )}
    </>
  )
}

const CLIENT_HELP: Readonly<Record<ClientKind, string>> = {
  'claude-code': 'Run this in a terminal. It adds Valet to Claude Code for your user.',
  'claude-desktop':
    'Or add this to claude_desktop_config.json yourself (Settings › Developer › Edit Config), then restart it.',
}

function ClientCard({
  kind,
  name,
  client,
}: {
  readonly kind: ClientKind
  readonly name: string
  readonly client: ClientInfo | null
}) {
  const api = useApi()
  const add = useAction()
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle className="flex-1">{name}</CardTitle>
        {client === null ? null : client.lastSeen !== null ? (
          <Badge tone="success">Connected</Badge>
        ) : (
          <Badge>Not connected yet</Badge>
        )}
      </CardHeader>
      <CardContent>
        {client === null ? (
          <Stack gap={2}>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                leading={<Plus />}
                loading={add.busy}
                onClick={() => void add.run(() => api.clients.add(name))}
              >
                Add {name}
              </Button>
              <Text size="sm" tone="muted">
                Makes its token and the setup to copy
              </Text>
            </div>
            <Failed failed={add.failed} what={`add ${name}`} />
          </Stack>
        ) : (
          <ClientSnippet client={client} kind={kind} />
        )}
      </CardContent>
    </Card>
  )
}

function ClientSnippet({ client, kind }: { readonly client: ClientInfo; readonly kind: ClientKind }) {
  const api = useApi()
  const copy = useAction()
  const [copied, setCopied] = useState(false)
  const snippets = useLoad((a) => a.clients.snippets(client.id), [client.id], ['clients-changed'])
  if (snippets.status === 'loading') return <Spinner />
  const text =
    snippets.status === 'ready' ? (snippets.data.find((s) => s.client === kind)?.text ?? null) : null
  if (text === null) return <Text tone="muted">This build has no bridge to set {client.name} up with.</Text>
  return (
    <Stack gap={3}>
      {kind === 'claude-desktop' ? <AddToClaudeDesktop clientId={client.id} /> : null}
      <Text size="sm" tone="muted">
        {CLIENT_HELP[kind]}
      </Text>
      <CodeBlock label={`${client.name} setup`} wrap>
        {text}
      </CodeBlock>
      <div className="flex flex-wrap items-center gap-2">
        {/* The main process copies: a sandboxed window can't always reach the clipboard. */}
        <Button
          leading={copied ? <Check /> : <Copy />}
          loading={copy.busy}
          onClick={async () => setCopied(await copy.run(() => api.clients.copyConfig(client.id, kind)))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Failed failed={copy.failed} what="copy" />
      </div>
    </Stack>
  )
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * "Add to Claude Desktop" (D-connect): writes the app's bridge entry into Claude Desktop's config, in
 * place of copying JSON by hand. The old file is kept beside it.
 */
function AddToClaudeDesktop({ clientId }: { readonly clientId: string }) {
  const api = useApi()
  const action = useAction()
  const [written, setWritten] = useState<DesktopConfigWritten | null>(null)
  return (
    <Stack gap={2}>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={written === null ? 'primary' : 'secondary'}
          leading={written === null ? <Plus /> : <Check />}
          loading={action.busy}
          onClick={() =>
            void action.run(async () => setWritten(await api.clients.addToClaudeDesktop(clientId)))
          }
        >
          {written === null ? 'Add to Claude Desktop' : 'Added to Claude Desktop'}
        </Button>
        {written === null && !action.failed ? (
          <Text size="sm" tone="muted">
            Keeps your other servers, and a copy of the old file
          </Text>
        ) : null}
      </div>
      {written !== null ? (
        <Banner tone="success" title="Quit and reopen Claude Desktop to load Valet." live>
          {written.backup === null ? null : (
            <>
              The old config is kept beside it as <Value mono>{fileName(written.backup)}</Value>.
            </>
          )}
        </Banner>
      ) : null}
      {action.failed ? (
        <Banner
          tone="warning"
          title="Valet couldn’t update Claude Desktop’s config, and left it as it was."
          live
        >
          If the file has a mistake in it, fix that and try again, or copy the entry below into it yourself.
        </Banner>
      ) : null}
    </Stack>
  )
}
