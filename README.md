# Scout Desktop

> **One-click downloads → https://tacodepapel.github.io/Scout-Desktop**
> The landing page auto-detects Mac (Apple Silicon / Intel), Windows, or Linux and serves the right installer. Share this URL — no GitHub navigation needed.

---

## What's New

**June 27, 2026 — v2.3.0**
- **Macro Mode — record and replay your clicks and keystrokes, no sign-in needed.** New "Macros" tab. Hit the big record button (or `Alt+Shift+K` from anywhere), do whatever you want — fill a form, click through a checkout, navigate an app — then hit it again to save. Every saved macro gets a `▶ Run with AI` button that replays the exact sequence at the original speed. Scout minimizes itself, counts down 3 → 2 → 1, then drives your mouse and keyboard.
- **Local-only, offline.** Macros live as plain JSON in your user-data folder. Nothing touches Supabase. Recording works whether you're signed in or not.
- **Active-window awareness.** Recorded skills now know which app and window were focused when you started and stopped, so the AI-generated guide can mention the app/route by name.
- **Bail-out hotkey.** `Alt+Shift+Esc` aborts any macro mid-replay if it starts going somewhere you don't want.

**June 7, 2026 — v2.2.0**
- **Quality pass across the whole app.** Tightened copy in the UI, sharper log messages, cleaner comments, and a refreshed download page. No behavior changes — every feature works the same, just nicer to read and easier to follow.
- **Docs refresh.** README, release notes, and the public download page are now consistent with the current feature set and the latest version on disk.
- **Housekeeping.** Updated copyright year, cleaned up a few stale lines in `main.js` and `renderer.js`, and synced product strings across `package.json`, the marketing page, and the in-app About text.

**June 1, 2026 — v2.1.3**
- **Starter task pack in the Agent tab.** Six clickable starters tuned for service-business work — tidy Downloads, set up a client project, audit a website, research a prospect, weekly recap, summarize notes. Click one and the textarea fills with a real prompt you can edit before running. No more staring at a blank box.
- **Native OS notification when the background agent finishes.** Walk away while Scout works; when it's done you get a system notification with a one-line summary. Clicking it brings Scout to the front. Suppressed if the Scout window is already focused.
- **"Scout" name on Windows notifications.** App user-model ID set so notifications and taskbar entries identify as Scout, not generic Electron.

**June 1, 2026 — v2.1.2**
- **Friendly download names.** The Releases page now shows plain `Scout Mac.dmg`, `Scout Windows.exe`, `Scout Linux.AppImage`, `Scout Linux.deb` instead of cryptic versioned filenames.
- **One Mac file for everyone.** The macOS build is now a **universal binary** — same file runs on Apple Silicon and Intel Macs. No more "which chip do I have?" decision.

**June 1, 2026 — v2.1.1**
- **Public download page.** One short URL works on any device: `tacodepapel.github.io/Scout-Desktop`. Detects your OS and shows the right download button.
- **Stable release-asset URLs.** Filenames no longer include the version number, so the landing-page links keep working through every future release.
- **Polished macOS tray icon.** Monochrome template image that auto-tints for the menu bar (white on dark, black on light) instead of the old colored blob.
- **Renderer-side agent is fully OS-aware** too — no more leftover "PowerShell on Windows" assumptions in the legacy code path.

**June 1, 2026 — v2.1.0**
- **Scout now runs on macOS and Linux.** No more Windows-only. Universal `.dmg` for Mac (Intel + Apple Silicon), `.AppImage` and `.deb` for Linux, alongside the existing Windows installer.
- **The agent is OS-aware.** It detects whether it's running on Windows, macOS, or Linux and uses the right shell automatically — PowerShell on Windows, your default shell (bash/zsh) on Mac and Linux. No more PowerShell commands failing on Mac.
- **Agent gets a sharper system prompt.** Rewritten to push Claude toward ambitious, real-world tasks ("set up a project and push it to GitHub") instead of toy ones ("open a folder"). The agent now knows everything it can do, with concrete examples.
- **New `open_app` tool.** Launches any installed native app cross-platform — Slack, Notion, VS Code, Finder/Explorer, etc.
- **Shell commands can take their time.** The bash timeout went from 60 seconds to 5 minutes so the agent can run real builds, installs, and scripts.
- **GitHub Actions release pipeline.** Pushing a `v*` tag automatically builds binaries for all three OSes and publishes a release.

**May 28, 2026**
- **Agent runs on Claude Sonnet 4.6.** The `agent-run` edge function now uses the latest model — faster responses and better tool use.
- **Agent endpoint is now protected.** The edge function requires a valid session token, so only authenticated Scout users can invoke it.
- **Monitor uses less memory.** Screen frames are now stored as JPEG instead of PNG — about 10× smaller per frame, so the 5-minute buffer takes ~600 KB instead of ~6 MB.
- **Malformed MCP config now warns instead of silently failing.** If `~/.claude.json` exists but can't be parsed, Scout logs a warning on startup so you know to fix it.

**May 27, 2026 — v2.0.0**
- **Scout now runs in the background.** Start a task in the Agent tab and Scout handles it while you keep using your computer normally. You don't have to wait, watch, or babysit it. When it's done, the result appears and a skill guide is saved automatically.
- **Scout watches your screen.** The new Monitor tab takes a screenshot of your desktop every 10 seconds and keeps the last 5 minutes of activity. Nothing is uploaded — it all stays on your machine. When something interesting happens, you can turn it into a skill in one click.
- **The agent can use any tool you give it.** Scout now connects to MCP servers — the same ones Claude Code uses — so it can talk to Slack, GitHub, Notion, Linear, or any other tool your team uses. Add servers to your `~/.claude.json` file and Scout picks them up automatically on launch.
- **Scout can see the whole screen, not just a browser.** A new desktop screenshot tool lets the AI see what's on your screen at any moment — not just what's in the controlled browser window. It can react to what's actually happening.
- **Scout lives in your system tray.** Even when you close the window, Scout keeps running as long as the agent or monitor is active. Right-click the tray icon to check status, stop a task, or quit.
- **New global shortcut for the monitor.** `Alt + Shift + M` starts and stops screen monitoring from anywhere on your desktop — no need to open the app.
- **Scout can now do things for you.** There's an Agent tab. Type what you want done and Claude executes it: terminal commands, file operations, browser automation.
- **Passwords and API keys are handled safely.** If the AI encounters a credential during a task, it asks before saving anything. You approve every entry before it touches your `.env` file.
- **Every task becomes a guide.** Whether you record yourself or let the AI do it, Scout turns every session into a reusable Markdown skill file saved to your library.

---

> **Your AI teammate that lives on your computer.**
> Record what you do and Scout turns it into a step-by-step skill guide — or just tell Scout what you want done and it handles it for you, hands-off.

---

## Download

**The easy way: open [tacodepapel.github.io/Scout-Desktop](https://tacodepapel.github.io/Scout-Desktop) on the computer you want to install Scout on.** The page auto-detects your OS and gives you one download button. Done.

**Direct links** (stable across versions — `latest` always resolves to the newest release):

| Platform | File on GitHub Releases |
|---|---|
| **macOS** (Intel + Apple Silicon, universal) | [Scout Mac.dmg](https://github.com/TacoDePapel/Scout-Desktop/releases/latest/download/Scout%20Mac.dmg) |
| **Windows** 10 / 11 | [Scout Windows.exe](https://github.com/TacoDePapel/Scout-Desktop/releases/latest/download/Scout%20Windows.exe) |
| **Linux** (AppImage) | [Scout Linux.AppImage](https://github.com/TacoDePapel/Scout-Desktop/releases/latest/download/Scout%20Linux.AppImage) |
| **Linux** (Debian/Ubuntu) | [Scout Linux.deb](https://github.com/TacoDePapel/Scout-Desktop/releases/latest/download/Scout%20Linux.deb) |

> Scout has no iOS or Android version — it's a desktop app and the underlying tech (Electron) can't target mobile. The Mac build runs on iPhones/iPads through... it doesn't. Use a Mac, PC, or Linux computer.

### First launch on macOS

Scout's Mac build is **unsigned** (no Apple Developer ID — yet), so macOS Gatekeeper will refuse to open it the first time. One-time fix:

```bash
xattr -cr /Applications/Scout.app
```

Then double-click Scout normally. After that, it launches without any warning. (If you'd rather skip the terminal: right-click the app → **Open** → **Open** in the dialog. Either works.)

You'll be asked for permissions for microphone, screen recording, and accessibility the first time you use those features — these are required for recording, the screen monitor, and the agent's `screenshot_desktop` tool. Grant them in **System Settings → Privacy & Security**.

---

## What Scout Does

Scout is an AI-powered desktop agent for teams. It does two things:

1. **Record yourself doing a task** → Scout captures your screen and voice, then writes a clean step-by-step skill guide your AI can follow later.
2. **Tell Scout what you want done** → Scout's built-in Claude agent executes the task on your computer autonomously — terminal, files, browser, APIs — and turns the session into a skill automatically.

---

## Features

### Agent Mode
Scout has a full AI agent powered by Claude that operates your computer — in the background, while you keep working:

- **Terminal** — runs any shell command (PowerShell on Windows, bash/zsh on macOS/Linux), scripts, git, npm, Python, and more
- **Native apps** — opens any installed app (Slack, Notion, VS Code, Finder/Explorer, etc.) cross-platform
- **File system** — reads, writes, creates, and organizes files anywhere on your machine
- **Browser** — opens URLs, takes screenshots, clicks buttons, fills forms, and scrapes pages
- **Desktop screenshots** — sees your full screen at any moment to react to what's actually on it
- **MCP servers** — connects to any MCP server in your `~/.claude.json` (GitHub, Slack, Notion, Linear, etc.)
- **Background execution** — runs in the main process so closing or minimizing the Scout window doesn't stop the task
- **Live feed** — every action streams to the UI: what Claude is thinking, what ran, what came back
- **Auto-skill** — every completed session is automatically turned into a Markdown skill guide in your Library
- **Credential detection** — after each session, Claude scans for API keys or passwords and asks before saving to `.env`

### Screen Monitor (New)
- Passively watches your desktop — takes a screenshot every 10 seconds
- Stores the last 30 frames (5 minutes of activity) locally — nothing uploaded unless you choose to act on it
- Live thumbnail feed visible in the Monitor tab
- Toggle with `Alt + Shift + M` from anywhere on your desktop
- Layer voice recording on top at any time to generate a full skill from the captured session

### MCP Integration (New)
- Reads MCP server config from `~/.claude.json` (same file Claude Code uses — no duplicate setup)
- Connects to each configured server on launch via the MCP JSON-RPC protocol
- Exposes all server tools to the agent automatically
- Shows connected servers and tool counts in the Settings tab

### Recording
- Record any screen or window via a live source picker with thumbnail previews
- Microphone audio captured alongside screen — toggle mic on/off in Settings
- Two recording modes: **Skill** (how-to guide) or **Improvement** (process critique)
- Global keyboard shortcut **Alt + Shift + R** starts or stops a recording from anywhere — no need to switch back to the app
- Add optional context notes before stopping to help the AI focus

### AI Processing Pipeline
After you stop recording, Scout runs a three-stage pipeline automatically:

1. **Upload** — audio is securely uploaded to cloud storage
2. **Transcribe** — Gemini Flash converts speech to text
3. **Draft** — Claude generates a formatted Markdown skill guide, streamed live so you see it appear word by word

### Skill Library
- Every generated skill — from recordings and agent sessions — is saved to your personal library
- Browse and re-read past skills from the Library tab
- Download any individual skill as a `.md` file
- Export all skills at once as a `.zip` archive

### Authentication
- Sign in with your email only — no password ever required
- A 6-digit one-time code is sent to your inbox
- Session is remembered between app restarts — sign in once and stay signed in

### Settings
- Toggle microphone on/off
- Switch between Skill and Improvement recording modes
- Sign out

### System Integration
- Single-instance: only one Scout window ever runs at a time
- **System tray** — Scout lives in the tray when minimized; right-click for status and controls
- Global shortcut `Alt + Shift + R` — toggle recording from anywhere
- Global shortcut `Alt + Shift + M` — toggle screen monitor from anywhere
- Background persistence — closing the window does not stop an active agent or monitor
- OS-native Save dialogs for exporting files
- One-click Windows installer — creates desktop and Start Menu shortcuts, launches automatically after install
- Universal macOS `.dmg` (Intel + Apple Silicon) — drag to Applications and launch
- Linux `.AppImage` and `.deb` packages

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 35 |
| AI agent | Claude Sonnet 4.6 via Supabase Edge Function (`agent-run`) · SSE streaming · tool use · JWT-verified |
| Agent execution | Main process (Node.js 22 native `fetch`) — survives window close |
| Agent tools | Platform-aware shell (PowerShell on Windows, bash/zsh on macOS/Linux) · Node.js fs · Electron BrowserWindow · desktopCapturer · cross-platform `open_app` |
| MCP integration | JSON-RPC over stdio · reads `~/.claude.json` automatically |
| Screen monitor | `desktopCapturer` at 10s interval · up to 30 JPEG frames in memory (~600 KB) |
| System tray | Electron `Tray` + `Menu` · status indicator + quick controls |
| AI transcription | Gemini Flash (via Supabase Edge Function) |
| AI skill generation | Claude (via Supabase Edge Function, SSE streaming) |
| Backend / Auth / Storage | Supabase (Postgres + Storage + Auth) |
| Credential vault | `.env` file · AI-assisted detection · user approval required |
| Packaging | electron-builder · NSIS (Windows) · DMG + ZIP (macOS, universal) · AppImage + deb (Linux) · GitHub Actions cross-platform CI |

---

## Development

```bash
npm install
npm start                  # run in dev mode (any OS)

npm run dist:win           # Windows installer → dist/Scout Setup x.x.x.exe
npm run dist:mac           # macOS dmg + zip   → dist/Scout-x.x.x.dmg (run on macOS)
npm run dist:linux         # Linux AppImage + deb → dist/Scout-x.x.x.AppImage (run on Linux)
npm run dist               # build for the current platform
```

Requires Node.js 18+. Each platform installer must be built on its matching OS (the GitHub Actions workflow at `.github/workflows/release.yml` does this automatically — push a `v*` tag and a multi-platform release is built and published).

### Deploying the Agent Edge Function

The agent requires a Supabase edge function and an Anthropic API key:

```bash
# 1. Login to Supabase CLI
npx supabase login

# 2. Deploy the function (JWT verification enabled by default)
npx supabase functions deploy agent-run --project-ref wmicxsafqbixedpjhchc

# 3. Set the Anthropic API key secret in Supabase dashboard:
#    Edge Functions → Secrets → Add → ANTHROPIC_API_KEY
```

---

## Hosting the download page (one-time setup)

The download landing page lives at `docs/index.html` in this repo and is served free via GitHub Pages.

**To turn it on** (only needs to be done once per repo):
1. Go to **Settings → Pages** on the GitHub repo.
2. Under **Build and deployment → Source**, pick **Deploy from a branch**.
3. Choose **Branch:** `main`, **Folder:** `/docs`, then **Save**.
4. Wait ~1 minute. The page becomes live at https://tacodepapel.github.io/Scout-Desktop.

After that, any change you push to `docs/index.html` redeploys automatically. To use a custom domain later (e.g. `scout.orage.agency`), add a CNAME DNS record pointing to `tacodepapel.github.io` and create a `docs/CNAME` file containing the domain.

---

## License

Copyright © 2026 Orage AI Agency
