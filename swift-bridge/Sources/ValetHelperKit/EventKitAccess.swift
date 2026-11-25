// What the reader helper does for Calendar and Reminders (docs/calendar.md): EventKit, the Mac's
// own calendar and reminder store, so neither app needs to be open. macOS asks the person once to
// let "Valet Reader" use each; nothing here works before they allow it.
//
// Which calendars and lists agents may see, and whether they may write, is decided in Valet's main
// process (packages/native-calendar), which names the calendars on every request. The helper only
// answers these questions:
//
// - eventkit.status     the access macOS gives the helper for events or reminders
// - eventkit.request    asks macOS for it (the prompt), and answers at once with the access now
// - eventkit.calendars  the calendars (events) or lists (reminders), with their accounts
// - eventkit.events     the events in some calendars between two times, recurring ones expanded
// - eventkit.reminders  the reminders in some lists, open or done, optionally due in a range
// - eventkit.saveEvent  creates an event, or changes one (one occurrence of a recurring one)
// - eventkit.saveReminder  creates a reminder, or changes or completes one
// - eventkit.removeEvent   deletes an event (one occurrence of a recurring one)
// - eventkit.removeReminder  deletes a reminder
//
// No request adds attendees. Changing or deleting an event other people are on may send them an
// update, as it would from the Calendar app (Nick, 2026-11-24: allowed, audited).

import EventKit
import Foundation

public enum EventKitFailure: String, Error {
  case invalid
  case notFound = "not-found"
  case denied
  case readOnly = "read-only"
  case hasAttendees = "has-attendees"
  case unavailable
}

public enum EventKitKind: String {
  case events
  case reminders

  var entity: EKEntityType { self == .events ? .event : .reminder }
}

/// A day ("2026-11-25") or an instant (milliseconds since 1970).
public enum EventKitTime: Equatable {
  case day(year: Int, month: Int, day: Int)
  case instant(Int64)
}

public struct EventFields: Equatable {
  public var title: String?
  public var start: EventKitTime?
  public var end: EventKitTime?
  public var location: String??
  public var notes: String??
  public var url: String??
}

public struct ReminderFields: Equatable {
  public var title: String?
  public var notes: String??
  /// .some(nil) clears the due date.
  public var due: EventKitTime??
  public var priority: Int?
  public var completed: Bool?
}

public enum EventKitRequest: Equatable {
  case status(EventKitKind)
  case request(EventKitKind)
  case calendars(EventKitKind)
  case events(calendars: [String], startMs: Int64, endMs: Int64, limit: Int)
  case reminders(calendars: [String], completed: Bool?, dueStartMs: Int64?, dueEndMs: Int64?, limit: Int)
  /// id nil: a new event in `calendar`. occurrenceMs: which occurrence of a recurring one.
  case saveEvent(calendar: String, id: String?, occurrenceMs: Int64?, fields: EventFields)
  case saveReminder(calendar: String, id: String?, fields: ReminderFields)
  case removeEvent(calendar: String, id: String, occurrenceMs: Int64?)
  case removeReminder(calendar: String, id: String)
}

let maxEventKitResults = 500
let maxTextChars = 10_000
let maxCalendarsPerRequest = 200
/// EventKit searches at most four years at once; agents get one.
let maxRangeMs: Int64 = 400 * 86_400_000

public func isEventKitRequest(_ data: Data) -> Bool {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    let op = object["op"] as? String
  else { return false }
  return op.hasPrefix("eventkit.")
}

private func int64(_ value: Any?) -> Int64? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
  let double = number.doubleValue
  guard double.rounded() == double, abs(double) < 9.0e15 else { return nil }
  return number.int64Value
}

private func bool(_ value: Any?) -> Bool? {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
  return number.boolValue
}

private func text(_ value: Any?, max: Int) -> String? {
  guard let string = value as? String, string.count <= max else { return nil }
  return string
}

/// A key that may be absent (nil), null (.some(nil)) or text (.some(text)).
private func optionalText(_ object: [String: Any], _ key: String, max: Int) throws -> String?? {
  guard let value = object[key] else { return nil }
  if value is NSNull { return .some(nil) }
  guard let string = text(value, max: max) else { throw EventKitFailure.invalid }
  return .some(string)
}

/// `{"day":"2026-11-25"}` or `{"ms":1764000000000}`.
func parseTime(_ value: Any?) throws -> EventKitTime {
  guard let object = value as? [String: Any], object.count == 1 else { throw EventKitFailure.invalid }
  if let ms = int64(object["ms"]) { return .instant(ms) }
  guard let day = object["day"] as? String, day.utf8.count == 10 else { throw EventKitFailure.invalid }
  let parts = day.split(separator: "-").compactMap { Int($0) }
  guard parts.count == 3, (1...12).contains(parts[1]), (1...31).contains(parts[2]), parts[0] >= 1900,
    parts[0] <= 9999
  else { throw EventKitFailure.invalid }
  return .day(year: parts[0], month: parts[1], day: parts[2])
}

private func kind(_ object: [String: Any]) throws -> EventKitKind {
  guard let name = object["kind"] as? String, let kind = EventKitKind(rawValue: name) else {
    throw EventKitFailure.invalid
  }
  return kind
}

private func calendarIds(_ value: Any?) throws -> [String] {
  guard let list = value as? [Any], list.count <= maxCalendarsPerRequest else { throw EventKitFailure.invalid }
  return try list.map {
    guard let id = text($0, max: 200), !id.isEmpty else { throw EventKitFailure.invalid }
    return id
  }
}

private func limit(_ value: Any?) throws -> Int {
  guard let value else { return maxEventKitResults }
  guard let n = int64(value), n >= 1, n <= Int64(maxEventKitResults) else { throw EventKitFailure.invalid }
  return Int(n)
}

/// Parses `{"v":1,"op":"eventkit.…",…}`. Unknown keys or ops are refused.
public func parseEventKitRequest(_ data: Data) throws -> EventKitRequest {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    (object["v"] as? NSNumber)?.intValue == 1, let op = object["op"] as? String
  else { throw EventKitFailure.invalid }
  let keys = Set(object.keys)
  func only(_ allowed: Set<String>, required: Set<String> = []) throws {
    guard keys.isSubset(of: allowed.union(["v", "op"])), required.isSubset(of: keys) else {
      throw EventKitFailure.invalid
    }
  }
  switch op {
  case "eventkit.status", "eventkit.request", "eventkit.calendars":
    try only(["kind"], required: ["kind"])
    let k = try kind(object)
    return op == "eventkit.status" ? .status(k) : op == "eventkit.request" ? .request(k) : .calendars(k)
  case "eventkit.events":
    try only(["calendars", "startMs", "endMs", "limit"], required: ["calendars", "startMs", "endMs"])
    guard let start = int64(object["startMs"]), let end = int64(object["endMs"]), end > start,
      end - start <= maxRangeMs
    else { throw EventKitFailure.invalid }
    return .events(
      calendars: try calendarIds(object["calendars"]), startMs: start, endMs: end, limit: try limit(object["limit"]))
  case "eventkit.reminders":
    try only(["calendars", "completed", "dueStartMs", "dueEndMs", "limit"], required: ["calendars"])
    var completed: Bool?
    if let value = object["completed"], !(value is NSNull) {
      guard let b = bool(value) else { throw EventKitFailure.invalid }
      completed = b
    }
    let dueStart = object["dueStartMs"].flatMap { $0 is NSNull ? nil : $0 }
    let dueEnd = object["dueEndMs"].flatMap { $0 is NSNull ? nil : $0 }
    let start = try dueStart.map { (v: Any) -> Int64 in
      guard let n = int64(v) else { throw EventKitFailure.invalid }
      return n
    }
    let end = try dueEnd.map { (v: Any) -> Int64 in
      guard let n = int64(v) else { throw EventKitFailure.invalid }
      return n
    }
    if let start, let end, end <= start { throw EventKitFailure.invalid }
    return .reminders(
      calendars: try calendarIds(object["calendars"]), completed: completed, dueStartMs: start, dueEndMs: end,
      limit: try limit(object["limit"]))
  case "eventkit.saveEvent":
    try only(
      ["calendar", "id", "occurrenceMs", "title", "start", "end", "location", "notes", "url"],
      required: ["calendar"])
    guard let calendar = text(object["calendar"], max: 200), !calendar.isEmpty else { throw EventKitFailure.invalid }
    let id = try optionalText(object, "id", max: 400) ?? nil
    var occurrence: Int64?
    if let value = object["occurrenceMs"] {
      guard let n = int64(value), id != nil else { throw EventKitFailure.invalid }
      occurrence = n
    }
    var fields = EventFields()
    if let value = object["title"] {
      guard let title = text(value, max: 500), !title.isEmpty else { throw EventKitFailure.invalid }
      fields.title = title
    }
    if object["start"] != nil { fields.start = try parseTime(object["start"]) }
    if object["end"] != nil { fields.end = try parseTime(object["end"]) }
    fields.location = try optionalText(object, "location", max: 1_000)
    fields.notes = try optionalText(object, "notes", max: maxTextChars)
    fields.url = try optionalText(object, "url", max: 2_000)
    // A new event needs a title and both ends, of the same kind (all day or timed).
    if id == nil {
      guard fields.title != nil, let start = fields.start, let end = fields.end else { throw EventKitFailure.invalid }
      if case .day = start, case .instant = end { throw EventKitFailure.invalid }
      if case .instant = start, case .day = end { throw EventKitFailure.invalid }
    }
    return .saveEvent(calendar: calendar, id: id, occurrenceMs: occurrence, fields: fields)
  case "eventkit.saveReminder":
    try only(["calendar", "id", "title", "notes", "due", "priority", "completed"], required: ["calendar"])
    guard let calendar = text(object["calendar"], max: 200), !calendar.isEmpty else { throw EventKitFailure.invalid }
    let id = try optionalText(object, "id", max: 400) ?? nil
    var fields = ReminderFields()
    if let value = object["title"] {
      guard let title = text(value, max: 500), !title.isEmpty else { throw EventKitFailure.invalid }
      fields.title = title
    }
    fields.notes = try optionalText(object, "notes", max: maxTextChars)
    if let value = object["due"] {
      fields.due = value is NSNull ? .some(nil) : .some(try parseTime(value))
    }
    if let value = object["priority"] {
      guard let n = int64(value), (0...9).contains(n) else { throw EventKitFailure.invalid }
      fields.priority = Int(n)
    }
    if let value = object["completed"] {
      guard let b = bool(value) else { throw EventKitFailure.invalid }
      fields.completed = b
    }
    if id == nil && fields.title == nil { throw EventKitFailure.invalid }
    return .saveReminder(calendar: calendar, id: id, fields: fields)
  case "eventkit.removeEvent", "eventkit.removeReminder":
    let event = op == "eventkit.removeEvent"
    try only(event ? ["calendar", "id", "occurrenceMs"] : ["calendar", "id"], required: ["calendar", "id"])
    guard let calendar = text(object["calendar"], max: 200), !calendar.isEmpty,
      let id = text(object["id"], max: 400), !id.isEmpty
    else { throw EventKitFailure.invalid }
    if !event { return .removeReminder(calendar: calendar, id: id) }
    var occurrence: Int64?
    if let value = object["occurrenceMs"] {
      guard let n = int64(value) else { throw EventKitFailure.invalid }
      occurrence = n
    }
    return .removeEvent(calendar: calendar, id: id, occurrenceMs: occurrence)
  default:
    throw EventKitFailure.invalid
  }
}

// ---------- Answers ----------

public func accessName(_ status: EKAuthorizationStatus) -> String {
  if #available(macOS 14.0, *) {
    if status == .fullAccess { return "full" }
    if status == .writeOnly { return "write-only" }
  }
  switch status {
  case .notDetermined: return "not-determined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .authorized: return "full"
  default: return "denied"
  }
}

/// The helper's one store, made again when access changes (a store made before access was given
/// sees nothing).
final class EventKitStores {
  private var store: EKEventStore?
  private var madeWith: [EKEntityType: String] = [:]

  func get() -> EKEventStore {
    let now: [EKEntityType: String] = [
      .event: accessName(EKEventStore.authorizationStatus(for: .event)),
      .reminder: accessName(EKEventStore.authorizationStatus(for: .reminder)),
    ]
    if let store, now == madeWith { return store }
    let made = EKEventStore()
    store = made
    madeWith = now
    return made
  }
}

let eventKitStores = EventKitStores()

private let isoFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  f.timeZone = TimeZone.current
  return f
}()

func isoTime(_ date: Date) -> String {
  isoFormatter.timeZone = TimeZone.current
  return isoFormatter.string(from: date)
}

func dayString(_ date: Date) -> String {
  let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

func components(of time: EventKitTime, calendar: Calendar = .current) -> DateComponents {
  switch time {
  case .day(let y, let m, let d):
    return DateComponents(calendar: calendar, year: y, month: m, day: d)
  case .instant(let ms):
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    var c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    c.calendar = calendar
    c.timeZone = calendar.timeZone
    return c
  }
}

func date(of time: EventKitTime, calendar: Calendar = .current) -> Date? {
  switch time {
  case .day(let y, let m, let d):
    return calendar.date(from: DateComponents(year: y, month: m, day: d))
  case .instant(let ms):
    return Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
  }
}

private func orNull<T>(_ value: T?) -> Any {
  guard let value else { return NSNull() }
  return value
}

private func clip(_ value: String?) -> Any {
  guard let value else { return NSNull() }
  return value.count > maxTextChars ? String(value.prefix(maxTextChars)) : value
}

private func calendarJSON(_ calendar: EKCalendar) -> [String: Any] {
  [
    "id": calendar.calendarIdentifier,
    "title": calendar.title,
    "account": orNull(calendar.source?.title),
    "writable": calendar.allowsContentModifications,
    "subscribed": calendar.type == .subscription || calendar.type == .birthday,
  ]
}

private func participantJSON(_ p: EKParticipant) -> [String: Any] {
  let email: String? = p.url.scheme == "mailto" ? String(p.url.absoluteString.dropFirst(7)).removingPercentEncoding : nil
  let status: String
  switch p.participantStatus {
  case .accepted: status = "accepted"
  case .declined: status = "declined"
  case .tentative: status = "tentative"
  case .pending: status = "pending"
  default: status = "unknown"
  }
  return ["name": orNull(p.name), "email": orNull(email), "status": status, "me": p.isCurrentUser]
}

func eventJSON(_ event: EKEvent) -> [String: Any] {
  let start: Any = event.isAllDay ? dayString(event.startDate) : isoTime(event.startDate)
  // An all-day event ends late on its last day (or midnight after); give the last day itself.
  let end: Any =
    event.isAllDay
    ? dayString(event.endDate.addingTimeInterval(-1)) : isoTime(event.endDate)
  return [
    "id": event.eventIdentifier ?? event.calendarItemIdentifier,
    "occurrenceMs": Int64((event.occurrenceDate ?? event.startDate).timeIntervalSince1970 * 1000),
    "calendarId": orNull(event.calendar?.calendarIdentifier),
    "title": clip(event.title),
    "start": start,
    "end": end,
    "allDay": event.isAllDay,
    "location": clip(event.location),
    "notes": clip(event.notes),
    "url": orNull(event.url?.absoluteString),
    "recurring": event.hasRecurrenceRules || event.isDetached,
    "organizer": orNull(event.organizer.map { participantJSON($0) }),
    "attendees": (event.attendees ?? []).prefix(100).map { participantJSON($0) },
    "status": event.status == .canceled ? "canceled" : event.status == .tentative ? "tentative" : "confirmed",
  ]
}

private func dueJSON(_ c: DateComponents?) -> Any {
  guard let c, let year = c.year, let month = c.month, let day = c.day else { return NSNull() }
  if c.hour == nil {
    return String(format: "%04d-%02d-%02d", year, month, day)
  }
  var full = c
  full.calendar = full.calendar ?? Calendar.current
  guard let date = full.date ?? Calendar.current.date(from: full) else { return NSNull() }
  return isoTime(date)
}

func reminderJSON(_ reminder: EKReminder) -> [String: Any] {
  [
    "id": reminder.calendarItemIdentifier,
    "listId": orNull(reminder.calendar?.calendarIdentifier),
    "title": clip(reminder.title),
    "notes": clip(reminder.notes),
    "due": dueJSON(reminder.dueDateComponents),
    "priority": reminder.priority,
    "completed": reminder.isCompleted,
    "completedAt": orNull(reminder.completionDate.map { isoTime($0) }),
    "url": orNull(reminder.url?.absoluteString),
  ]
}

private func hasFullAccess(_ kind: EventKitKind) -> Bool {
  accessName(EKEventStore.authorizationStatus(for: kind.entity)) == "full"
}

private func calendars(_ ids: [String], _ kind: EventKitKind, _ store: EKEventStore) -> [EKCalendar] {
  let wanted = Set(ids)
  return store.calendars(for: kind.entity).filter { wanted.contains($0.calendarIdentifier) }
}

/// Waits for EventKit's callback, at most `seconds`.
private func wait<T>(seconds: Double, _ start: (@escaping (T) -> Void) -> Void) -> T? {
  let done = DispatchSemaphore(value: 0)
  var result: T?
  let lock = NSLock()
  start { value in
    lock.lock()
    result = value
    lock.unlock()
    done.signal()
  }
  guard done.wait(timeout: .now() + seconds) == .success else { return nil }
  lock.lock()
  defer { lock.unlock() }
  return result
}

/// Finds one occurrence of an event by its id: the one starting at `occurrenceMs`, or the event.
private func findEvent(_ id: String, occurrenceMs: Int64?, in calendar: EKCalendar, _ store: EKEventStore) -> EKEvent? {
  guard let first = store.event(withIdentifier: id), first.calendar?.calendarIdentifier == calendar.calendarIdentifier
  else { return nil }
  guard let occurrenceMs else { return first }
  let at = Date(timeIntervalSince1970: TimeInterval(occurrenceMs) / 1000)
  let predicate = store.predicateForEvents(
    withStart: at.addingTimeInterval(-86_400), end: at.addingTimeInterval(86_400), calendars: [calendar])
  return store.events(matching: predicate).first {
    $0.eventIdentifier == id && abs(($0.occurrenceDate ?? $0.startDate).timeIntervalSince(at)) < 1
  }
}

private func apply(_ fields: EventFields, to event: EKEvent) throws {
  if let title = fields.title { event.title = title }
  if let location = fields.location { event.location = location }
  if let notes = fields.notes { event.notes = notes }
  if let url = fields.url {
    if let url {
      guard let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme?.lowercased() ?? "") else {
        throw EventKitFailure.invalid
      }
      event.url = parsed
    } else {
      event.url = nil
    }
  }
  if fields.start != nil || fields.end != nil {
    let start = fields.start ?? (event.isAllDay ? .dayOf(event.startDate) : .instant(ms(event.startDate)))
    let end =
      fields.end
      ?? (event.isAllDay ? .dayOf(event.endDate.addingTimeInterval(-1)) : .instant(ms(event.endDate)))
    switch (start, end) {
    case (.day, .day):
      guard let s = date(of: start), let lastDay = date(of: end), let span = allDaySpan(s, lastDay)
      else { throw EventKitFailure.invalid }
      event.isAllDay = true
      event.startDate = span.start
      event.endDate = span.end
    case (.instant, .instant):
      guard let s = date(of: start), let e = date(of: end), e > s else { throw EventKitFailure.invalid }
      event.isAllDay = false
      event.startDate = s
      event.endDate = e
    default:
      throw EventKitFailure.invalid
    }
  }
}

/// An all-day event's dates as EventKit takes them: its end is a moment on the last day itself.
/// (Midnight after the last day reads to EventKit as one more day: feedback issue #8.)
func allDaySpan(_ start: Date, _ lastDay: Date) -> (start: Date, end: Date)? {
  lastDay >= start ? (start, lastDay) : nil
}

private func ms(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }

extension EventKitTime {
  static func dayOf(_ date: Date) -> EventKitTime {
    let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
    return .day(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
  }
}

/// Answers one request as a JSON object: the answer's keys, or `error`.
public func answerEventKit(_ request: EventKitRequest) -> [String: Any] {
  do {
    switch request {
    case .status(let kind):
      return ["access": accessName(EKEventStore.authorizationStatus(for: kind.entity))]
    case .request(let kind):
      let before = accessName(EKEventStore.authorizationStatus(for: kind.entity))
      if before == "not-determined" || before == "write-only" {
        // macOS shows its prompt; Valet asks for the status again until the person answers.
        let store = EKEventStore()
        let keep: (Bool, Error?) -> Void = { _, _ in _ = store }
        if #available(macOS 14.0, *) {
          if kind == .events { store.requestFullAccessToEvents(completion: keep) } else {
            store.requestFullAccessToReminders(completion: keep)
          }
        } else {
          store.requestAccess(to: kind.entity, completion: keep)
        }
      }
      return ["access": before]
    case .calendars(let kind):
      guard hasFullAccess(kind) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      store.refreshSourcesIfNecessary()
      return ["calendars": store.calendars(for: kind.entity).prefix(maxEventKitResults).map { calendarJSON($0) }]
    case .events(let ids, let startMs, let endMs, let limit):
      guard hasFullAccess(.events) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      let chosen = calendars(ids, .events, store)
      if chosen.isEmpty { return ["events": [], "more": false] }
      let predicate = store.predicateForEvents(
        withStart: Date(timeIntervalSince1970: TimeInterval(startMs) / 1000),
        end: Date(timeIntervalSince1970: TimeInterval(endMs) / 1000), calendars: chosen)
      let found = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
      return ["events": found.prefix(limit).map { eventJSON($0) }, "more": found.count > limit]
    case .reminders(let ids, let completed, let dueStartMs, let dueEndMs, let limit):
      guard hasFullAccess(.reminders) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      let chosen = calendars(ids, .reminders, store)
      if chosen.isEmpty { return ["reminders": [], "more": false] }
      let start = dueStartMs.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
      let end = dueEndMs.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
      let predicate: NSPredicate
      switch completed {
      case .some(true):
        predicate = store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: chosen)
      case .some(false):
        predicate = store.predicateForIncompleteReminders(withDueDateStarting: start, ending: end, calendars: chosen)
      case .none:
        predicate = store.predicateForReminders(in: chosen)
      }
      guard let fetched: [EKReminder]? = wait(seconds: 15, { done in
        _ = store.fetchReminders(matching: predicate) { done($0) }
      }) else { throw EventKitFailure.unavailable }
      var found = fetched ?? []
      if completed != false, start != nil || end != nil {
        found = found.filter { r in
          guard let c = r.dueDateComponents, let due = Calendar.current.date(from: c) else { return false }
          return (start.map { due >= $0 } ?? true) && (end.map { due < $0 } ?? true)
        }
      }
      // Open ones by due date (none last), then done ones newest first.
      found.sort { a, b in
        if a.isCompleted != b.isCompleted { return !a.isCompleted }
        if a.isCompleted { return (a.completionDate ?? .distantPast) > (b.completionDate ?? .distantPast) }
        let da = a.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture
        let db = b.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture
        return da < db
      }
      return ["reminders": found.prefix(limit).map { reminderJSON($0) }, "more": found.count > limit]
    case .saveEvent(let calendarId, let id, let occurrenceMs, let fields):
      guard hasFullAccess(.events) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      guard let calendar = calendars([calendarId], .events, store).first else { throw EventKitFailure.notFound }
      guard calendar.allowsContentModifications else { throw EventKitFailure.readOnly }
      let event: EKEvent
      if let id {
        guard let found = findEvent(id, occurrenceMs: occurrenceMs, in: calendar, store) else {
          throw EventKitFailure.notFound
        }
        event = found
      } else {
        event = EKEvent(eventStore: store)
        event.calendar = calendar
      }
      try apply(fields, to: event)
      do {
        try store.save(event, span: .thisEvent, commit: true)
      } catch {
        throw EventKitFailure.unavailable
      }
      return ["event": eventJSON(event)]
    case .saveReminder(let calendarId, let id, let fields):
      guard hasFullAccess(.reminders) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      guard let calendar = calendars([calendarId], .reminders, store).first else { throw EventKitFailure.notFound }
      guard calendar.allowsContentModifications else { throw EventKitFailure.readOnly }
      let reminder: EKReminder
      if let id {
        guard let found = store.calendarItem(withIdentifier: id) as? EKReminder,
          found.calendar?.calendarIdentifier == calendar.calendarIdentifier
        else { throw EventKitFailure.notFound }
        reminder = found
      } else {
        reminder = EKReminder(eventStore: store)
        reminder.calendar = calendar
      }
      if let title = fields.title { reminder.title = title }
      if let notes = fields.notes { reminder.notes = notes }
      if let priority = fields.priority { reminder.priority = priority }
      if let due = fields.due {
        reminder.alarms?.forEach { reminder.removeAlarm($0) }
        if let due {
          reminder.dueDateComponents = components(of: due)
          // A timed due date also alerts then, as the Reminders app does.
          if case .instant = due, let at = date(of: due) { reminder.addAlarm(EKAlarm(absoluteDate: at)) }
        } else {
          reminder.dueDateComponents = nil
        }
      }
      if let completed = fields.completed { reminder.isCompleted = completed }
      do {
        try store.save(reminder, commit: true)
      } catch {
        throw EventKitFailure.unavailable
      }
      return ["reminder": reminderJSON(reminder)]
    case .removeEvent(let calendarId, let id, let occurrenceMs):
      guard hasFullAccess(.events) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      guard let calendar = calendars([calendarId], .events, store).first else { throw EventKitFailure.notFound }
      guard calendar.allowsContentModifications else { throw EventKitFailure.readOnly }
      guard let found = findEvent(id, occurrenceMs: occurrenceMs, in: calendar, store) else {
        throw EventKitFailure.notFound
      }
      let removed = eventJSON(found)
      do {
        try store.remove(found, span: .thisEvent, commit: true)
      } catch {
        throw EventKitFailure.unavailable
      }
      return ["event": removed]
    case .removeReminder(let calendarId, let id):
      guard hasFullAccess(.reminders) else { throw EventKitFailure.denied }
      let store = eventKitStores.get()
      guard let calendar = calendars([calendarId], .reminders, store).first else { throw EventKitFailure.notFound }
      guard calendar.allowsContentModifications else { throw EventKitFailure.readOnly }
      guard let found = store.calendarItem(withIdentifier: id) as? EKReminder,
        found.calendar?.calendarIdentifier == calendar.calendarIdentifier
      else { throw EventKitFailure.notFound }
      let removed = reminderJSON(found)
      do {
        try store.remove(found, commit: true)
      } catch {
        throw EventKitFailure.unavailable
      }
      return ["reminder": removed]
    }
  } catch let failure as EventKitFailure {
    return ["error": failure.rawValue]
  } catch {
    return ["error": EventKitFailure.unavailable.rawValue]
  }
}
