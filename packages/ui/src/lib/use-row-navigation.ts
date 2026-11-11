import { type KeyboardEvent, useCallback, useEffect, useRef } from 'react'
import { copyText } from '../components/copy-button'
import { ariaShortcut, currentPlatform } from './shortcut'

export type RowNavigation = {
  /** Called with the row's index and element when Return is pressed on a row with no main action. */
  onOpen?: (index: number, row: HTMLElement) => void
  /** Called after mod+C copied the row's `data-copy-value`. */
  onCopy?: (value: string, index: number) => void
  /** Delete or Backspace on a row. Leave it off and those keys do nothing. */
  onDismiss?: (index: number, row: HTMLElement) => void
  /** The focused row changed: for a table whose selection follows focus. */
  onActiveChange?: (index: number, row: HTMLElement) => void
  /** Focus the first row when the list mounts (Needs you, the tray). */
  autoFocus?: boolean
  /** Which descendants are rows. */
  rowSelector?: string
  /** Only rows with a `[data-row-link]` or `data-focusable` take part (table rows that open nothing). */
  linkedOnly?: boolean
}

const typing = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

/**
 * Roving row focus for Calls, Needs you and Audit. Up and Down move a row, Home and End to the ends;
 * Return opens the row (follows its RowLink, or clicks its `[data-row-action]` button, or calls
 * `onOpen`); Tab goes into the row's buttons; mod+C copies the row's `data-copy-value` when no text
 * is selected; Delete dismisses (`onDismiss`). Only one row is a Tab stop, so a long list is one
 * stop, not fifty.
 *
 * A row's focus target is its `[data-row-link]` if it has one, else the row itself. Rows without a
 * link are made focusable here (tabindex 0 for the active one, -1 for the rest).
 */
export function useRowNavigation<T extends HTMLElement = HTMLElement>({
  onOpen,
  onCopy,
  onDismiss,
  onActiveChange,
  autoFocus = false,
  rowSelector = '[data-row]',
  linkedOnly = false,
}: RowNavigation = {}) {
  const ref = useRef<T>(null)
  const active = useRef(0)

  const rows = useCallback(
    () =>
      ref.current
        ? [...ref.current.querySelectorAll<HTMLElement>(rowSelector)].filter(
            (row) =>
              !linkedOnly || row.hasAttribute('data-focusable') || row.querySelector('[data-row-link]'),
          )
        : [],
    [rowSelector, linkedOnly],
  )
  const target = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-row-link]') ?? row

  // Keep exactly one row in the Tab order. Runs after every render, since rows come and go.
  useEffect(() => {
    const all = rows()
    if (all.length === 0) return
    active.current = Math.min(active.current, all.length - 1)
    all.forEach((row, i) => {
      if (row.querySelector('[data-row-link]')) return
      row.tabIndex = i === active.current ? 0 : -1
    })
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, on mount
  useEffect(() => {
    if (!autoFocus) return
    const first = rows()[0]
    if (first) target(first).focus()
  }, [])

  const rowOf = (el: EventTarget | null) => {
    const all = rows()
    const i = all.findIndex((row) => row.contains(el as Node))
    return { all, i, row: all[i] }
  }

  const focusRow = (all: HTMLElement[], i: number) => {
    const row = all[i]
    if (!row) return
    const t = target(row)
    if (!row.querySelector('[data-row-link]')) {
      for (const r of all) if (!r.querySelector('[data-row-link]')) r.tabIndex = -1
      row.tabIndex = 0
    }
    t.focus()
    t.scrollIntoView?.({ block: 'nearest' })
  }

  const onFocus = (e: { target: EventTarget | null }) => {
    const { i, row } = rowOf(e.target)
    if (i === -1 || !row || i === active.current) return
    active.current = i
    onActiveChange?.(i, row)
  }

  const onKeyDown = (e: KeyboardEvent<T>) => {
    if (e.defaultPrevented || typing(e.target as Element)) return
    const { all, i, row } = rowOf(e.target)
    if (i === -1 || !row) return
    const onTarget = e.target === target(row)
    const mod = currentPlatform() === 'mac' ? e.metaKey : e.ctrlKey
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && !mod && !e.altKey) {
      e.preventDefault()
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? all.length - 1
            : e.key === 'ArrowDown'
              ? Math.min(all.length - 1, i + 1)
              : Math.max(0, i - 1)
      focusRow(all, next)
      return
    }
    if (!onTarget) return
    if (e.key === 'Enter' && target(row) === row) {
      const action = row.querySelector<HTMLElement>(
        '[data-row-action] button:not(:disabled), [data-row-action] a',
      )
      e.preventDefault()
      if (action) action.click()
      else onOpen?.(i, row)
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && onDismiss) {
      e.preventDefault()
      onDismiss(i, row)
      return
    }
    if (mod && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      const value = row.dataset['copyValue']
      if (value === undefined) return
      e.preventDefault()
      void copyText(value).then((ok) => {
        if (ok) onCopy?.(value, i)
      })
    }
  }

  const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']
  if (onDismiss) keys.push('Delete')
  keys.push(ariaShortcut('mod+C') ?? 'Control+C')
  return { ref, onKeyDown, onFocus, 'aria-keyshortcuts': keys.join(' ') }
}
