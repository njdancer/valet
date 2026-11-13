# Putting Valet on your iPhone (free Apple account)

This is the short version for a person installing the iPhone app from source with a free Apple
Developer account. A free account has no TestFlight and no push notifications, and what it signs
stops opening after 7 days. So the phone doesn't buzz: open Valet on the phone and it fetches
whatever is waiting for you.

The design is in [ios-app.md](ios-app.md) and the relay in [relay-worker.md](relay-worker.md).

## What you need

- A Mac with Xcode, and Valet running on it.
- A deployed relay, and its host name (for example `valet-relay.<your-subdomain>.workers.dev`).
- An iPhone on iOS 18 or later, with a cable for the first install.

## 1. Sign in to Xcode (once)

Open Xcode › Settings › Accounts, click **+**, choose **Apple ID** and sign in. Xcode makes a
"Personal Team" for you. Its team id is the `OU` of your "Apple Development" certificate:

```bash
security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
```

## 2. Turn on Developer Mode on the iPhone (once)

1. Plug the iPhone into the Mac and tap **Trust** on the phone if it asks.
2. On the iPhone: Settings › Privacy & Security › **Developer Mode** › on. (The switch only
   appears once Xcode has seen the phone.)
3. The phone restarts. After it unlocks, tap **Turn On** and enter your passcode.

## 3. Build and install

From the repository, with your team id and the phone's id (`xcrun devicectl list devices`):

```bash
cd ios && mise exec xcodegen@2.46.0 -- xcodegen generate
```

```bash
xcodebuild -project ios/ValetPhone.xcodeproj -scheme ValetPhone -configuration Debug -destination 'id=<PHONE_ID>' -derivedDataPath ios/build/dd -allowProvisioningUpdates -allowProvisioningDeviceRegistration CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_IDENTITY="Apple Development" build
```

```bash
xcrun devicectl device install app --device <PHONE_ID> "ios/build/dd/Build/Products/Debug-iphoneos/ValetPhone.app"
```

The first build may ask for your login keychain password, so Xcode can use the signing key:
choose **Always Allow**.

## 4. Trust the developer profile (once per install from a new certificate)

The first time, iOS refuses to open the app ("Untrusted Developer"). On the iPhone: Settings ›
General › **VPN & Device Management** › your Apple ID under "Developer App" › **Trust**.

## 5. Run the Mac app with its helpers

The Mac app needs its Swift helpers (`swift-bridge`): they hold the Mac's approval keys and the
Keychain anchor of its trusted approvals store. Without them it can't open that store, so it locks
itself down and can't pair.

The development package builds them and puts them inside the app. It refuses to finish without
them:

```bash
pnpm --filter @valet/desktop package --target dir
open "apps/desktop/dist/mac-arm64/Valet Dev.app"
```

Or run it unpackaged from the repository, after building the debug helpers:

```bash
cd swift-bridge && swift build
```

```bash
cd apps/desktop && pnpm exec electron-vite build && pnpm exec electron .
```

Both use the same data folder (`~/Library/Application Support/Valet Dev`). The first time the
package's helper reads the Keychain items the unpackaged run made, macOS asks to allow it: choose
**Always Allow**. If the package can't use the approval key the unpackaged run made, it shows the
lockdown or the phone as unpaired. Then pair the iPhone again (Settings › Devices).

Approve the Touch ID prompt when it starts: the Mac signs its relay key with it.

## 6. Point the Mac at the relay

In Valet on the Mac: Settings › Devices › **Relay**, type the relay's host name, and **Save**. The
line under it should say "Connected to the relay".

## 7. Pair with the QR code

1. On the Mac: Settings › Devices › **Pair an iPhone**. A QR code appears.
2. On the iPhone, open Valet. It shows "Pair with your Mac" and asks to use the camera. Scan the
   code.
3. The phone shows six digits. The Mac shows three codes: pick the one that matches the phone. If
   none match, choose **None of these**, and nothing is paired.
4. The Mac lists the phone under "Paired phones".

Pairing makes keys on the phone that never leave it. Approving a card asks for Face ID, or your
passcode.

## 8. Every 7 days: install again

With a free account the app stops opening 7 days after it was signed. Your pairing is kept in the
phone's Keychain, so you don't need to pair again: plug the phone in and run step 3 again. If the
certificate changed, trust it again (step 4).

If an install ever does lose the pairing, unpair the phone on the Mac (Settings › Devices) and pair
again.

## No notifications

A free account can't use push, so the phone never alerts you. When an agent asks for something,
the Mac shows it, and the phone shows it the next time you open Valet there.
