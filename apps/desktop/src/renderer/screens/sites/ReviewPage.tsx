// Reviewing a site's waiting adapter bundle (IA: #/sites/<id>/versions/review; wireframes
// site-review-update and site-review-first-install). A full page in the shell: what it asks for
// first, every permission in detail, the manifest and its files, and Approve / Reject in a bar that
// is always in view.
//
// Safety, kept from the screen this replaces:
// - Approve sends exactly the hash shown. The page is keyed by that hash, so a different bundle that
//   arrives while it is open starts again with the tick cleared, and the main process refuses an
//   approval for a hash that is no longer the pending one ("the bundle may have changed").
// - An update that adds anything needs the "I've read the highlighted additions" tick. The renderer
//   decides that from the diff itself (lib/permissions), not from a flag the review carries.
// - Adapter-supplied text (descriptions, titles) is plain text, quoted, capped and attributed.
// - Setup reuses the page with its own exits: both lead back into setup, and setup offers the grant.

import {
  Accordion,
  AccordionItem,
  ActionBar,
  ApprovalSeal,
  Badge,
  Banner,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Code,
  ConfirmDialog,
  EmptyState,
  Field,
  HashChip,
  Kbd,
  Page,
  PageBody,
  PageHeader,
  SiteAvatar,
  Spacer,
  Stack,
  Text,
  Textarea,
} from '@valet/ui'
import { PackageCheck } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import type { HashRoute, PendingReview, ReviewRequestInfo } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatTime, plural } from '../../lib/format'
import { additionBadges, addsPermissions, reviewLogsIn } from '../../lib/permissions'
import { href, navigate } from '../../lib/router'
import { addedCount, FileList, ManifestDiff, removedCount } from './review/CodeChanges'
import { FirstInstallSummary } from './review/FirstInstallSummary'
import { PermissionChanges } from './review/PermissionChanges'
import { capText, sourceWording } from './review/words'

/**
 * Where the review goes when it ends. From setup, both lead back into setup and the "choose a login
 * next" choice is setup's own next step, so the tick isn't offered.
 */
export interface ReviewExits {
  readonly approved: HashRoute
  readonly closed: HashRoute
}

/** How long the approval seal shows before the page moves on. */
export const SEAL_MS = 900

export function ReviewPage({
  adapterId,
  exits,
}: {
  readonly adapterId: string
  readonly exits?: ReviewExits
}) {
  const reviews = useLoad(
    async (api) => {
      const [pending, turnedDown] = await Promise.all([api.approvals.pending(), api.approvals.turnedDown()])
      return { pending, turnedDown }
    },
    [],
    ['approvals-changed'],
  )
  const closeHref = exits?.closed ?? href.site(adapterId)
  // Held above the list: once approved, the review leaves the pending list, but the seal stays.
  const [sealed, setSealed] = useState<{ name: string; version: string; next: HashRoute } | null>(null)

  useEffect(() => {
    if (sealed === null) return
    const timer = window.setTimeout(() => navigate(sealed.next), SEAL_MS)
    return () => window.clearTimeout(timer)
  }, [sealed])

  // Escape (or Close) returns to the site, unless an overlay above the page has the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null) return
      navigate(closeHref)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeHref])

  if (sealed !== null) {
    return (
      <Page>
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <ApprovalSeal size={96} label={`Approved ${sealed.name} ${sealed.version}`} />
          <Stack gap={1} align="center">
            <Text size="lg" weight="semibold">
              {sealed.name} {sealed.version} approved
            </Text>
            <Text tone="muted">Valet has recorded it in the audit log.</Text>
          </Stack>
        </div>
      </Page>
    )
  }

  if (reviews.status !== 'ready') {
    return (
      <Page>
        <ReviewHeader adapterId={adapterId} title="Review" closeHref={closeHref} exits={exits} />
        <PageBody>
          {reviews.status === 'error' ? (
            <Text tone="muted">Valet couldn’t load the review. It tries again when something changes.</Text>
          ) : null}
        </PageBody>
      </Page>
    )
  }
  // Waiting first; else a version the person turned down, which they may reconsider.
  const waiting = reviews.data.pending.find((r) => r.adapterId === adapterId)
  const review = waiting ?? reviews.data.turnedDown.find((r) => r.adapterId === adapterId)
  if (review === undefined) {
    return (
      <Page>
        <ReviewHeader adapterId={adapterId} title="Review" closeHref={closeHref} exits={exits} />
        <PageBody>
          <EmptyState
            icon={<PackageCheck />}
            title="Nothing to review"
            action={
              <Button asChild>
                <a href={closeHref}>{exits === undefined ? 'Back to the site' : 'Back to setup'}</a>
              </Button>
            }
          >
            Nothing is waiting for review for this adapter.
          </EmptyState>
        </PageBody>
      </Page>
    )
  }
  // Keyed by the hash under review, so a different bundle starts with the tick cleared.
  return (
    <Review
      key={review.to.hash}
      review={review}
      turnedDown={waiting === undefined}
      exits={exits}
      closeHref={closeHref}
      onApproved={(next) => setSealed({ name: review.name, version: review.to.version, next })}
    />
  )
}

/**
 * Whether calls carry on while an update waits. A changed bundle on disk is unapproved (its tools are
 * off: the tool host lists only approved hashes), so only say calls use the old version when the site
 * itself still reads as approved.
 */
function UpdateStatusBadge({
  adapterId,
  from,
}: {
  readonly adapterId: string
  readonly from: string | null
}) {
  const adapter = useLoad(
    (api) => api.adapters.get(adapterId),
    [adapterId],
    ['adapters-changed', 'approvals-changed'],
  )
  if (adapter.status !== 'ready') return null
  return adapter.data?.approval === 'approved' && from !== null ? (
    <Badge tone="info">Calls use {from} until you decide</Badge>
  ) : (
    <Badge tone="warning">Its tools are off until you decide</Badge>
  )
}

function ReviewHeader({
  adapterId,
  name,
  title,
  status,
  description,
  closeHref,
  exits,
  crumb = 'Review',
}: {
  readonly adapterId: string
  readonly name?: string
  readonly title: string
  readonly status?: ReactNode
  readonly description?: ReactNode
  readonly closeHref: HashRoute
  readonly exits: ReviewExits | undefined
  readonly crumb?: string
}) {
  const items =
    exits === undefined
      ? [
          { label: 'Sites', href: href.sites() },
          { label: name ?? adapterId, href: href.site(adapterId) },
          { label: 'Versions', href: href.site(adapterId, 'versions') },
          { label: crumb },
        ]
      : [{ label: 'Set up Valet', href: exits.closed }, { label: crumb }]
  return (
    <PageHeader
      breadcrumb={<Breadcrumb items={items} />}
      leading={name === undefined ? undefined : <SiteAvatar id={adapterId} name={name} size="lg" />}
      title={title}
      status={status}
      description={description}
      actions={
        <Button variant="ghost" asChild>
          <a href={closeHref} aria-keyshortcuts="Escape">
            Close <Kbd aria-hidden="true">Esc</Kbd>
          </a>
        </Button>
      }
    />
  )
}

function Review({
  review,
  turnedDown,
  exits,
  closeHref,
  onApproved,
}: {
  readonly review: PendingReview
  /** The person turned this version down before; approving it now is reconsidering. */
  readonly turnedDown: boolean
  readonly exits: ReviewExits | undefined
  readonly closeHref: HashRoute
  readonly onApproved: (next: HashRoute) => void
}) {
  const api = useApi()
  const now = useNow(60_000)
  const action = useAction()
  const ackId = useId()
  const nextId = useId()
  // D-review: a first install is a diff against nothing, so it opens on a plain summary and no tick
  // box: nobody can honestly say they read every line of a whole manifest. Updates keep both.
  const firstInstall = review.from === null
  const needsAck = !firstInstall && addsPermissions(review.diff)
  const [acknowledged, setAcknowledged] = useState(false)
  const secretsToGrant = [...review.diff.secrets.unchanged, ...review.diff.secrets.added].map((s) => s.name)
  // After a first install the login comes next (wireframe site-review-first-install); after an
  // update it is offered, unticked.
  const [grantNext, setGrantNext] = useState(firstInstall)
  const logsIn = reviewLogsIn(review)
  const request = review.request ?? null
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const badges = additionBadges(review.diff, logsIn).map((b) =>
    firstInstall ? { ...b, label: b.label.replace(/^\+/, '') } : b,
  )
  const canApprove = !needsAck || acknowledged
  const version = review.to.version

  const approve = async () => {
    if (!canApprove || action.busy) return
    const ok = await action.run(() => api.approvals.approve(review.adapterId, review.to.hash))
    if (!ok) return
    const first = secretsToGrant[0]
    onApproved(
      exits !== undefined
        ? exits.approved
        : grantNext && first !== undefined
          ? href.grant(review.adapterId, first)
          : href.site(review.adapterId),
    )
  }
  const reject = async () => {
    const note = reason.trim()
    const ok = await action.run(() =>
      note === '' || request === null
        ? api.approvals.reject(review.adapterId, review.to.hash)
        : api.approvals.reject(review.adapterId, review.to.hash, note),
    )
    if (ok) navigate(exits?.closed ?? href.site(review.adapterId))
  }

  const fileSummary = firstInstall
    ? `${plural(review.files.length, 'file')}`
    : `${plural(review.files.length, 'file')} changed`
  const manifestSummary = firstInstall
    ? plural(addedCount(review.manifestDiff), 'line')
    : `+${addedCount(review.manifestDiff)} −${removedCount(review.manifestDiff)}`

  return (
    <Page>
      <ReviewHeader
        adapterId={review.adapterId}
        name={review.name}
        crumb={`Review ${version}`}
        title={
          firstInstall
            ? `Review ${review.name} before first use`
            : `Review the ${review.name} update (${version})`
        }
        status={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {firstInstall ? (
              <Badge tone="info">Not approved yet</Badge>
            ) : review.staged === true && review.from !== null ? (
              <Badge tone="info">Calls use {review.from.version} until you decide</Badge>
            ) : (
              <UpdateStatusBadge adapterId={review.adapterId} from={review.from?.version ?? null} />
            )}
            {request === null ? null : (
              <Badge tone="neutral">
                Approval <span className="font-mono">{request.ref}</span>
              </Badge>
            )}
          </span>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>
              {sourceWording(review)} {formatTime(review.submittedAt, now)} · adapter
            </span>
            <Code>{review.adapterId}</Code>
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {review.from !== null ? (
                <>
                  <Code>{review.from.version}</Code>
                  <HashChip value={review.from.hash} label={`${review.from.version} hash`} />
                  <span>to</span>
                </>
              ) : null}
              <Code>{version}</Code>
              <HashChip value={review.to.hash} label={`${version} hash`} />
            </span>
          </span>
        }
        closeHref={closeHref}
        exits={exits}
      />
      <PageBody>
        {turnedDown ? (
          <Banner tone="warning" title={`You turned down ${review.name} ${review.to.version}`}>
            Its tools stay off until you approve it. If you’ve changed your mind, review it again below.
          </Banner>
        ) : null}
        {review.diff.sandbox.unsandboxed ? (
          <Banner tone="danger" title="Runs without the sandbox: it can reach anything you can on this Mac">
            That includes your other sites’ logins that Valet holds. Its author says why:{' '}
            <q>{review.diff.sandbox.reason}</q>. Approve it only if you trust whoever wrote it.
          </Banner>
        ) : null}
        {review.takesSession === true || (review.origin !== undefined && review.origin !== 'builtin') ? (
          <Banner
            tone="danger"
            title={
              review.takesSession === true
                ? `This code will use your signed-in session for ${review.site}`
                : 'This version didn’t come with Valet'
            }
          >
            {review.origin === 'draft'
              ? 'Your agent wrote it'
              : review.origin === 'folder'
                ? 'It was installed from a folder'
                : 'It came with Valet'}
            {review.from === null ? '' : ', and replaces the version in use'}.{' '}
            {review.diff.sandbox.unsandboxed
              ? 'Approve it only if you trust whoever wrote it.'
              : 'It runs in the sandbox, with only the access listed here.'}
          </Banner>
        ) : null}
        {review.diff.sandbox.exceptions.length > 0 ? (
          <Card>
            <CardHeader className="flex-col gap-1">
              <CardTitle>On this Mac</CardTitle>
              <CardDescription>
                What its code can reach outside the sandbox. The reasons are its author’s words.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul aria-label="Access on this Mac" className="m-0 flex list-none flex-col gap-2 p-0">
                {review.diff.sandbox.exceptions.map((e) => (
                  <li key={`${e.change}:${e.text}`} className="flex flex-col gap-0.5">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Badge tone={e.change === 'added' ? 'write' : 'neutral'}>
                        {e.change === 'added' ? 'Adds' : e.change === 'removed' ? 'Removes' : 'Same'}
                      </Badge>
                      <Code>{e.text}</Code>
                    </span>
                    <Text size="sm" tone="muted">
                      Why, says its author: {e.purpose}
                    </Text>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader className="flex-wrap items-center gap-y-2">
            <Stack gap={0.5} className="flex-1">
              <CardTitle>
                {firstInstall
                  ? 'What it asks for'
                  : badges.length > 0
                    ? 'This update asks for more'
                    : 'Nothing new is asked for'}
              </CardTitle>
              <CardDescription>
                {firstInstall
                  ? logsIn
                    ? 'Approving gives this exact version these permissions. Logins are chosen after.'
                    : 'Approving gives this exact version these permissions. It needs no login.'
                  : needsAck
                    ? 'The additions are highlighted below. Logins don’t carry over to a new version.'
                    : 'This update adds no permissions.'}
              </CardDescription>
            </Stack>
          </CardHeader>
          {badges.length > 0 ? (
            <CardContent>
              <ul aria-label="Summary" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {badges.map((b) => (
                  <li key={b.label}>
                    <Badge tone={b.tone}>{b.label}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          ) : null}
        </Card>

        {request === null ? null : <AgentRequestCard request={request} />}

        {firstInstall ? <FirstInstallSummary review={review} /> : null}

        {firstInstall ? null : (
          <Card flush>
            <CardHeader className="pb-1">
              <CardTitle>Permission changes</CardTitle>
              <Spacer />
              <Text size="sm" tone="muted">
                additions are highlighted
              </Text>
            </CardHeader>
            <PermissionChanges review={review} />
          </Card>
        )}

        {secretsToGrant.length > 0 ? (
          <Card>
            <CardHeader className="flex-col gap-1">
              <CardTitle>Your login</CardTitle>
              <CardDescription>
                Logins are tied to this exact version. Once approved, {version} uses no login until you choose
                one{firstInstall ? '' : ', even the one the older version used'}.
              </CardDescription>
            </CardHeader>
            {exits === undefined ? (
              <CardContent>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={nextId}
                    checked={grantNext}
                    onCheckedChange={(v) => setGrantNext(v === true)}
                    className="mt-0.5"
                  />
                  <label htmlFor={nextId} className="text-md text-fg">
                    Choose the login for {version} next
                  </label>
                </div>
              </CardContent>
            ) : null}
          </Card>
        ) : null}

        <Card flush>
          <CardHeader className="pb-1">
            <CardTitle>{firstInstall ? 'The details' : 'Manifest and files'}</CardTitle>
          </CardHeader>
          <Accordion
            type="multiple"
            defaultValue={firstInstall ? [] : ['manifest', 'files']}
            className="px-3 pb-1"
          >
            {firstInstall ? (
              <AccordionItem
                value="permissions"
                title="Every permission, in detail"
                meta={
                  <Text size="sm" tone="muted">
                    login steps, requests, limits
                  </Text>
                }
              >
                <div className="-ml-6">
                  <PermissionChanges review={review} />
                </div>
              </AccordionItem>
            ) : null}
            {review.manifestDiff.length > 0 ? (
              <AccordionItem
                value="manifest"
                title={firstInstall ? 'Raw manifest' : 'Manifest'}
                meta={
                  <Text size="sm" tone="muted">
                    {manifestSummary}
                  </Text>
                }
              >
                <ManifestDiff lines={review.manifestDiff} />
              </AccordionItem>
            ) : null}
            {review.files.length > 0 ? (
              <AccordionItem
                value="files"
                title="Code"
                meta={
                  <Text size="sm" tone="muted">
                    {fileSummary} · runs apart from your logins
                  </Text>
                }
              >
                <FileList files={review.files} />
              </AccordionItem>
            ) : null}
          </Accordion>
        </Card>
      </PageBody>

      <ActionBar className="flex-wrap gap-y-2">
        {turnedDown ? (
          <Button asChild>
            <a href={closeHref}>Keep it turned down</a>
          </Button>
        ) : request === null ? (
          <Button onClick={reject} disabled={action.busy}>
            Turn down
          </Button>
        ) : (
          <ConfirmDialog
            open={declining}
            onOpenChange={setDeclining}
            trigger={<Button disabled={action.busy}>Turn down…</Button>}
            title={`Turn down ${review.name} ${version}?`}
            description={`${capText(request.client, 60)} is told you turned it down${
              firstInstall ? '' : `, and ${review.from?.version ?? 'the version in use'} keeps working`
            }.`}
            confirmLabel="Turn down"
            destructive
            onConfirm={() => void reject()}
          >
            <Field label={`Tell ${capText(request.client, 60)} why`} optional>
              <Textarea
                value={reason}
                maxLength={280}
                onChange={(e) => setReason(e.target.value)}
                placeholder="It only goes to the agent that asked."
              />
            </Field>
          </ConfirmDialog>
        )}
        <Button variant="ghost" asChild>
          <a href={closeHref}>Decide later</a>
        </Button>
        <Spacer />
        {action.failed ? (
          <Text role="alert" size="sm" tone="danger">
            Couldn’t save your answer; the bundle may have changed. Try again.
          </Text>
        ) : firstInstall ? (
          <Text size="sm" tone="subtle">
            {secretsToGrant.length > 0 && grantNext && exits === undefined
              ? 'Next: choose a login'
              : 'Until you approve, Claude can’t use its tools.'}
          </Text>
        ) : null}
        {needsAck ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={ackId}
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
            />
            <label htmlFor={ackId} className="text-md text-fg">
              I’ve read the highlighted additions
            </label>
          </div>
        ) : null}
        <Button
          variant="primary"
          onClick={approve}
          loading={action.busy}
          disabled={!canApprove}
          disabledReason={canApprove ? undefined : 'Tick “I’ve read the highlighted additions” first'}
        >
          {firstInstall ? `Approve ${review.name}` : `Approve ${version}`}
        </Button>
      </ActionBar>
    </Page>
  )
}

/**
 * What the agent said and what Valet checked, for an agent's draft. The note, the client's name and
 * its test counts are the agent's own; only the check lines are Valet's.
 */
function AgentRequestCard({ request }: { readonly request: ReviewRequestInfo }) {
  const client = capText(request.client, 60)
  const tests = request.agentTests
  return (
    <Card data-testid="agent-request">
      <CardHeader className="flex-col gap-1">
        <CardTitle>
          Asked by {request.remote ? `“${client}”, a cloud agent` : client} · approval{' '}
          <span className="font-mono">{request.ref}</span>
        </CardTitle>
        <CardDescription>
          The agent was told to quote this approval code. Its words and its own tests are its claims; the
          checks are Valet’s.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Stack gap={3}>
          <Stack gap={0.5}>
            <Text size="sm" tone="muted">
              {client} says
            </Text>
            {request.note === null || request.note.trim() === '' ? (
              <Text tone="subtle">It left no note.</Text>
            ) : (
              <blockquote className="m-0 border-l-2 border-line pl-3 text-md text-fg whitespace-pre-wrap">
                {capText(request.note)}
              </blockquote>
            )}
          </Stack>
          {request.checks.length > 0 ? (
            <Stack gap={0.5}>
              <Text size="sm" tone="muted">
                Valet checked
              </Text>
              <ul aria-label="Valet’s checks" className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-md">
                {request.checks.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Stack>
          ) : null}
          {tests === null ? null : (
            <Text size="sm" tone="muted">
              Its own tests, run by Valet: {tests.passed} passed, {tests.failed} failed.
            </Text>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
