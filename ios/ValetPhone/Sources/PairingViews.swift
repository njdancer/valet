import AuthenticationServices
import SwiftUI
import ValetPhoneCore
import VisionKit

/// Sign in to the Valet account with its passkey (step 4d): the hub's page opens in Safari's
/// sheet, the passkey adds this phone, and the phone reaches every Mac on the account. Pairing
/// with one Mac's code (J1) stays, below it, for an account without a passkey.
struct PairStartView: View {
  let model: PhoneModel
  let host: AppHost
  let notice: String?
  @State private var scanning = false
  @State private var name = "iPhone"
  @State private var hubAddress = PhoneModel.defaultHub
  @State private var showPairing = false
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession

  private func signIn() async {
    guard let url = model.startSignIn(hub: hubAddress, name: name) else { return }
    #if VALET_FAKES
      if host.world != nil {
        _ = host.signInAtFakeHub(url)
        await model.finishSignIn()
        return
      }
    #endif
    do {
      _ = try await webAuthenticationSession.authenticate(
        using: url, callbackURLScheme: "valet", preferredBrowserSession: .shared
      )
      await model.finishSignIn()
    } catch {
      // Closed the sheet: nothing changed. If the passkey had already added this phone, the
      // next sign-in finds it on the list.
      model.cancelSignIn()
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if let notice {
            Text(verbatim: notice)
              .padding()
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(.orange.opacity(0.15), in: .rect(cornerRadius: 12))
              .accessibilityIdentifier("pair.notice")
          }
          Text("Sign in to Valet").font(.largeTitle.bold())
          Text(
            "Valet asks you here before an agent can do something that matters. Sign in with the passkey you set up for your Valet account, and this iPhone reaches every Mac on it."
          )
          TextField("Name for this iPhone", text: $name)
            .textFieldStyle(.roundedBorder)
            .textContentType(.name)
            .accessibilityIdentifier("pair.name")
          Button {
            Task { await signIn() }
          } label: {
            Label("Sign in with your passkey", systemImage: "person.badge.key").frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .disabled(model.signIn == .checking || model.signIn == .inBrowser)
          .accessibilityIdentifier("signin.start")
          switch model.signIn {
          case .checking, .inBrowser:
            ProgressView("Signing in\u{2026}").accessibilityIdentifier("signin.progress")
          case let .failed(reason):
            Text(verbatim: reason)
              .padding()
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(.orange.opacity(0.15), in: .rect(cornerRadius: 12))
              .accessibilityIdentifier("signin.failed")
          case .idle:
            EmptyView()
          }
          DisclosureGroup("Account address") {
            TextField("Account address", text: $hubAddress)
              .textFieldStyle(.roundedBorder)
              .keyboardType(.URL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityIdentifier("signin.hub")
          }
          Divider()
          DisclosureGroup("Pair with one Mac\u{2019}s code instead", isExpanded: $showPairing) {
            pairing
          }
          .accessibilityIdentifier("pair.instead")
        }
        .padding()
      }
      .onAppear {
        #if VALET_FAKES
          // The pairing journeys and the walkthrough start from a Mac's code.
          if host.pairFrom != nil || host.world?.scenario == .pair { showPairing = true }
        #endif
      }
      .sheet(isPresented: $scanning) {
        QRScanner { text in
          scanning = false
          model.pair(qr: text, name: name)
        }
        .ignoresSafeArea()
      }
    }
  }

  @ViewBuilder private var pairing: some View {
    VStack(alignment: .leading, spacing: 16) {
          Text(
            "On your Mac, open Valet and choose Settings, then Devices, then Pair an iPhone. A code appears. Scan it with this phone."
          )
          Button {
            scanning = true
          } label: {
            Label("Scan the code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .disabled(!DataScannerViewController.isSupported)
          .accessibilityIdentifier("pair.scan")
          if !DataScannerViewController.isSupported {
            Text("This iPhone can't scan codes.").foregroundStyle(.secondary)
          }
          #if VALET_FAKES
            if host.pairFrom != nil {
              // The simulator has no camera: the test build reads the code the Mac shows.
              Button {
                Task { if let qr = await host.pairingTextFromMac() { model.pair(qr: qr, name: name) } }
              } label: {
                Label("Use the code on the Mac (Simulator)", systemImage: "desktopcomputer").frame(maxWidth: .infinity)
              }
              .buttonStyle(.bordered)
              .controlSize(.large)
              .accessibilityIdentifier("pair.fromMac")
            }
            if host.world != nil {
              Button("Use the test Mac\u{2019}s code") {
                if let qr = host.fakeQR { model.pair(qr: qr, name: name) }
              }
              .accessibilityIdentifier("pair.fake")
            }
          #endif
    }
    .padding(.top, 8)
  }
}

struct PairingView: View {
  let model: PhoneModel
  let host: AppHost
  let step: PairingStep

  var body: some View {
    VStack(spacing: 24) {
      switch step {
      case .sending:
        ProgressView("Reaching your Mac\u{2026}")
      case let .code(code), let .waitingForMac(code):
        Text("Check the code").font(.largeTitle.bold())
        Text("Your Mac shows three codes. Pick the one that matches this one.")
          .multilineTextAlignment(.center)
        Text(verbatim: spaced(code))
          .font(.system(size: 48, weight: .semibold, design: .monospaced))
          .accessibilityLabel(code.map(String.init).joined(separator: " "))
          .accessibilityIdentifier("pair.code")
        Text("If none of them match, choose None of these on your Mac. Someone else may be trying to pair.")
          .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        #if VALET_FAKES
          if host.world != nil {
            HStack {
              Button("Mac: matches") { host.confirmAtFakeMac() }.accessibilityIdentifier("fake.mac.confirm")
              Button("Mac: none of these") { host.rejectAtFakeMac() }.accessibilityIdentifier("fake.mac.reject")
            }
            .buttonStyle(.bordered)
          }
        #endif
      case let .failed(failure):
        Image(systemName: "xmark.octagon").font(.largeTitle).accessibilityHidden(true)
        Text(verbatim: failure.rawValue).multilineTextAlignment(.center).accessibilityIdentifier("pair.failed")
      }
      Button(isFailed ? "Start again" : "Cancel") { model.cancelPairing() }
        .accessibilityIdentifier("pair.cancel")
    }
    .padding()
  }

  private var isFailed: Bool { if case .failed = step { return true } else { return false } }

  private func spaced(_ code: String) -> String {
    guard code.count == 6 else { return code }
    return "\(code.prefix(3)) \(code.suffix(3))"
  }
}

/// The camera, reading one QR code. Only text starting with the pairing prefix is passed on; the
/// model checks the rest.
struct QRScanner: UIViewControllerRepresentable {
  let found: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true
    )
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void
    private var done = false
    init(found: @escaping (String) -> Void) { self.found = found }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      for case let .barcode(code) in items {
        guard !done, let text = code.payloadStringValue, text.hasPrefix("valet-pair:") else { continue }
        done = true
        scanner.stopScanning()
        found(text)
        return
      }
    }
  }
}
