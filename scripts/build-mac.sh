#!/usr/bin/env bash
#
# Build a signed + notarized Scout DMG for macOS distribution.
# RUN THIS ON A MAC — macOS builds cannot be produced on Linux/Windows.
#
# Prerequisites (one-time):
#   1. Apple Developer Program membership ($99/yr).
#   2. A "Developer ID Application" certificate installed in your login
#      keychain (Xcode → Settings → Accounts → Manage Certificates → +).
#   3. An app-specific password for notarization:
#      appleid.apple.com → Sign-In and Security → App-Specific Passwords.
#
# Set these before running (do NOT commit them):
#   export APPLE_ID="you@example.com"
#   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   export APPLE_TEAM_ID="ABCDE12345"      # from developer.apple.com → Membership
#
# Then:
#   ./scripts/build-mac.sh
#
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: macOS builds must run on a Mac. You are on $(uname)." >&2
  exit 1
fi

for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: $v is not set. See the header of this script." >&2
    exit 1
  fi
done

echo "→ Installing dependencies…"
npm install

echo "→ Building, signing and notarizing the universal DMG…"
# CSC_IDENTITY_AUTO_DISCOVERY lets electron-builder find your Developer ID cert.
# notarize=true makes electron-builder submit to Apple's notary service using
# the APPLE_* env vars checked above.
export CSC_IDENTITY_AUTO_DISCOVERY=true
npm run gen-icon
npx electron-builder --mac dmg zip --publish never --config.mac.notarize=true

echo ""
echo "✓ Done. Artifacts are in dist/:"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null || true
echo ""
echo "Verify the signature and notarization before shipping:"
echo "  codesign --verify --deep --strict --verbose=2 'dist/mac-universal/Scout.app'"
echo "  spctl -a -vvv -t install 'dist/mac-universal/Scout.app'"
echo "  xcrun stapler validate 'dist/Scout Mac.dmg'"
