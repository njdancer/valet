// A first install in plain words (D-review): where it goes, what its tools do, what it will need from
// you. Nobody can honestly say they read every line of a whole manifest, so this comes first and the
// full list folds open below it.

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  DescriptionList,
  RiskBadge,
  SecretBadge,
} from '@valet/ui'
import type { PendingReview } from '../../../../shared/api'
import { hostOf, plural } from '../../../lib/format'
import { FIELD_WORDING } from '../../../lib/wording'
import { capText, PURPOSE_WORDING } from './words'

const PURPOSES = ['read', 'write', 'irreversible'] as const

export function FirstInstallSummary({ review }: { readonly review: PendingReview }) {
  const { diff } = review
  const tools = diff.tools.added
  const of = (purpose: (typeof PURPOSES)[number]) => tools.filter((t) => t.sideEffect === purpose)
  const counts = PURPOSES.filter((p) => of(p).length > 0).map(
    (p) => `${of(p).length} ${p === 'read' ? 'read' : p === 'write' ? 'change things' : 'can’t be undone'}`,
  )
  const items = [
    {
      term: 'Opens pages on',
      value: <Hosts hosts={diff.navigation.added.map(hostOf)} />,
    },
    {
      term: 'Sends requests to',
      value: (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Hosts hosts={diff.egress.added} />
          <span className="text-sm text-fg-muted">
            ({plural(diff.requests.added.length, 'declared API call')})
          </span>
        </span>
      ),
    },
    {
      term: 'Tools',
      value: (
        <span className="flex flex-col gap-1.5">
          {PURPOSES.map((purpose) =>
            of(purpose).length === 0 ? null : (
              <span key={purpose} className="inline-flex flex-wrap items-center gap-1.5">
                <RiskBadge purpose={purpose}>{PURPOSE_WORDING[purpose]}</RiskBadge>
                <span>
                  {of(purpose)
                    .map((t) => capText(t.title, 80))
                    .join(', ')}
                </span>
              </span>
            ),
          )}
        </span>
      ),
    },
    {
      term: 'Will need',
      value: (
        <span className="flex flex-col gap-1.5">
          {diff.secrets.added.length === 0 && diff.messagesSources.added.length === 0 ? (
            <span>No login</span>
          ) : null}
          {diff.secrets.added.map((secret) => (
            <span key={secret.name} className="inline-flex flex-wrap items-center gap-1.5">
              <SecretBadge name={secret.name} />
              <span>
                {secret.fields.map((f) => FIELD_WORDING[f]).join(', ')}, typed only on{' '}
                <Hosts hosts={secret.origins.map(hostOf)} />
              </span>
            </span>
          ))}
          {diff.messagesSources.added.map((m) => (
            <span key={m.sender} className="inline-flex flex-wrap items-center gap-1.5">
              <SecretBadge name="SMS code" />
              <span>
                one-time codes sent by <Code>{m.sender}</Code>, read from Messages
              </span>
            </span>
          ))}
          {diff.settings.added.map((setting) => (
            <span key={setting.name}>
              {capText(setting.title, 80)}
              {setting.required ? ' (needed before its tools run)' : ' (you choose)'}
            </span>
          ))}
        </span>
      ),
    },
  ]
  return (
    <Card data-testid="first-install-summary">
      <CardHeader className="flex-col gap-1">
        <CardTitle>What {review.name} may do</CardTitle>
        <p className="m-0 text-md text-fg-muted text-pretty">
          {tools.length === 0
            ? `${review.name} has no tools.`
            : `${plural(tools.length, 'tool')}: ${counts.join(', ')}.`}{' '}
          Nothing is given to it yet: after approving, you choose which login it may use.
        </p>
      </CardHeader>
      <CardContent>
        <DescriptionList items={items} />
      </CardContent>
    </Card>
  )
}

function Hosts({ hosts }: { readonly hosts: readonly string[] }) {
  if (hosts.length === 0) return <span className="text-fg-muted">nowhere</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {hosts.map((h) => (
        <Code key={h}>{h}</Code>
      ))}
    </span>
  )
}
