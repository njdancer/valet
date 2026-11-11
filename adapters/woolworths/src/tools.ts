// The tool implementations alone, without the manifest: the entry the app bundles into the script
// that runs in the isolated tool process (packages/runtime/src/isolation). Tools call the site with
// paths relative to the page, so they need none of the manifest's options.

import type { ToolImplementation } from '@valet/core'
import { addToCart, getCart, removeFromCart, setCartQuantity, updateCart } from './cart'
import { getProduct, searchProducts } from './products'
import { applyStore, findStores } from './stores'

export const tools: Readonly<Record<string, ToolImplementation>> = {
  search_products: searchProducts,
  get_product: getProduct,
  get_cart: getCart,
  add_to_cart: addToCart,
  set_cart_quantity: setCartQuantity,
  remove_from_cart: removeFromCart,
  update_cart: updateCart,
  // The store setting's own tools, which only the runtime runs (stores.ts).
  find_stores: findStores,
  apply_store: applyStore,
}
