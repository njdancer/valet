import SwiftUI
import UIKit

/// Tone colours that pass WCAG AA (4.5:1) for text on the system backgrounds, in light and dark.
/// The system orange, red and green don't on white. Words carry the meaning; colour only adds to it.
enum Palette {
  static let caution = adaptive(light: 0x9A4A00, dark: 0xFFB45C)
  static let strong = adaptive(light: 0xB0201A, dark: 0xFF8A80)
  static let ok = adaptive(light: 0x1E6B30, dark: 0x7FD98F)

  private static func adaptive(light: UInt32, dark: UInt32) -> Color {
    Color(uiColor: UIColor { traits in
      let hex = traits.userInterfaceStyle == .dark ? dark : light
      return UIColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
      )
    })
  }
}

/// A list section's header in the primary colour: the system's grey header text on the grouped
/// background falls just short of the contrast the accessibility audit asks for.
struct SectionHeader: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(verbatim: text).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).textCase(nil)
      .accessibilityAddTraits(.isHeader)
  }
}
