// How to set up one app: "Add to Claude Desktop" in one click (D-connect), and the snippets for
// anyone who'd rather do it themselves. No token is ever in a snippet: the bridge reads the app's
// token from its own config file, so copying is done by the main process from the same text.

import { Banner, Button, CodeBlock, Inline, Stack, Text, Value } from '@valet/ui'
import { Check, Lock, Plus } from 'lucide-react'
import { useState } from 'react'
import type { ClientInfo, ClientKind, DesktopConfigWritten } from '../../../shared/api'
import { useApi, useLoad } from '../../lib/api-context'
import { CopyButtonThrough, Failed } from './shared'

const SNIPPET_WORDING: Readonly<Record<ClientKind, { readonly title: string; readonly detail: string }>> = {
  'claude-code': {
    title: 'Claude Code',
    detail: 'Run this once in a terminal. It adds Valet through the bridge that comes with Valet.',
  },
  'claude-desktop': {
    title: 'Claude Desktop',
    detail: 'Or add this entry to claude_desktop_config.json yourself.',
  },
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Writes the app's bridge entry into Claude Desktop's config, keeping a copy of the old file. */
export function AddToClaudeDesktop({ clientId }: { readonly clientId: string }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [written, setWritten] = useState<DesktopConfigWritten | null>(null)
  const add = async () => {
    setBusy(true)
    setFailed(false)
    try {
      setWritten(await api.clients.addToClaudeDesktop(clientId))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Stack gap={2}>
      <Inline gap={3}>
        <Button
          variant={written === null ? 'primary' : 'secondary'}
          loading={busy}
          leading={written === null ? <Plus /> : <Check />}
          onClick={() => void add()}
        >
          {written === null ? 'Add to Claude Desktop' : 'Added to Claude Desktop'}
        </Button>
        {written === null && !failed ? (
          <Text size="sm" tone="muted">
            Keeps your other servers, and a copy of the old file
          </Text>
        ) : null}
      </Inline>
      {written !== null ? (
        <Banner tone="success" live title="Quit and reopen Claude Desktop to load Valet.">
          {written.backup === null ? null : (
            <>
              The old config is kept beside it as <Value mono>{fileName(written.backup)}</Value>.
            </>
          )}
        </Banner>
      ) : null}
      {failed ? (
        <Banner
          tone="warning"
          live
          title="Valet couldn’t update Claude Desktop’s config, and left it as it was."
        >
          If the file has a mistake in it, fix that and try again, or copy the entry below into it yourself.
        </Banner>
      ) : null}
    </Stack>
  )
}

export function SetupSnippets({ client }: { readonly client: ClientInfo }) {
  const api = useApi()
  const snippets = useLoad((a) => a.clients.snippets(client.id), [client.id], ['clients-changed'])
  if (snippets.status === 'loading') return null
  if (snippets.status === 'error') return <Failed failed what="load the setup steps" />
  return (
    <Stack gap={5}>
      {snippets.data.length === 0 ? (
        <Text tone="muted">This build has no bridge to set {client.name} up with.</Text>
      ) : null}
      {[...snippets.data]
        // The one-click way first.
        .sort((x, y) => (x.client === 'claude-desktop' ? -1 : 0) - (y.client === 'claude-desktop' ? -1 : 0))
        .map((snippet) => {
          const words = SNIPPET_WORDING[snippet.client]
          return (
            <Stack key={snippet.client} gap={2}>
              <Stack gap={0.5}>
                <Text weight="semibold">{words.title}</Text>
                {snippet.client === 'claude-desktop' ? null : (
                  <Text size="sm" tone="muted">
                    {words.detail}
                  </Text>
                )}
              </Stack>
              {snippet.client === 'claude-desktop' ? (
                <>
                  <AddToClaudeDesktop clientId={client.id} />
                  <Text size="sm" tone="muted">
                    {words.detail}
                  </Text>
                </>
              ) : null}
              <CodeBlock label={`${words.title} setup for ${client.name}`}>{snippet.text}</CodeBlock>
              <Inline gap={2}>
                <CopyButtonThrough copy={() => api.clients.copyConfig(client.id, snippet.client)}>
                  {snippet.client === 'claude-code' ? 'Copy command' : 'Copy entry'}
                </CopyButtonThrough>
              </Inline>
            </Stack>
          )
        })}
      <Inline gap={1.5} wrap={false} align="start" className="text-fg-muted [&_svg]:mt-0.5 [&_svg]:size-3.5">
        <Lock aria-hidden="true" />
        <Text size="sm" tone="muted">
          The bridge reads {client.name}’s token from its own config file (readable only by you), so the token
          never sits in {client.name}’s settings.
        </Text>
      </Inline>
    </Stack>
  )
}
