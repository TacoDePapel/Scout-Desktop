# Scout Desktop

> **Record your screen. Get an AI-written skill guide. Done.**
> No setup, no passwords, no configuration — open the app, type your email, and start recording.

---

## Download

**[Download Scout Setup 1.0.0.exe](https://github.com/TacoDePapel/Scout-Desktop/releases/latest)**

Double-click the installer. Scout installs silently and opens automatically.
Windows 10/11 · x64

---

## What Scout Does

Scout is an AI-powered workflow capture tool for teams. You record yourself doing something on your computer — the app captures your screen and mic audio — and Scout automatically generates a clean, structured skill guide in Markdown.

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
- Every generated skill is saved to your personal library
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
| AI transcription | Gemini Flash (via Supabase Edge Function) |
| AI skill generation | Claude (via Supabase Edge Function, SSE streaming) |
| Backend / Auth / Storage | Supabase (Postgres + Storage + Auth) |
| Packaging | electron-builder · NSIS installer |

---

## Development

```bash
npm install
npm start          # run in dev mode
npm run dist       # build installer → dist/Scout Setup x.x.x.exe
```

Requires Node.js 18+ and Windows (for the installer target).

---

## License

Copyright © 2025 Orage AI Agency
