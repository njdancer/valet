// agent-network.json: each agent's network settings for its browser sessions (docs/agent-browser.md,
// "Network"). Off by default: a session reaches public addresses only, through whichever interface
// the Mac routes by. The person can let one agent's sessions reach the home network (private
// addresses, never this Mac's own or loopback), and pin them to one network interface, such as a
// VLAN made for that agent. Turning either wider is approved (Touch ID, or the phone when the agent
// asks); narrowing is a click. A session takes the settings it opened with.
//
// A file that doesn't validate reads as nothing set: the narrow side.

import { networkInterfaces as osInterfaces } from 'node:os'
import { z } from 'zod'
import { JsonDocument } from './files'

/** An interface name as macOS gives it (en0, bridge100, vlan1), never a path or free text. */
export const INTERFACE_NAME = /^[a-z][a-z0-9]{0,14}$/

/** A key per agent: `local:<client id>` or `remote:<registration id>`, as audits name them. */
const AGENT_KEY = /^(local:c_[0-9a-f]{16}|remote:[a-z0-9_]{1,52})$/

const entrySchema = z
  .object({
    homeNetwork: z.boolean(),
    interface: z.string().regex(INTERFACE_NAME).nullable(),
  })
  .strict()
export type AgentNetwork = z.infer<typeof entrySchema>

const fileSchema = z
  .object({ version: z.literal(1), agents: z.record(z.string().regex(AGENT_KEY), entrySchema) })
  .strict()
type NetworkFile = z.infer<typeof fileSchema>

/** What an agent gets until the person changes it: public addresses, the Mac's own routing. */
export const DEFAULT_NETWORK: AgentNetwork = { homeNetwork: false, interface: null }

export function isAgentKey(key: string): boolean {
  return AGENT_KEY.test(key)
}

export class AgentNetworkStore {
  private readonly document: JsonDocument<NetworkFile>

  constructor(path: string) {
    this.document = new JsonDocument(path, fileSchema, () => ({ version: 1, agents: {} }), true)
  }

  async get(key: string): Promise<AgentNetwork> {
    const agents = (await this.document.read()).agents
    return (Object.hasOwn(agents, key) ? agents[key] : undefined) ?? DEFAULT_NETWORK
  }

  async set(key: string, patch: Partial<AgentNetwork>): Promise<AgentNetwork> {
    if (!isAgentKey(key)) throw new Error('not an agent key')
    let next: AgentNetwork = DEFAULT_NETWORK
    await this.document.update((file) => {
      const agents: Record<string, AgentNetwork> = {}
      for (const [k, v] of Object.entries(file.agents))
        if (k !== key) Object.defineProperty(agents, k, { value: v, enumerable: true, writable: true })
      const was = Object.hasOwn(file.agents, key) ? file.agents[key] : undefined
      next = { ...(was ?? DEFAULT_NETWORK), ...patch }
      // Back to the default is no entry at all.
      if (next.homeNetwork || next.interface !== null)
        Object.defineProperty(agents, key, { value: next, enumerable: true, writable: true })
      return { version: 1, agents }
    })
    return next
  }

  /** Forgets an agent's settings, when it is revoked. */
  async forget(key: string): Promise<void> {
    await this.set(key, DEFAULT_NETWORK).catch(() => undefined)
  }
}

/** One of the Mac's network interfaces a session could be pinned to, as Settings lists them. */
export interface NetworkInterfaceInfo {
  readonly name: string
  /** Its addresses, IPv4 first. */
  readonly addresses: readonly { readonly address: string; readonly family: 4 | 6 }[]
}

type OsInterfaces = () => NodeJS.Dict<
  readonly { readonly address: string; readonly family: string | number; readonly internal: boolean }[]
>

/** The interfaces with an address a session could leave from: not loopback, not link-local only. */
export function listInterfaces(read: OsInterfaces = osInterfaces): readonly NetworkInterfaceInfo[] {
  const out: NetworkInterfaceInfo[] = []
  for (const [name, list] of Object.entries(read())) {
    if (!INTERFACE_NAME.test(name) || list === undefined) continue
    const addresses = list
      .filter((a) => !a.internal && !a.address.toLowerCase().startsWith('fe80:'))
      .map((a) => ({
        address: a.address,
        family: (a.family === 'IPv6' || a.family === 6 ? 6 : 4) as 4 | 6,
      }))
      .sort((a, b) => a.family - b.family)
    if (addresses.length > 0) out.push({ name, addresses })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
}

/** Which of an agent's network settings a `setting` approval names. */
export type NetworkSettingName = 'home' | 'nic'

/**
 * The `setting` approval name for one agent's network setting (scope "valet"): the agent is in the
 * name, as `remote_ask_<id>` carries its agent, so the phone's setting card shows it as it is.
 */
export function networkSettingName(key: string, which: NetworkSettingName): string | null {
  const match = /^(local|remote):(.+)$/.exec(key)
  if (match === null || !isAgentKey(key)) return null
  const name = `bnet_${which}_${match[1] === 'local' ? 'l' : 'r'}_${match[2]}`
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : null
}

/** The agent and setting a `bnet_…` setting name carries, or null for any other name. */
export function networkSettingOf(
  setting: string,
): { readonly key: string; readonly which: NetworkSettingName } | null {
  const match = /^bnet_(home|nic)_(l|r)_([a-z0-9_]{1,52})$/.exec(setting)
  if (match === null) return null
  const key = `${match[2] === 'l' ? 'local' : 'remote'}:${match[3]}`
  return isAgentKey(key) ? { key, which: match[1] as NetworkSettingName } : null
}

/** A setting's value in the words a card shows: On/Off, or an interface's name/Automatic. */
export function networkSettingWords(which: NetworkSettingName, network: AgentNetwork): string {
  if (which === 'home') return network.homeNetwork ? 'On' : 'Off'
  return network.interface ?? 'Automatic'
}

/** The value a card's words stand for; null when they aren't one. */
export function networkSettingValue(which: NetworkSettingName, words: string): Partial<AgentNetwork> | null {
  if (which === 'home') return words === 'On' || words === 'Off' ? { homeNetwork: words === 'On' } : null
  if (words === 'Automatic') return { interface: null }
  return INTERFACE_NAME.test(words) ? { interface: words } : null
}

export const NETWORK_SETTING_LABELS: Readonly<Record<NetworkSettingName, string>> = {
  home: 'Browser sessions reach your home network',
  nic: 'Browser sessions’ network interface',
}

/**
 * Whether a change widens what the agent's sessions reach, so it is approved: the home network
 * turned on, or a different interface (it could be a network the default route doesn't reach).
 * Turning the home network off, or going back to Automatic, only narrows.
 */
export function networkChangeWidens(
  which: NetworkSettingName,
  from: AgentNetwork,
  to: Partial<AgentNetwork>,
): boolean {
  if (which === 'home') return to.homeNetwork === true && !from.homeNetwork
  return to.interface !== undefined && to.interface !== null && to.interface !== from.interface
}
