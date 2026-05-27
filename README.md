# Scout Desktop

## What's New

**May 26, 2026 — v2.0**
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
> Record what you do and Scout turns it into a skill guide — or just tell Scout what you want done and it handles it for you.

---

## Download

**[Download Scout Setup 1.0.0.exe](https://github.com/TacoDePapel/Scout-Desktop/releases/latest)**

Double-click the installer. Scout installs silently and opens automatically.
Windows 10/11 · x64

---

## What Scout Does

Scout is an AI-powered desktop agent for teams. It does two things:

1. **Record yourself doing a task** → Scout captures your screen and voice, then writes a clean step-by-step skill guide your AI can follow later.
2. **Tell Scout what you want done** → Scout's built-in Claude agent executes the task on your computer autonomously — terminal, files, browser, APIs — and turns the session into a skill automatically.

---

## Features

### Agent Mode
Scout has a full AI agent powered by Claude that operates your computer — in the background, while you keep working:

- **Terminal** — runs any PowerShell command, scripts, git, npm, Python, and more
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

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 35 |
| AI agent | Claude via Supabase Edge Function (`agent-run`) · SSE streaming · tool use |
| Agent execution | Main process (Node.js 22 native `fetch`) — survives window close |
| Agent tools | PowerShell · Node.js fs · Electron BrowserWindow · desktopCapturer |
| MCP integration | JSON-RPC over stdio · reads `~/.claude.json` automatically |
| Screen monitor | `desktopCapturer` at 10s interval · up to 30 frames in memory |
| System tray | Electron `Tray` + `Menu` · status indicator + quick controls |
| AI transcription | Gemini Flash (via Supabase Edge Function) |
| AI skill generation | Claude (via Supabase Edge Function, SSE streaming) |
| Backend / Auth / Storage | Supabase (Postgres + Storage + Auth) |
| Credential vault | `.env` file · AI-assisted detection · user approval required |
| Packaging | electron-builder · NSIS installer |

---

## Development

```bash
npm install
npm start          # run in dev mode
npm run dist       # build installer → dist/Scout Setup x.x.x.exe
```

Requires Node.js 18+ and Windows (for the installer target).

### Deploying the Agent Edge Function

The agent requires a Supabase edge function and an Anthropic API key:

```bash
# 1. Login to Supabase CLI
npx supabase login

# 2. Deploy the function
npx supabase functions deploy agent-run --project-ref wmicxsafqbixedpjhchc --no-verify-jwt

# 3. Set the Anthropic API key secret in Supabase dashboard:
#    Edge Functions → Secrets → Add → ANTHROPIC_API_KEY
```

---

## License

Copyright © 2025 Orage AI Agency
