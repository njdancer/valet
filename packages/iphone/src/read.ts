// One pass over a plugged-in phone: what it is, its home screen, and the pictures a preview needs.
// And the one write: a whole layout, read back straight after.

import {
  type AttachedDevice,
  type DeviceDeps,
  type DeviceInfo,
  Lockdown,
  type RawIconState,
  SpringBoard,
} from './device'
import { DEFAULT_GRID, type Grid, parseIconState } from './layout'
import { isDict, type PlistValue } from './plist'

export interface PhoneRead {
  readonly device: DeviceInfo
  readonly grid: Grid
  readonly metrics: Record<string, PlistValue>
  readonly iconState: RawIconState
  /** PNG by bundle id, for every app the layout shows (widgets' apps included). */
  readonly icons: ReadonlyMap<string, Uint8Array>
  readonly wallpaper: Uint8Array | null
}

function num(value: PlistValue | undefined): number | null {
  if (typeof value === 'number') return value
  if (isDict(value)) return null
  if (value !== null && typeof value === 'object' && 'value' in value && typeof value.value === 'number')
    return value.value
  return null
}

export function gridFrom(metrics: Record<string, PlistValue>): Grid {
  const columns = num(metrics['homeScreenIconColumns'])
  const rows = num(metrics['homeScreenIconRows'])
  const dock = num(metrics['homeScreenIconDockMaxCount'])
  const fc = num(metrics['homeScreenIconFolderColumns'])
  const fr = num(metrics['homeScreenIconFolderRows'])
  const ok = (n: number | null, min: number, max: number) => n !== null && n >= min && n <= max
  return {
    columns: ok(columns, 3, 8) ? (columns as number) : DEFAULT_GRID.columns,
    rows: ok(rows, 3, 10) ? (rows as number) : DEFAULT_GRID.rows,
    dock: ok(dock, 2, 8) ? (dock as number) : DEFAULT_GRID.dock,
    folderColumns: ok(fc, 2, 6) ? (fc as number) : DEFAULT_GRID.folderColumns,
    folderRows: ok(fr, 2, 6) ? (fr as number) : DEFAULT_GRID.folderRows,
  }
}

async function session<T>(
  device: AttachedDevice,
  deps: DeviceDeps,
  run: (sb: SpringBoard, lockdown: Lockdown) => Promise<T>,
): Promise<T> {
  const lockdown = await Lockdown.open(device, deps)
  try {
    const sb = await SpringBoard.open(lockdown)
    try {
      return await run(sb, lockdown)
    } finally {
      sb.close()
    }
  } finally {
    lockdown.close()
  }
}

export interface ReadOptions extends DeviceDeps {
  /** Icons already saved: not fetched again. */
  readonly haveIcon?: (bundleId: string) => boolean
}

export async function readPhone(device: AttachedDevice, options: ReadOptions = {}): Promise<PhoneRead> {
  return session(device, options, async (sb, lockdown) => {
    const info = await lockdown.info()
    const metrics = await sb.iconMetrics().catch(() => ({}))
    const iconState = await sb.iconState()
    const { layout } = parseIconState(iconState)
    const bundles = new Set<string>()
    for (const i of layout.dock) if (i.kind === 'app') bundles.add(i.id)
    for (const p of layout.pages)
      for (const i of p.items) {
        if (i.kind === 'app') bundles.add(i.id)
        if (i.kind === 'widget') for (const a of i.apps) bundles.add(a)
        if (i.kind === 'folder')
          for (const fp of i.pages) for (const a of fp) if (a.kind === 'app') bundles.add(a.id)
      }
    const icons = new Map<string, Uint8Array>()
    for (const bundle of bundles) {
      if (options.haveIcon?.(bundle) === true) continue
      const png = await sb.iconPng(bundle).catch(() => null)
      if (png !== null) icons.set(bundle, png)
    }
    const wallpaper = await sb.wallpaperPng().catch(() => null)
    return { device: info, grid: gridFrom(metrics), metrics, iconState, icons, wallpaper }
  })
}

/** Writes the layout, waits for SpringBoard to settle, and returns what the phone has now. */
export async function writeLayout(
  device: AttachedDevice,
  state: RawIconState,
  options: DeviceDeps & { readonly settleMs?: number } = {},
): Promise<RawIconState> {
  return session(device, options, async (sb) => {
    sb.setIconState(state)
    await new Promise((r) => setTimeout(r, options.settleMs ?? 3000))
    return sb.iconState()
  })
}
