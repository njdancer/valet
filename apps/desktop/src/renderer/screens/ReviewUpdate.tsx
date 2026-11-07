// Reviewing a new adapter bundle (docs/mockups/approve-adapter.html): the permission diff as a person
// reads it, additions highlighted, and Approve gated on an acknowledgement whenever anything is added.

import { type ReactNode, useState } from 'react'
import type { AuthStepEntry, HashRoute, LimitsInfo, ListDiff, PendingReview } from '../../shared/api'
import {
  ActionFailed,
  Avatar,
  capText,
  Hash,
  Icon,
  LoadState,
  SecretBadge,
  SideEffect,
} from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatTime, plural, shortHash } from '../lib/format'
import {
  additionBadges,
  addsPermissions,
  changedNames,
  limitsChanged,
  limitsLoosened,
  probeChanged,
  probeText,
  requestsByPurpose,
  secretChanges,
  type Tone,
  toolChanges,
} from '../lib/permissions'
import { href, navigate } from '../lib/router'
import { FIELD_WORDING } from '../lib/wording'

/** Why an added login step matters, by op. The step's detail is the runtime's rendering of the manifest. */
const STEP_WHY: Readonly<Record<AuthStepEntry['op'], string>> = {
  goto: 'The login opens this page.',
  waitFor: 'The login waits for this before going on.',
  click: 'The login clicks this. A click can accept terms or confirm something on the site.',
  fill: 'The login types into this field.',
  otp: 'The login types a one-time code here.',
  pause: 'The login pauses here.',
  when: 'The login branches on this.',
  retry: 'The login repeats these steps.',
  assertLoggedIn: 'The login checks that it worked before handing the session over.',
  needsUser: 'The login stops here and hands over to you.',
  fail: 'The login gives up here.',
}

function stepWhy(op: string): string {
  return Object.hasOwn(STEP_WHY, op) ? STEP_WHY[op as AuthStepEntry['op']] : 'A login step.'
}

const SOURCE_WORDING: Readonly<Record<PendingReview['source'], string>> = {
  import: 'Imported',
  ide: 'Edited in the IDE',
  'authoring-agent': 'Edited by the authoring agent in the IDE',
}

/**
 * Where the review goes when it ends. From setup, both lead back into setup and the "grant next"
 * choice is setup's own next step, so the tick isn't offered.
 */
export interface ReviewExits {
  readonly approved: HashRoute
  readonly closed: HashRoute
}

export function ReviewUpdate({
  adapterId,
  exits,
}: {
  readonly adapterId: string
  readonly exits?: ReviewExits
}) {
  const reviews = useLoad((api) => api.approvals.pending(), [], ['approvals-changed'])
  const closeHref = exits?.closed ?? href.adapter(adapterId)
  return (
    <LoadState loaded={reviews} what="the review">
      {(list) => {
        const review = list.find((r) => r.adapterId === adapterId)
        if (review === undefined) {
          return (
            <div className="window review-window">
              <div className="titlebar">
                <div className="title">Review update</div>
                <div className="tools">
                  <a className="btn" href={closeHref}>
                    Close
                  </a>
                </div>
              </div>
              <div className="empty">Nothing is waiting for review for this adapter.</div>
            </div>
          )
        }
        // Keyed by the hash under review, so a different bundle starts with the tick cleared.
        return <Review key={review.to.hash} review={review} exits={exits} />
      }}
    </LoadState>
  )
}

function Review({
  review,
  exits,
}: {
  readonly review: PendingReview
  readonly exits: ReviewExits | undefined
}) {
  const api = useApi()
  const now = useNow(60_000)
  const action = useAction()
  const [acknowledged, setAcknowledged] = useState(false)
  const [grantNext, setGrantNext] = useState(false)
  const needsAck = addsPermissions(review.diff)
  const badges = additionBadges(review.diff)
  const secretsToGrant = [...review.diff.secrets.unchanged, ...review.diff.secrets.added].map((s) => s.name)
  const canApprove = !action.busy && (!needsAck || acknowledged)

  const approve = async () => {
    const ok = await action.run(() => api.approvals.approve(review.adapterId, review.to.hash))
    if (!ok) return
    const first = secretsToGrant[0]
    if (exits !== undefined) navigate(exits.approved)
    else
      navigate(
        grantNext && first !== undefined
          ? href.grant(review.adapterId, first)
          : href.adapter(review.adapterId),
      )
  }
  const reject = async () => {
    const ok = await action.run(() => api.approvals.reject(review.adapterId, review.to.hash))
    if (ok) navigate(exits?.closed ?? href.adapter(review.adapterId))
  }

  return (
    <div className="window review-window">
      <div className="titlebar">
        <div style={{ marginLeft: 64 }}>
          <div className="title">{review.from === null ? 'Review new adapter' : 'Review update'}</div>
          <div className="subtitle">
            {review.name}{' '}
            {review.from === null ? review.to.version : `${review.from.version} → ${review.to.version}`}
          </div>
        </div>
        <div className="tools">
          <a className="btn" href={exits?.closed ?? href.adapter(review.adapterId)}>
            Close
          </a>
        </div>
      </div>

      <div className="summary">
        <Avatar adapterId={review.adapterId} name={review.name} size="lg" />
        <div className="grow stack" style={{ gap: 3 }}>
          <div className="row">
            <span className="h2">
              {review.name} {review.to.version}
            </span>
            <span className="pill info">Waiting for your approval</span>
          </div>
          <div className="small muted">
            {SOURCE_WORDING[review.source]} at {formatTime(review.submittedAt, now)}.
          </div>
          <div className="row xs">
            {review.from !== null ? (
              <>
                <Hash hash={review.from.hash} />
                <Icon name="chevron" size="sm" className="tertiary" />
              </>
            ) : null}
            <span className="hash" style={{ color: 'var(--text)' }} title={review.to.hash}>
              {shortHash(review.to.hash)}
            </span>
            <span className="muted">
              · {plural(review.files.length, 'file')} changed · new hash, so grants don’t carry over
            </span>
          </div>
        </div>
        <div className="stack" style={{ gap: 4, justifyItems: 'end' }}>
          <div className="eyebrow">
            {badges.length > 0 ? 'This update asks for more' : 'Nothing new is asked for'}
          </div>
          <div
            className="row"
            style={{ flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 360, gap: 4 }}
          >
            {badges.map((b) => (
              <span key={b.label} className={`badge ${b.tone}`}>
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="review">
        <div className="stack gap-3" style={{ alignContent: 'start' }}>
          <PermissionChanges review={review} />
        </div>

        <div className="stack gap-3" style={{ alignContent: 'start' }}>
          <div className="callout secret">
            <Icon name="key" />
            <div className="stack" style={{ gap: 6 }}>
              <div>
                <strong>Grants are tied to the content hash.</strong> On approval, {review.to.version} has no
                secrets until you bind them.
              </div>
              {secretsToGrant.length > 0 && exits === undefined ? (
                <label className="row">
                  <input
                    type="checkbox"
                    className="check"
                    checked={grantNext}
                    onChange={(e) => setGrantNext(e.target.checked)}
                  />
                  Grant {secretsToGrant.map((s) => `“${s}”`).join(' and ')} next (opens the grant sheet)
                </label>
              ) : null}
            </div>
          </div>

          {review.manifestDiff.length > 0 ? (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-head">
                <span className="h3">manifest</span>
                <span className="muted">
                  +{review.manifestDiff.filter((l) => l.kind === 'add').length} −
                  {review.manifestDiff.filter((l) => l.kind === 'del').length}
                </span>
              </div>
              <div className="diff" style={{ border: 0, borderRadius: 0 }}>
                {review.manifestDiff.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                  <div key={i} className={line.kind === 'same' ? '' : line.kind}>
                    <span>{line.oldLine ?? ''}</span>
                    <span>{line.newLine ?? ''}</span>
                    <span>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {review.files.length > 0 ? (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-head">
                <span className="h3">Code</span>
                <span className="muted">runs in the tool partition only</span>
              </div>
              <table className="table files">
                <tbody>
                  {review.files.map((f) => (
                    <tr key={f.path}>
                      <td className="mono xs">{f.path}</td>
                      <td>
                        {f.status === 'added' ? (
                          <span className="pill info">new</span>
                        ) : f.status === 'removed' ? (
                          <span className="pill">removed</span>
                        ) : null}
                      </td>
                      <td className="num xs">
                        {f.added > 0 ? <span className="ok-text">+{f.added}</span> : null}{' '}
                        {f.removed > 0 ? <span className="danger-text">−{f.removed}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      <div className="dialog-foot">
        {needsAck ? (
          <label className="row small">
            <input
              type="checkbox"
              className="check"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I’ve read the highlighted additions
          </label>
        ) : (
          <span className="small muted">This update adds no permissions.</span>
        )}
        <span className="spacer" />
        <ActionFailed failed={action.failed} what="save your answer; the bundle may have changed" />
        <span className="xs muted">
          {review.from === null
            ? 'Until you approve, its tools stay off MCP.'
            : `Until you approve, calls keep using ${review.from.version}.`}
        </span>
        <button type="button" className="btn lg danger" disabled={action.busy} onClick={reject}>
          Reject
        </button>
        <button
          type="button"
          className="btn lg primary default-ring"
          disabled={!canApprove}
          onClick={approve}
        >
          Approve {review.to.version}
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <>
      <div className="perm-section">{title}</div>
      {children}
    </>
  )
}

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  read: 'added read-add',
  write: 'added',
  irreversible: 'added risk',
  secret: 'added secret-add',
}

function Added({
  tone,
  tag,
  why,
  children,
}: {
  readonly tone: Tone
  readonly tag: string
  readonly why?: string
  readonly children: ReactNode
}) {
  return (
    <div className={`perm ${TONE_CLASS[tone]}`} data-testid="perm-added">
      <span className="mark" title="added">
        +
      </span>
      <div>
        <div>{children}</div>
        {why !== undefined ? <div className="why">{why}</div> : null}
      </div>
      <span className={`badge ${tone}`}>{tag}</span>
    </div>
  )
}

function Removed({ children, tag }: { readonly children: ReactNode; readonly tag?: ReactNode }) {
  return (
    <div className="perm removed" data-testid="perm-removed">
      <span className="mark" title="removed">
        −
      </span>
      <div>{children}</div>
      {tag ?? <span />}
    </div>
  )
}

function Unchanged({ children }: { readonly children: ReactNode }) {
  return (
    <div className="perm">
      <span className="mark" title="unchanged">
        =
      </span>
      <div>{children}</div>
      <span className="xs muted">unchanged</span>
    </div>
  )
}

/** The heading over each purpose's new request declarations. */
const REQUEST_GROUP: Readonly<Record<'read' | 'write' | 'irreversible', string>> = {
  irreversible: 'New irreversible requests: each asks you first',
  write: 'New write requests: change your account',
  read: 'New read requests',
}

function isEmpty<T>(diff: ListDiff<T>): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.unchanged.length === 0
}

function PermissionChanges({ review }: { readonly review: PendingReview }) {
  const { diff } = review
  const mono = (text: string) => <span className="mono xs">{text}</span>
  const changedSecrets = changedNames(diff.secrets)
  const changedTools = changedNames(diff.tools)
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head">
        <span className="h3">Permission changes</span>
        <span className="muted">additions are highlighted</span>
      </div>

      <Section title="Tools may contact · egress allowlist">
        {diff.egress.unchanged.length > 0 ? (
          <Unchanged>{mono(diff.egress.unchanged.join(', '))}</Unchanged>
        ) : null}
        {diff.egress.added.map((host) => (
          <Added
            key={host}
            tone="write"
            tag="new host"
            why="New host. Tool pages may send requests, including your session cookies, here."
          >
            {mono(host)}
          </Added>
        ))}
        {diff.egress.removed.map((host) => (
          <Removed key={host}>{mono(host)}</Removed>
        ))}
      </Section>

      <Section title="Login may visit · auth partition">
        {diff.navigation.unchanged.length > 0 ? (
          <Unchanged>{mono(diff.navigation.unchanged.join(', '))}</Unchanged>
        ) : null}
        {diff.navigation.added.map((o) => (
          <Added key={o} tone="write" tag="new origin" why="The login flow may now navigate here.">
            {mono(o)}
          </Added>
        ))}
        {diff.navigation.removed.map((o) => (
          <Removed key={o}>{mono(o)}</Removed>
        ))}
        {diff.frameOrigins.added.map((o) => (
          <Added
            key={`frame-${o}`}
            tone="write"
            tag="new frame origin"
            why="Login-page subframes may load from here."
          >
            {mono(o)}
          </Added>
        ))}
        {diff.frameOrigins.removed.map((o) => (
          <Removed key={`frame-${o}`}>{mono(`${o} (frames)`)}</Removed>
        ))}
      </Section>

      {isEmpty(diff.secretFills) ? null : (
        <Section title="Login steps · which field gets which secret">
          {diff.secretFills.unchanged.length > 0 ? (
            <Unchanged>
              {mono(
                diff.secretFills.unchanged.map((f) => `${f.selector} ← ${f.secret}.${f.field}`).join(' · '),
              )}
            </Unchanged>
          ) : null}
          {diff.secretFills.added.map((f) => (
            <Added
              key={`${f.selector}-${f.secret}-${f.field}`}
              tone="secret"
              tag="new fill"
              why={`Typed only on the origins you grant for “${f.secret}”.`}
            >
              {mono(`fill ${f.selector} ← ${f.secret}.${f.field}`)}
            </Added>
          ))}
          {diff.secretFills.removed.map((f) => (
            <Removed key={`${f.selector}-${f.secret}-${f.field}`}>
              {mono(`fill ${f.selector} ← ${f.secret}.${f.field}`)}
            </Removed>
          ))}
        </Section>
      )}

      {isEmpty(diff.authSteps) && !probeChanged(diff) ? null : (
        <Section title="Login flow · what the login does, and how it checks">
          {diff.authSteps.unchanged.length > 0 ? (
            <Unchanged>
              <span className="xs muted">{plural(diff.authSteps.unchanged.length, 'step')}</span>
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
              {mono(step.detail)}
            </Added>
          ))}
          {diff.authSteps.removed.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps can repeat; order is the identity
            <Removed key={`${i}-${step.op}-${step.detail}`}>{mono(step.detail)}</Removed>
          ))}
          {diff.probe !== null && probeChanged(diff) ? (
            <Added
              tone="write"
              tag="new login check"
              why={`Was: ${probeText(diff.probe.before)}. A different check can treat a logged-out session as logged in, or the reverse.`}
            >
              {mono(probeText(diff.probe.after))}
            </Added>
          ) : null}
        </Section>
      )}

      <Section title="Session hand-over · copied from login to tools">
        {diff.cookieDomains.unchanged.length > 0 || diff.storage.unchanged.length > 0 ? (
          <Unchanged>
            {mono(
              `cookies on ${diff.cookieDomains.unchanged.join(', ') || 'no domains'} · ${
                diff.storage.unchanged.length === 0
                  ? 'no storage keys'
                  : plural(diff.storage.unchanged.length, 'storage key')
              }`,
            )}
          </Unchanged>
        ) : null}
        {diff.cookieDomains.added.map((d) => (
          <Added
            key={d}
            tone="write"
            tag="new domain"
            why="Your session on this domain would be copied into the tool partition, where adapter code runs."
          >
            {mono(`cookies on ${d}`)}
          </Added>
        ))}
        {diff.cookieDomains.removed.map((d) => (
          <Removed key={d}>{mono(`cookies on ${d}`)}</Removed>
        ))}
        {diff.storage.added.map((s) => (
          <Added
            key={`${s.origin} ${s.key}`}
            tone="write"
            tag="new storage key"
            why="This web-storage value would be copied into the tool partition."
          >
            {mono(`${s.origin} · ${s.key}`)}
          </Added>
        ))}
        {diff.storage.removed.map((s) => (
          <Removed key={`${s.origin} ${s.key}`}>{mono(`${s.origin} · ${s.key}`)}</Removed>
        ))}
      </Section>

      <Section title="Secrets">
        {diff.secrets.unchanged.map((s) => (
          <Unchanged key={s.name}>
            <span className="small">
              <SecretBadge name={s.name} /> {s.fields.map((f) => FIELD_WORDING[f]).join(', ')}
            </span>
          </Unchanged>
        ))}
        {secretChanges(diff).map(({ secret: s, was, newFields, newOrigins }) => {
          const fields = (
            <span className="small">
              <SecretBadge name={s.name} /> {s.fields.map((f) => FIELD_WORDING[f]).join(', ')}
            </span>
          )
          if (was === null) {
            return (
              <Added
                key={s.name}
                tone="secret"
                tag="new secret"
                why={`The manifest describes it as “${capText(s.description)}”. For ${s.origins.join(', ')} only.`}
              >
                {fields}
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
              {fields}
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
            why="Logins may read one-time codes from this sender once you grant it."
          >
            {mono(m.sender)}
          </Added>
        ))}
        {diff.messagesSources.removed.map((m) => (
          <Removed key={m.sender}>{mono(m.sender)}</Removed>
        ))}
        {diff.secrets.unchanged.length + diff.secrets.added.length + diff.secrets.removed.length === 0 &&
        isEmpty(diff.messagesSources) ? (
          <Unchanged>
            <span className="xs muted">None</span>
          </Unchanged>
        ) : null}
      </Section>

      <Section title="Tools">
        {diff.tools.unchanged.length > 0 ? (
          <Unchanged>
            <span className="xs muted">{plural(diff.tools.unchanged.length, 'tool')}</span>
          </Unchanged>
        ) : null}
        {toolChanges(diff).map(({ tool: t, was, raised }) => (
          <Added
            key={`${t.name}-${t.sideEffect}`}
            tone={t.sideEffect}
            tag={was !== null && was !== t.sideEffect ? `${was} → ${t.sideEffect}` : t.sideEffect}
            why={`${raised ? 'Its side effect went up. ' : ''}${
              t.sideEffect === 'irreversible'
                ? `“${t.title}”. Can’t be undone; asks you every time.`
                : t.sideEffect === 'write'
                  ? `“${t.title}”. Changes your account without asking.`
                  : `“${t.title}”.`
            }`}
          >
            {mono(t.name)}
          </Added>
        ))}
        {diff.tools.removed
          .filter((t) => !changedTools.has(t.name))
          .map((t) => (
            <Removed key={`${t.name}-${t.sideEffect}`} tag={<SideEffect purpose={t.sideEffect} />}>
              {mono(t.name)}
            </Removed>
          ))}
      </Section>

      <Section title="Request surface">
        {diff.requests.unchanged.length > 0 ? (
          <Unchanged>
            <span className="xs muted">{plural(diff.requests.unchanged.length, 'declared request')}</span>
          </Unchanged>
        ) : null}
        {requestsByPurpose(diff.requests.added).map((group) => (
          <div key={group.purpose} data-testid={`requests-${group.purpose}`}>
            <div className="perm-group xs muted">{REQUEST_GROUP[group.purpose]}</div>
            {group.requests.map((r) => (
              <Added key={`${r.method} ${r.path} ${r.purpose}`} tone={r.purpose} tag={r.purpose}>
                {mono(`${r.method} ${r.path}`)}
              </Added>
            ))}
          </div>
        ))}
        {diff.requests.removed.map((r) => (
          <Removed key={`${r.method} ${r.path} ${r.purpose}`} tag={<SideEffect purpose={r.purpose} />}>
            {mono(`${r.method} ${r.path}`)}
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
        <span className="small">{parts.join(' · ')}</span>
      </Added>
    )
  }
  return (
    <div className="perm">
      <span className="mark">~</span>
      <span className="small">{parts.join(' · ')}</span>
      <span className="xs muted">tightened</span>
    </div>
  )
}
