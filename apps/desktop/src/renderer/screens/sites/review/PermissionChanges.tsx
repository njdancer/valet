// Every permission in a review, section by section, as a person reads it: additions tinted by how
// much they widen access and tagged with what they are, removals struck through, the rest summed up.
// Each row's tag is a label, never a control. Values (hosts, selectors, paths) are selectable Code.

import { describeDeclaration } from '@valet/core/request-surface'
import { Badge, Code, cn, RiskBadge, SecretBadge } from '@valet/ui'
import type { ReactNode } from 'react'
import type { LimitsInfo, ListDiff, PendingReview } from '../../../../shared/api'
import { plural } from '../../../lib/format'
import {
  changedNames,
  limitsChanged,
  limitsLoosened,
  probeChanged,
  probeText,
  requestsByPurpose,
  secretChanges,
  type Tone,
  toolChanges,
} from '../../../lib/permissions'
import { FIELD_WORDING } from '../../../lib/wording'
import { capText, REQUEST_GROUP, stepWhy } from './words'

/** The row tint per kind of addition: amber for reach, violet for secrets, red for the irreversible. */
const TINT: Readonly<Record<Tone, string>> = {
  read: 'bg-risk-read-soft/45',
  write: 'bg-risk-write-soft/55',
  irreversible: 'bg-risk-irreversible-soft/60',
  secret: 'bg-risk-secret-soft/55',
}

const MARK: Readonly<Record<Tone, string>> = {
  read: 'text-risk-read-fg',
  write: 'text-risk-write-fg',
  irreversible: 'text-risk-irreversible-fg',
  secret: 'text-risk-secret-fg',
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col border-t border-line-subtle first:border-t-0">
      <h4 className="m-0 px-4 pt-3 pb-1.5 text-2xs font-semibold tracking-wide text-fg-subtle uppercase">
        {title}
      </h4>
      <ul className="m-0 flex list-none flex-col p-0 pb-2">{children}</ul>
    </section>
  )
}

function Row({
  mark,
  markClass,
  label,
  className,
  testId,
  why,
  tag,
  children,
}: {
  readonly mark: string
  readonly markClass?: string
  readonly label: string
  readonly className?: string
  readonly testId?: string
  readonly why?: string
  readonly tag?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <li
      data-testid={testId}
      className={cn('mx-2 flex items-start gap-2.5 rounded-sm px-2 py-1.5', className)}
    >
      <span aria-hidden="true" className={cn('w-3 shrink-0 text-center font-mono text-md', markClass)}>
        {mark}
      </span>
      <span className="sr-only">{label}: </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="min-w-0 break-words text-md text-fg">{children}</div>
        {why !== undefined ? <p className="m-0 text-sm text-fg-muted text-pretty">{why}</p> : null}
      </div>
      {tag !== undefined ? <span className="flex shrink-0 items-center pt-px">{tag}</span> : null}
    </li>
  )
}

function Added({
  tone,
  tag,
  why,
  children,
}: {
  readonly tone: Tone
  readonly tag: ReactNode
  readonly why?: string
  readonly children: ReactNode
}) {
  return (
    <Row
      testId="perm-added"
      mark="+"
      markClass={cn('font-semibold', MARK[tone])}
      label="Added"
      className={TINT[tone]}
      why={why}
      tag={typeof tag === 'string' ? <Badge tone={tone}>{tag}</Badge> : tag}
    >
      {children}
    </Row>
  )
}

function Removed({ children, tag }: { readonly children: ReactNode; readonly tag?: ReactNode }) {
  return (
    <Row
      testId="perm-removed"
      mark="−"
      markClass="text-fg-subtle"
      label="Removed"
      className="text-fg-muted [&_code]:line-through [&_code]:decoration-current/40"
      tag={tag}
    >
      {children}
    </Row>
  )
}

function Unchanged({ children }: { readonly children: ReactNode }) {
  return (
    <Row mark="=" markClass="text-fg-subtle" label="Unchanged" tag={<Muted>unchanged</Muted>}>
      {children}
    </Row>
  )
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-sm text-fg-subtle">{children}</span>
}

function isEmpty<T>(diff: ListDiff<T>): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.unchanged.length === 0
}

function Fields({ name, fields }: { readonly name: string; readonly fields: readonly string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <SecretBadge name={name} />
      <span>{fields.map((f) => FIELD_WORDING[f as keyof typeof FIELD_WORDING] ?? f).join(', ')}</span>
    </span>
  )
}

/** Each permission section of a review. The caller puts it in a card or a fold. */
export function PermissionChanges({ review }: { readonly review: PendingReview }) {
  const { diff } = review
  const changedSecrets = changedNames(diff.secrets)
  const changedTools = changedNames(diff.tools)
  return (
    <div className="flex flex-col">
      <Section title="Web addresses its tools may contact">
        {diff.egress.unchanged.length > 0 ? (
          <Unchanged>
            <Code>{diff.egress.unchanged.join(', ')}</Code>
          </Unchanged>
        ) : null}
        {diff.egress.added.map((host) => (
          <Added
            key={host}
            tone="write"
            tag="new host"
            why="New web address. Tool pages may send requests here, including your session cookies."
          >
            <Code>{host}</Code>
          </Added>
        ))}
        {diff.egress.removed.map((host) => (
          <Removed key={host}>
            <Code>{host}</Code>
          </Removed>
        ))}
      </Section>

      <Section title="Pages the login may open">
        {diff.navigation.unchanged.length > 0 ? (
          <Unchanged>
            <Code>{diff.navigation.unchanged.join(', ')}</Code>
          </Unchanged>
        ) : null}
        {diff.navigation.added.map((o) => (
          <Added key={o} tone="write" tag="new origin" why="The login may now open pages here.">
            <Code>{o}</Code>
          </Added>
        ))}
        {diff.navigation.removed.map((o) => (
          <Removed key={o}>
            <Code>{o}</Code>
          </Removed>
        ))}
        {diff.frameOrigins.added.map((o) => (
          <Added
            key={`frame-${o}`}
            tone="write"
            tag="new frame origin"
            why="Parts of the login page may load from here."
          >
            <Code>{o}</Code>
          </Added>
        ))}
        {diff.frameOrigins.removed.map((o) => (
          <Removed key={`frame-${o}`}>
            <Code>{`${o} (frames)`}</Code>
          </Removed>
        ))}
      </Section>

      {isEmpty(diff.secretFills) ? null : (
        <Section title="Where the login types each secret">
          {diff.secretFills.unchanged.length > 0 ? (
            <Unchanged>
              <Code>
                {diff.secretFills.unchanged.map((f) => `${f.selector} ← ${f.secret}.${f.field}`).join(' · ')}
              </Code>
            </Unchanged>
          ) : null}
          {diff.secretFills.added.map((f) => (
            <Added
              key={`${f.selector}-${f.secret}-${f.field}`}
              tone="secret"
              tag="new fill"
              why={`Typed only on the web addresses you allow for “${f.secret}”.`}
            >
              <Code>{`fill ${f.selector} ← ${f.secret}.${f.field}`}</Code>
            </Added>
          ))}
          {diff.secretFills.removed.map((f) => (
            <Removed key={`${f.selector}-${f.secret}-${f.field}`}>
              <Code>{`fill ${f.selector} ← ${f.secret}.${f.field}`}</Code>
            </Removed>
          ))}
        </Section>
      )}

      {isEmpty(diff.authSteps) && !probeChanged(diff) ? null : (
        <Section title="What the login does, and how it checks">
          {diff.authSteps.unchanged.length > 0 ? (
            <Unchanged>
              <Muted>{plural(diff.authSteps.unchanged.length, 'step')}</Muted>
            </Unchanged>
          ) : null}
          {diff.authSteps.added.map((step, i) => (
            <Added
              // biome-ignore lint/suspicious/noArrayIndexKey: steps can repeat; order is the identity
              key={`${i}-${step.op}-${step.detail}`}
              tone="write"
              tag="new step"
              why={stepWhy(step.op)}
            >
              <Code>{step.detail}</Code>
            </Added>
          ))}
          {diff.authSteps.removed.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps can repeat; order is the identity
            <Removed key={`${i}-${step.op}-${step.detail}`}>
              <Code>{step.detail}</Code>
            </Removed>
          ))}
          {diff.probe !== null && probeChanged(diff) ? (
            <Added
              tone="write"
              tag="new login check"
              why={`Was: ${probeText(diff.probe.before)}. A different check can treat a logged-out session as logged in, or the reverse.`}
            >
              <Code>{probeText(diff.probe.after)}</Code>
            </Added>
          ) : null}
        </Section>
      )}

      <Section title="What moves from the login to its tools">
        {diff.cookieDomains.unchanged.length > 0 || diff.storage.unchanged.length > 0 ? (
          <Unchanged>
            <Code>
              {`cookies on ${diff.cookieDomains.unchanged.join(', ') || 'no domains'} · ${
                diff.storage.unchanged.length === 0
                  ? 'no storage keys'
                  : plural(diff.storage.unchanged.length, 'storage key')
              }`}
            </Code>
          </Unchanged>
        ) : null}
        {diff.cookieDomains.added.map((d) => (
          <Added
            key={d}
            tone="write"
            tag="new domain"
            why="Your session on this domain would be copied to where the adapter’s code runs."
          >
            <Code>{`cookies on ${d}`}</Code>
          </Added>
        ))}
        {diff.cookieDomains.removed.map((d) => (
          <Removed key={d}>
            <Code>{`cookies on ${d}`}</Code>
          </Removed>
        ))}
        {diff.storage.added.map((s) => (
          <Added
            key={`${s.origin} ${s.key}`}
            tone="write"
            tag="new storage key"
            why="This saved web-page value would be copied to where the adapter’s code runs."
          >
            <Code>{`${s.origin} · ${s.key}`}</Code>
          </Added>
        ))}
        {diff.storage.removed.map((s) => (
          <Removed key={`${s.origin} ${s.key}`}>
            <Code>{`${s.origin} · ${s.key}`}</Code>
          </Removed>
        ))}
      </Section>

      <Section title="Logins and codes it asks for">
        {diff.secrets.unchanged.map((s) => (
          <Unchanged key={s.name}>
            <Fields name={s.name} fields={s.fields} />
          </Unchanged>
        ))}
        {secretChanges(diff).map(({ secret: s, was, newFields, newOrigins }) => {
          if (was === null) {
            return (
              <Added
                key={s.name}
                tone="secret"
                tag="new secret"
                why={`The adapter describes it as “${capText(s.description)}”. For ${s.origins.join(', ')} only.`}
              >
                <Fields name={s.name} fields={s.fields} />
              </Added>
            )
          }
          const grew = [
            newFields.length > 0
              ? `Now also asks for ${newFields.map((f) => FIELD_WORDING[f]).join(', ')}.`
              : null,
            newOrigins.length > 0 ? `Now also typed on ${newOrigins.join(', ')}.` : null,
          ].filter((line) => line !== null)
          return (
            <Added
              key={s.name}
              tone="secret"
              tag={
                newFields.length > 0 && newOrigins.length > 0
                  ? 'new field and origin'
                  : newFields.length > 0
                    ? 'new field'
                    : newOrigins.length > 0
                      ? 'new origin'
                      : 'changed secret'
              }
              why={`${grew.length > 0 ? `${grew.join(' ')} ` : ''}For ${s.origins.join(', ')} only.`}
            >
              <Fields name={s.name} fields={s.fields} />
            </Added>
          )
        })}
        {diff.secrets.removed
          .filter((s) => !changedSecrets.has(s.name))
          .map((s) => (
            <Removed key={s.name}>
              <SecretBadge name={s.name} />
            </Removed>
          ))}
        {diff.messagesSources.added.map((m) => (
          <Added
            key={m.sender}
            tone="secret"
            tag="new SMS sender"
            why="Logins may read one-time codes from this sender once you allow it."
          >
            <Code>{m.sender}</Code>
          </Added>
        ))}
        {diff.messagesSources.removed.map((m) => (
          <Removed key={m.sender}>
            <Code>{m.sender}</Code>
          </Removed>
        ))}
        {diff.secrets.unchanged.length + diff.secrets.added.length + diff.secrets.removed.length === 0 &&
        isEmpty(diff.messagesSources) ? (
          <Unchanged>
            <Muted>None</Muted>
          </Unchanged>
        ) : null}
      </Section>

      <Section title="Tools">
        {diff.tools.unchanged.some((t) => t.internal !== true) ? (
          <Unchanged>
            <Muted>{plural(diff.tools.unchanged.filter((t) => t.internal !== true).length, 'tool')}</Muted>
          </Unchanged>
        ) : null}
        {toolChanges(diff).map(({ tool: t, was, raised, becameDestructive, hintsRelaxed }) => (
          <Added
            key={`${t.name}-${t.sideEffect}`}
            tone={t.sideEffect}
            tag={
              <RiskBadge purpose={t.sideEffect}>
                {was !== null && was !== t.sideEffect ? `${was} → ${t.sideEffect}` : t.sideEffect}
              </RiskBadge>
            }
            why={`${raised ? 'Its side effect went up. ' : ''}${
              becameDestructive ? 'Now marked as able to remove or overwrite things. ' : ''
            }${
              hintsRelaxed
                ? 'The adapter now tells AI apps it is safe to run or retry without asking. Valet can’t check that. '
                : ''
            }${
              t.sideEffect === 'irreversible'
                ? `“${capText(t.title)}”. Can’t be undone; asks you every time.`
                : t.sideEffect === 'write'
                  ? `“${capText(t.title)}”. Changes your account without asking.`
                  : `“${capText(t.title)}”.`
            }`}
          >
            <Code>{t.name}</Code>
          </Added>
        ))}
        {diff.tools.removed
          .filter((t) => !changedTools.has(t.name))
          .map((t) => (
            <Removed key={`${t.name}-${t.sideEffect}`} tag={<RiskBadge purpose={t.sideEffect} />}>
              <Code>{t.name}</Code>
            </Removed>
          ))}
      </Section>

      {isEmpty(diff.settings) ? null : (
        <Section title="Settings you choose, and the tools Valet runs for them">
          {diff.settings.unchanged.length > 0 ? (
            <Unchanged>
              <Muted>{plural(diff.settings.unchanged.length, 'setting')}</Muted>
            </Unchanged>
          ) : null}
          {diff.settings.added.map((s) => (
            <Added
              key={s.name}
              tone={s.applyTool === null ? 'read' : 'write'}
              tag={s.required ? 'required setting' : 'setting'}
              why={`“${capText(s.title)}”. Valet runs ${s.choicesTool} to list the choices when you search${
                s.applyTool === null
                  ? ''
                  : `, and ${s.applyTool} before a tool call to apply the one you chose`
              }. Neither is offered to AI apps.${s.required ? ' The adapter’s tools wait until you choose.' : ''}`}
            >
              <Code>{s.name}</Code>
            </Added>
          ))}
          {diff.settings.removed
            .filter((s) => !diff.settings.added.some((a) => a.name === s.name))
            .map((s) => (
              <Removed key={s.name}>
                <Code>{s.name}</Code>
              </Removed>
            ))}
        </Section>
      )}

      <Section title="Requests and limits">
        {diff.requests.unchanged.length > 0 ? (
          <Unchanged>
            <Muted>{plural(diff.requests.unchanged.length, 'declared request')}</Muted>
          </Unchanged>
        ) : null}
        {requestsByPurpose(diff.requests.added).map((group) => (
          <li key={group.purpose} data-testid={`requests-${group.purpose}`} className="flex flex-col">
            <span className="px-4 pt-1.5 pb-1 text-sm font-medium text-fg-muted">
              {REQUEST_GROUP[group.purpose]}
            </span>
            <ul className="m-0 flex list-none flex-col p-0">
              {group.requests.map((r) => (
                <Added
                  key={`${describeDeclaration(r)} ${r.purpose}`}
                  tone={r.purpose}
                  tag={<RiskBadge purpose={r.purpose}>{r.purpose}</RiskBadge>}
                >
                  <Code>{describeDeclaration(r)}</Code>
                </Added>
              ))}
            </ul>
          </li>
        ))}
        {diff.requests.removed.map((r) => (
          <Removed key={`${describeDeclaration(r)} ${r.purpose}`} tag={<RiskBadge purpose={r.purpose} />}>
            <Code>{describeDeclaration(r)}</Code>
          </Removed>
        ))}
        {diff.limits !== null && limitsChanged(diff) ? (
          <LimitsRow before={diff.limits.before} after={diff.limits.after} />
        ) : null}
      </Section>
    </div>
  )
}

function LimitsRow({ before, after }: { readonly before: LimitsInfo; readonly after: LimitsInfo }) {
  const parts: string[] = []
  if (before.requestsPerRun !== after.requestsPerRun) {
    parts.push(`Requests per run ${before.requestsPerRun} → ${after.requestsPerRun}`)
  }
  if (before.minGapMs !== after.minGapMs)
    parts.push(`Gap ${before.minGapMs / 1000} s → ${after.minGapMs / 1000} s`)
  if (before.cooldownSeconds !== after.cooldownSeconds) {
    parts.push(`Cool-down ${before.cooldownSeconds / 60} → ${after.cooldownSeconds / 60} min`)
  }
  if (before.maxCooldownSeconds !== after.maxCooldownSeconds) {
    parts.push(`Longest cool-down ${before.maxCooldownSeconds / 60} → ${after.maxCooldownSeconds / 60} min`)
  }
  if (limitsLoosened(before, after)) {
    return (
      <Added tone="write" tag="looser limits" why="The adapter may call the site faster or more often.">
        <span>{parts.join(' · ')}</span>
      </Added>
    )
  }
  return (
    <Row mark="~" markClass="text-fg-subtle" label="Changed" tag={<Muted>tightened</Muted>}>
      <span>{parts.join(' · ')}</span>
    </Row>
  )
}
