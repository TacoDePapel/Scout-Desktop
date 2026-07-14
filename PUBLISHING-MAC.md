# Publishing Scout for macOS

## Read this first: the Mac App Store is not an option for Scout

Scout's core features are **incompatible with the Mac App Store**, and no amount
of configuration changes that. The App Store requires every app to run inside a
strict sandbox that **forbids exactly what Scout does**:

| Scout feature | Why the App Store rejects it |
| --- | --- |
| Global keyboard/mouse recording (`uiohook-napi`) | System-wide input capture is banned in the sandbox — it's treated as keylogging. |
| Replaying input / driving other apps (`nut-js`) | Synthesizing input into other applications is not permitted. |
| Background agent shell tools (`bash`, arbitrary file access) | Sandboxed apps can only touch their own container, not run arbitrary commands. |
| Screen capture of other apps | Only through narrow, user-gated APIs — not the way Scout uses it. |

Apple reviewers reject apps with these capabilities. This is a **policy wall, not
a technical one.** Submitting a Mac App Store build would waste the review cycle.

## The right way to ship Scout on Mac: a notarized DMG

This is how virtually every serious desktop-automation tool (Raycast, Rewind,
BetterTouchTool, keyboard managers, etc.) distributes on Mac. You sign the app
with your **Apple Developer ID**, Apple **notarizes** it, and users download a
DMG from your site. It installs cleanly with no scary warnings, and Scout keeps
all its capabilities.

### What you need (one-time)

1. **Apple Developer Program** membership — $99/year, https://developer.apple.com/programs/
2. A **Developer ID Application** certificate in your login keychain.
   Xcode → Settings → Accounts → Manage Certificates → **+** → *Developer ID Application*.
3. An **app-specific password** for notarization.
   https://appleid.apple.com → Sign-In and Security → App-Specific Passwords.
4. Your **Team ID** — https://developer.apple.com/account → Membership Details.
5. **A Mac.** macOS builds cannot be produced on Linux or Windows.

### Build it

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"

# In package.json → build.mac, remove the line:  "identity": null,
# (that line forces an UNSIGNED build for local testing; removing it lets
#  electron-builder auto-detect your Developer ID certificate.)

./scripts/build-mac.sh
```

The signed, notarized `Scout Mac.dmg` lands in `dist/`.

### Verify before shipping

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-universal/Scout.app"
spctl -a -vvv -t install "dist/mac-universal/Scout.app"    # should say: accepted, Notarized Developer ID
xcrun stapler validate "dist/Scout Mac.dmg"
```

### First-launch permissions (expected, normal)

On first run each user grants two macOS permissions — this is standard for any
automation app and happens through the normal system prompts:

- **Accessibility** (System Settings → Privacy & Security → Accessibility) — to
  record and replay input.
- **Screen Recording** — for screenshots and the screen monitor.

The `build/entitlements.mac.plist` and the `NS*UsageDescription` strings in
`package.json` are already set up so these prompts appear correctly.

## Distributing the DMG

- Host `Scout Mac.dmg` on your site / GitHub Releases.
- Optional auto-updates: electron-builder can generate `latest-mac.yml` for
  `electron-updater`. Not wired up yet — ask if you want it.

## If you still want to *try* the App Store anyway

You'd have to strip Scout down to a shell of itself: remove `uiohook-napi` and
`nut-js` (no record/replay), remove the agent's `bash`/file tools (no shell
automation), and enable full App Sandbox with a `mas` target and provisioning
profile. At that point it isn't Scout anymore. Not recommended — ship the DMG.

---

*Current config: `build.mac` uses Hardened Runtime + `build/entitlements.mac.plist`
(required for notarization) and builds a universal (Intel + Apple Silicon) binary.
`identity: null` is set so `npm run dist:mac` produces an unsigned app for local
testing until you're ready to sign.*
