// The reader helper's Calendar and Reminders requests: what it accepts and refuses. These never
// touch the Mac's real calendars; the CI runner has no access to them anyway.

import Foundation
import XCTest

@testable import ValetHelperKit

final class EventKitAccessTests: XCTestCase {
  func parse(_ json: String) throws -> EventKitRequest {
    try parseEventKitRequest(Data(json.utf8))
  }

  func refused(_ json: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertThrowsError(try parse(json), file: file, line: line)
  }

  func testRecognisesItsRequests() {
    XCTAssertTrue(isEventKitRequest(Data(#"{"v":1,"op":"eventkit.status","kind":"events"}"#.utf8)))
    XCTAssertFalse(isEventKitRequest(Data(#"{"v":1,"op":"mail.info"}"#.utf8)))
    XCTAssertFalse(isEventKitRequest(Data("not json".utf8)))
  }

  func testStatusAndCalendars() throws {
    XCTAssertEqual(try parse(#"{"v":1,"op":"eventkit.status","kind":"events"}"#), .status(.events))
    XCTAssertEqual(try parse(#"{"v":1,"op":"eventkit.request","kind":"reminders"}"#), .request(.reminders))
    XCTAssertEqual(try parse(#"{"v":1,"op":"eventkit.calendars","kind":"reminders"}"#), .calendars(.reminders))
    refused(#"{"v":1,"op":"eventkit.status","kind":"contacts"}"#)
    refused(#"{"v":1,"op":"eventkit.status","kind":"events","extra":1}"#)
    refused(#"{"v":2,"op":"eventkit.status","kind":"events"}"#)
    refused(#"{"v":1,"op":"eventkit.delete","kind":"events"}"#)
  }

  func testEvents() throws {
    XCTAssertEqual(
      try parse(#"{"v":1,"op":"eventkit.events","calendars":["A"],"startMs":1000,"endMs":2000,"limit":5}"#),
      .events(calendars: ["A"], startMs: 1000, endMs: 2000, limit: 5))
    refused(#"{"v":1,"op":"eventkit.events","calendars":["A"],"startMs":2000,"endMs":1000}"#)
    refused(#"{"v":1,"op":"eventkit.events","calendars":["A"],"startMs":0,"endMs":40000000000}"#)
    refused(#"{"v":1,"op":"eventkit.events","calendars":"A","startMs":0,"endMs":1}"#)
    refused(#"{"v":1,"op":"eventkit.events","calendars":["A"],"startMs":0,"endMs":1,"limit":0}"#)
  }

  func testReminders() throws {
    XCTAssertEqual(
      try parse(#"{"v":1,"op":"eventkit.reminders","calendars":["L"],"completed":false}"#),
      .reminders(calendars: ["L"], completed: false, dueStartMs: nil, dueEndMs: nil, limit: 500))
    XCTAssertEqual(
      try parse(#"{"v":1,"op":"eventkit.reminders","calendars":["L"],"completed":null,"dueEndMs":5}"#),
      .reminders(calendars: ["L"], completed: nil, dueStartMs: nil, dueEndMs: 5, limit: 500))
    refused(#"{"v":1,"op":"eventkit.reminders","calendars":["L"],"completed":"yes"}"#)
    refused(#"{"v":1,"op":"eventkit.reminders","calendars":["L"],"dueStartMs":5,"dueEndMs":5}"#)
  }

  func testSaveEvent() throws {
    let created = try parse(
      #"{"v":1,"op":"eventkit.saveEvent","calendar":"C","title":"Dentist","start":{"ms":1000},"end":{"ms":2000},"notes":null}"#
    )
    guard case .saveEvent(let calendar, let id, let occurrence, let fields) = created else { return XCTFail() }
    XCTAssertEqual(calendar, "C")
    XCTAssertNil(id)
    XCTAssertNil(occurrence)
    XCTAssertEqual(fields.title, "Dentist")
    XCTAssertEqual(fields.start, .instant(1000))
    XCTAssertEqual(fields.notes, .some(nil))
    XCTAssertNil(fields.location)

    let allDay = try parse(
      #"{"v":1,"op":"eventkit.saveEvent","calendar":"C","title":"Leave","start":{"day":"2026-12-01"},"end":{"day":"2026-12-03"}}"#
    )
    guard case .saveEvent(_, _, _, let dayFields) = allDay else { return XCTFail() }
    XCTAssertEqual(dayFields.start, .day(year: 2026, month: 12, day: 1))

    // A new event needs a title and both ends, of one kind.
    refused(#"{"v":1,"op":"eventkit.saveEvent","calendar":"C","start":{"ms":1},"end":{"ms":2}}"#)
    refused(#"{"v":1,"op":"eventkit.saveEvent","calendar":"C","title":"x","start":{"ms":1}}"#)
    refused(
      #"{"v":1,"op":"eventkit.saveEvent","calendar":"C","title":"x","start":{"day":"2026-12-01"},"end":{"ms":2}}"#)
    refused(#"{"v":1,"op":"eventkit.saveEvent","calendar":"C","title":"x","start":{"day":"2026-13-01"},"end":{"day":"2026-12-01"}}"#)
    // An occurrence only of an existing event; nothing else is accepted (no attendees, no deleting).
    refused(#"{"v":1,"op":"eventkit.saveEvent","calendar":"C","title":"x","start":{"ms":1},"end":{"ms":2},"occurrenceMs":1}"#)
    refused(#"{"v":1,"op":"eventkit.saveEvent","calendar":"C","id":"E","attendees":["a@b.c"]}"#)
    XCTAssertEqual(
      try parse(#"{"v":1,"op":"eventkit.saveEvent","calendar":"C","id":"E","occurrenceMs":7,"title":"New"}"#),
      .saveEvent(calendar: "C", id: "E", occurrenceMs: 7, fields: EventFields(title: "New")))
  }

  func testSaveReminder() throws {
    XCTAssertEqual(
      try parse(#"{"v":1,"op":"eventkit.saveReminder","calendar":"L","id":"R","completed":true}"#),
      .saveReminder(calendar: "L", id: "R", fields: ReminderFields(completed: true)))
    XCTAssertEqual(
      try parse(#"{"v":1,"op":"eventkit.saveReminder","calendar":"L","id":"R","due":null}"#),
      .saveReminder(calendar: "L", id: "R", fields: ReminderFields(due: .some(nil))))
    refused(#"{"v":1,"op":"eventkit.saveReminder","calendar":"L","notes":"no title"}"#)
    refused(#"{"v":1,"op":"eventkit.saveReminder","calendar":"L","title":"x","priority":12}"#)
  }

  func testDayComponents() {
    let c = components(of: .day(year: 2026, month: 2, day: 3))
    XCTAssertEqual(c.year, 2026)
    XCTAssertEqual(c.month, 2)
    XCTAssertEqual(c.day, 3)
    XCTAssertNil(c.hour)
    XCTAssertNotNil(components(of: .instant(0)).hour)
  }
}
