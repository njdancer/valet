import LocalAuthentication

/// A Face ID check for the few tightening steps that still need one (removing a device). Approvals
/// don't use this: their Face ID is the Secure Enclave key's own, which a check here can't stand in for.
enum Biometrics {
  static func confirm(_ reason: String) async -> Bool {
    #if VALET_FAKES
      return true
    #else
      let context = LAContext()
      context.localizedFallbackTitle = ""
      return (try? await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)) ?? false
    #endif
  }
}
