#!/usr/bin/env bash
# A live check of Valet's secure store on a provisioned Mac, after build-helper-apps.sh. Not a test:
# the suites never touch the real Keychain. This touches only a probe item (service valet.probe),
# which it removes again, and reads the device keys' public halves.
#
# It fails if any step takes longer than a few seconds, which is what a Keychain prompt looks like
# from here, or if the probe lands in the classic Keychain instead of the protected one.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
apps="$here/.build/apps/Debug"
keychain="$apps/Valet Keychain.app/Contents/MacOS/valet-keychain"
approver="$apps/Valet Approver.app/Contents/MacOS/valet-approver"
account="probe-$$"
failures=0

step() { # step <name> <seconds> <command...>
  local name=$1 seconds=$2
  shift 2
  if perl -e 'alarm shift; exec @ARGV' "$seconds" "$@" >/dev/null 2>&1; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $?; a timeout means the Keychain asked for permission)"
    failures=$((failures + 1))
  fi
}

where="$(perl -e 'alarm 5; exec @ARGV' "$keychain" store)"
case "$where" in
  "protected "*.me.dncr.valet.dev.keys) echo "ok   store: $where" ;;
  *) echo "FAIL store: $where (expected the protected store; is the profile embedded?)"; exit 1 ;;
esac

step "write a probe" 5 sh -c "printf probe | '$keychain' write valet.probe $account 'live check'"
step "read it back" 5 sh -c "test \"\$('$keychain' read valet.probe $account)\" = probe"
step "read its comment" 5 sh -c "test \"\$('$keychain' info valet.probe $account)\" = 'live check'"
if security find-generic-password -s valet.probe -a "$account" >/dev/null 2>&1; then
  echo "FAIL the probe is in the classic Keychain"
  failures=$((failures + 1))
else
  echo "ok   not in the classic Keychain"
fi

# A rebuild is a new binary with the same signature: it must read the same item without asking.
copy="$(mktemp -d)/Valet Keychain.app"
cp -R "$apps/Valet Keychain.app" "$copy"
identity="$(codesign -dvv "$apps/Valet Keychain.app" 2>&1 | sed -n 's/^Authority=\(Apple Development: .*\)$/\1/p' | head -1)"
entitlements="$(mktemp)"
codesign -d --entitlements - --xml "$apps/Valet Keychain.app" >"$entitlements" 2>/dev/null
codesign --force --sign "$identity" --entitlements "$entitlements" --options runtime "$copy" >/dev/null 2>&1
step "a re-signed copy reads it" 5 sh -c "test \"\$('$copy/Contents/MacOS/valet-keychain' read valet.probe $account)\" = probe"
rm -rf "$(dirname "$copy")" "$entitlements"

step "delete the probe" 5 "$keychain" delete valet.probe "$account"
step "the Mac's device keys" 10 "$approver" keys

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
