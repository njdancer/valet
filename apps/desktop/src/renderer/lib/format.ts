// Formatting for times, durations and hashes, in the macOS style the mockups use ("9:47 pm").

const timeFormat = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true })
const secondsFormat = new Intl.DateTimeFormat('en-AU', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
})
const weekdayFormat = new Intl.DateTimeFormat('en-AU', { weekday: 'short' })
const dayFormat = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' })

const DAY_MS = 86_400_000

function valid(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "9:47 pm" today, "Thu 6:20 pm" this week, otherwise "2 Nov". */
export function formatTime(iso: string | null, now: number): string {
  if (iso === null) return '—'
  const date = valid(iso)
  if (date === null) return '—'
  const today = new Date(now)
  if (sameDay(date, today)) return timeFormat.format(date)
  if (now - date.getTime() < 6 * DAY_MS && date.getTime() <= now) {
    return `${weekdayFormat.format(date)} ${timeFormat.format(date)}`
  }
  return dayFormat.format(date)
}

/** Like formatTime with seconds, for the audit log. */
export function formatSeconds(iso: string, now: number): string {
  const date = valid(iso)
  if (date === null) return '—'
  const time = secondsFormat.format(date)
  if (sameDay(date, new Date(now))) return time
  if (now - date.getTime() < 6 * DAY_MS && date.getTime() <= now)
    return `${weekdayFormat.format(date)} ${time}`
  return `${dayFormat.format(date)} ${time}`
}

/** "2 Nov". */
export function formatDay(iso: string | null): string {
  if (iso === null) return '—'
  const date = valid(iso)
  return date === null ? '—' : dayFormat.format(date)
}

/** "640 ms", "5.2 s", "2 min". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.round(ms / 60_000)} min`
}

/** "3:58" for a countdown; "0:00" once passed. */
export function formatCountdown(untilIso: string, now: number): string {
  const date = valid(untilIso)
  const left = date === null ? 0 : Math.max(0, Math.ceil((date.getTime() - now) / 1000))
  const minutes = Math.floor(left / 60)
  const seconds = left % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** "in 4 min", "in 1 h 20 min", "now". */
export function formatIn(untilIso: string, now: number): string {
  const date = valid(untilIso)
  if (date === null) return 'now'
  const minutes = Math.ceil((date.getTime() - now) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`
}

/** "6 h ago", "12 min ago", "just now". */
export function formatAgo(iso: string, now: number): string {
  const date = valid(iso)
  if (date === null) return '—'
  const minutes = Math.floor((now - date.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}

/** "9f3c1a7e…e0f1": enough to compare by eye, never mistaken for the whole. */
export function shortHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`
}

/** "7b2f…19ad", for dense tables. */
export function tinyHash(hash: string): string {
  return hash.length <= 10 ? hash : `${hash.slice(0, 4)}…${hash.slice(-4)}`
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** "https://www.woolworths.com.au" → "www.woolworths.com.au". */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The clock time alone, "9:52 pm", for deadlines and "calls resume at". */
export function formatClock(iso: string | number): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : timeFormat.format(date)
}

/** A call's short ref, "7F2A": the same one tool results and notifications name. */
export { callRef } from '@valet/core/vocabulary'
