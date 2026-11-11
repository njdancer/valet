// A site's Permissions tab (wireframe `site-permissions`): plain sentences first, worked out by Valet
// from the declaration, then the declaration itself under Details, every host, origin and path a
// selectable value.

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  DescriptionList,
  Inline,
  RiskBadge,
  Stack,
  StatusDot,
  Text,
  TextLink,
  Value,
} from '@valet/ui'
import type { ReactNode } from 'react'
import { hostOf, plural } from '../../lib/format'
import { probeText, requestsByPurpose } from '../../lib/permissions'
import { href } from '../../lib/router'
import type { SiteData } from './SitePage'

function Values({ items, mono = true }: { readonly items: readonly string[]; readonly mono?: boolean }) {
  if (items.length === 0) return <span className="text-fg-subtle">None</span>
  return (
    <Inline gap={1.5}>
      {items.map((i) => (
        <Value key={i} mono={mono} copy={i}>
          {i}
        </Value>
      ))}
    </Inline>
  )
}

function Line({ tone, children }: { readonly tone: 'success' | 'neutral'; readonly children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <StatusDot tone={tone} className="mt-1.5" />
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

export function SitePermissions({ data }: { readonly data: SiteData }) {
  const { adapter } = data
  const reads = adapter.requests.filter((r) => r.purpose === 'read').length
  const changes = adapter.requests.length - reads
  const loginHosts = adapter.secretRequests.flatMap((s) => s.origins.map(hostOf))
  const { limits } = adapter
  return (
    <Stack gap={4}>
      <div className="grid grid-cols-1 items-start gap-4 @min-[720px]:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What {adapter.name} can do</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              <Line tone="success">
                Contact {plural(adapter.egress.length, 'web address', 'web addresses')}:{' '}
                {adapter.egress.join(', ')}
              </Line>
              {loginHosts.length > 0 ? (
                <Line tone="success">
                  Fill the login you give it, only on {[...new Set(loginHosts)].join(', ')}
                </Line>
              ) : null}
              <Line tone="success">
                {plural(adapter.requests.length, 'kind of request', 'kinds of request')}: {reads} read
                {changes > 0 ? `, ${changes} change things` : ''}
              </Line>
              <Line tone="success">
                At most {limits.requestsPerRun} requests a call, {limits.minGapMs / 1000} s apart; waits{' '}
                {Math.round(limits.cooldownSeconds / 60)} min if the site pushes back
              </Line>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>What it can’t do</CardTitle>
            <Text size="sm" tone="subtle">
              Worked out by Valet from the declaration
            </Text>
          </CardHeader>
          <CardContent>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              <Line tone="neutral">
                Contact any other web address. Valet blocks it and shows it in{' '}
                <TextLink href={href.calls({ site: adapter.id, outcome: 'blocked' })}>blocked calls</TextLink>
              </Line>
              <Line tone="neutral">Use any login but the one you give it</Line>
              <Line tone="neutral">See other sites’ sessions or cookies</Line>
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <Text size="sm" tone="subtle">
            The declaration of {adapter.version}, as Valet enforces it
          </Text>
        </CardHeader>
        <CardContent>
          <DescriptionList
            items={[
              { term: 'Web addresses (egress)', value: <Values items={adapter.egress} /> },
              { term: 'Login pages (navigation)', value: <Values items={adapter.navigation} /> },
              ...(adapter.frameOrigins.length > 0
                ? [{ term: 'Frames only', value: <Values items={adapter.frameOrigins} /> }]
                : []),
              { term: 'Cookies', value: <Values items={adapter.cookieDomains} /> },
              ...(adapter.storage.length > 0
                ? [
                    {
                      term: 'Storage',
                      value: (
                        <Values items={adapter.storage.map((s) => `${s.origin} · ${s.keys.join(', ')}`)} />
                      ),
                    },
                  ]
                : []),
              {
                term: 'Requests',
                value: (
                  <Stack gap={1.5}>
                    {requestsByPurpose(adapter.requests).flatMap((g) =>
                      g.requests.map((r) => (
                        <Inline key={`${r.method} ${r.path}`} gap={2}>
                          <Code>
                            {r.method} {r.path}
                          </Code>
                          <RiskBadge purpose={r.purpose} />
                        </Inline>
                      )),
                    )}
                  </Stack>
                ),
              },
              { term: 'Sign-in check', value: <Code>{probeText(adapter.probe)}</Code> },
              {
                term: 'Sessions',
                value: <Values items={[adapter.partitions.auth, adapter.partitions.tool]} />,
              },
              ...(adapter.handedOver === null
                ? []
                : [
                    {
                      term: 'Last hand-off',
                      value: `${plural(adapter.handedOver.cookies, 'cookie')} · ${plural(adapter.handedOver.storageKeys, 'storage key')}`,
                    },
                  ]),
              {
                term: 'Limits',
                value: (
                  <Code>
                    requestsPerRun {limits.requestsPerRun} · minGap {limits.minGapMs / 1000} s · cooldown{' '}
                    {limits.cooldownSeconds} s · max {limits.maxCooldownSeconds} s
                  </Code>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </Stack>
  )
}
