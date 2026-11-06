// Where the app's small windows go. Pure, so the arithmetic is tested without a screen.

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The tray popover: centred under the menu-bar icon, kept inside the screen's work area. */
export function underTrayIcon(icon: Rect, size: { width: number; height: number }, workArea: Rect): Rect {
  const x = clamp(
    Math.round(icon.x + icon.width / 2 - size.width / 2),
    workArea.x,
    workArea.x + workArea.width - size.width,
  )
  const y = clamp(
    Math.round(icon.y + icon.height + 4),
    workArea.y,
    workArea.y + workArea.height - size.height,
  )
  return { x, y, width: size.width, height: size.height }
}

/** The confirmation panel: top right of the work area, clear of the menu bar, like a notification. */
export function topRight(size: { width: number; height: number }, workArea: Rect, margin = 16): Rect {
  return {
    x: workArea.x + workArea.width - size.width - margin,
    y: workArea.y + margin,
    width: size.width,
    height: size.height,
  }
}

/**
 * The hand-off banner: as wide as the auth window, directly above it; if there's no room above,
 * along the top of the work area (over the auth window's top edge rather than off screen).
 */
export function aboveWindow(target: Rect | null, height: number, workArea: Rect): Rect {
  if (target === null) {
    const width = Math.min(760, workArea.width)
    return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y, width, height }
  }
  const width = Math.min(target.width, workArea.width)
  const x = clamp(target.x, workArea.x, workArea.x + workArea.width - width)
  // Above it when there's room, else along the top of the work area.
  const y = Math.max(target.y - height, workArea.y)
  return { x, y, width, height }
}
