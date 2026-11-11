import { type RefObject, useLayoutEffect, useState } from 'react'

/**
 * Where a sliding indicator (tab underline, segmented pill) should sit: the offset box of the
 * child matching `selector`. Re-measured when the selection changes, when the container resizes,
 * and once web fonts finish loading, so the indicator never sits under the wrong width.
 */
export function useIndicator(root: RefObject<HTMLElement | null>, selector: string) {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const update = () => {
      const active = el.querySelector<HTMLElement>(selector)
      setBox((prev) => {
        if (!active) return null
        const next = { left: active.offsetLeft, width: active.offsetWidth }
        return prev && prev.left === next.left && prev.width === next.width ? prev : next
      })
    }
    update()
    const mutations = new MutationObserver(update)
    mutations.observe(el, {
      attributes: true,
      subtree: true,
      childList: true,
      attributeFilter: ['data-state'],
    })
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    sizes?.observe(el)
    let live = true
    document.fonts?.ready.then(() => live && update())
    return () => {
      live = false
      mutations.disconnect()
      sizes?.disconnect()
    }
  }, [root, selector])
  return box
}
