#!/bin/bash
# Scout — one-click install for the Mac test drive.
# Mounts the DMG sitting next to this file, copies Scout into Applications,
# clears the Gatekeeper quarantine flag, and launches it.

cd "$(dirname "$0")"

say_dialog() {
  osascript -e "display dialog \"$1\" with title \"Scout\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1
}

DMG="Scout Mac.dmg"
if [ ! -f "$DMG" ]; then
  say_dialog "Couldn't find 'Scout Mac.dmg' next to this file. Keep both files in the same folder and try again."
  exit 1
fi

echo "→ Mounting $DMG…"
MOUNT=$(hdiutil attach -nobrowse -readonly "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')
if [ -z "$MOUNT" ] || [ ! -d "$MOUNT/Scout.app" ]; then
  say_dialog "Couldn't open the Scout disk image. Try double-clicking 'Scout Mac.dmg' yourself and dragging Scout into Applications."
  exit 1
fi

echo "→ Copying Scout into /Applications…"
rm -rf "/Applications/Scout.app"
if ! cp -R "$MOUNT/Scout.app" /Applications/; then
  hdiutil detach "$MOUNT" -quiet
  say_dialog "Couldn't copy Scout into Applications (permission problem?). Open 'Scout Mac.dmg' and drag Scout into Applications manually."
  exit 1
fi
hdiutil detach "$MOUNT" -quiet

echo "→ Removing the Gatekeeper quarantine flag…"
xattr -dr com.apple.quarantine /Applications/Scout.app 2>/dev/null

echo "→ Launching Scout…"
open /Applications/Scout.app

say_dialog "Scout is installed and opening now.

When you first record something, macOS will ask for a couple of permissions (Accessibility, Screen Recording) — allow them, and quit + reopen Scout after enabling Screen Recording.

You can eject the installer — Scout lives in Applications now."
exit 0
