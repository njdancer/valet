// What the session's store and pick-up time are now, read the way the site's own header reads them
// (GET /apis/ui/Delivery/DeliveryInfo). Choosing a store again can drop a reserved time, and the
// runtime chooses the store again every few hours and after every login, so apply_store reads this
// first and leaves a store already in force alone. choose_pickup_time reads it back to confirm.

import { type ToolContext, ValetError } from '@valet/core'
import { getJson, PATHS } from './site'
import { deliveryInfoWire } from './wire'

export interface CurrentFulfilment {
  /** The chosen address (a store's, for pick-up), or null when none is, or it can't be read. */
  readonly addressId: number | null
  /** The reserved time's id, or null when none is reserved (the site sends 0). */
  readonly timeId: number | null
}

/** Answers that say nothing about the session: the caller goes on as if it couldn't ask. */
const UNREAD: ReadonlySet<string> = new Set(['site-changed', 'unavailable', 'not-found', 'not-logged-in'])

/**
 * The session's fulfilment now, or null when the site's answer can't be read or says nothing (a
 * guest's 401, a moved endpoint). A block, a cancelled run or anything else still fails the call.
 */
export async function currentFulfilment(ctx: ToolContext): Promise<CurrentFulfilment | null> {
  let info: Awaited<ReturnType<typeof read>>
  try {
    info = await read(ctx)
  } catch (error) {
    if (error instanceof ValetError && error.stage === 'tool-run' && UNREAD.has(error.errorClass)) {
      return null
    }
    throw error
  }
  const addressId = info.Address?.AddressId
  const timeId = info.ReservedTime?.Id
  return {
    addressId: typeof addressId === 'number' && addressId > 0 ? addressId : null,
    timeId: typeof timeId === 'number' && timeId > 0 ? timeId : null,
  }
}

function read(ctx: ToolContext) {
  // Always the site's own answer: the person can change it from their browser at any time.
  return getJson(ctx, PATHS.deliveryInfo, deliveryInfoWire, { fresh: true })
}
