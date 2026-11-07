// The Woolworths adapter: its manifest plus the tool implementations. Tools call the site with
// paths relative to the page, so the same implementations serve the real and the fake origin.

import { type AdapterDefinition, defineAdapter } from '@valet/core'
import { addToCart, getCart, removeFromCart, setCartQuantity } from './cart'
import { createManifest, type ManifestOptions } from './manifest'
import { getProduct, searchProducts } from './products'

export function createAdapter(options: ManifestOptions = {}): AdapterDefinition {
  return defineAdapter({
    manifest: createManifest(options),
    tools: {
      search_products: searchProducts,
      get_product: getProduct,
      get_cart: getCart,
      add_to_cart: addToCart,
      set_cart_quantity: setCartQuantity,
      remove_from_cart: removeFromCart,
    },
  })
}
