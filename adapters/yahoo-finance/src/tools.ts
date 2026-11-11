// The tool implementations alone, without the manifest: the entry the app bundles into the script
// that runs in the isolated tool process.

import type { ToolImplementation } from '@valet/core'
import { getPriceHistory } from './history'
import { getQuote } from './quote'
import { searchSymbols } from './search'

export const tools: Readonly<Record<string, ToolImplementation>> = {
  get_quote: getQuote,
  search_symbols: searchSymbols,
  get_price_history: getPriceHistory,
}
