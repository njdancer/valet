// settings.json. The renderer changes it only through a SettingsPatch (validated in ipc.ts); the
// 1Password CLI path changes only through the main process's own file dialog and checks. A file
// that doesn't validate reads as the defaults, which are the cautious side of every setting:
// Messages off, no pinned op path, no launch at login.

import type { Settings, SettingsPatch } from '../../shared/api'
import { JsonDocument } from './files'
import { z } from './zod'

export const DEFAULT_SETTINGS: Settings = {
  updateChannel: 'stable',
  autoInstallUpdates: false,
  launchAtLogin: false,
  opPath: null,
  messagesOtpEnabled: false,
}

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
    }
    return this.document.update((current) => ({ ...current, ...known }))
  }

  /** Only after the main process has checked the binary. */
  setOpPath(opPath: string | null): Promise<Settings> {
    return this.document.update((current) => ({ ...current, opPath }))
  }
}
