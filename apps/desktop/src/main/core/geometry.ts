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

/** Where the hand-off banner and the adapter's auth window go together. */
export interface HandoffLayout {
  readonly banner: Rect
  /** New bounds for the auth window, or null to leave it where it is. */
  readonly window: Rect | null
}

/** The smallest the auth window is made to give the banner room; below that it isn't shrunk. */
export const MIN_AUTH_WINDOW_HEIGHT = 420

/**
 * The hand-off banner: as wide as the auth window and never over it, since it is frameless and on
 * top and would hide the window's title bar and the top of the login page. Directly above the
 * window when there's room. When there isn't (the usual case for a tall auth window), the window is
 * moved down by the banner's height, and shortened if it would then run off the bottom, but never
 * below MIN_AUTH_WINDOW_HEIGHT. On a screen too small even for that, the window stays and the banner
 * goes wherever bannerBeside puts it.
 */
export function handoffLayout(target: Rect | null, height: number, workArea: Rect): HandoffLayout {
  if (target === null) {
    const width = Math.min(760, workArea.width)
    return {
      banner: { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y, width, height },
      window: null,
    }
  }
  if (target.y - height >= workArea.y) return { banner: bannerBeside(target, height, workArea), window: null }
  const top = workArea.y + height
  const room = workArea.y + workArea.height - top
  const windowHeight = Math.min(target.height, room)
  if (windowHeight < Math.min(MIN_AUTH_WINDOW_HEIGHT, target.height)) {
    return { banner: bannerBeside(target, height, workArea), window: null }
  }
  const moved = { x: target.x, y: top, width: target.width, height: windowHeight }
  return { banner: bannerBeside(moved, height, workArea), window: moved }
}

/**
 * The banner for a window where it is now, without moving the window (as it is dragged or
 * resized): directly above it if there's room, else directly below it, else along the bottom of the
 * work area, where it covers the least of the page and none of the title bar.
 */
export function bannerBeside(target: Rect, height: number, workArea: Rect): Rect {
  const width = Math.min(target.width, workArea.width)
  const x = clamp(target.x, workArea.x, workArea.x + workArea.width - width)
  const bottom = workArea.y + workArea.height
  if (target.y - height >= workArea.y) return { x, y: target.y - height, width, height }
  if (target.y + target.height + height <= bottom) return { x, y: target.y + target.height, width, height }
  return { x, y: bottom - height, width, height }
}
