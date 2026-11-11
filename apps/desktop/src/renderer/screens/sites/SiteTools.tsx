// A site's Tools tab (wireframe `site-tools`): each tool's plain title (the link to its calls), its
// tool name, what the manifest says it does, what it can change, and how often it ran. A tool an
// update would add shows where it will appear, with the same Review button.

import {
  Badge,
  Button,
  Code,
  ObjectLink,
  RiskBadge,
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
import { plural } from '../../lib/format'
import { toolChanges } from '../../lib/permissions'
import { href } from '../../lib/router'
import type { SiteData } from './SitePage'
import { SiteText } from './site-ui'

export function SiteTools({ data }: { readonly data: SiteData }) {
  const { adapter, review } = data
  const exposed = adapter.tools.filter((t) => !t.internal)
  const known = new Set(adapter.tools.map((t) => t.name))
  const arriving =
    review === null ? [] : toolChanges(review.diff).filter((c) => c.was === null && !known.has(c.tool.name))
  return (
    <Stack gap={3}>
      <Text tone="muted">
        {plural(exposed.length, 'tool')} your apps can call. Any tool may make any request {adapter.name}{' '}
        declares; <TextLink href={href.site(adapter.id, 'permissions')}>see Permissions</TextLink>.
      </Text>
      <Table aria-label={`${adapter.name} tools`}>
        <THead>
          <TR>
            <TH>Tool</TH>
            <TH>What it does (from the manifest)</TH>
            <TH>Effect</TH>
            <TH align="right">Calls · 7 days</TH>
          </TR>
        </THead>
        <TBody>
          {adapter.tools.map((t) => (
            <TR key={t.name}>
              <TD className="py-2 align-top">
                <Stack gap={0.5}>
                  {t.internal ? (
                    <span className="font-medium">{t.title}</span>
                  ) : (
                    <ObjectLink href={href.calls({ site: adapter.id, tool: t.name })}>{t.title}</ObjectLink>
                  )}
                  <Code className="w-fit">{t.name}</Code>
                </Stack>
              </TD>
              <TD className="py-2 align-top text-sm text-fg-muted">
                <SiteText text={t.description} from={null} />
              </TD>
              <TD className="py-2 align-top">
                {t.internal ? (
                  <span title="Valet runs this tool itself. No app can list or call it.">
                    <Badge>Settings only · not exposed</Badge>
                  </span>
                ) : (
                  <RiskBadge purpose={t.sideEffect} />
                )}
              </TD>
              <TD align="right" className="py-2 align-top">
                {t.internal ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  <TextLink
                    href={href.calls({ site: adapter.id, tool: t.name })}
                    aria-label={`${t.calls7d} calls to ${t.title} in 7 days`}
                  >
                    {t.calls7d}
                  </TextLink>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {arriving.length > 0 && review !== null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-line-strong px-3 py-2">
          <Text size="sm" tone="muted" className="flex-1">
            {arriving.map((c) => c.tool.title).join(', ')} {arriving.length === 1 ? 'arrives' : 'arrive'} with{' '}
            {review.to.version}, waiting for your review.
          </Text>
          <Button size="sm" asChild>
            <a href={href.review(adapter.id)}>Review {adapter.name} update</a>
          </Button>
        </div>
      ) : null}
    </Stack>
  )
}
