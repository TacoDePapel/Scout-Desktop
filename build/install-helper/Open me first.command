#!/bin/bash
# Scout — one-time Gatekeeper unblock + launch.
# Double-click this after dragging Scout into Applications.

APP="/Applications/Scout.app"

if [ ! -d "$APP" ]; then
  osascript -e 'tell application "System Events" to display dialog "Drag Scout into your Applications folder first, then double-click this file again." with title "Scout" buttons {"OK"} default button "OK"' >/dev/null 2>&1
  exit 1
fi

xattr -dr com.apple.quarantine "$APP" 2>/dev/null
open "$APP"
exit 0
