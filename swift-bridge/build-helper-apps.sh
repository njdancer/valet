#!/usr/bin/env bash
# Builds valet-approver and valet-keychain as signed development app bundles that can open Valet's
# secure store (the data protection Keychain, access group <team>.me.dncr.valet.dev.keys), and
# "Valet Reader" (the Mail and Messages reader, given Full Disk Access by name), into
# swift-bridge/.build/apps/Debug. Xcode creates the development App IDs and profiles itself
# (-allowProvisioningUpdates), which needs an Apple ID signed in under Xcode › Settings › Accounts.
#
#   VALET_TEAM_ID=<team> swift-bridge/build-helper-apps.sh
#   swift-bridge/build-helper-apps.sh --unsigned   # CI: the same bundles, unsigned, no group
#
# Set VALET_TEAM_ID in mise.local.toml ([env]). The app finds the bundles there before the plain
# binaries (apps/desktop/src/main/electron/app.ts, nativeHelper).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/apps"
if [ "${1:-}" = "--unsigned" ]; then
  VALET_TEAM_ID="" xcodegen --quiet
  xcodebuild -project ValetHelpers.xcodeproj -configuration Debug -alltargets \
    SYMROOT="$here/.build/apps" CODE_SIGNING_ALLOWED=NO build -quiet
  echo "built unsigned: $here/.build/apps/Debug"
  exit 0
fi
: "${VALET_TEAM_ID:?set VALET_TEAM_ID, e.g. in mise.local.toml}"
xcodegen --quiet
xcodebuild -project ValetHelpers.xcodeproj -configuration Debug -alltargets \
  -allowProvisioningUpdates SYMROOT="$here/.build/apps" build -quiet
for app in "Valet Approver" "Valet Keychain"; do
  bundle="$here/.build/apps/Debug/$app.app"
  codesign --verify --strict "$bundle"
  test -f "$bundle/Contents/embedded.provisionprofile"
done
codesign --verify --strict "$here/.build/apps/Debug/Valet Reader.app"
echo "built: $here/.build/apps/Debug/{Valet Approver,Valet Keychain,Valet Reader}.app"
