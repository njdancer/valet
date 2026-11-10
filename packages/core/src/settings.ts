// What a setting's tools exchange with the runtime (D69). The manifest declares the settings
// (manifest.ts); these are the fixed shapes of the two tools' input and output, whatever the tools'
// own schemas allow. Zod only, so tool code can import them in the isolated tool process.

import { z } from 'zod'

/** The longest value a setting may hold, and the most choices one lookup may offer. */
export const MAX_SETTING_VALUE = 100
export const MAX_SETTING_CHOICES = 50

/** What the app passes a setting's choices tool. */
export const settingQuerySchema = z.object({ query: z.string().max(100) }).strict()

/**
 * One choice. `value` is the adapter's own identifier, opaque to everything else. `label` and
 * `detail` may be site text: they are shown to the person in the app and never sent to an MCP client.
 */
export const settingChoiceSchema = z
  .object({
    value: z.string().min(1).max(MAX_SETTING_VALUE),
    label: z.string().min(1).max(100),
    detail: z.string().max(200).optional(),
  })
  .strict()
export type SettingChoice = z.infer<typeof settingChoiceSchema>

/** What a setting's choices tool must return. */
export const settingChoicesSchema = z
  .object({ choices: z.array(settingChoiceSchema).max(MAX_SETTING_CHOICES) })
  .strict()

/** What the runtime passes a setting's apply tool. */
export const settingValueSchema = z.object({ value: z.string().min(1).max(MAX_SETTING_VALUE) }).strict()
