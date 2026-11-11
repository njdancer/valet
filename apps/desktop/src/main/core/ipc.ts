// Every IPC request from a renderer, checked before anything acts on it. Renderers show site- and
// adapter-derived text, so they are treated as untrusted: the sender must be one of the app's own
// windows on the app's own page, the channel must be one of ours, and the arguments must match the
// channel's schema exactly (strict objects, bounded strings, no extra arguments). Anything else is
// refused with a fixed error whose message says nothing about why.

import { z } from 'zod'
import { parseRoute } from '../../renderer/lib/routes'
import type { HashRoute, ValetApi } from '../../shared/api'
import { CHANNEL_PREFIX, INVOKE_METHODS, type InvokeMethod } from './channels'
import { onePasswordAccountSchema, traceRetentionDaysSchema } from './settings'

/** Which of the app's windows sent a request. The main process assigns it when it opens the window. */
export type WindowRole = 'control' | 'tray' | 'confirmation' | 'needs-user'

/** One of the app's windows, as the main process recorded it when it opened the window. */
export interface AppWindow {
  readonly role: WindowRole
  /**
   * What the window was opened for: the confirmation id of a confirmation panel, the adapter id of
   * a hand-off banner, null for the control panel and the tray.
   */
  readonly shows: string | null
}

export interface Sender {
  /** The window the request came from, or null for anything that isn't one of the app's windows. */
  readonly role: WindowRole | null
  /** What that window was opened for (AppWindow.shows); null when it isn't one of ours. */
  readonly shows: string | null
  /** The URL of the frame that sent it. */
  readonly frameUrl: string
  /** Whether that frame is its window's main frame. Subframes never speak for the app. */
  readonly mainFrame: boolean
}

/** What a refused or failed request rejects with. Deliberately says nothing. */
export class IpcRefused extends Error {
  constructor() {
    super('valet: request refused')
    this.name = 'IpcRefused'
  }
}

/** The service behind the channels: the API, plus who sent a confirmation answer. */
export type MainApi = Omit<ValetApi, 'onEvent' | 'answerConfirmation'> & {
  answerConfirmation(confirmationId: string, approved: boolean, from: AppWindow): Promise<void>
}

const MAX_TEXT = 10_000
const ADAPTER_ID = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)
const HASH = z.string().regex(/^[0-9a-f]{64}$/)
const SECRET = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
/** A setting's name in a manifest: the same alphabet as a secret's. */
const SETTING = SECRET
/** Call, confirmation and client ids: the runtime's call-id alphabet. */
const OPAQUE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const PROVIDER = z.enum([
  'keychain-copy',
  'onepassword-desktop',
  'onepassword-service-account',
  'onepassword-cli',
  'messages',
  'fake',
])
const ITEM_REF = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
const ORIGIN = z.string().min(1).max(300)
const ISO_TIME = z.iso.datetime({ offset: true })
/** `<adapterId>.<tool>`, as the consent window grants tools. */
const REMOTE_TOOL = z.string().regex(/^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9_]{0,63}$/)
const REMOTE_CLIENT_ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)

const grantRequest = z
  .object({
    adapterId: ADAPTER_ID,
    adapterHash: HASH,
    secret: SECRET,
    provider: PROVIDER,
    itemRef: ITEM_REF,
    origins: z.array(ORIGIN).min(1).max(20),
  })
  .strict()

const auditQuery = z
  .object({
    category: z
      .enum(['tool-calls', 'logins', 'secret-use', 'blocked', 'confirmations', 'approvals-grants'])
      .optional(),
    adapterId: ADAPTER_ID.optional(),
    client: z.string().min(1).max(200).optional(),
    clientId: z
      .string()
      .regex(/^(local|remote):[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    since: ISO_TIME.optional(),
    search: z.string().max(200).optional(),
    beforeSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()

const runsQuery = z
  .object({ adapterId: ADAPTER_ID.optional(), limit: z.number().int().min(1).max(500).optional() })
  .strict()

/** SettingsPatch. opPath isn't here: only settings.chooseOpPath() changes it. */
const settingsPatch = z
  .object({
    updateChannel: z.enum(['stable', 'beta']).optional(),
    autoInstallUpdates: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    messagesOtpEnabled: z.boolean().optional(),
    onePasswordAccount: onePasswordAccountSchema.nullable().optional(),
    traceRetentionDays: traceRetentionDaysSchema.optional(),
    notifications: z.boolean().optional(),
  })
  .strict()

/** A hash route the renderer's own parser reads as a page. Never a URL. */
const hashRoute = z
  .string()
  .max(500)
  .refine((value): value is HashRoute => value.startsWith('#/') && parseRoute(value).page !== 'not-found')

type Handler = (api: MainApi, args: readonly unknown[], sender: Sender) => Promise<unknown>

function entry<A extends readonly unknown[]>(
  schema: z.ZodType<A>,
  call: (api: MainApi, args: A, sender: Sender) => Promise<unknown>,
): { readonly schema: z.ZodType<readonly unknown[]>; readonly call: Handler } {
  return { schema, call: call as Handler }
}

const none = z.tuple([])

/** One schema and one call per channel. Optional trailing arguments are explicit in the tuple. */
const HANDLERS: Readonly<
  Record<InvokeMethod, { readonly schema: z.ZodType<readonly unknown[]>; readonly call: Handler }>
> = {
  'adapters.list': entry(none, (api) => api.adapters.list()),
  'adapters.get': entry(z.tuple([ADAPTER_ID]), (api, [id]) => api.adapters.get(id)),
  'adapters.settingChoices': entry(z.tuple([ADAPTER_ID, SETTING, z.string().max(100)]), (api, [id, s, q]) =>
    api.adapters.settingChoices(id, s, q),
  ),
  'adapters.setSetting': entry(
    z.tuple([ADAPTER_ID, SETTING, z.string().min(1).max(100)]),
    (api, [id, s, v]) => api.adapters.setSetting(id, s, v),
  ),
  'adapters.clearSetting': entry(z.tuple([ADAPTER_ID, SETTING]), (api, [id, s]) =>
    api.adapters.clearSetting(id, s),
  ),
  'adapters.openCart': entry(z.tuple([ADAPTER_ID]), (api, [id]) => api.adapters.openCart(id)),
  'approvals.pending': entry(none, (api) => api.approvals.pending()),
  'approvals.approve': entry(z.tuple([ADAPTER_ID, HASH]), (api, [id, hash]) =>
    api.approvals.approve(id, hash),
  ),
  'approvals.reject': entry(z.tuple([ADAPTER_ID, HASH]), (api, [id, hash]) => api.approvals.reject(id, hash)),
  'grants.list': entry(none, (api) => api.grants.list()),
  'grants.providers': entry(none, (api) => api.grants.providers()),
  'grants.vaultItems': entry(z.tuple([PROVIDER]), (api, [provider]) => api.grants.vaultItems(provider)),
  'grants.make': entry(z.tuple([grantRequest]), (api, [request]) => api.grants.make(request)),
  'grants.revoke': entry(z.tuple([ADAPTER_ID, SECRET]), (api, [id, secret]) => api.grants.revoke(id, secret)),
  'grants.resync': entry(z.tuple([ADAPTER_ID, SECRET]), (api, [id, secret]) => api.grants.resync(id, secret)),
  'runs.list': entry(z.union([none, z.tuple([runsQuery])]), (api, args) =>
    args.length === 0 ? api.runs.list() : api.runs.list(stripUndefined(args[0])),
  ),
  'runs.trace': entry(z.tuple([OPAQUE_ID]), (api, [callId]) => api.runs.trace(callId)),
  'runs.statsToday': entry(none, (api) => api.runs.statsToday()),
  'audit.page': entry(z.tuple([auditQuery]), (api, [query]) => api.audit.page(stripUndefined(query))),
  'audit.verify': entry(none, (api) => api.audit.verify()),
  'audit.chainStatus': entry(none, (api) => api.audit.chainStatus()),
  'audit.exportJsonl': entry(none, (api) => api.audit.exportJsonl()),
  'endpoint.status': entry(none, (api) => api.endpoint.status()),
  'endpoint.setListening': entry(z.tuple([z.boolean()]), (api, [on]) => api.endpoint.setListening(on)),
  'endpoint.copyUrl': entry(none, (api) => api.endpoint.copyUrl()),
  'clients.list': entry(none, (api) => api.clients.list()),
  'clients.add': entry(z.tuple([z.string().min(1).max(200)]), (api, [name]) => api.clients.add(name)),
  'clients.resetAccess': entry(z.tuple([OPAQUE_ID]), (api, [id]) => api.clients.resetAccess(id)),
  'clients.revoke': entry(z.tuple([OPAQUE_ID]), (api, [id]) => api.clients.revoke(id)),
  'clients.snippets': entry(z.tuple([OPAQUE_ID]), (api, [id]) => api.clients.snippets(id)),
  'clients.copyConfig': entry(
    z.tuple([OPAQUE_ID, z.enum(['claude-code', 'claude-desktop'])]),
    (api, [id, kind]) => api.clients.copyConfig(id, kind),
  ),
  'attention.list': entry(none, (api) => api.attention.list()),
  answerConfirmation: entry(z.tuple([OPAQUE_ID, z.boolean()]), (api, [id, approved], sender) =>
    // The sender's role is non-null here: untrusted senders never reach a handler.
    api.answerConfirmation(id, approved, { role: sender.role as WindowRole, shows: sender.shows }),
  ),
  openLoginWindow: entry(z.tuple([ADAPTER_ID]), (api, [id]) => api.openLoginWindow(id)),
  finishLogin: entry(z.tuple([ADAPTER_ID]), (api, [id]) => api.finishLogin(id)),
  closeLoginWindow: entry(z.tuple([ADAPTER_ID]), (api, [id]) => api.closeLoginWindow(id)),
  'settings.get': entry(none, (api) => api.settings.get()),
  'settings.set': entry(z.tuple([settingsPatch]), (api, [patch]) => api.settings.set(stripUndefined(patch))),
  'settings.chooseOpPath': entry(none, (api) => api.settings.chooseOpPath()),
  'settings.clearOpPath': entry(none, (api) => api.settings.clearOpPath()),
  'updates.status': entry(none, (api) => api.updates.status()),
  'updates.check': entry(none, (api) => api.updates.check()),
  'health.sites': entry(none, (api) => api.health.sites()),
  'setup.status': entry(none, (api) => api.setup.status()),
  'setup.finish': entry(none, (api) => api.setup.finish()),
  'remote.consents': entry(none, (api) => api.remote.consents()),
  'remote.approveConsent': entry(
    z.tuple([z.string().min(1).max(32), z.array(REMOTE_TOOL).max(200)]),
    (api, [code, tools]) => api.remote.approveConsent(code, tools),
  ),
  'remote.declineConsent': entry(z.tuple([OPAQUE_ID]), (api, [id]) => api.remote.declineConsent(id)),
  'remote.declineAllConsents': entry(none, (api) => api.remote.declineAllConsents()),
  'remote.clients': entry(none, (api) => api.remote.clients()),
  'remote.revokeClient': entry(z.tuple([REMOTE_CLIENT_ID]), (api, [id]) => api.remote.revokeClient(id)),
  'remote.revokeAllClients': entry(none, (api) => api.remote.revokeAllClients()),
  'app.status': entry(none, (api) => api.app.status()),
  'app.setPaused': entry(z.tuple([z.boolean()]), (api, [paused]) => api.app.setPaused(paused)),
  'app.openControlPanel': entry(z.union([none, z.tuple([hashRoute])]), (api, args) =>
    args.length === 0 ? api.app.openControlPanel() : api.app.openControlPanel(args[0] as HashRoute),
  ),
  'app.copyText': entry(z.tuple([z.string().max(MAX_TEXT)]), (api, [text]) => api.app.copyText(text)),
  'app.quit': entry(none, (api) => api.app.quit()),
  // Settings lives in the control panel, and nowhere else may ask: a confirmation panel or a
  // hand-off banner shows adapter text. The main process's own dialog still decides.
  'app.erase': entry(z.tuple([z.enum(['reset', 'uninstall'])]), (api, [kind], sender) => {
    if (sender.role !== 'control') throw new IpcRefused()
    return api.app.erase(kind)
  }),
}

/** The method a channel name stands for, or null for anything that isn't exactly one of ours. */
export function methodOf(channel: string): InvokeMethod | null {
  if (!channel.startsWith(CHANNEL_PREFIX)) return null
  const method = channel.slice(CHANNEL_PREFIX.length)
  return (INVOKE_METHODS as readonly string[]).includes(method) ? (method as InvokeMethod) : null
}

/**
 * True when the request came from the main frame of one of the app's windows, showing one of the
 * app's own pages. `isAppPage` decides what the app's pages are (app://renderer in a build, the dev
 * server's origin under electron-vite dev).
 */
export function senderTrusted(sender: Sender, isAppPage: (url: string) => boolean): boolean {
  return sender.role !== null && sender.mainFrame && isAppPage(sender.frameUrl)
}

export interface Dispatcher {
  /** Validates and runs one request. Rejects with IpcRefused for anything refused or failed. */
  dispatch(channel: string, args: readonly unknown[], sender: Sender): Promise<unknown>
}

export interface DispatcherOptions {
  readonly isAppPage: (url: string) => boolean
  /** Told about each refusal, for a diagnostic log. Never given the arguments. */
  readonly onRefused?: (method: string | null, why: 'channel' | 'sender' | 'arguments' | 'failed') => void
}

export function createDispatcher(api: MainApi, options: DispatcherOptions): Dispatcher {
  const refused = options.onRefused ?? (() => {})
  return {
    async dispatch(channel, args, sender) {
      const method = methodOf(channel)
      if (method === null) {
        refused(null, 'channel')
        throw new IpcRefused()
      }
      if (!senderTrusted(sender, options.isAppPage)) {
        refused(method, 'sender')
        throw new IpcRefused()
      }
      const handler = HANDLERS[method]
      const parsed = handler.schema.safeParse(args)
      if (!parsed.success) {
        refused(method, 'arguments')
        throw new IpcRefused()
      }
      try {
        return await handler.call(api, parsed.data, sender)
      } catch {
        // The renderer never shows a main-process message; none crosses.
        refused(method, 'failed')
        throw new IpcRefused()
      }
    },
  }
}

/** Optional keys arrive as undefined from zod; the API's types say absent. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
