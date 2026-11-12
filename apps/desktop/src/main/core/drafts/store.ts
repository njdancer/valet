// Drafts on disk (docs/authoring-tools.md#storage): one folder per draft under <userData>/drafts,
// holding draft.json (the record) and files/ (the package, as the person sees it with Open draft
// folder). Folder names are ids Valet made, never anything an agent chose. Every read of the files
// goes through C's folder reader (lstat, no symlinks, nothing a package may not hold), into memory
// once; every write checks the path against C's package rules and the package's size limits
// first, refuses a symlink on the way, and lands atomically.

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readPackageFolder } from '@valet/adapter-store'
import { checkPackagePath, PACKAGE_LIMITS, PackageError, type PackageFiles, sha256Hex } from '@valet/core'
import { isErrno, writeFileAtomic } from '@valet/runtime'
import { z } from 'zod'
import { ensurePrivateDir, readJsonFile, writeJsonFile } from '../files'

export const DRAFT_ID = /^dr-[a-z2-7]{10}$/
export const DRAFT_LIMITS = { perClient: 10, total: 30 } as const

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const clientId = z.string().regex(/^(?:local|remote):[A-Za-z0-9_-]{1,64}$/)

export const DRAFT_STATUSES = ['editing', 'waiting', 'approved', 'declined', 'withdrawn', 'expired'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

const checkSummarySchema = z
  .object({
    packageHash: hash,
    at: z.iso.datetime(),
    ok: z.boolean(),
    /** Cases run and passed. */
    cases: z.number().int().min(0),
    passed: z.number().int().min(0),
    /** The first problem, in Valet's words. */
    problem: z.string().max(500).nullable(),
  })
  .strict()

/** One live trial (docs/authoring-tools.md#live-trials): what it ran against and how it ended. */
const trialSummarySchema = z
  .object({
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    packageHash: hash,
    at: z.iso.datetime(),
    /** Returned output that matches the tool's output schema. */
    ok: z.boolean(),
    /** How it ended otherwise, in Valet's words. */
    problem: z.string().max(200).nullable(),
  })
  .strict()

const submissionSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    ref: z.string().max(8),
    adapterHash: hash,
    packageHash: hash,
    previousHash: hash.nullable(),
    at: z.iso.datetime(),
    by: clientId,
    /** The staged version wasn't stored before this submit, so closing the request may drop it. */
    stagedNew: z.boolean().default(false),
    /** Set once the request is closed: the decline's note, for the agent only. */
    note: z.string().max(500).nullable().default(null),
  })
  .strict()

export const draftRecordSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(DRAFT_ID),
    adapterId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    createdBy: clientId,
    createdByName: z.string().max(100),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    status: z.enum(DRAFT_STATUSES),
    /** The installed version it started from (`from: 'installed'`), or null. */
    basedOn: hash.nullable(),
    repairId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .nullable(),
    lastCheck: checkSummarySchema.nullable(),
    /** Fixtures Valet recorded (PR 2): path → sha-256 of what it wrote. */
    recorded: z.record(z.string().max(200), hash).default({}),
    /** The latest live trials, newest last (PR 2b). */
    trials: z.array(trialSummarySchema).max(20).default([]),
    submission: submissionSchema.nullable(),
  })
  .strict()

export type DraftRecord = z.output<typeof draftRecordSchema>
export type CheckSummary = z.output<typeof checkSummarySchema>
export type Submission = z.output<typeof submissionSchema>
export type TrialSummary = z.output<typeof trialSummarySchema>

/** Why a draft operation was refused, in words for the agent. Never file contents. */
export class DraftError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'DraftError'
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function newDraftId(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  return `dr-${[...random(10)].map((b) => BASE32[b % 32]).join('')}`
}

export class DraftStore {
  /** One queue per draft, so two writes to one draft never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
    /** Called after each change to a draft (the Mac's Drafts section refreshes on it). Must not throw. */
    private readonly changed: () => void = () => {},
  ) {}

  folder(id: string): string {
    if (!DRAFT_ID.test(id)) throw new DraftError('No draft has that id.')
    return join(this.root, id)
  }

  filesFolder(id: string): string {
    return join(this.folder(id), 'files')
  }

  async list(): Promise<DraftRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    const out: DraftRecord[] = []
    for (const name of names.sort()) {
      if (!DRAFT_ID.test(name)) continue
      const record = await this.record(name).catch(() => null)
      if (record !== null) out.push(record)
    }
    return out
  }

  /** The record, or null if there is no such draft. Throws if it exists but doesn't parse. */
  async record(id: string): Promise<DraftRecord | null> {
    const record = await readJsonFile(join(this.folder(id), 'draft.json'), draftRecordSchema)
    if (record !== null && record.id !== id)
      throw new DraftError('The draft’s record doesn’t match its folder.')
    return record
  }

  async require(id: string): Promise<DraftRecord> {
    const record = await this.record(id).catch(() => null)
    if (record === null) throw new DraftError('No draft has that id. valet_list_drafts lists them.')
    return record
  }

  /** Creates a draft folder with `files`, checked against the package rules first. */
  async create(
    fields: Pick<DraftRecord, 'adapterId' | 'createdBy' | 'createdByName' | 'basedOn' | 'repairId'>,
    files: PackageFiles,
    id: string = newDraftId(),
  ): Promise<DraftRecord> {
    for (const path of Object.keys(files)) checkPath(path)
    checkSize(files)
    const at = this.now().toISOString()
    const record: DraftRecord = draftRecordSchema.parse({
      v: 1,
      id,
      ...fields,
      createdAt: at,
      updatedAt: at,
      status: 'editing',
      lastCheck: null,
      recorded: {},
      trials: [],
      submission: null,
    })
    await ensurePrivateDir(this.root)
    await mkdir(this.folder(id), { mode: 0o700 })
    await mkdir(this.filesFolder(id), { mode: 0o700 })
    for (const [path, text] of Object.entries(files)) await this.writeUnder(id, path, text)
    await writeJsonFile(join(this.folder(id), 'draft.json'), record)
    this.changed()
    return record
  }

  /** The draft's files, read once through C's folder reader. Throws DraftError. */
  async files(id: string): Promise<PackageFiles> {
    try {
      return await readPackageFolder(this.filesFolder(id))
    } catch (error) {
      if (error instanceof PackageError) {
        if (/symlink/.test(error.detail))
          throw new DraftError('The draft folder has a link in it; remove it first.')
        throw new DraftError(`The draft folder breaks a package rule (${error.rule}): ${error.detail}.`)
      }
      if (isErrno(error, 'ENOENT'))
        throw new DraftError('No draft has that id. valet_list_drafts lists them.')
      throw error
    }
  }

  /** Writes one file, after checking its path and that the package stays within its limits. */
  write(id: string, path: string, text: string): Promise<void> {
    return this.queued(id, async () => {
      checkPath(path)
      const current = await this.files(id)
      checkSize({ ...current, [path]: text })
      await this.writeUnder(id, path, text)
      await this.touch(id)
    })
  }

  remove(id: string, path: string): Promise<boolean> {
    return this.queued(id, async () => {
      checkPath(path)
      const target = await this.resolveUnder(id, path, false)
      try {
        await unlink(target)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return false
        throw error
      }
      await this.touch(id)
      return true
    })
  }

  /** Changes the record; `change` gets the current one. */
  update(id: string, change: (record: DraftRecord) => DraftRecord): Promise<DraftRecord> {
    return this.queued(id, async () => {
      const current = await this.require(id)
      const next = draftRecordSchema.parse({ ...change(current), id, updatedAt: this.now().toISOString() })
      await writeJsonFile(join(this.folder(id), 'draft.json'), next)
      return next
    })
  }

  delete(id: string): Promise<void> {
    return this.queued(id, async () => {
      await rm(this.folder(id), { recursive: true, force: true })
    })
  }

  private touch(id: string): Promise<unknown> {
    return (async () => {
      const current = await this.require(id)
      await writeJsonFile(join(this.folder(id), 'draft.json'), {
        ...current,
        updatedAt: this.now().toISOString(),
      })
    })()
  }

  private async writeUnder(id: string, path: string, text: string): Promise<void> {
    const target = await this.resolveUnder(id, path, true)
    await writeFileAtomic(target, text)
  }

  /**
   * The absolute path of `path` inside the draft's files folder, refusing any segment that is a
   * symlink or not a folder, so a link planted in the draft can't send a write elsewhere.
   */
  private async resolveUnder(id: string, path: string, create: boolean): Promise<string> {
    let dir = this.filesFolder(id)
    await this.assertPlainDir(dir)
    const segments = path.split('/')
    for (const segment of segments.slice(0, -1)) {
      dir = join(dir, segment)
      try {
        await this.assertPlainDir(dir)
      } catch (error) {
        if (!create || !isErrno(error, 'ENOENT')) throw error
        await mkdir(dir, { mode: 0o700 })
      }
    }
    const target = join(dir, segments.at(-1) ?? '')
    try {
      const info = await lstat(target)
      if (!info.isFile()) throw new DraftError('The draft folder has a link in it; remove it first.')
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    return target
  }

  private async assertPlainDir(dir: string): Promise<void> {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new DraftError('The draft folder has a link in it; remove it first.')
  }

  private queued<T>(id: string, run: () => Promise<T>): Promise<T> {
    const before = this.queues.get(id) ?? Promise.resolve()
    const next = before
      .catch(() => undefined)
      .then(run)
      .then((value) => {
        this.changed()
        return value
      })
    const settled = next.catch(() => undefined)
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return next
  }
}

function checkPath(path: string): void {
  try {
    checkPackagePath(path)
  } catch (error) {
    if (error instanceof PackageError)
      throw new DraftError(
        error.rule === 'placement'
          ? `Not written: ${error.detail} isn’t a place a package may hold that file. src/ holds .ts, test/ .ts and .json, fixtures/ .json, .html and .txt; manifest.json and README.md sit at the top.`
          : `Not written: ${error.detail} isn’t a package path. Use lowercase letters, digits, dots, dashes and underscores, separated by /.`,
      )
    throw error
  }
}

function checkSize(files: PackageFiles): void {
  const paths = Object.keys(files)
  if (paths.length > PACKAGE_LIMITS.files)
    throw new DraftError(`Not written: the draft would be over ${PACKAGE_LIMITS.files} files.`)
  let total = 0
  for (const text of Object.values(files)) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > PACKAGE_LIMITS.fileBytes) throw new DraftError('Not written: one file would be over 1 MiB.')
    total += bytes
  }
  if (total > PACKAGE_LIMITS.totalBytes) throw new DraftError('Not written: the draft would be over 8 MiB.')
}

/** Short hash of a file for listings. */
export function fileDigest(text: string): string {
  return sha256Hex(text).slice(0, 12)
}
