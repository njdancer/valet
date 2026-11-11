// First-run setup (AC2, AC3; docs/mockups/onboarding.html): where logins come from, approving the
// bundled adapter, granting its login, and connecting Claude Code and Claude Desktop. Each step
// reads its state from the same API as the rest of the control panel, so a step done elsewhere
// shows as done here, and the setup can be left and resumed at any point. The approval and the
// grant are the app's own review screen and grant sheet, opened from setup and returning to it,
// so setup can't approve or grant anything those screens wouldn't.

import { type ReactNode, useState } from 'react'
import type {
  AdapterDetail,
  ClientInfo,
  ClientKind,
  EndpointStatus,
  PendingReview,
  ProviderStatus,
  Settings,
} from '../../../shared/api'
import { AddToClaudeDesktop } from '../../components/AddToClaudeDesktop'
import { ActionFailed, Avatar, Hash, Icon, SecretBadge, SideEffect } from '../../components/ui'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { hostOf, plural } from '../../lib/format'
import { href, navigate, SETUP_STEPS, type SetupStep } from '../../lib/router'
import { FIELD_WORDING, PROVIDER_WORDING } from '../../lib/wording'
import { OnePasswordAccountSetting } from '../secrets/OnePasswordSettings'
import { MESSAGES_SECRET } from '../sites/grant/target'
import { SettingBlock } from '../sites/SettingChooser'

/** The adapter setup approves and grants: the bundled one. */
export const SETUP_ADAPTER = 'woolworths'

/** The clients setup offers, each added under this name with its own token (D42). */
export const SETUP_CLIENTS: readonly { readonly kind: ClientKind; readonly name: string }[] = [
  { kind: 'claude-code', name: 'Claude Code' },
  { kind: 'claude-desktop', name: 'Claude Desktop' },
]

const STEP_TITLES: Readonly<Record<SetupStep, { readonly title: string; readonly sub: string }>> = {
  welcome: { title: 'Welcome', sub: 'What Valet does' },
  onepassword: { title: '1Password', sub: 'Where logins come from' },
  approve: { title: 'Approve the adapter', sub: 'What it may do' },
  grant: { title: 'Grant its login', sub: 'Which item it may use' },
  store: { title: 'Pick your store', sub: 'Where prices and stock come from' },
  clients: { title: 'Connect Claude', sub: 'Claude Code, Claude Desktop' },
}

const welcomeStep: SetupStep = 'welcome'

/** What setup knows once everything has loaded. */
export interface SetupFacts {
  readonly providers: readonly ProviderStatus[]
  readonly adapter: AdapterDetail | null
  /** The adapter's pending review, if any. */
  readonly review: PendingReview | null
  readonly clients: readonly ClientInfo[]
  readonly endpoint: EndpointStatus
  readonly settings: Settings
}

/** The providers a login secret can come from: everything but Messages, which only has codes. */
export function vaultProviders(providers: readonly ProviderStatus[]): readonly ProviderStatus[] {
  return providers.filter((p) => p.kind !== 'messages')
}

/** The non-revoked client setup added for `kind`, by the name it gave it. */
export function setupClient(clients: readonly ClientInfo[], kind: ClientKind): ClientInfo | null {
  const name = SETUP_CLIENTS.find((c) => c.kind === kind)?.name
  return clients.find((c) => c.name === name && c.revokedAt === null) ?? null
}

/** Whether each step is done. Welcome is done once the person has done something in a later one. */
export function stepsDone(facts: SetupFacts): Readonly<Record<SetupStep, boolean>> {
  const adapter = facts.adapter
  const onepassword = vaultProviders(facts.providers).some((p) => p.available)
  const approve = adapter !== null && adapter.approval === 'approved'
  // Every secret, and the one-time codes when the adapter reads any: a login that needs a code it
  // may not read stops at the code page, so setup isn't done without that grant either.
  const grant =
    approve &&
    adapter.secretRequests.every((s) => s.grant !== null) &&
    (adapter.messages.length === 0 || adapter.messages.some((m) => m.grant !== null))
  // Every required setting (the store, D69): until it is chosen every tool ends needsUser. Its own
  // step (D-setup), so the login step isn't also the place a store hides.
  const store = approve && adapter.settings.every((s) => !s.required || s.chosen !== null)
  // Connected, not just added: copying a config isn't the client using it.
  const clients = facts.clients.some((c) => c.revokedAt === null && c.lastSeen !== null)
  // A provider can be ready before the person has done anything (set up outside the app, or demo
  // mode's test provider), so it alone doesn't skip the welcome.
  return { welcome: approve || grant || clients, onepassword, approve, grant, store, clients }
}

/** Where `#/setup` with no step lands: the first step not done, or welcome if nothing is. */
export function resumeStep(done: Readonly<Record<SetupStep, boolean>>): SetupStep {
  return SETUP_STEPS.find((s) => !done[s]) ?? 'clients'
}

export function SetupPage({ step }: { readonly step: SetupStep | null }) {
  const providers = useLoad((a) => a.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const adapter = useLoad(
    (a) => a.adapters.get(SETUP_ADAPTER),
    [],
    ['adapters-changed', 'approvals-changed', 'grants-changed'],
  )
  const reviews = useLoad((a) => a.approvals.pending(), [], ['approvals-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])

  const all = [providers, adapter, reviews, clients, endpoint, settings]
  if (all.some((l) => l.status === 'error')) {
    return (
      <SetupFrame step={step ?? 'welcome'} done={null}>
        <div className="empty" role="alert">
          Couldn’t load setup. Valet will try again when something changes.
        </div>
      </SetupFrame>
    )
  }
  if (
    providers.status !== 'ready' ||
    adapter.status !== 'ready' ||
    reviews.status !== 'ready' ||
    clients.status !== 'ready' ||
    endpoint.status !== 'ready' ||
    settings.status !== 'ready'
  ) {
    return (
      <SetupFrame step={step ?? 'welcome'} done={null}>
        <div className="empty">Loading setup…</div>
      </SetupFrame>
    )
  }
  const facts: SetupFacts = {
    providers: providers.data,
    adapter: adapter.data,
    review: reviews.data.find((r) => r.adapterId === SETUP_ADAPTER) ?? null,
    clients: clients.data,
    endpoint: endpoint.data,
    settings: settings.data,
  }
  const done = stepsDone(facts)
  const current = step ?? resumeStep(done)
  return (
    <SetupFrame step={current} done={done} clientAdded={facts.clients.some((c) => c.revokedAt === null)}>
      <StepView step={current} facts={facts} />
    </SetupFrame>
  )
}

function StepView({ step, facts }: { readonly step: SetupStep; readonly facts: SetupFacts }) {
  switch (step) {
    case 'welcome':
      return <Welcome />
    case 'onepassword':
      return <OnePassword providers={facts.providers} settings={facts.settings} />
    case 'approve':
      return <Approve adapter={facts.adapter} review={facts.review} />
    case 'grant':
      return <Grant adapter={facts.adapter} />
    case 'store':
      return <Store adapter={facts.adapter} />
    case 'clients':
      return <Clients clients={facts.clients} endpoint={facts.endpoint} />
  }
}

function SetupFrame({
  step,
  done,
  clientAdded = false,
  children,
}: {
  readonly step: SetupStep
  /** Null while loading: every step reads as not done. */
  readonly done: Readonly<Record<SetupStep, boolean>> | null
  /** A client was added, connected or not: finishing then isn't "without a client". */
  readonly clientAdded?: boolean
  readonly children: ReactNode
}) {
  const api = useApi()
  const finish = useAction()
  const index = SETUP_STEPS.indexOf(step)
  const previous = SETUP_STEPS[index - 1]
  const next = SETUP_STEPS[index + 1]
  const stepDone = done?.[step] ?? false
  const end = async () => {
    if (await finish.run(() => api.setup.finish())) navigate(href.sites())
  }
  return (
    <div className="setup">
      <nav className="setup-rail" aria-label="Setup steps">
        <div className="setup-brand">
          <span className="setup-logo">
            <Icon name="logo" />
          </span>
          <div>
            <div className="h3">Set up Valet</div>
            <div className="xs muted">About 5 minutes</div>
          </div>
        </div>
        {SETUP_STEPS.map((s, i) => {
          const isDone = done?.[s] ?? false
          return (
            <a
              key={s}
              href={href.setup(s)}
              className={`setup-step${s === step ? ' on' : ''}${isDone && s !== step ? ' done' : ''}`}
              aria-current={s === step ? 'step' : undefined}
            >
              <span className="n">{isDone && s !== step ? <Icon name="check" /> : i + 1}</span>
              <span>
                <span className="title">{STEP_TITLES[s].title}</span>
                <span className="sub" style={{ display: 'block' }}>
                  {isDone && s !== welcomeStep ? 'Done' : STEP_TITLES[s].sub}
                </span>
              </span>
            </a>
          )
        })}
        <div className="foot">
          <span>Everything here can be changed later in the control panel.</span>
          <button type="button" className="btn ghost" disabled={finish.busy} onClick={end}>
            Skip setup
          </button>
        </div>
      </nav>
      <main className="setup-main">
        <div className="setup-content">
          <div className="kicker">
            Step {index + 1} of {SETUP_STEPS.length}
          </div>
          {children}
        </div>
        <div className="setup-foot">
          <div className="dots" aria-hidden="true">
            {SETUP_STEPS.map((s) => (
              <i key={s} className={s === step ? 'on' : ''} />
            ))}
          </div>
          <span className="spacer" />
          <ActionFailed failed={finish.failed} what="finish setup" />
          {previous !== undefined ? (
            <a className="btn lg" href={href.setup(previous)}>
              Back
            </a>
          ) : null}
          {next !== undefined && (stepDone || step === welcomeStep) ? (
            <a className="btn lg primary" href={href.setup(next)}>
              Continue
            </a>
          ) : next !== undefined ? (
            // Until the step is done, the main button waits and skipping is the quiet choice: a blue
            // "Skip for now" invited people past the approval, grant and store every tool needs.
            <>
              <a className="btn lg ghost" href={href.setup(next)}>
                Skip for now
              </a>
              <button type="button" className="btn lg primary" disabled title="Finish this step first">
                Continue
              </button>
            </>
          ) : (
            <button type="button" className="btn lg primary" disabled={finish.busy} onClick={end}>
              {stepDone || clientAdded ? 'Finish' : 'Finish without a client'}
            </button>
          )}
        </div>
      </main>
    </div>
  )
}

function Welcome() {
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">Let your AI tools use websites, not your passwords</h1>
      <p className="lede">
        Valet runs small adapters for sites without a public API, like Woolworths, and offers their tools to
        Claude over MCP. It runs on this Mac only: no account, no cloud.
      </p>
      <div className="setup-flow">
        <div className="box">
          <div className="h3">
            <Icon name="clients" size="sm" />
            Claude
          </div>
          <div className="muted">
            Calls a tool: <span className="mono">woolworths_get_cart</span>
          </div>
        </div>
        <div className="arrow" />
        <div className="box">
          <div className="h3">
            <Icon name="logo" size="sm" />
            Valet
          </div>
          <div className="muted">
            Runs the adapter in a browser session and checks every request against its manifest
          </div>
        </div>
        <div className="arrow" />
        <div className="box">
          <div className="h3">
            <Icon name="globe" size="sm" />
            woolworths.com.au
          </div>
          <div className="muted">Sees an ordinary browser, logged in as you</div>
        </div>
      </div>
      <div className="setup-never">
        <div className="card">
          <div className="h3">
            <Icon name="key" size="sm" className="secret-text" />
            Adapters never see a password
          </div>
          <div className="muted">
            Logins run in a separate browser session, with values from 1Password. Adapter code never runs
            there, and gets a logged-in page afterwards.
          </div>
        </div>
        <div className="card">
          <div className="h3">
            <Icon name="globe" size="sm" />
            Only declared hosts
          </div>
          <div className="muted">
            Every request an adapter makes is checked against the hosts and API calls it declared and you
            approved.
          </div>
        </div>
        <div className="card">
          <div className="h3">
            <Icon name="touchid" size="sm" className="danger-text" />
            Nothing irreversible without you
          </div>
          <div className="muted">
            Checkout, payment and the like wait for your confirmation in this app. An agent can’t give it.
          </div>
        </div>
      </div>
    </section>
  )
}

function providerState(p: ProviderStatus): { readonly label: string; readonly tone: 'ok' | '' } {
  if (p.available) return { label: 'Ready', tone: 'ok' }
  switch (p.unavailableReason) {
    case 'not-installed':
      return { label: 'Not installed', tone: '' }
    case 'disabled':
      return { label: 'Off', tone: '' }
    default:
      return { label: 'Not set up', tone: '' }
  }
}

function OnePassword({
  providers,
  settings,
}: {
  readonly providers: readonly ProviderStatus[]
  readonly settings: Settings
}) {
  const api = useApi()
  const save = useAction()
  const vaults = vaultProviders(providers)
  const ready = vaults.filter((p) => p.available)
  const copy = vaults.find((p) => p.kind === 'keychain-copy') ?? null
  // Beside the Keychain copy (D6), only providers this launch can actually use: the rest are
  // alternatives Nick hasn't chosen, and listing them unset would read as steps to do.
  const others = vaults.filter((p) => p.kind !== 'keychain-copy' && p.available)
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">Where logins come from</h1>
      <p className="lede">
        Valet types a login from your own 1Password into the site’s sign-in page. Adapters never see it, and
        you pick the item each one may use.
      </p>
      <div className="stack gap-3">
        {copy !== null ? (
          <div className="card">
            <ProviderHead provider={copy} />
            <div className="card-body stack">
              <div className="xs muted">
                {PROVIDER_WORDING[copy.kind].detail} Turn on “Integrate with other apps” in 1Password’s
                Developer settings first.
              </div>
              <OnePasswordAccountSetting
                value={settings.onePasswordAccount}
                onSave={(account) => save.run(() => api.settings.set({ onePasswordAccount: account }))}
              />
              <ActionFailed failed={save.failed} what="save the account" />
            </div>
          </div>
        ) : null}
        {others.map((p) => (
          <div className="card" key={p.kind}>
            <ProviderHead provider={p} />
            <div className="card-body xs muted">{PROVIDER_WORDING[p.kind].detail}</div>
          </div>
        ))}
      </div>
      {ready.length > 0 ? (
        <div className="setup-done">
          <Icon name="check" />
          {PROVIDER_WORDING[ready[0]?.kind ?? 'fake'].title} is ready. You’ll pick the item in a later step
          {ready[0]?.kind === 'keychain-copy' ? ', and approve the copy in 1Password' : ''}.
        </div>
      ) : (
        // A note, not a warning: on arrival nothing has failed, the person just hasn't set it up yet.
        <div className="callout info" style={{ marginTop: 'var(--space-4)' }}>
          <Icon name="key" />
          <div>
            Valet can’t reach 1Password yet. Until it can, a login stops and shows you the site’s sign-in
            window instead. You can carry on with setup and come back to this.
          </div>
        </div>
      )}
    </section>
  )
}

function ProviderHead({ provider }: { readonly provider: ProviderStatus }) {
  const state = providerState(provider)
  return (
    <div className="card-head">
      <span className={`dot ${provider.available ? 'ok' : 'warn'}`} />
      <span className="h3">{PROVIDER_WORDING[provider.kind].title}</span>
      <span className={`pill ${state.tone}`} style={{ marginLeft: 'auto' }}>
        {state.label}
      </span>
    </div>
  )
}

function Approve({
  adapter,
  review,
}: {
  readonly adapter: AdapterDetail | null
  readonly review: PendingReview | null
}) {
  if (adapter === null) return <NoAdapter />
  const approved = adapter.approval === 'approved'
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">Approve the {adapter.name} adapter</h1>
      <p className="lede">
        Approving lets this exact bundle offer its tools to Claude. It can only reach what its manifest
        declares, and any later version waits for you to review it again.
      </p>
      <AdapterCard adapter={adapter} review={review} />
      <div className="row" style={{ marginTop: 'var(--space-4)' }}>
        {approved && review === null ? (
          <div className="setup-done" style={{ marginTop: 0 }}>
            <Icon name="check" />
            {adapter.name} {adapter.version} is approved. Its tools are on MCP.
          </div>
        ) : review !== null ? (
          <>
            <a className="btn lg primary" href={href.setupReview()}>
              Review {review.name} {review.to.version}…
            </a>
            <span className="xs muted">
              {approved
                ? `${adapter.version} stays approved until you decide on ${review.to.version}.`
                : 'Until you approve, its tools stay off MCP.'}
            </span>
          </>
        ) : (
          <span className="small muted">
            {adapter.approval === 'rejected'
              ? `You rejected ${adapter.name} ${adapter.version}. Its tools stay off MCP.`
              : 'Nothing is waiting for review.'}
          </span>
        )}
      </div>
    </section>
  )
}

function AdapterCard({
  adapter,
  review,
}: {
  readonly adapter: AdapterDetail
  readonly review: PendingReview | null
}) {
  // A first install's review is the whole manifest; otherwise the installed one is what runs.
  const firstInstall = review !== null && review.from === null
  const version = firstInstall ? review.to.version : adapter.version
  const hash = firstInstall ? review.to.hash : adapter.hash
  return (
    <div className="card">
      <div className="card-head">
        <Avatar adapterId={adapter.id} name={adapter.name} />
        <span className="h3">
          {adapter.name} {version}
        </span>
        <Hash hash={hash} />
        <span className="muted" style={{ marginLeft: 'auto' }}>
          Bundled with Valet
        </span>
      </div>
      <dl className="setup-perms">
        <dt>Opens pages on</dt>
        <dd>
          {adapter.navigation.map((o) => (
            <span key={o} className="mono">
              {hostOf(o)}
            </span>
          ))}
        </dd>
        <dt>Contacts</dt>
        <dd>
          {adapter.egress.map((h) => (
            <span key={h} className="mono">
              {h}
            </span>
          ))}
        </dd>
        <dt>API requests</dt>
        <dd>{plural(adapter.requests.length, 'declared request')}</dd>
        <dt>Tools</dt>
        <dd>
          <SideEffect purpose="read">{adapter.toolCounts.read} read</SideEffect>
          <SideEffect purpose="write">{adapter.toolCounts.write} write</SideEffect>
          <SideEffect purpose="irreversible">{adapter.toolCounts.irreversible} irreversible</SideEffect>
        </dd>
        <dt>Asks for</dt>
        <dd>
          {adapter.secretRequests.length === 0
            ? 'No secrets'
            : adapter.secretRequests.map((s) => (
                <span key={s.name} className="row" style={{ gap: 6 }}>
                  <SecretBadge name={s.name} />
                  {s.fields.map((f) => FIELD_WORDING[f]).join(', ')}, typed only on{' '}
                  {s.origins.map((o) => (
                    <span key={o} className="mono">
                      {hostOf(o)}
                    </span>
                  ))}
                </span>
              ))}
        </dd>
      </dl>
    </div>
  )
}

function Grant({ adapter }: { readonly adapter: AdapterDetail | null }) {
  if (adapter === null) return <NoAdapter />
  const approved = adapter.approval === 'approved'
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">Let {adapter.name} use your login</h1>
      <p className="lede">
        Pick the 1Password item {adapter.name} may use. Valet types it only on the sign-in origins listed
        here, and only for this exact version: an update needs a new grant.
      </p>
      {!approved ? (
        <div className="callout info">
          <Icon name="key" />
          <div>
            Approve {adapter.name} first: a grant is tied to the version you approved.{' '}
            <a href={href.setup('approve')}>Go to approval</a>
          </div>
        </div>
      ) : (
        <div className="card">
          {adapter.secretRequests.map((s) => (
            <div className="setup-bind" key={s.name}>
              <Icon name="key" className="secret-text" />
              <SecretBadge name={s.name} />
              <span>
                {s.grant === null ? (
                  <>
                    Not granted. Typed only on{' '}
                    {s.origins.map((o) => (
                      <span key={o} className="mono">
                        {o}
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    Uses “{s.grant.itemTitle}” from {PROVIDER_WORDING[s.grant.provider].title}, typed only on{' '}
                    {s.grant.origins.map((o) => (
                      <span key={o} className="mono">
                        {o}
                      </span>
                    ))}
                  </>
                )}
              </span>
              <a
                className={`btn${s.grant === null ? ' primary' : ''}`}
                style={{ marginLeft: 'auto' }}
                href={href.setupGrant(s.name)}
              >
                {s.grant === null ? 'Choose an item…' : 'Change…'}
              </a>
            </div>
          ))}
          {adapter.messages.length === 0 ? null : (
            <div className="setup-bind">
              <Icon name="key" className="secret-text" />
              <span className="badge secret">SMS code</span>
              <span>
                {adapter.messages.some((m) => m.grant !== null) ? (
                  <>
                    Reads one-time codes from{' '}
                    {adapter.messages.find((m) => m.grant !== null)?.grant?.itemTitle} in Messages, typed only
                    where the login asks for them
                  </>
                ) : (
                  <>
                    Not granted. The login asks for a one-time code sent by{' '}
                    {adapter.messages.map((m) => (
                      <span key={m.sender} className="mono">
                        {m.sender}
                      </span>
                    ))}
                  </>
                )}
              </span>
              <a
                className={`btn${adapter.messages.some((m) => m.grant !== null) ? '' : ' primary'}`}
                style={{ marginLeft: 'auto' }}
                href={href.setupGrant(MESSAGES_SECRET)}
              >
                {adapter.messages.some((m) => m.grant !== null) ? 'Change…' : 'Allow codes…'}
              </a>
            </div>
          )}
          {adapter.secretRequests.length === 0 && adapter.messages.length === 0 ? (
            <div className="empty">{adapter.name} doesn’t ask for any secrets.</div>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** The adapter's required settings: for Woolworths, the store its prices and stock come from (D69). */
function Store({ adapter }: { readonly adapter: AdapterDetail | null }) {
  const now = useNow(30_000)
  if (adapter === null) return <NoAdapter />
  const approved = adapter.approval === 'approved'
  const required = adapter.settings.filter((s) => s.required)
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">Pick your {adapter.name} store</h1>
      <p className="lede">
        Prices, specials and what’s in stock follow the store, and {adapter.name}’s tools wait until one is
        chosen. You can change it later on the adapter’s page.
      </p>
      {!approved ? (
        <div className="callout info">
          <Icon name="adapter" />
          <div>
            Approve {adapter.name} first: the store is found through its tools.{' '}
            <a href={href.setup('approve')}>Go to approval</a>
          </div>
        </div>
      ) : required.length === 0 ? (
        <div className="empty">{adapter.name} doesn’t need a store or any other setting.</div>
      ) : (
        <div className="card" data-testid="setup-settings">
          <div className="card-body stack gap-3">
            {required.map((s) => (
              <SettingBlock key={s.name} adapter={adapter} setting={s} now={now} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function NoAdapter() {
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">No adapter to set up</h1>
      <p className="lede">This build has no bundled adapter. You can finish setup and add one later.</p>
    </section>
  )
}

function Clients({
  clients,
  endpoint,
}: {
  readonly clients: readonly ClientInfo[]
  readonly endpoint: EndpointStatus
}) {
  return (
    <section aria-labelledby="setup-title">
      <h1 id="setup-title">Connect Claude</h1>
      <p className="lede">
        Each client gets its own token, which only Valet’s bridge reads: no token sits in Claude’s config, and
        you can cut one client off without touching the other.
      </p>
      <div className="stack gap-3">
        {SETUP_CLIENTS.map((c) => (
          <ClientCard key={c.kind} kind={c.kind} name={c.name} client={setupClient(clients, c.kind)} />
        ))}
      </div>
      <div className="callout info" style={{ marginTop: 'var(--space-4)' }}>
        <Icon name="clients" />
        <div>
          {endpoint.listening && endpoint.url !== null ? (
            <>
              The endpoint listens on this Mac only, at <span className="mono">{endpoint.url}</span>. Other
              clients can be added under Clients, each with its own token.
            </>
          ) : (
            'The MCP endpoint is off. Turn it on under Clients before Claude can call a tool.'
          )}
        </div>
      </div>
    </section>
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
    <div className="card">
      <div className="card-head">
        <span className="h3">{name}</span>
        {client === null ? null : client.lastSeen !== null ? (
          <span className="pill ok" style={{ marginLeft: 'auto' }}>
            Connected
          </span>
        ) : (
          <span className="pill" style={{ marginLeft: 'auto' }}>
            Not connected yet
          </span>
        )}
      </div>
      <div className="card-body stack">
        {client === null ? (
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={add.busy}
              onClick={() => add.run(() => api.clients.add(name))}
            >
              <Icon name="plus" size="sm" />
              Add {name}
            </button>
            <span className="xs muted">Makes its token and the setup to copy</span>
            <ActionFailed failed={add.failed} what={`add ${name}`} />
          </div>
        ) : (
          <ClientSnippet client={client} kind={kind} />
        )}
      </div>
    </div>
  )
}

function ClientSnippet({ client, kind }: { readonly client: ClientInfo; readonly kind: ClientKind }) {
  const api = useApi()
  const copy = useAction()
  const [copied, setCopied] = useState(false)
  const snippets = useLoad((a) => a.clients.snippets(client.id), [client.id], ['clients-changed'])
  if (snippets.status === 'loading') return <div className="xs muted">Loading its setup…</div>
  const text =
    snippets.status === 'ready' ? (snippets.data.find((s) => s.client === kind)?.text ?? null) : null
  if (text === null)
    return <div className="xs muted">This build has no bridge to set {client.name} up with.</div>
  return (
    <>
      {kind === 'claude-desktop' ? <AddToClaudeDesktop clientId={client.id} /> : null}
      <div className="xs muted">{CLIENT_HELP[kind]}</div>
      <pre className="code">{text}</pre>
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={copy.busy}
          onClick={async () => setCopied(await copy.run(() => api.clients.copyConfig(client.id, kind)))}
        >
          <Icon name={copied ? 'check' : 'copy'} size="sm" />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <ActionFailed failed={copy.failed} what="copy" />
      </div>
    </>
  )
}
