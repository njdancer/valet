// Signed subjects for the kinds other than installs (B's contract), built only from what the Mac
// knows: the manifest, the stored grant, the setting's current value. One function per kind, so
// the person's own paths (D) and the agents' admin tools (E) ask for exactly the same thing.

import { createHash } from 'node:crypto'
import {
  type AdapterManifest,
  type ApprovalSubject,
  type Grant,
  isDisplayText,
  MESSAGES_SECRET,
  type ProviderKind,
} from '@valet/core'

/**
 * The provider as the signed subject names it. `fake` exists only in tests, where no real
 * provider is offered, and is signed as the Keychain copy it stands in for.
 */
export function subjectProvider(provider: ProviderKind): ApprovalSubject<'secret-grant'>['provider'] {
  if (provider === 'fake') return 'keychain-copy'
  // The 1Password CLI reads the person's vault through the 1Password app, as the desktop one does.
  if (provider === 'onepassword-cli') return 'onepassword-desktop'
  return provider
}

/** First 16 hex of SHA-256 of an item reference: tells two items with one title apart. */
export function itemFingerprint(itemRef: string): string {
  return createHash('sha256').update(itemRef).digest('hex').slice(0, 16)
}

/** Display text of at most `max` UTF-16 units, or `fallback` when nothing printable is left. */
function label(value: string, max: number, fallback: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  let out = ''
  for (const c of flat) {
    if (out.length + c.length > max) break
    out += c
  }
  return out !== '' && isDisplayText(out) ? out : fallback
}

/**
 * The `secret-grant` subject for `grant` of `manifest`'s version: the fields its manifest declares
 * for the secret (a code from Messages for the Messages secret), the item's title and fingerprint,
 * and the origins it may be typed into.
 */
export function grantSubject(
  manifest: AdapterManifest,
  grant: Grant,
  itemTitle: string,
): ApprovalSubject<'secret-grant'> {
  const fields =
    grant.provider === 'messages' || grant.secret === MESSAGES_SECRET
      ? (['otp'] as const)
      : (manifest.secrets[grant.secret]?.fields ?? [])
  return {
    adapterId: grant.adapterId,
    adapterHash: grant.adapterHash,
    secret: grant.secret,
    fields: [...fields],
    provider: subjectProvider(grant.provider),
    itemTitle: label(itemTitle, 120, 'Untitled item'),
    itemFingerprint: itemFingerprint(grant.itemRef),
    origins: [...grant.origins],
  }
}

/**
 * The `tool-enable` subject for turning `tool` of `manifest`'s version (hash `adapterHash`) on:
 * locally, or for remote clients (all of them, or `clientId`). Null when the manifest has no
 * such tool.
 */
export function toolEnableSubject(
  manifest: AdapterManifest,
  adapterHash: string,
  tool: string,
  scope: 'local' | 'remote',
  clientId: string | null = null,
): ApprovalSubject<'tool-enable'> | null {
  const declared = manifest.tools.find((t) => t.name === tool)
  if (declared === undefined) return null
  return { adapterId: manifest.id, adapterHash, tool, scope, clientId, sideEffect: declared.sideEffect }
}

/**
 * Valet's own settings (by the subject's snake-case name) that widen what Valet reaches when they change this way, and so are a
 * signed `setting` request. Their opposites, and every other setting, are clicks.
 */
export const WIDENING_SETTINGS = {
  /** Valet reads Messages for verification codes. */
  messages_otp: { label: 'Read codes from Messages', widens: (to: unknown) => to === true },
  /** Remote MCP clients can reach Valet. */
  remote_enabled: { label: 'Remote access', widens: (to: unknown) => to === true },
  /**
   * System notifications. Off hides the notify tier from the person, so turning them off is
   * signed (A's R6); turning them on is a click.
   */
  notifications: { label: 'Notifications', widens: (to: unknown) => to === false },
  /** Days traces are kept. Shortening them removes evidence (A's R6); lengthening is a click. */
  trace_retention: {
    label: 'Keep run traces (days)',
    widens: (to: unknown, from: unknown) => typeof to === 'number' && typeof from === 'number' && to < from,
  },
  /**
   * A host remote clients may connect through. One request per host added: `to` is that host,
   * so a long list never has to fit on the card.
   */
  remote_hosts: {
    label: 'Add a remote host',
    widens: (to: unknown, from: unknown) => {
      const known = Array.isArray(from) ? from : []
      return Array.isArray(to)
        ? to.some((h) => !known.includes(h))
        : typeof to === 'string' && !known.includes(to)
    },
  },
} as const

export type WideningSetting = keyof typeof WIDENING_SETTINGS

/** Whether changing `setting` from `from` to `to` widens, and so needs a signed request. */
export function settingWidens(setting: WideningSetting, from: unknown, to: unknown): boolean {
  // Setting a value to what it already is changes nothing, whichever value it is.
  if (JSON.stringify(from) === JSON.stringify(to)) return false
  return WIDENING_SETTINGS[setting].widens(to, from)
}

function shownValue(value: unknown): string {
  if (value === true) return 'On'
  if (value === false) return 'Off'
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.join(', ')
  return String(value)
}

/** The `setting` subject for one of Valet's own widening settings, from `from` to `to`. */
export function settingSubject(
  setting: WideningSetting,
  from: unknown,
  to: unknown,
): ApprovalSubject<'setting'> {
  return {
    scope: 'valet',
    adapterId: null,
    setting,
    label: WIDENING_SETTINGS[setting].label,
    from: label(shownValue(from), 120, '(blank)'),
    to: label(shownValue(to), 120, '(blank)'),
  }
}

/**
 * The `setting` subject for an adapter's own setting (a store): the person picks the value on the
 * card from `choices`, the adapter's own list as the Mac fetched it; an agent never supplies it
 * (A's R8). The approved decision names the pick (`choice`). Null with fewer than two choices,
 * when there is nothing to pick between, or for a setting the manifest doesn't declare.
 */
export function adapterSettingSubject(
  manifest: AdapterManifest,
  setting: string,
  current: string | null,
  choices: readonly { readonly id: string; readonly label: string }[],
): ApprovalSubject<'setting'> | null {
  const declared = manifest.settings[setting]
  if (declared === undefined) return null
  const offered = choices
    .slice(0, 50)
    .filter((c) => c.id.length > 0 && c.id.length <= 200)
    .map((c) => ({ value: c.id, label: label(c.label, 120, c.id.slice(0, 120)) }))
  if (offered.length < 2) return null
  return {
    scope: 'adapter',
    adapterId: manifest.id,
    setting,
    label: label(declared.title, 80, setting),
    from: label(current ?? 'Not set', 120, 'Not set'),
    to: 'Chosen on this card',
    choices: offered,
  }
}

/**
 * The value a `setting` subject for one of Valet's own settings sets, read back from its `to`.
 * Null when `to` doesn't read back to exactly that text (a host list cut to fit, say): such a
 * request is never applied.
 */
export function settingValue(setting: WideningSetting, to: string): boolean | number | string | null {
  let value: boolean | number | string | null
  if (setting === 'trace_retention') value = /^[0-9]{1,3}$/.test(to) ? Number(to) : null
  else if (setting === 'remote_hosts') value = /^[a-z0-9.-]{1,120}$/.test(to) ? to : null
  else value = to === 'On' ? true : to === 'Off' ? false : null
  if (value === null) return null
  return label(shownValue(value), 120, '(blank)') === to ? value : null
}

/** The `remote-client` subject for a pending consent: the client's claims, shown as claims. */
export function remoteClientSubject(
  consent: { readonly clientId: string; readonly clientHost: string; readonly source: string | null },
  tools: readonly string[],
): ApprovalSubject<'remote-client'> {
  return {
    clientId: `remote:${consent.clientId}`,
    host: consent.clientHost.toLowerCase(),
    sourceAddress:
      consent.source !== null && /^[0-9A-Fa-f:.]{2,45}$/.test(consent.source) ? consent.source : null,
    tools: [...tools],
  }
}
