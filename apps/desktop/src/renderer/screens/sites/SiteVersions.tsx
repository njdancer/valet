// A site's Versions tab (wireframe `site-versions`), the one place that says "adapter": the update
// waiting for review (with its Review button), the version calls use now, and its hash. Logins are
// given to one content hash, so each version says whether it has one.

import {
  Badge,
  Button,
  HashChip,
  Inline,
  Stack,
  Table,
  TBody,
  TD,
  Text,
  TextLink,
  TH,
  THead,
  TR,
} from '@valet/ui'
import type { PendingReview } from '../../../shared/api'
import { formatClock, formatDay } from '../../lib/format'
import { href } from '../../lib/router'
import type { SiteData } from './SitePage'

const SOURCE: Readonly<Record<PendingReview['source'], string>> = {
  import: 'Imported from a file',
  ide: 'Your IDE',
  'authoring-agent': 'Authoring agent (IDE)',
}

export function SiteVersions({ data }: { readonly data: SiteData }) {
  const { adapter, review } = data
  // A first install's pending bundle is the installed one: one row, not two.
  const pending =
    adapter.approval !== 'approved' || adapter.pendingUpdate?.hash === adapter.hash
      ? null
      : adapter.pendingUpdate
  const approved = adapter.approval === 'approved'
  const loginGiven = adapter.secretRequests.some((s) => s.grant !== null)
  return (
    <Stack gap={3}>
      <Text tone="muted">
        Each version of the {adapter.name} adapter is known by its content hash. Calls use the approved one; a
        new version waits for your review, and a login is given to one version at a time.
      </Text>
      <Table aria-label={`${adapter.name} adapter versions`}>
        <THead>
          <TR>
            <TH>Version</TH>
            <TH>Content hash</TH>
            <TH>From</TH>
            <TH>Approved</TH>
            <TH>Login</TH>
            <TH align="right">Calls · 7 days</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {pending !== null ? (
            <TR>
              <TD>
                <Inline gap={2} wrap={false}>
                  <span className="font-semibold">{pending.version}</span>
                  <Badge tone="warning">Waiting</Badge>
                </Inline>
              </TD>
              <TD>
                <HashChip value={pending.hash} label={`Content hash of ${pending.version}`} />
              </TD>
              <TD className="text-fg-muted">
                {review === null
                  ? '—'
                  : `${SOURCE[review.source]}, ${formatDay(review.submittedAt)} ${formatClock(review.submittedAt)}`}
              </TD>
              <TD className="text-fg-subtle">not yet</TD>
              <TD className="text-fg-subtle">
                {adapter.secretRequests.length > 0 ? 'asks on approve' : 'none'}
              </TD>
              <TD align="right" className="text-fg-subtle">
                none
              </TD>
              <TD>
                <Button size="sm" variant="primary" asChild>
                  <a href={href.review(adapter.id)}>Review {pending.version}</a>
                </Button>
              </TD>
            </TR>
          ) : null}
          <TR>
            <TD>
              <Inline gap={2} wrap={false}>
                <span className="font-semibold">{adapter.version}</span>
                {approved ? (
                  <Badge tone="success">Live</Badge>
                ) : adapter.approval === 'rejected' ? (
                  <Badge>Turned down</Badge>
                ) : (
                  <Badge tone="info">Not approved yet</Badge>
                )}
              </Inline>
            </TD>
            <TD>
              <HashChip value={adapter.hash} label={`Content hash of ${adapter.version}`} />
            </TD>
            <TD className="text-fg-muted">Installed</TD>
            <TD className="whitespace-nowrap text-fg-muted">
              {approved && adapter.approvedAt !== null
                ? `${formatDay(adapter.approvedAt)} ${formatClock(adapter.approvedAt)}`
                : 'not yet'}
            </TD>
            <TD className="text-fg-muted">
              {adapter.secretRequests.length === 0 ? 'none needed' : loginGiven ? 'given' : 'not given'}
            </TD>
            <TD align="right">
              <TextLink href={href.calls({ site: adapter.id })}>{adapter.calls7d}</TextLink>
            </TD>
            <TD>
              {!approved ? (
                <Button size="sm" variant="primary" asChild>
                  <a href={href.review(adapter.id)}>Review {adapter.version}</a>
                </Button>
              ) : null}
            </TD>
          </TR>
        </TBody>
      </Table>
      <Text size="sm" tone="subtle">
        Older versions aren’t kept in this build, so there is nothing to restore. Approvals and rejections
        stay in the{' '}
        <TextLink href={href.audit({ category: 'approvals-grants', site: adapter.id })}>Audit log</TextLink>.
      </Text>
    </Stack>
  )
}
