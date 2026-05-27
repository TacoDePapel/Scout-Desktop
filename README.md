# Scout Desktop

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

### Agent Mode (New)
Scout has a full AI agent powered by Claude that can operate your computer:

- **Terminal** — runs any PowerShell command, scripts, git, npm, Python, and more
- **File system** — reads, writes, creates, and organizes files anywhere on your machine
- **Browser** — opens URLs, takes screenshots, clicks buttons, fills forms, and scrapes pages using a controlled Electron browser window
- **Live feed** — every action streams to the UI in real time: what Claude is thinking, what command it ran, what came back
- **Auto-skill** — every completed agent session is automatically turned into a reusable Markdown skill guide in your Library
- **Credential detection** — after each session, Claude scans for any API keys, passwords, or tokens it encountered and asks if you want them saved to an encrypted `.env` file

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
- Global shortcut (Alt + Shift + R) works even when the app is minimized or in the background
- OS-native Save dialogs for exporting files
- One-click Windows installer — creates desktop and Start Menu shortcuts, launches automatically after install

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 35 |
| AI agent | Claude via Supabase Edge Function (`agent-run`) · SSE streaming · tool use |
| Agent tools | PowerShell · Node.js fs · Electron BrowserWindow (no extra deps) |
| AI transcription | Gemini Flash (via Supabase Edge Function) |
| AI skill generation | Claude (via Supabase Edge Function, SSE streaming) |
| Backend / Auth / Storage | Supabase (Postgres + Storage + Auth) |
| Credential vault | Encrypted `.env` file · AI-assisted detection |
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
