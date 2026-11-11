// First-run setup (AC2, AC3; wireframes 90-setup): the whole window, a step list on the left and one
// step on the right in a column whose heading never moves, with Back and Continue in the same place
// on every step. Every step reads its state from the same API as the rest of the app, so a step done
// elsewhere shows as done here, and setup can be left and resumed at any point. A step not done
// can be skipped; whatever is left stays as "Finish setup" in the menu bar.

import {
  ActionBar,
  AppShell,
  Banner,
  Button,
  CheckItem,
  CheckList,
  Heading,
  Page,
  PageBody,
  Sidebar,
  Spacer,
  Sparkle,
  Spinner,
  Stack,
  Stepper,
  type StepState,
  SuccessCheck,
  Text,
  TextLink,
} from '@valet/ui'
import { type ReactNode, useState } from 'react'
import { useAction, useApi } from '../../lib/api-context'
import { navigate } from '../../lib/router'
import { href, SETUP_STEPS, type SetupStep } from '../../lib/routes'
import { PROVIDER_WORDING } from '../../lib/wording'
import {
  ApproveStep,
  ClientsStep,
  Failed,
  GrantStep,
  OnePasswordStep,
  StoreStep,
  WelcomeStep,
} from './SetupSteps'
import {
  ACTION_STEPS,
  resumeStep,
  type SetupFacts,
  type StepsDone,
  stepsDone,
  stepsLeft,
  useSetupFacts,
  waitingClients,
} from './setup-logic'

/** What the step list calls each step, and its line when not done. */
export function stepLabel(
  step: SetupStep,
  siteName: string,
): { readonly title: string; readonly sub: string } {
  switch (step) {
    case 'welcome':
      return { title: 'Welcome', sub: 'What Valet does' }
    case 'onepassword':
      return { title: '1Password', sub: 'Where passwords come from' }
    case 'approve':
      return { title: `Approve ${siteName}`, sub: 'What it may do' }
    case 'grant':
      return { title: 'Your login', sub: 'Which 1Password item' }
    case 'store':
      return { title: 'Your store', sub: 'Where prices come from' }
    case 'clients':
      return { title: 'Connect Claude', sub: 'Claude Desktop or Code' }
  }
}

/** The step list's line for a done step: what was chosen ("Approved 0.3.0"). */
export function doneHint(step: SetupStep, facts: SetupFacts): string {
  const adapter = facts.adapter
  switch (step) {
    case 'onepassword': {
      const ready = facts.providers.find((p) => p.available && p.kind !== 'messages')
      return ready === undefined ? 'Done' : PROVIDER_WORDING[ready.kind].title
    }
    case 'approve':
      return adapter === null ? 'Done' : `Approved ${adapter.version}`
    case 'grant': {
      const item = adapter?.secretRequests.find((s) => s.grant !== null)?.grant?.itemTitle
      return item === undefined ? 'Done' : `“${item}”`
    }
    case 'store': {
      const chosen = adapter?.settings.find((s) => s.chosen !== null)?.chosen?.label
      return chosen ?? 'Done'
    }
    case 'clients': {
      const names = facts.clients
        .filter((c) => c.revokedAt === null && c.lastSeen !== null)
        .map((c) => c.name)
      return names.length === 0 ? 'Done' : names.join(', ')
    }
    default:
      return 'Done'
  }
}

export function SetupFlow({ step }: { readonly step: SetupStep | null }) {
  const facts = useSetupFacts()
  const [finished, setFinished] = useState(false)
  if (facts.status !== 'ready') {
    return (
      <SetupShell step={step ?? 'welcome'} facts={null} finished={false}>
        {facts.status === 'error' ? (
          <Page>
            <PageBody width="form">
              <Text role="alert" tone="muted">
                Couldn’t load setup. Valet will try again when something changes.
              </Text>
            </PageBody>
          </Page>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )}
      </SetupShell>
    )
  }
  const done = stepsDone(facts.data)
  const current = step ?? resumeStep(done)
  return (
    <SetupShell step={current} facts={facts.data} finished={finished}>
      {finished ? (
        <DoneView facts={facts.data} done={done} />
      ) : (
        <StepPage step={current} facts={facts.data} done={done} onFinished={() => setFinished(true)} />
      )}
    </SetupShell>
  )
}

function SetupShell({
  step,
  facts,
  finished,
  children,
}: {
  readonly step: SetupStep
  /** Null while loading: every step reads as not done. */
  readonly facts: SetupFacts | null
  readonly finished: boolean
  readonly children: ReactNode
}) {
  const done = facts === null ? null : stepsDone(facts)
  const siteName = facts?.adapter?.name ?? 'your site'
  const steps: { id: string; label: string; state: StepState; href?: string; hint: string }[] =
    SETUP_STEPS.map((s) => {
      const label = stepLabel(s, siteName)
      const isDone = done?.[s] === true && s !== 'welcome'
      const state: StepState =
        !finished && s === step ? 'current' : isDone ? 'done' : finished ? 'skipped' : 'upcoming'
      return {
        id: s,
        label: label.title,
        state,
        href: href.setup(s),
        hint:
          isDone && facts !== null
            ? doneHint(s, facts)
            : finished && s === 'clients' && facts !== null && waitingClients(facts).length > 0
              ? 'Waiting for it to connect'
              : finished && s !== 'welcome'
                ? 'Skipped'
                : label.sub,
      }
    })
  steps.push({
    id: 'done',
    label: 'Done',
    state: finished ? 'current' : 'upcoming',
    hint: finished ? 'Change anything later' : 'Open Valet',
  })
  return (
    <AppShell
      sidebar={
        <Sidebar label="Setup steps" className="w-60">
          <Heading level={2} size="eyebrow" className="px-2">
            Set up Valet · about 5 minutes
          </Heading>
          <Stepper steps={steps} />
          <div className="mt-auto flex flex-col gap-0.5 border-t border-line-subtle px-2 pt-3">
            <Text size="sm" weight="medium">
              Valet never pays.
            </Text>
            <Text size="sm" tone="muted">
              Checkout is always you, on the site itself.
            </Text>
          </div>
        </Sidebar>
      }
    >
      {children}
    </AppShell>
  )
}

function StepPage({
  step,
  facts,
  done,
  onFinished,
}: {
  readonly step: SetupStep
  readonly facts: SetupFacts
  readonly done: StepsDone
  readonly onFinished: () => void
}) {
  const api = useApi()
  const finish = useAction()
  const index = SETUP_STEPS.indexOf(step)
  const previous = SETUP_STEPS[index - 1]
  const next = SETUP_STEPS[index + 1]
  const stepDone = done[step]
  const siteName = facts.adapter?.name ?? 'your site'
  const clientAdded = facts.clients.some((c) => c.revokedAt === null)
  const end = async () => {
    if (await finish.run(() => api.setup.finish())) onFinished()
  }
  // Finish later: setup stops opening at launch; what's left waits as "Finish setup" in the menu bar.
  const later = async () => {
    if (await finish.run(() => api.setup.finish())) navigate(href.sites())
  }
  return (
    <Page>
      <PageBody>
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 pt-6">
          {/* The welcome isn't a step: "five short steps", as it says, are the action steps. */}
          {step === 'welcome' ? null : (
            <Text size="sm" tone="muted" weight="medium">
              Step {index} of {ACTION_STEPS.length}
            </Text>
          )}
          <StepBody step={step} facts={facts} siteName={siteName} />
        </div>
      </PageBody>
      <ActionBar className="flex-wrap">
        {previous !== undefined ? (
          <Button size="lg" asChild>
            <a href={href.setup(previous)}>Back</a>
          </Button>
        ) : null}
        <Button size="lg" variant="ghost" loading={finish.busy} onClick={() => void later()}>
          Finish later
        </Button>
        <Spacer />
        <Failed failed={finish.failed} what="finish setup" />
        {next !== undefined && (stepDone || step === 'welcome') ? (
          <Button size="lg" variant="primary" asChild>
            <a href={href.setup(next)}>{step === 'welcome' ? 'Get started' : 'Continue'}</a>
          </Button>
        ) : next !== undefined ? (
          // Until the step is done, the main button waits and skipping is the quiet choice: a blue
          // "Skip for now" invited people past the approval, login and store every tool needs.
          <>
            <Button size="lg" variant="ghost" asChild>
              <a href={href.setup(next)}>Skip for now</a>
            </Button>
            <Button size="lg" variant="primary" disabled disabledReason="Finish this step first, or skip it">
              Continue
            </Button>
          </>
        ) : (
          <Button size="lg" variant="primary" loading={finish.busy} onClick={() => void end()}>
            {stepDone || clientAdded ? 'Finish' : 'Finish without an app'}
          </Button>
        )}
      </ActionBar>
    </Page>
  )
}

function StepBody({
  step,
  facts,
  siteName,
}: {
  readonly step: SetupStep
  readonly facts: SetupFacts
  readonly siteName: string
}) {
  switch (step) {
    case 'welcome':
      return <WelcomeStep siteName={siteName} />
    case 'onepassword':
      return <OnePasswordStep providers={facts.providers} settings={facts.settings} siteName={siteName} />
    case 'approve':
      return <ApproveStep adapter={facts.adapter} review={facts.review} />
    case 'grant':
      return <GrantStep adapter={facts.adapter} />
    case 'store':
      return <StoreStep adapter={facts.adapter} />
    case 'clients':
      return <ClientsStep clients={facts.clients} endpoint={facts.endpoint} />
  }
}

/** Setup finished: what is set up, what was skipped with a way back to it, and Open Valet. */
function DoneView({ facts, done }: { readonly facts: SetupFacts; readonly done: StepsDone }) {
  const left = stepsLeft(done)
  const siteName = facts.adapter?.name ?? 'your site'
  return (
    <Page>
      <PageBody>
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 pt-6">
          <Stack gap={3} className="items-start">
            <Sparkle play={left === 0}>
              <SuccessCheck size={56} />
            </Sparkle>
            <Heading level={1} size="page" id="setup-title">
              {left === 0 ? 'You’re set up' : 'Almost set up'}
            </Heading>
            <Text tone="muted">
              {left === 0
                ? `Ask Claude to use ${siteName}. Valet asks you here before anything that can’t be undone.`
                : `${left === 1 ? 'One step waits' : `${left} steps wait`} for you. Until they’re done, Claude may not be able to use ${siteName}; they stay in the menu bar as “Finish setup”.`}
            </Text>
          </Stack>
          <CheckList label="Setup">
            {SETUP_STEPS.filter((s) => s !== 'welcome').map((s) => {
              // An app added here but not yet connected: the person did their part.
              const waiting = !done[s] && s === 'clients' ? waitingClients(facts) : []
              return (
                <CheckItem
                  key={s}
                  state={done[s] ? 'pass' : waiting.length > 0 ? 'pending' : 'skipped'}
                  title={
                    done[s]
                      ? `${stepLabel(s, siteName).title}: ${doneHint(s, facts)}`
                      : waiting.length > 0
                        ? `${stepLabel(s, siteName).title}: waiting for ${waiting.join(', ')} to connect`
                        : stepLabel(s, siteName).title
                  }
                  action={
                    done[s] ? undefined : (
                      <Button size="sm" asChild>
                        <a href={href.setup(s)}>{waiting.length > 0 ? 'See the setup' : 'Do it now'}</a>
                      </Button>
                    )
                  }
                />
              )
            })}
          </CheckList>
          <Banner tone="info" title="Valet lives in the menu bar.">
            Its icon shows a count when something needs you, and each one also arrives as a notification. See
            what Claude did any time in <TextLink href={href.calls()}>Activity</TextLink>.
          </Banner>
        </div>
      </PageBody>
      <ActionBar>
        <Spacer />
        <Button size="lg" variant="primary" asChild>
          <a href={href.sites()}>Open Valet</a>
        </Button>
      </ActionBar>
    </Page>
  )
}
