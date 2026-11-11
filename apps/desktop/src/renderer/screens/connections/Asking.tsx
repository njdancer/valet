// The cloud agents asking to connect, where Connections and Remote access show them: who is asking
// as far as Valet can tell (its claimed host, its IP, the name it calls itself, marked not verified),
// and the two answers side by side. Approve… opens the code sheet; the code is never shown here.

import { Badge, Banner, Button, DeadlineChip, Stack, Value } from '@valet/ui'
import type { RemoteConsentRequest } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatClock } from '../../lib/format'
import { href } from '../../lib/router'
import { clientLabel } from '../../lib/wording'
import { Failed } from './shared'

export function AskingToConnect() {
  const consents = useLoad((a) => a.remote.consents(), [], ['remote-changed'])
  if (consents.status !== 'ready' || consents.data.requests.length === 0) return null
  return <AskingBanner requests={consents.data.requests} />
}

function AskingBanner({ requests }: { readonly requests: readonly RemoteConsentRequest[] }) {
  const api = useApi()
  const now = useNow(1000)
  const action = useAction()
  const soonest = Math.min(...requests.map((r) => Date.parse(r.expiresAt)))
  const one = requests.length === 1 ? requests[0] : undefined
  return (
    <Banner
      tone="warning"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {requests.length === 1 ? '1 asking to connect' : `${requests.length} asking to connect`}
          <DeadlineChip until={soonest} now={now} subject="Approve a connection" />
        </span>
      }
      action={
        <>
          <Button
            size="sm"
            loading={action.busy}
            onClick={() =>
              void action.run(() =>
                one !== undefined ? api.remote.declineConsent(one.id) : api.remote.declineAllConsents(),
              )
            }
          >
            {one !== undefined ? 'Decline' : 'Decline all'}
          </Button>
          <Button size="sm" asChild>
            <a href={href.approveConnection()}>Approve…</a>
          </Button>
        </>
      }
    >
      <Stack gap={1}>
        {requests.map((r) => (
          <span key={r.id}>
            Asked {formatClock(r.requestedAt)}
            {r.source !== null ? (
              <>
                {' '}
                from <Value mono>{r.source}</Value>
              </>
            ) : null}{' '}
            as <Value mono>{r.clientHost}</Value>
            {r.clientName !== null ? (
              <>
                . Calls itself “{clientLabel(r.clientName)}”{' '}
                <Badge size="sm" tone="neutral">
                  not verified
                </Badge>
              </>
            ) : null}
            .
          </span>
        ))}
        <span>
          <strong>If you didn’t start this, decline it.</strong> Anyone who knows your public name can ask.
        </span>
        <Failed failed={action.failed} what="decline" />
      </Stack>
    </Banner>
  )
}
