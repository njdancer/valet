// A draft's page (wireframe `mac-draft-page`): what Valet checked and tried on the draft as it is
// now, its files, and the request it waits on. The agent writes the draft over MCP; the person can
// open its folder to read or edit it (R53). Nothing here approves it: Review goes to the review
// page, as for any other version.

import {
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  DescriptionList,
  EmptyState,
  Inline,
  Page,
  PageBody,
  PageHeader,
  Skeleton,
  Stack,
  Text,
} from '@valet/ui'
import type { DraftPage as DraftData } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatAgo, plural } from '../../lib/format'
import { href } from '../../lib/router'
import { DraftStatus, draftTitle } from './draft-ui'
import { ActionError } from './site-ui'

export function DraftPage({ draftId }: { readonly draftId: string }) {
  const draft = useLoad((api) => api.drafts.get(draftId), [draftId], ['drafts-changed', 'approvals-changed'])
  const crumbs = (last: string) => (
    <Breadcrumb items={[{ label: 'Sites', href: href.sites() }, { label: 'Drafts' }, { label: last }]} />
  )
  if (draft.status === 'loading') {
    return (
      <Page>
        <PageHeader breadcrumb={crumbs('…')} title={<span className="sr-only">Loading</span>} />
        <PageBody>
          <Stack gap={3} aria-hidden="true">
            <Skeleton className="h-10" />
            <Skeleton className="h-32" />
          </Stack>
        </PageBody>
      </Page>
    )
  }
  if (draft.status === 'error' || draft.data === null) {
    return (
      <Page>
        <PageHeader
          breadcrumb={crumbs(draftId)}
          title={draft.status === 'error' ? 'Couldn’t load this draft' : 'No such draft'}
        />
        <PageBody width="form">
          <EmptyState
            title={draft.status === 'error' ? 'Valet couldn’t load it' : 'The agent may have deleted it'}
            action={
              <Button asChild>
                <a href={href.sites()}>Go to Sites</a>
              </Button>
            }
          >
            {draft.status === 'error'
              ? 'It tries again when something changes.'
              : 'Drafts live on this Mac only.'}
          </EmptyState>
        </PageBody>
      </Page>
    )
  }
  return <DraftView draft={draft.data} />
}

function DraftView({ draft }: { readonly draft: DraftData }) {
  const api = useApi()
  const now = useNow(60_000)
  const open = useAction()
  const title = draftTitle(draft)
  const submitted =
    draft.submission === null
      ? ''
      : ` · submitted ${formatAgo(draft.submission.at, now)} as approval ${draft.submission.ref}`
  return (
    <Page>
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[{ label: 'Sites', href: href.sites() }, { label: 'Drafts' }, { label: title }]}
          />
        }
        title={title}
        status={<DraftStatus status={draft.status} />}
        description={`${draft.update ? 'An update' : 'A new site'} by ${draft.writtenBy} · started ${formatAgo(draft.createdAt, now)}${submitted}`}
        actions={
          draft.status === 'waiting' ? (
            <Button variant="primary" asChild>
              <a href={href.review(draft.adapterId)}>{draft.update ? 'Review update' : 'Review'}</a>
            </Button>
          ) : null
        }
        overflowActions={[
          {
            label: 'Open draft folder',
            onSelect: () => void open.run(() => api.drafts.openFolder(draft.draftId)),
          },
        ]}
      />
      <PageBody width="form">
        <Stack gap={4}>
          <ActionError failed={open.failed} what="open the draft’s folder" />
          {draft.submission?.note ? (
            <Text tone="muted">
              Your note when you declined: <q>{draft.submission.note}</q>
            </Text>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Checks Valet ran</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                items={[
                  {
                    term: 'Build, manifest, lint',
                    value:
                      draft.check === null
                        ? 'Not checked since the last edit'
                        : draft.check.ok
                          ? `Passed · ${formatAgo(draft.check.at, now)}`
                          : `Failed: ${draft.check.problem ?? 'a check failed'}`,
                  },
                  {
                    term: 'Agent’s tests',
                    value:
                      draft.check === null
                        ? '—'
                        : `${draft.check.passed} of ${plural(draft.check.cases, 'test')} pass, in Valet’s sandbox`,
                  },
                  ...(draft.trials.length === 0
                    ? [{ term: 'Live trial', value: 'Not run on this version' }]
                    : draft.trials.map((t) => ({
                        term: 'Live trial',
                        value: (
                          <>
                            <Code>{t.tool}</Code>, signed out:{' '}
                            {t.ok ? 'returned output that fits its schema' : (t.problem ?? 'failed')} ·{' '}
                            {formatAgo(t.at, now)}
                          </>
                        ),
                      }))),
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {draft.files.map((f) => (
                  <li key={f.path}>
                    <Inline gap={2} align="baseline">
                      <Code>{f.path}</Code>
                      <Text tone="subtle" size="sm">
                        {formatBytes(f.bytes)}
                        {f.recordedByValet ? ' · recorded by Valet from the site' : ''}
                      </Text>
                    </Inline>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </Stack>
      </PageBody>
    </Page>
  )
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`
}
