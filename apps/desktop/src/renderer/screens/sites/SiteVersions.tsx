// A site's Versions tab (wireframe `site-versions`), the one place that says "adapter": the update
// waiting for review (with its Review button), the version calls use now, and its hash. Logins are
// given to one content hash, so each version says whether it has one.

import {
  Badge,
  Button,
  ConfirmDialog,
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
import { useState } from 'react'
import type { PackageOrigin, PendingReview, RollbackPreview } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
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
  // An update as the main process has it: the changed bundle is installed and waiting, and the
  // version it replaced, approved before, is no longer kept.
  const replaced = !approved && adapter.approval !== 'rejected' && review !== null ? review.from : null
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
                ) : replaced !== null ? (
                  <Badge tone="warning">Waiting</Badge>
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
          {replaced !== null ? (
            <TR>
              <TD>
                <Inline gap={2} wrap={false}>
                  <span className="font-semibold">{replaced.version}</span>
                  <Badge>Replaced</Badge>
                </Inline>
              </TD>
              <TD>
                <HashChip value={replaced.hash} label={`Content hash of ${replaced.version}`} />
              </TD>
              <TD className="text-fg-muted">Approved earlier</TD>
              <TD className="text-fg-subtle">—</TD>
              <TD className="text-fg-subtle">not used now</TD>
              <TD align="right" className="text-fg-subtle">
                —
              </TD>
              <TD />
            </TR>
          ) : null}
        </TBody>
      </Table>
      <StoredVersions adapterId={adapter.id} name={adapter.name} />
      <Text size="sm" tone="subtle">
        Approvals, rejections and rollbacks stay in the{' '}
        <TextLink href={href.audit({ category: 'approvals-grants', site: adapter.id })}>Audit log</TextLink>.
      </Text>
    </Stack>
  )
}

const FROM: Readonly<Record<PackageOrigin, string>> = {
  builtin: 'Came with Valet',
  folder: 'Installed from a folder',
  draft: 'Written by your agent',
}

/**
 * Every version Valet keeps for this site (docs/adapter-packages.md), newest first, with Roll back
 * on each one approved before. The confirmation shows what the older version can reach that the
 * one in use can't, and which logins come back with it, before the click that approves it.
 */
function StoredVersions({ adapterId, name }: { readonly adapterId: string; readonly name: string }) {
  const api = useApi()
  const versions = useLoad(
    (a) => a.adapters.versions(adapterId),
    [adapterId],
    ['adapters-changed', 'approvals-changed'],
  )
  const [preview, setPreview] = useState<RollbackPreview | null>(null)
  const action = useAction()
  if (versions.status !== 'ready' || versions.data.versions.length < 2) return null
  const open = (hash: string) =>
    void action.run(async () => setPreview(await api.adapters.rollbackPreview(adapterId, hash)))
  return (
    <Stack gap={2}>
      <Text weight="semibold">Kept versions</Text>
      <Table aria-label={`${name} kept versions`}>
        <THead>
          <TR>
            <TH>Version</TH>
            <TH>Content hash</TH>
            <TH>From</TH>
            <TH>Installed</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {versions.data.versions.map((v) => (
            <TR key={v.hash}>
              <TD>
                <Inline gap={2} wrap={false}>
                  <span className="font-semibold">{v.version}</span>
                  {v.active ? <Badge tone="success">In use</Badge> : null}
                  {v.active && versions.data.pinned ? <Badge>Kept by you</Badge> : null}
                </Inline>
              </TD>
              <TD>
                <HashChip value={v.hash} label={`Content hash of ${v.version}`} />
              </TD>
              <TD className="text-fg-muted">{FROM[v.source]}</TD>
              <TD className="whitespace-nowrap text-fg-muted">
                {formatDay(v.installedAt)} {formatClock(v.installedAt)}
              </TD>
              <TD>
                {v.canRollBack ? (
                  <Button size="sm" disabled={action.busy} onClick={() => open(v.hash)}>
                    Roll back to {v.version}
                  </Button>
                ) : null}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {action.failed ? <Text tone="danger">That didn’t work. The version in use hasn’t changed.</Text> : null}
      {preview !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => (isOpen ? undefined : setPreview(null))}
          title={`Roll back to ${preview.version}?`}
          description={`Calls to ${name} will use ${preview.version} straight away. Rolling back approves it again.`}
          confirmLabel={`Roll back to ${preview.version}`}
          destructive={preview.widens}
          onConfirm={() => {
            const target = preview
            setPreview(null)
            void action.run(() => api.adapters.rollback(target.adapterId, target.hash))
          }}
        >
          <RollbackChanges preview={preview} />
        </ConfirmDialog>
      ) : null}
    </Stack>
  )
}

function RollbackChanges({ preview }: { readonly preview: RollbackPreview }) {
  const { changes } = preview
  const added = [
    ...changes.egress.added.map((host) => `Sends traffic to ${host}`),
    ...changes.requests.added.map((r) => `${r.method} ${r.path} (${r.purpose})`),
    ...changes.tools.added.map((t) => `Tool ${t.name} (${t.sideEffect})`),
    ...changes.secrets.added.map((s) => `Asks for the login “${s.name}”`),
    ...changes.cookieDomains.added.map((d) => `Copies cookies for ${d}`),
  ]
  return (
    <Stack gap={2}>
      {preview.widens ? (
        <Stack gap={1}>
          <Text weight="semibold">It can do more than the version in use:</Text>
          <ul className="m-0 list-disc pl-5 text-fg-muted">
            {(added.length > 0 ? added : ['Its login or limits are looser']).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Stack>
      ) : (
        <Text tone="muted">It can’t reach anything the version in use can’t.</Text>
      )}
      <Text tone="muted">
        {preview.grants.length === 0
          ? 'No login comes back with it.'
          : `Your login for ${preview.grants.join(', ')} comes back with it, as you gave it to this version.`}
      </Text>
    </Stack>
  )
}
