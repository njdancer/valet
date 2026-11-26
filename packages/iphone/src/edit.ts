// Changes an agent proposes to a home screen layout. Every change only moves what is already there:
// nothing is added from the App Library or taken off the home screen (iOS would put a removed app
// back on a page of its own). Pages and positions are counted from 1, as people say them.

import { z } from 'zod'
import {
  allIds,
  DEFAULT_GRID,
  type FolderItem,
  type Grid,
  type IconItem,
  type Item,
  type Layout,
  place,
} from './layout'

const id = z.string().min(1).max(300)
const pageNo = z.number().int().min(1).max(50)
const position = z.number().int().min(1).max(200).optional().describe('From 1; the end when left out.')

const target = z.discriminatedUnion('where', [
  z.object({ where: z.literal('page'), page: pageNo, position }).strict(),
  z.object({ where: z.literal('dock'), position }).strict(),
  z
    .object({
      where: z.literal('folder'),
      folder: id,
      folderPage: pageNo.optional().describe('The folder’s own page, from 1; its last when left out.'),
      position,
    })
    .strict(),
])

export const editOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), item: id, to: target }).strict(),
  z
    .object({
      op: z.literal('setPage'),
      page: pageNo.describe('One past the last page adds a page.'),
      items: z
        .array(id)
        .max(60)
        .describe('The page’s items in order; each is taken from wherever it is now.'),
    })
    .strict(),
  z.object({ op: z.literal('setDock'), items: z.array(id).max(6) }).strict(),
  z
    .object({
      op: z.literal('createFolder'),
      name: z.string().min(1).max(60),
      items: z.array(id).min(1).max(200),
      page: pageNo,
      position,
    })
    .strict(),
  z.object({ op: z.literal('renameFolder'), folder: id, name: z.string().min(1).max(60) }).strict(),
  z
    .object({
      op: z.literal('emptyFolder'),
      folder: id,
      page: pageNo.describe('Where its apps go; the folder itself goes away.'),
      position,
    })
    .strict(),
  z
    .object({ op: z.literal('addPage'), page: pageNo.optional().describe('Where the new empty page goes.') })
    .strict(),
  z.object({ op: z.literal('movePage'), from: pageNo, to: pageNo }).strict(),
])
export type EditOp = z.infer<typeof editOp>

export class EditError extends Error {}

interface MutableFolder {
  kind: 'folder'
  id: string
  name: string
  pages: IconItem[][]
}
type MutableItem = Exclude<Item, FolderItem> | MutableFolder
interface Mutable {
  dock: IconItem[]
  pages: MutableItem[][]
}

function thaw(layout: Layout): Mutable {
  return {
    dock: [...layout.dock],
    pages: layout.pages.map((p) =>
      p.items.map((i) => (i.kind === 'folder' ? { ...i, pages: i.pages.map((fp) => [...fp]) } : i)),
    ),
  }
}

function freeze(m: Mutable): Layout {
  return {
    dock: m.dock,
    pages: m.pages.map((items) => ({ items: items as Item[] })),
  }
}

function insertAt<T>(list: T[], value: T, position: number | undefined): void {
  const at = position === undefined ? list.length : Math.min(Math.max(position - 1, 0), list.length)
  list.splice(at, 0, value)
}

/** Takes the item out from wherever it is; folders left empty go away. */
function take(m: Mutable, itemId: string): MutableItem {
  const at = m.dock.findIndex((i) => i.id === itemId)
  if (at >= 0) return m.dock.splice(at, 1)[0] as MutableItem
  for (const page of m.pages) {
    const p = page.findIndex((i) => i.id === itemId)
    if (p >= 0) return page.splice(p, 1)[0] as MutableItem
    for (const folder of page) {
      if (folder.kind !== 'folder') continue
      for (const fp of folder.pages) {
        const f = fp.findIndex((i) => i.id === itemId)
        if (f >= 0) {
          const [found] = fp.splice(f, 1)
          folder.pages = folder.pages.filter((x) => x.length > 0)
          if (folder.pages.length === 0) page.splice(page.indexOf(folder), 1)
          return found as MutableItem
        }
      }
    }
  }
  throw new EditError(`There is no ${itemId} on the home screen.`)
}

function folderById(m: Mutable, folderId: string): MutableFolder {
  for (const page of m.pages) for (const i of page) if (i.kind === 'folder' && i.id === folderId) return i
  throw new EditError(`There is no folder ${folderId}.`)
}

function page(m: Mutable, n: number, create = false): MutableItem[] {
  if (create && n === m.pages.length + 1) m.pages.push([])
  const found = m.pages[n - 1]
  if (found === undefined) throw new EditError(`There is no page ${n}; there are ${m.pages.length}.`)
  return found
}

function asIcon(item: MutableItem, where: string): IconItem {
  if (item.kind === 'folder' || item.kind === 'widget')
    throw new EditError(`A ${item.kind} can’t go in ${where}: only apps can.`)
  return item
}

function apply(m: Mutable, op: EditOp, grid: Grid, nextFolderId: () => string): void {
  switch (op.op) {
    case 'move': {
      const to = op.to
      // Check the target before taking the item, so a bad target changes nothing.
      if (to.where === 'page') page(m, to.page, true)
      if (to.where === 'folder') folderById(m, to.folder)
      const item = take(m, op.item)
      if (to.where === 'page') insertAt(page(m, to.page, true), item, to.position)
      else if (to.where === 'dock') insertAt(m.dock, asIcon(item, 'the dock'), to.position)
      else {
        const folder = folderById(m, to.folder)
        const icon = asIcon(item, 'a folder')
        const n = to.folderPage ?? folder.pages.length
        if (n === folder.pages.length + 1 || folder.pages.length === 0) folder.pages.push([])
        const fp = folder.pages[Math.min(n, folder.pages.length) - 1] as IconItem[]
        insertAt(fp, icon, to.position)
      }
      return
    }
    case 'setPage': {
      page(m, op.page, true)
      const items = op.items.map((i) => take(m, i))
      const target = page(m, op.page)
      const rest = target.splice(0, target.length)
      target.push(...items)
      if (rest.length > 0)
        throw new EditError(
          `Page ${op.page} still had ${rest.map((r) => r.id).join(', ')}: list every item it keeps, or move them first.`,
        )
      return
    }
    case 'setDock': {
      const items = op.items.map((i) => asIcon(take(m, i), 'the dock'))
      if (m.dock.length > 0)
        throw new EditError(`The dock still had ${m.dock.map((r) => r.id).join(', ')}: move them first.`)
      m.dock.push(...items)
      return
    }
    case 'createFolder': {
      page(m, op.page, true)
      const icons = op.items.map((i) => asIcon(take(m, i), 'a folder'))
      const per = grid.folderColumns * grid.folderRows
      const pages: IconItem[][] = []
      for (let k = 0; k < icons.length; k += per) pages.push(icons.slice(k, k + per))
      insertAt(
        page(m, op.page, true),
        { kind: 'folder', id: nextFolderId(), name: op.name, pages },
        op.position,
      )
      return
    }
    case 'renameFolder':
      folderById(m, op.folder).name = op.name
      return
    case 'emptyFolder': {
      const folder = folderById(m, op.folder)
      const target = page(m, op.page, true)
      const icons = folder.pages.flat()
      for (const p of m.pages) {
        const at = p.indexOf(folder)
        if (at >= 0) p.splice(at, 1)
      }
      let at = op.position
      for (const icon of icons) {
        insertAt(target, icon, at)
        if (at !== undefined) at++
      }
      return
    }
    case 'addPage': {
      const at = op.page === undefined ? m.pages.length : Math.min(op.page - 1, m.pages.length)
      m.pages.splice(at, 0, [])
      return
    }
    case 'movePage': {
      const moved = m.pages.splice(op.from - 1, 1)
      if (moved.length === 0) throw new EditError(`There is no page ${op.from}.`)
      m.pages.splice(Math.min(op.to - 1, m.pages.length), 0, moved[0] as MutableItem[])
      return
    }
  }
}

export interface Problem {
  readonly where: string
  readonly problem: string
}

/** What stops a layout from going on the phone as it is. Empty: it fits. */
export function problems(layout: Layout, grid: Grid = DEFAULT_GRID): Problem[] {
  const out: Problem[] = []
  if (layout.dock.length > grid.dock)
    out.push({ where: 'dock', problem: `The dock holds ${grid.dock}; it has ${layout.dock.length}.` })
  const per = grid.folderColumns * grid.folderRows
  layout.pages.forEach((p, n) => {
    const { overflow } = place(p.items, grid)
    if (overflow.length > 0)
      out.push({
        where: `page ${n + 1}`,
        problem: `Doesn’t fit on one page (${grid.columns}×${grid.rows}): ${overflow.map((i) => i.id).join(', ')} left over.`,
      })
    for (const item of p.items)
      if (item.kind === 'folder')
        item.pages.forEach((fp, k) => {
          if (fp.length > per)
            out.push({
              where: `${item.id} page ${k + 1}`,
              problem: `A folder page holds ${per}; it has ${fp.length}.`,
            })
        })
  })
  return out
}

/**
 * Applies the changes in order, all or none. Throws EditError when one can't be made. Checks that
 * nothing went missing or got doubled.
 */
export function applyEdits(
  layout: Layout,
  ops: readonly EditOp[],
  options: { grid?: Grid; nextFolderId: () => string },
): Layout {
  const grid = options.grid ?? DEFAULT_GRID
  const m = thaw(layout)
  ops.forEach((op, n) => {
    try {
      apply(m, op, grid, options.nextFolderId)
    } catch (error) {
      if (error instanceof EditError) throw new EditError(`Change ${n + 1} (${op.op}): ${error.message}`)
      throw error
    }
  })
  const result = freeze(m)
  const before = allIds(layout)
    .filter((i) => !i.startsWith('folder:'))
    .sort()
  const after = allIds(result)
    .filter((i) => !i.startsWith('folder:'))
    .sort()
  if (before.join('\n') !== after.join('\n'))
    throw new EditError('Those changes would lose or double an item.')
  return result
}

/** Empty pages and empty folders go: iOS drops them anyway. */
export function tidy(layout: Layout): Layout {
  return {
    dock: layout.dock,
    pages: layout.pages
      .map((p) => ({
        items: p.items.flatMap((i): Item[] => {
          if (i.kind !== 'folder') return [i]
          const pages = i.pages.filter((fp) => fp.length > 0)
          return pages.length > 0 ? [{ ...i, pages }] : []
        }),
      }))
      .filter((p) => p.items.length > 0),
  }
}

// ---------- Differences, in words ----------

interface Where {
  readonly text: string
  readonly key: string
}

function locations(layout: Layout): Map<string, Where> {
  const out = new Map<string, Where>()
  layout.dock.forEach((i, k) => {
    out.set(i.id, { text: `dock ${k + 1}`, key: `dock:${k}` })
  })
  layout.pages.forEach((p, n) => {
    p.items.forEach((i, k) => {
      out.set(i.id, { text: `page ${n + 1} position ${k + 1}`, key: `p${n}:${k}` })
      if (i.kind !== 'folder') return
      i.pages.forEach((fp, f) => {
        fp.forEach((a, j) => {
          out.set(a.id, { text: `folder “${i.name}” (page ${n + 1})`, key: `${i.id}:${f}:${j}` })
        })
      })
    })
  })
  return out
}

function names(layout: Layout): Map<string, string> {
  const out = new Map<string, string>()
  for (const i of layout.dock) out.set(i.id, i.name)
  for (const p of layout.pages)
    for (const i of p.items) {
      out.set(i.id, i.name)
      if (i.kind === 'folder') for (const fp of i.pages) for (const a of fp) out.set(a.id, a.name)
    }
  return out
}

/** Short lines saying where things moved, for a person to read or hear. */
export function describeChanges(before: Layout, after: Layout, limit = 80): string[] {
  const a = locations(before)
  const b = locations(after)
  const label = names(after)
  const lines: string[] = []
  const folderNames = new Map<string, string>()
  for (const p of before.pages)
    for (const i of p.items) if (i.kind === 'folder') folderNames.set(i.id, i.name)
  for (const p of after.pages)
    for (const i of p.items)
      if (i.kind === 'folder') {
        const old = folderNames.get(i.id)
        if (old === undefined) lines.push(`New folder “${i.name}” on ${b.get(i.id)?.text ?? 'a page'}.`)
        else if (old !== i.name) lines.push(`Folder “${old}” renamed “${i.name}”.`)
      }
  for (const [id, name] of folderNames) if (!b.has(id)) lines.push(`Folder “${name}” removed.`)
  for (const [id, where] of b) {
    if (id.startsWith('folder:')) continue
    const was = a.get(id)
    if (was === undefined || was.text === where.text) continue
    // Moving within a page only by others shifting doesn't count as a move.
    const samePage = was.text.split(' position')[0] === where.text.split(' position')[0]
    if (samePage && was.text.startsWith('page')) continue
    lines.push(`${label.get(id) ?? id}: ${was.text} → ${where.text}.`)
  }
  const oldNames = names(before)
  for (const [id, was] of a)
    if (!id.startsWith('folder:') && !b.has(id)) lines.push(`${oldNames.get(id) ?? id}: ${was.text} → gone.`)
  for (const id of b.keys())
    if (!id.startsWith('folder:') && !a.has(id)) lines.push(`${label.get(id) ?? id}: new on the home screen.`)
  if (before.pages.length !== after.pages.length)
    lines.push(`Pages: ${before.pages.length} → ${after.pages.length}.`)
  return lines.length > limit ? [...lines.slice(0, limit), `…and ${lines.length - limit} more.`] : lines
}
