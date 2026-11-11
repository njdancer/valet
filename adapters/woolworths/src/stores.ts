// The store setting (D69): which pick-up store the session shops at. Woolworths prices, specials
// and stock follow the chosen store, and Valet's browser is a new device to the site, so without
// this the tools would quote whatever store the site defaults to.
//
// Both tools serve the setting and are run only by the runtime: find_stores when the person searches
// for a store in the app, apply_store before a tool call whenever the store isn't known to be in
// force. Neither is listed to, or callable by, an MCP client.
//
// Nothing here has been seen live. The paths, the request body and the response fields are what
// the site is believed to use; README.md ("Store") lists what a live session has to confirm.

import { MAX_SETTING_CHOICES, settingChoicesSchema, settingQuerySchema, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { getJson, PATHS, postJson } from './site'
import { htmlToText } from './text'
import { fulfilmentWire, pickupStoresWire, pickupStoreWire } from './wire'

const POSTCODE = /^\d{4}$/
/** A store's address id, as the setting's value. */
const STORE_VALUE = /^[1-9]\d{0,11}$/

/** Site text for the app to show: tags and entities removed, one line, at most `max` characters. */
function line(value: unknown, max: number): string | null {
  const plain = htmlToText(value)?.replace(/\s+/g, ' ').trim() ?? ''
  return plain.length === 0 ? null : plain.slice(0, max)
}

export const findStores = tool({
  input: settingQuerySchema,
  output: settingChoicesSchema,
  async run(ctx, { query }) {
    const postcode = query.trim()
    // Anything that isn't a postcode finds nothing, without a call to the site.
    if (!POSTCODE.test(postcode)) return { choices: [] }
    const stores = await getJson(ctx, `${PATHS.pickupStores}?postcode=${postcode}`, pickupStoresWire)
    const choices = []
    for (const raw of stores) {
      // One store in a shape the adapter can't read is left out rather than failing the list.
      const parsed = pickupStoreWire.safeParse(raw)
      if (!parsed.success) continue
      const store = parsed.data
      const label = line(store.Description, 100)
      if (label === null) continue
      const address = [store.Street1, store.Suburb, store.State, store.Postcode]
        .map((part) => line(part, 80))
        .filter((part) => part !== null)
        .join(', ')
      choices.push({
        value: String(store.AddressId),
        label,
        ...(address.length === 0 ? {} : { detail: address.slice(0, 200) }),
      })
      if (choices.length === MAX_SETTING_CHOICES) break
    }
    return { choices }
  },
})

export const applyStore = tool({
  input: z.object({ value: z.string().regex(STORE_VALUE) }).strict(),
  output: z.object({}).strict(),
  async run(ctx, { value }) {
    const addressId = Number(value)
    const reply = await postJson(
      ctx,
      PATHS.fulfilment,
      { addressId, fulfilmentMethod: 'Pickup' },
      fulfilmentWire,
    )
    // The site answered, but not with the store asked for: the tools must not go on to quote another.
    if (reply.IsSuccessful === false) throw new ValetError('tool-run', 'unavailable')
    if (typeof reply.AddressId === 'number' && reply.AddressId !== addressId) {
      throw new ValetError('tool-run', 'site-changed')
    }
    return {}
  },
})
