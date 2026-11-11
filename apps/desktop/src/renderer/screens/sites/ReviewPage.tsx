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
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Code,
  EmptyState,
  HashChip,
  Kbd,
  Page,
  PageBody,
  PageHeader,
  SiteAvatar,
  Spacer,
  Stack,
  Text,
} from '@valet/ui'
import { PackageCheck } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import type { HashRoute, PendingReview } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatTime, plural } from '../../lib/format'
import { additionBadges, addsPermissions } from '../../lib/permissions'
import { href, navigate } from '../../lib/router'
import { addedCount, FileList, ManifestDiff, removedCount } from './review/CodeChanges'
import { FirstInstallSummary } from './review/FirstInstallSummary'
import { PermissionChanges } from './review/PermissionChanges'
import { SOURCE_WORDING } from './review/words'

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
  const reviews = useLoad((api) => api.approvals.pending(), [], ['approvals-changed'])
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
  const review = reviews.data.find((r) => r.adapterId === adapterId)
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
  exits,
  closeHref,
  onApproved,
}: {
  readonly review: PendingReview
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
  const badges = additionBadges(review.diff).map((b) =>
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
    const ok = await action.run(() => api.approvals.reject(review.adapterId, review.to.hash))
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
          firstInstall ? (
            <Badge tone="info">Not approved yet</Badge>
          ) : (
            <UpdateStatusBadge adapterId={review.adapterId} from={review.from?.version ?? null} />
          )
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>
              {SOURCE_WORDING[review.source]} {formatTime(review.submittedAt, now)} · adapter
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
                  ? 'Approving gives this exact version these permissions. Logins are chosen after.'
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
        <Button onClick={reject} disabled={action.busy}>
          {firstInstall ? 'Don’t install' : 'Reject'}
        </Button>
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
