// A port of packages/core/src/display-text.ts. Text a person reads on a card is refused, not
// cleaned, if it holds control, format, line or paragraph separator characters, invisible letters,
// variation selectors, piles of combining marks or long runs of spaces. The Mac cleaned it before
// sending, so a value that still has them is a bug or an attack. JavaScript's /u regexes match code
// points, which are Unicode scalars here.

public enum DisplayText {
  /// The explicit invisible list from core: Hangul fillers, the braille blank, Mongolian vowel
  /// separator, Khmer inherent vowels, the very wide ligatures and the three-em dash.
  static let invisible: Set<UInt32> = [
    0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x180E, 0x17B4, 0x17B5, 0xFDFD, 0xFDFA, 0xFDFB, 0x2E3B,
  ]

  public static func isValid(_ value: String) -> Bool {
    var marksInARow = 0
    var spacesInARow = 0
    var visible = false
    for scalar in value.unicodeScalars {
      let category = scalar.properties.generalCategory
      switch category {
      case .control, .format, .lineSeparator, .paragraphSeparator, .enclosingMark:
        return false
      default: break
      }
      if invisible.contains(scalar.value) || scalar.properties.isVariationSelector { return false }
      let isMark = category == .nonspacingMark || category == .spacingMark || category == .enclosingMark
      marksInARow = isMark ? marksInARow + 1 : 0
      if marksInARow >= 3 { return false }
      spacesInARow = category == .spaceSeparator ? spacesInARow + 1 : 0
      if spacesInARow >= 4 { return false }
      if !isMark && category != .spaceSeparator { visible = true }
    }
    return visible
  }

  /// `displayText(max)` in core: 1 to `max` UTF-16 code units, as JavaScript counts length.
  public static func isValid(_ value: String, max: Int) -> Bool {
    let length = value.utf16.count
    return length >= 1 && length <= max && isValid(value)
  }
}
