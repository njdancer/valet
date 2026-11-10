// The Woolworths adapter: its manifest plus the tool implementations. Tools call the site with
// paths relative to the page, so the same implementations serve the real and the fake origin.

import { type AdapterDefinition, defineAdapter } from '@valet/core'
import { createManifest, type ManifestOptions } from './manifest'
import { tools } from './tools'

export function createAdapter(options: ManifestOptions = {}): AdapterDefinition {
  return defineAdapter({
    manifest: createManifest(options),
    tools: { ...tools },
  })
}
