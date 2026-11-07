// The adapters this build ships, each with the content hash approvals and grants are keyed by, and
// a record of what the person last approved, so an update can be reviewed as a diff.
//
// The hash covers the adapter's source files exactly as this build compiled them (embedded at build
// time, see src/main/adapters.ts) plus the effective manifest, because the same source makes a
// different manifest for the fake site: a demo approval must never stand for the real site's.

import {
  type AdapterDefinition,
  type AdapterManifest,
  bundleHash,
  canonicalJson,
  parseManifest,
} from '@valet/core'
import { z } from 'zod'
import { JsonDocument } from './files'

/** The bundle entry that carries the effective manifest. No source path can look like it. */
export const MANIFEST_ENTRY = ':manifest.json'

export interface BuiltinAdapter {
  readonly definition: AdapterDefinition
  readonly hash: string
  /** Source files by path relative to the adapter's package, as hashed. */
  readonly files: Readonly<Record<string, string>>
}

export function builtinAdapter(
  definition: AdapterDefinition,
  files: Readonly<Record<string, string>>,
): BuiltinAdapter {
  if (Object.hasOwn(files, MANIFEST_ENTRY)) throw new Error('reserved bundle entry')
  const hash = bundleHash({ ...files, [MANIFEST_ENTRY]: canonicalJson(definition.manifest) })
  return { definition, hash, files: { ...files } }
}

export interface ApprovedSnapshot {
  readonly hash: string
  readonly version: string
  readonly approvedAt: string
  readonly manifest: AdapterManifest
  readonly files: Readonly<Record<string, string>>
}

const snapshotSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.string().max(40),
    approvedAt: z.iso.datetime(),
    manifest: z.unknown(),
    files: z.record(z.string().max(500), z.string()),
  })
  .strict()

const fileSchema = z
  .object({
    version: z.literal(1),
    adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), snapshotSchema),
  })
  .strict()

type SnapshotFile = z.infer<typeof fileSchema>

/**
 * What each adapter looked like when the person last approved it. Only used to show a diff: the
 * approval itself is ApprovalStore's, keyed by hash. An unreadable file shows the next review as a
 * first install (everything added), which over-reports rather than hides.
 */
export class SnapshotStore {
  private readonly document: JsonDocument<SnapshotFile>

  constructor(path: string) {
    this.document = new JsonDocument(path, fileSchema, () => ({ version: 1, adapters: {} }), true)
  }

  async get(adapterId: string): Promise<ApprovedSnapshot | null> {
    const file = await this.document.read()
    const entry = Object.hasOwn(file.adapters, adapterId) ? file.adapters[adapterId] : undefined
    if (entry === undefined) return null
    try {
      return { ...entry, manifest: parseManifest(entry.manifest) }
    } catch {
      return null
    }
  }

  async put(adapterId: string, adapter: BuiltinAdapter, approvedAt: string): Promise<void> {
    const manifest = adapter.definition.manifest
    await this.document.update((file) => {
      const adapters = { ...file.adapters }
      Object.defineProperty(adapters, adapterId, {
        value: { hash: adapter.hash, version: manifest.version, approvedAt, manifest, files: adapter.files },
        enumerable: true,
        writable: true,
        configurable: true,
      })
      return { version: 1, adapters }
    })
  }
}
