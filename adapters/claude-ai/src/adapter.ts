import { type AdapterDefinition, defineAdapter } from '@valet/core'
import { createManifest, type ManifestOptions } from './manifest'
import { tools } from './tools'

export function createAdapter(options: ManifestOptions = {}): AdapterDefinition {
  return defineAdapter({ manifest: createManifest(options), tools: { ...tools } })
}
