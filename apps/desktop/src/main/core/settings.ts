// settings.json. The renderer changes it only through a SettingsPatch (validated in ipc.ts); the
// 1Password CLI path changes only through the main process's own file dialog and checks. A file
// that doesn't validate reads as the defaults, which are the cautious side of every setting:
// Messages off, no pinned op path, no launch at login.

import { isOnePasswordAccount } from '@valet/credentials'
import {
  DEFAULT_TRACE_RETENTION_DAYS,
  MAX_TRACE_RETENTION_DAYS,
  MIN_TRACE_RETENTION_DAYS,
} from '@valet/runtime'
import { z } from 'zod'
import type { Settings, SettingsPatch } from '../../shared/api'
import { JsonDocument } from './files'

export const DEFAULT_SETTINGS: Settings = {
  updateChannel: 'stable',
  autoInstallUpdates: false,
  launchAtLogin: false,
  opPath: null,
  messagesOtpEnabled: false,
  onePasswordAccount: null,
  traceRetentionDays: DEFAULT_TRACE_RETENTION_DAYS,
  notifications: true,
  relayHost: null,
  relayMacHost: null,
}

/**
 * A relay's host name: lower-case DNS labels, at least two, no port, no scheme. The relay is
 * always reached over https on the default port.
 */
export const relayHostSchema = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/)

/** What DesktopAuth takes: an account name or UUID, trimmed, without control characters. */
export const onePasswordAccountSchema = z.string().refine(isOnePasswordAccount)

/** Days a run's traces and screenshots are kept (D27). */
export const traceRetentionDaysSchema = z
  .number()
  .int()
  .min(MIN_TRACE_RETENTION_DAYS)
  .max(MAX_TRACE_RETENTION_DAYS)

const settingsSchema = z
  .object({
    updateChannel: z.enum(['stable', 'beta']),
    autoInstallUpdates: z.boolean(),
    launchAtLogin: z.boolean(),
    opPath: z
      .string()
      .max(1024)
      .regex(/^\/[^\0]*$/)
      .nullable(),
    messagesOtpEnabled: z.boolean(),
    // Absent in files written before it existed.
    onePasswordAccount: onePasswordAccountSchema.nullable().default(null),
    traceRetentionDays: traceRetentionDaysSchema.default(DEFAULT_TRACE_RETENTION_DAYS),
    // On unless the person turns it off: a notification only opens one of the app's own windows.
    notifications: z.boolean().default(true),
    relayHost: relayHostSchema.nullable().default(null),
    // The base of this Mac's own host for cloud agents, when the relay names Macs under another
    // domain than its own (docs/relay-worker.md, "Host names"). Unset: `<macId>.<relayHost>`.
    relayMacHost: relayHostSchema.nullable().default(null),
  })
  .strict()

export class SettingsStore {
  private readonly document: JsonDocument<Settings>

  constructor(path: string) {
    this.document = new JsonDocument(path, settingsSchema, () => DEFAULT_SETTINGS, true)
  }

  get(): Promise<Settings> {
    return this.document.read()
  }

  /** Applies only SettingsPatch's own keys; anything else, opPath above all, is ignored. */
  set(patch: SettingsPatch): Promise<Settings> {
    const known: SettingsPatch = {
      ...(patch.updateChannel === undefined ? {} : { updateChannel: patch.updateChannel }),
      ...(patch.autoInstallUpdates === undefined ? {} : { autoInstallUpdates: patch.autoInstallUpdates }),
      ...(patch.launchAtLogin === undefined ? {} : { launchAtLogin: patch.launchAtLogin }),
      ...(patch.messagesOtpEnabled === undefined ? {} : { messagesOtpEnabled: patch.messagesOtpEnabled }),
      ...(patch.onePasswordAccount === undefined ? {} : { onePasswordAccount: patch.onePasswordAccount }),
      ...(patch.traceRetentionDays === undefined ? {} : { traceRetentionDays: patch.traceRetentionDays }),
      ...(patch.notifications === undefined ? {} : { notifications: patch.notifications }),
      ...(patch.relayHost === undefined ? {} : { relayHost: patch.relayHost }),
      ...(patch.relayMacHost === undefined ? {} : { relayMacHost: patch.relayMacHost }),
    }
    return this.document.update((current) => ({ ...current, ...known }))
  }

  /** Only after the main process has checked the binary. */
  setOpPath(opPath: string | null): Promise<Settings> {
    return this.document.update((current) => ({ ...current, opPath }))
  }
}
