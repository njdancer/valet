// iCalendar (RFC 5545), as much as reading and writing simple events needs: unfolding long lines,
// escaping text, and the three ways a time is written. Pure, so cases test it through the tools.

export interface IcsEvent {
  readonly uid: string
  readonly title: string
  readonly start: string
  readonly end: string | null
  readonly allDay: boolean
  /** The TZID a local time is in, or null for UTC and dates. */
  readonly timeZone: string | null
  readonly location: string | null
}

/** Lines with RFC 5545 folding undone: a line that starts with a space or tab continues the last. */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

export function escapeText(value: string): string {
  return value.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n')
}

/** Folds a content line at 73 octets, as RFC 5545 asks (75 with the CRLF and the space). */
export function fold(line: string): string {
  const out: string[] = []
  let rest = line
  while (rest.length > 73) {
    out.push(rest.slice(0, 73))
    rest = rest.slice(73)
  }
  out.push(rest)
  return out.join('\r\n ')
}

/** A DATE-TIME or DATE value as ISO 8601: "20261118T090000Z" → "2026-11-18T09:00:00Z". */
export function isoTime(value: string): { iso: string; allDay: boolean } | null {
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (dt !== null)
    return { iso: `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6]}${dt[7]}`, allDay: false }
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (d !== null) return { iso: `${d[1]}-${d[2]}-${d[3]}`, allDay: true }
  return null
}

/** UTC ISO 8601 → "20261118T090000Z". */
export function icsTime(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')
}

/** Every VEVENT in one calendar object. Recurrence and alarms are left out of this example. */
export function readEvents(ics: string): IcsEvent[] {
  const events: IcsEvent[] = []
  let current: Record<string, { params: string; value: string }> | null = null
  for (const line of unfold(ics)) {
    if (line === 'BEGIN:VEVENT') current = {}
    else if (line === 'END:VEVENT' && current !== null) {
      const start = current['DTSTART']
      const parsedStart = start === undefined ? null : isoTime(start.value)
      const end = current['DTEND']
      const parsedEnd = end === undefined ? null : isoTime(end.value)
      if (parsedStart !== null && current['UID'] !== undefined)
        events.push({
          uid: current['UID'].value,
          title: unescapeText(current['SUMMARY']?.value ?? ''),
          start: parsedStart.iso,
          end: parsedEnd?.iso ?? null,
          allDay: parsedStart.allDay,
          timeZone: /;TZID=([^;:]+)/.exec(start?.params ?? '')?.[1] ?? null,
          location: current['LOCATION'] === undefined ? null : unescapeText(current['LOCATION'].value),
        })
      current = null
    } else if (current !== null) {
      const match = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(line)
      if (match !== null) current[match[1] as string] = { params: match[2] ?? '', value: match[3] ?? '' }
    }
  }
  return events
}

/** A calendar object holding one event. */
export function writeEvent(event: {
  uid: string
  title: string
  start: string
  end: string
  location: string | null
  stamp: string
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Valet//Example iCloud Calendar//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${event.stamp}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    fold(`SUMMARY:${escapeText(event.title)}`),
    ...(event.location === null ? [] : [fold(`LOCATION:${escapeText(event.location)}`)]),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}
