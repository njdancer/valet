// An agent's browser sessions' network (docs/agent-browser.md, "Network"), on its page: whether its
// sessions reach the home network, and the network interface they leave from. Turning either wider
// asks for Touch ID; narrowing is a click. Sessions already open keep what they opened with.

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from '@valet/ui'
import type { AgentNetworkPatch } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { Failed } from './shared'

const AUTOMATIC = '__automatic__'

export function BrowserNetwork({ agent, name }: { readonly agent: string; readonly name: string }) {
  const api = useApi()
  const action = useAction()
  const network = useLoad((a) => a.clients.network(agent), [agent], ['clients-changed', 'remote-changed'])
  if (network.status === 'loading') return null
  if (network.status === 'error') return <Failed failed what={`load ${name}’s browser network`} />
  const n = network.data
  const set = async (patch: AgentNetworkPatch, done: string) => {
    if (await action.run(() => api.clients.setNetwork(agent, patch)))
      toast.success(done, { description: 'New browser sessions have it; open ones keep what they had.' })
  }
  const listed = n.interfaces.some((i) => i.name === n.interface)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Browser network</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Failed failed={action.failed} what={`change ${name}’s browser network`} />
        <Field
          inline
          label="Home network"
          description="Its browser sessions may open devices on your network, such as a router’s page or a printer. Never this Mac itself. Off, they reach the public internet only."
        >
          <Switch
            checked={n.homeNetwork}
            onCheckedChange={(on) =>
              void set({ homeNetwork: on }, on ? 'Home network on' : 'Home network off')
            }
            aria-label="Home network"
          />
        </Field>
        <Field
          inline
          label="Network interface"
          description="Where its browser sessions’ connections leave this Mac. Automatic uses the Mac’s own routing; pick one, such as a VLAN made for this agent, to keep it there."
        >
          <Select
            value={n.interface ?? AUTOMATIC}
            onValueChange={(v) =>
              void set(
                { interface: v === AUTOMATIC ? null : v },
                v === AUTOMATIC ? 'Network interface: automatic' : `Network interface: ${v}`,
              )
            }
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
              {n.interfaces.map((i) => (
                <SelectItem key={i.name} value={i.name}>
                  {i.name} ({i.addresses[0]?.address})
                </SelectItem>
              ))}
              {n.interface !== null && !listed ? (
                <SelectItem value={n.interface}>{n.interface} (not connected)</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </Field>
        {n.interface !== null && !listed ? (
          <Text size="sm" tone="warning">
            {n.interface} isn’t connected now, so its browser sessions can’t reach anything until it is.
          </Text>
        ) : null}
      </CardContent>
    </Card>
  )
}
