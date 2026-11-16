#!/usr/bin/env bash
# Builds the debug helpers and signs them with a developer's own certificate, so the Keychain
# recognises them across rebuilds instead of asking for permission after every build (an ad hoc
# signature changes with each build). Debug builds skip the caller check, so an unsigned
# development Electron can still use them (ValetHelperKit/Caller.swift).
#
#   VALET_DEV_SIGN_IDENTITY="<SHA-1 or name from: security find-identity -v -p codesigning>" \
#     swift-bridge/sign-dev-helpers.sh
#
# Set the identity in mise.local.toml ([env]), which git ignores. Without it, this only builds.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
swift build --package-path "$here"
if [ -z "${VALET_DEV_SIGN_IDENTITY:-}" ]; then
  echo "VALET_DEV_SIGN_IDENTITY is not set: helpers left ad hoc signed" >&2
  exit 0
fi
for helper in valet-approver valet-keychain valet-messages-helper; do
  # A stable identifier, so the Keychain's record of the helper stays the same across builds.
  codesign --force --sign "$VALET_DEV_SIGN_IDENTITY" --identifier "dev.valet.$helper" \
    "$here/.build/debug/$helper"
done
echo "signed: valet-approver valet-keychain valet-messages-helper"
