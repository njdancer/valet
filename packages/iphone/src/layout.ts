// The home screen as agents see and change it: pages of apps, folders and widgets, and the dock.
// It is made from SpringBoard's raw layout and turned back into one for writing. Each item keeps its
// raw entry, so anything Valet doesn't understand (a widget's settings, say) goes back unchanged.

import type { RawIconState } from './device'
import { isDict, type PlistValue } from './plist'

export const WIDGET_SIZES = ['small', 'medium', 'large', 'extraLarge'] as const
export type WidgetSize = (typeof WIDGET_SIZES)[number]

export interface AppItem {
  readonly kind: 'app'
  /** The app's bundle id: its id everywhere in Valet. */
  readonly id: string
  readonly name: string
}

export interface WebClipItem {
  readonly kind: 'webclip'
  readonly id: string
  readonly name: string
}

export interface WidgetItem {
  readonly kind: 'widget'
  readonly id: string
  readonly name: string
  readonly size: WidgetSize
  /** Apps the widget (or each widget of a stack) belongs to. */
  readonly apps: readonly string[]
  /** A Smart Stack or a stack of several widgets. */
  readonly stack: boolean
  /** Each widget's kind, as the phone names it, when it says. */
  readonly kinds: readonly string[]
}

export interface FolderItem {
  readonly kind: 'folder'
  readonly id: string
  readonly name: string
  /** The folder's own pages, nine apps to a page on iPhone. */
  readonly pages: readonly (readonly IconItem[])[]
}

export interface OtherItem {
  readonly kind: 'other'
  readonly id: string
  readonly name: string
}

/** What a folder can hold. */
export type IconItem = AppItem | WebClipItem | OtherItem
export type Item = IconItem | WidgetItem | FolderItem

export interface Page {
  readonly items: readonly Item[]
}

export interface Layout {
  readonly dock: readonly IconItem[]
  readonly pages: readonly Page[]
}

export interface Grid {
  readonly columns: number
  readonly rows: number
  readonly dock: number
  readonly folderColumns: number
  readonly folderRows: number
}

/** iPhone 13 Pro and most iPhones since the X. */
export const DEFAULT_GRID: Grid = { columns: 4, rows: 6, dock: 4, folderColumns: 3, folderRows: 3 }

/** Grid cells a widget covers, as [columns, rows]. */
export function widgetSpan(size: WidgetSize, grid: Grid = DEFAULT_GRID): [number, number] {
  if (size === 'small') return [2, 2]
  if (size === 'medium') return [Math.min(4, grid.columns), 2]
  return [Math.min(4, grid.columns), 4]
}

// ---------- From raw ----------

/** The parsed layout, and each item's raw entry by id. */
export interface Parsed {
  readonly layout: Layout
  readonly raw: ReadonlyMap<string, Record<string, PlistValue>>
}

function str(value: PlistValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function isWidget(entry: Record<string, PlistValue>): boolean {
  return (
    entry['gridSize'] !== undefined ||
    entry['elements'] !== undefined ||
    entry['iconType'] === 'custom' ||
    entry['elementType'] === 'widget' ||
    entry['widgetIdentifier'] !== undefined
  )
}

function size(value: PlistValue | undefined): WidgetSize {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (text.includes('extra')) return 'extraLarge'
  if (text.includes('large')) return 'large'
  if (text.includes('medium')) return 'medium'
  return 'small'
}

/** Every string under a key whose name says it is a bundle id. */
function bundleIds(value: PlistValue | undefined, out: Set<string>, depth = 0): void {
  if (depth > 6 || value === undefined) return
  if (Array.isArray(value)) for (const v of value) bundleIds(v, out, depth + 1)
  else if (isDict(value))
    for (const [key, v] of Object.entries(value)) {
      if (
        /containerBundleIdentifier|^bundleIdentifier$|appBundleIdentifier/i.test(key) &&
        typeof v === 'string'
      )
        out.add(v)
      else bundleIds(v, out, depth + 1)
    }
}

function kinds(value: PlistValue | undefined, out: string[], depth = 0): void {
  if (depth > 6 || value === undefined) return
  if (Array.isArray(value)) for (const v of value) kinds(v, out, depth + 1)
  else if (isDict(value))
    for (const [key, v] of Object.entries(value)) {
      if (/^(kind|widgetKind)$/i.test(key) && typeof v === 'string') out.push(v)
      else kinds(v, out, depth + 1)
    }
}

export function parseIconState(state: RawIconState): Parsed {
  const raw = new Map<string, Record<string, PlistValue>>()
  let folders = 0
  let widgets = 0
  let others = 0
  const seen = new Set<string>()
  const unique = (base: string): string => {
    let id = base
    for (let n = 2; seen.has(id); n++) id = `${base}#${n}`
    seen.add(id)
    return id
  }
  const icon = (entry: Record<string, PlistValue>): IconItem => {
    const bundle = str(entry['bundleIdentifier']) ?? str(entry['displayIdentifier'])
    const name = str(entry['displayName']) ?? bundle ?? 'Unknown'
    let item: IconItem
    if (bundle !== null && (entry['webClipURL'] !== undefined || bundle.startsWith('com.apple.webapp')))
      item = { kind: 'webclip', id: unique(`webclip:${bundle}`), name }
    else if (bundle !== null) item = { kind: 'app', id: unique(bundle), name }
    else item = { kind: 'other', id: unique(`other:${++others}`), name }
    raw.set(item.id, entry)
    return item
  }
  const item = (value: PlistValue): Item | null => {
    if (!isDict(value)) return null
    if (Array.isArray(value['iconLists'])) {
      const id = unique(`folder:${++folders}`)
      raw.set(id, value)
      const pages = (value['iconLists'] as PlistValue[]).map((list) =>
        (Array.isArray(list) ? list : []).flatMap((e) =>
          isDict(e) && !Array.isArray(e['iconLists']) ? [icon(e)] : [],
        ),
      )
      return { kind: 'folder', id, name: str(value['displayName']) ?? 'Folder', pages }
    }
    if (isWidget(value)) {
      const id = unique(`widget:${++widgets}`)
      raw.set(id, value)
      const apps = new Set<string>()
      bundleIds(value, apps)
      const k: string[] = []
      kinds(value, k)
      const elements = Array.isArray(value['elements']) ? value['elements'].length : 1
      const firstApp = [...apps][0]
      return {
        kind: 'widget',
        id,
        name: str(value['displayName']) ?? (elements > 1 ? 'Widget stack' : (firstApp ?? 'Widget')),
        size: size(value['gridSize']),
        apps: [...apps],
        stack: elements > 1 || value['allowsSuggestions'] !== undefined,
        kinds: [...new Set(k)],
      }
    }
    return icon(value)
  }
  const lists = state.map((list) => (Array.isArray(list) ? list : []))
  const dock = (lists[0] ?? []).flatMap((v) => {
    const i = item(v)
    return i !== null && i.kind !== 'folder' && i.kind !== 'widget' ? [i] : []
  })
  const pages = lists.slice(1).map((list) => ({ items: list.flatMap((v) => item(v) ?? []) }))
  return { layout: { dock, pages }, raw }
}

// ---------- Back to raw ----------

/** The raw layout for `layout`, from the snapshot's raw entries. Throws on an id it doesn't know. */
export function buildIconState(
  layout: Layout,
  raw: ReadonlyMap<string, Record<string, PlistValue>>,
): PlistValue[] {
  const entry = (id: string): Record<string, PlistValue> => {
    const found = raw.get(id)
    if (found === undefined) throw new Error(`Unknown item ${id}.`)
    return found
  }
  const icon = (i: IconItem): PlistValue => entry(i.id)
  const item = (i: Item): PlistValue => {
    if (i.kind === 'folder') {
      const base = raw.get(i.id) ?? { listType: 'folder' }
      return {
        ...base,
        displayName: i.name,
        iconLists: i.pages.filter((p) => p.length > 0).map((p) => p.map(icon)),
      }
    }
    return entry(i.id)
  }
  return [
    layout.dock.map(icon),
    ...layout.pages.filter((p) => p.items.length > 0).map((p) => p.items.map(item)),
  ]
}

// ---------- Placement (for previews and fit checks) ----------

export interface Placed {
  readonly item: Item
  readonly column: number
  readonly row: number
  readonly columns: number
  readonly rows: number
}

/**
 * Where iOS puts each item: in order, each in the first free place from the top left that fits,
 * widgets on even columns. Items that don't fit are left out of `placed` and listed in `overflow`.
 */
export function place(
  items: readonly Item[],
  grid: Grid = DEFAULT_GRID,
): { placed: Placed[]; overflow: Item[] } {
  const used: boolean[][] = Array.from({ length: grid.rows }, () => Array(grid.columns).fill(false))
  const placed: Placed[] = []
  const overflow: Item[] = []
  const fits = (c: number, r: number, w: number, h: number) => {
    if (c + w > grid.columns || r + h > grid.rows) return false
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (used[y]?.[x]) return false
    return true
  }
  for (const item of items) {
    const [w, h] = item.kind === 'widget' ? widgetSpan(item.size, grid) : [1, 1]
    let done = false
    for (let r = 0; r < grid.rows && !done; r++)
      for (let c = 0; c < grid.columns && !done; c++) {
        if (item.kind === 'widget' && c % 2 !== 0) continue
        if (!fits(c, r, w, h)) continue
        for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) (used[y] as boolean[])[x] = true
        placed.push({ item, column: c, row: r, columns: w, rows: h })
        done = true
      }
    if (!done) overflow.push(item)
  }
  return { placed, overflow }
}

// ---------- Lookups ----------

/** Every id in the layout, folders' contents included. */
export function allIds(layout: Layout): string[] {
  const ids: string[] = layout.dock.map((i) => i.id)
  for (const page of layout.pages)
    for (const item of page.items) {
      ids.push(item.id)
      if (item.kind === 'folder') for (const p of item.pages) for (const i of p) ids.push(i.id)
    }
  return ids
}
