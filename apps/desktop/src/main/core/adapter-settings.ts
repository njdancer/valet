// adapter-settings.json: what the person chose for each adapter's settings (D69), such as the
// store an adapter shops at. The runtime reads only the values; the label and detail are the
// choice as the person saw it, kept so the app can show what is chosen without asking the site.
//
// A file that doesn't validate reads as nothing chosen. That is the safe side: a required setting
// then stops the adapter's tools until the person chooses again, rather than running on a guess.

import { MAX_SETTING_VALUE, type SettingChoice } from '@valet/core'
import type { AdapterSettingsLookup } from '@valet/runtime'
import { z } from 'zod'
import { JsonDocument } from './files'

const chosenSchema = z
  .object({
    value: z.string().min(1).max(MAX_SETTING_VALUE),
    label: z.string().min(1).max(100),
    detail: z.string().max(200).nullable(),
    chosenAt: z.iso.datetime(),
  })
  .strict()
export type ChosenSetting = z.infer<typeof chosenSchema>

const NAME = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const fileSchema = z
  .object({
    version: z.literal(1),
    adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), z.record(NAME, chosenSchema)),
  })
  .strict()
type SettingsFile = z.infer<typeof fileSchema>

/** Reads an own key only, so "constructor" or "__proto__" never reaches Object.prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function withEntry<T>(record: Readonly<Record<string, T>>, key: string, value: T | undefined): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [k, v] of Object.entries(record)) if (k !== key) define(next, k, v)
  if (value !== undefined) define(next, key, value)
  return next
}

function define<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true })
}

export class AdapterSettingsStore implements AdapterSettingsLookup {
  private readonly document: JsonDocument<SettingsFile>

  constructor(path: string) {
    this.document = new JsonDocument(path, fileSchema, () => ({ version: 1, adapters: {} }), true)
  }

  /** Every choice made for `adapterId`, by setting name. */
  async chosen(adapterId: string): Promise<Readonly<Record<string, ChosenSetting>>> {
    return own((await this.document.read()).adapters, adapterId) ?? {}
  }

  /** The runtime's view: values only. */
  async values(adapterId: string): Promise<Readonly<Record<string, string>>> {
    const values: Record<string, string> = {}
    for (const [name, choice] of Object.entries(await this.chosen(adapterId))) define(values, name, choice.value)
    return values
  }

  async set(adapterId: string, setting: string, choice: SettingChoice, chosenAt: string): Promise<void> {
    const entry: ChosenSetting = {
      value: choice.value,
      label: choice.label,
      detail: choice.detail ?? null,
      chosenAt,
    }
    await this.change(adapterId, setting, entry)
  }

  async clear(adapterId: string, setting: string): Promise<void> {
    await this.change(adapterId, setting, undefined)
  }

  private async change(adapterId: string, setting: string, entry: ChosenSetting | undefined): Promise<void> {
    await this.document.update((file) => {
      const settings = withEntry(own(file.adapters, adapterId) ?? {}, setting, entry)
      const adapters = withEntry(
        file.adapters,
        adapterId,
        Object.keys(settings).length === 0 ? undefined : settings,
      )
      return { version: 1, adapters }
    })
  }
}
