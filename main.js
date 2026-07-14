const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, dialog, shell, safeStorage, Tray, Menu, nativeImage, Notification, screen } = require('electron')
const path    = require('path')
const fs      = require('fs')
const os      = require('os')
const { exec, spawn, execFile } = require('child_process')
const macro   = require('./lib/macro')

// Disable hardware acceleration unconditionally. Fixes pitch-black windows on:
//   - Windows: certain GPU/driver combos that fail to composite
//   - macOS: Apple Silicon + external displays, ProMotion
//   - Linux: some Mesa drivers
// Minor perf hit from software compositing, but the window actually paints —
// which is the bar for a UI app.
app.disableHardwareAcceleration()

// Single-instance guard
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

let mainWindow     = null
let selectedSourceId = null
let agentBrowser   = null
let tray           = null

// ---- Settings ----

function settingsPath() { return path.join(app.getPath('userData'), 'scout-settings.json') }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } catch { return {} }
}
function writeSettings(data) { fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2)) }

// ---- Push to renderer ----

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data)
}

// ================================================================
// MCP CLIENT
// ================================================================

class MCPClient {
  constructor(name) {
    this.name    = name
    this.proc    = null
    this.tools   = []
    this.pending = new Map()
    this.nextId  = 1
    this.buf     = ''
  }

  start(command, args, env) {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(command, args, {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        })

        this.proc.stdout.on('data', chunk => {
          this.buf += chunk.toString()
          const lines = this.buf.split('\n')
          this.buf = lines.pop()
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const msg = JSON.parse(line)
              if (msg.id != null && this.pending.has(msg.id)) {
                const { res, rej } = this.pending.get(msg.id)
                this.pending.delete(msg.id)
                if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)))
                else res(msg.result)
              }
            } catch {}
          }
        })

        this.proc.stderr.on('data', () => {})
        this.proc.on('error', err => reject(err))
        this.proc.on('close', () => {
          for (const { rej } of this.pending.values()) rej(new Error('MCP process closed'))
          this.pending.clear()
        })

        this._rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'Scout', version: '2.4.1' },
        })
          .then(() => {
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            return this._rpc('tools/list', {})
          })
          .then(r => { this.tools = r?.tools ?? []; resolve() })
          .catch(reject)
      } catch (e) { reject(e) }
    })
  }

  _rpc(method, params) {
    return new Promise((res, rej) => {
      const id = this.nextId++
      const t  = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`MCP timeout: ${method}`))
      }, 15000)
      this.pending.set(id, {
        res: v  => { clearTimeout(t); res(v) },
        rej: e  => { clearTimeout(t); rej(e) },
      })
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') }
      catch (e) { this.pending.delete(id); clearTimeout(t); rej(e) }
    })
  }

  async callTool(toolName, args) {
    try {
      const r = await this._rpc('tools/call', { name: toolName, arguments: args })
      if (r?.isError) return { error: r.content?.map(c => c.text).join('\n') || 'MCP tool error' }
      return { result: r?.content?.map(c => c.text ?? JSON.stringify(c)).join('\n') ?? '' }
    } catch (e) { return { error: e.message } }
  }

  stop() { try { if (this.proc && !this.proc.killed) this.proc.kill() } catch {} }
}

// ---- MCP Manager ----

const mcpClients = new Map()

async function loadMCPServers() {
  const configPath = path.join(os.homedir(), '.claude.json')
  let raw, config
  try { raw = fs.readFileSync(configPath, 'utf8') } catch { return }
  try { config = JSON.parse(raw) } catch (e) { console.warn('MCP: ~/.claude.json is malformed —', e.message); return }
  const servers = config.mcpServers ?? {}
  for (const [name, conf] of Object.entries(servers)) {
    try {
      const client = new MCPClient(name)
      await client.start(conf.command, conf.args ?? [], conf.env ?? {})
      mcpClients.set(name, client)
      console.log(`MCP [${name}]: connected, ${client.tools.length} tools`)
    } catch (e) {
      console.warn(`MCP [${name}]: failed —`, e.message)
    }
  }
}

function getMCPTools() {
  const tools = []
  for (const [serverName, client] of mcpClients) {
    for (const t of client.tools) {
      tools.push({
        name:         `mcp__${serverName}__${t.name}`,
        description:  `[${serverName}] ${t.description ?? t.name}`,
        input_schema: t.inputSchema ?? { type: 'object', properties: {} },
      })
    }
  }
  return tools
}

async function callMCPTool(fullName, args) {
  const parts      = fullName.split('__')
  const serverName = parts[1]
  const toolName   = parts.slice(2).join('__')
  const client     = mcpClients.get(serverName)
  if (!client) return { error: `MCP server "${serverName}" not connected` }
  return client.callTool(toolName, args)
}

function getMCPStatus() {
  const status = {}
  for (const [name, client] of mcpClients) {
    status[name] = { connected: true, tools: client.tools.map(t => t.name) }
  }
  return status
}

// ================================================================
// BACKGROUND AGENT
// ================================================================

const SUPABASE_URL = 'https://fzcssialkdybftxmpmhm.supabase.co'

// ---- Platform-aware shell ----
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'
const PLATFORM_LABEL = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'
const SHELL_LABEL = IS_WIN ? 'PowerShell' : (process.env.SHELL?.split('/').pop() || 'bash')
const AGENT_SHELL = IS_WIN ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
const BASH_TIMEOUT_MS = 5 * 60 * 1000 // 5 min — real builds, installs, and migrations need real time

const AGENT_TOOLS = [
  {
    name: 'bash',
    description: `Run a shell command on the user's ${PLATFORM_LABEL} computer using ${SHELL_LABEL}. Returns stdout, stderr, and exit code. Use this for git, npm, python, file operations, launching commands, anything available in the terminal. Timeout: 5 minutes.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: `${SHELL_LABEL} command to run` },
        cwd:     { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full text contents of a file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a controlled browser window.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_action',
    description: 'Interact with the open browser: screenshot, get_text, navigate, click, type, wait, eval.',
    input_schema: {
      type: 'object',
      properties: {
        action:   { type: 'string', enum: ['screenshot', 'get_text', 'get_url', 'navigate', 'click', 'type', 'wait', 'eval'] },
        selector: { type: 'string' },
        text:     { type: 'string' },
        script:   { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'screenshot_desktop',
    description: 'Take a screenshot of the full desktop to see what is currently on screen.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'gmail_send',
    description: `One-shot: send an email through Gmail using the user's signed-in Gmail account. This is the PREFERRED way to send email — it opens Gmail's compose URL with prefilled fields and clicks Send in the background. Use this instead of browser_open/browser_action for any "send email" task. If the user is not signed in to Gmail in the Scout Agent Browser, this returns { needsSignin: true } and shows the browser so they can sign in once; after that it just works. Empty subject/body are allowed.`,
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Subject line (may be empty string)' },
        body:    { type: 'string', description: 'Body text (may be empty string)' },
        cc:      { type: 'string', description: 'Optional CC recipients (comma-separated)' },
        bcc:     { type: 'string', description: 'Optional BCC recipients (comma-separated)' },
      },
      required: ['to'],
    },
  },
  {
    name: 'show_agent_browser',
    description: 'Show or hide the Scout Agent Browser window. The browser runs HIDDEN by default — you should call this with {visible:true} ONLY if the page genuinely needs the user (login form requiring a password / 2FA / captcha) and you cannot proceed without them. After they help, call with {visible:false} again so it goes back to background mode. Do NOT show the browser for routine work — that defeats the whole point of background automation.',
    input_schema: {
      type: 'object',
      properties: { visible: { type: 'boolean' } },
      required: ['visible'],
    },
  },
  {
    name: 'open_app',
    description: `Launch a native application by name (cross-platform). On ${PLATFORM_LABEL}, uses ${IS_WIN ? '"start"' : IS_MAC ? '"open -a"' : 'xdg-open / direct exec'}. Examples: "Slack", "Notion", "Visual Studio Code", "Finder", "Explorer".`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App name or path' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional args / file paths to pass to the app' },
      },
      required: ['name'],
    },
  },
]

const AGENT_SYSTEM = `You are Scout Agent, an AI teammate embedded in a desktop app on the user's ${PLATFORM_LABEL} computer. You have full access to their machine and execute real work autonomously.

Environment:
- OS: ${PLATFORM_LABEL} (${process.platform})
- Shell: ${SHELL_LABEL}
- Home: ${os.homedir()}
- Path separator: ${path.sep}

Your tools let you do real things, not toy demos:
- bash — run any shell command (git clone, npm install, python scripts, ffmpeg, curl, file management, etc.)
- read_file / write_file / list_dir — read and modify the file system anywhere on the machine
- open_app — launch installed apps (Slack, Notion, VS Code, Finder, Chrome, etc.)
- gmail_send — ONE-SHOT send an email through the user's Gmail. ALWAYS use this for any email task instead of browser_open/browser_action — it is dramatically faster, more reliable, and costs almost no tokens. Just pass to/subject/body. Empty subject/body is fine.
- browser_open / browser_action — open URLs and automate them (navigate, click, type, screenshot, eval JS). Use this only when no dedicated tool exists for the job (e.g. for non-Gmail sites).
- screenshot_desktop — see exactly what's on the user's screen right now
- MCP tools (prefixed mcp__server__tool) — talk to GitHub, Slack, Notion, Linear, Supabase, and any other MCP server the user has configured

Operating principles:
1. Be ambitious. Real tasks: "set up a new React project and push it to GitHub", "find every PDF in Downloads from this month and summarize them", "open Slack and post a status update", "scrape this site and save the results to CSV". Don't reduce a request to a single trivial command unless that's literally what was asked.
2. Plan in 1-2 sentences, then execute. Show progress as you go — narrate what you're doing between tool calls.
3. Use ${SHELL_LABEL} syntax in bash commands. ${IS_WIN ? 'PowerShell cmdlets like Get-ChildItem, Set-Location, $env:VAR.' : 'POSIX shell — ls, cd, $VAR, /usr/bin paths.'}
4. The Scout Agent Browser runs HIDDEN. The user CANNOT see it and you should not expect them to. Drive it entirely yourself via browser_action: screenshot to see the page, then click/type using CSS selectors. After every action that changes the page, take a screenshot before the next click. Never tell the user to "open the browser and click X" — YOU click X.
5. Only call show_agent_browser({visible:true}) if the page genuinely requires the human (password entry, 2FA code, captcha). If you do, narrate "I need your help with <X>" in a text message so they know. After they're done, call show_agent_browser({visible:false}).
6. If a tool errors, read the error, then try a different approach (don't repeat the same failing call).
7. Touching ~/.env, credential files, or anything outside the user's expected scope? Mention it first.
8. When done, summarize in 2-4 lines: what you accomplished, where the output lives, what's next.`

let bgAgent = {
  running:     false,
  task:        '',
  steps:       [],
  messages:    [],
  startedAt:   0,
  wasStopped:  false,
}

// ---- Agent browser factory ----
//
// Background-first: the window opens HIDDEN. The agent drives it via
// webContents (loadURL, executeJavaScript, capturePage) — none of which
// require the window to be visible. The user sees the agent's narration
// in the Scout main window, not a popup that steals focus.
//
// The user can toggle it visible from the tray menu ("Show Agent Browser")
// if they want to peek or hand-resolve a login / captcha.
//
// We use the DEFAULT session (no `partition`) so any logins the user has
// already performed in earlier Scout versions are preserved.
let agentBrowserVisible = false
function makeAgentBrowser() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    title: 'Scout Agent Browser',
    show: agentBrowserVisible,
    skipTaskbar: !agentBrowserVisible,
    webPreferences: { contextIsolation: true },
  })
  // Real Chrome UA so Google et al. don't refuse interactive sign-in.
  try {
    const ua = win.webContents.getUserAgent()
      .replace(/Scout\/[^ ]+ /, '')
      .replace(/Electron\/[^ ]+ /, '')
    win.webContents.setUserAgent(ua)
  } catch {}
  win.on('closed', () => { agentBrowser = null })
  return win
}

function setAgentBrowserVisible(visible) {
  agentBrowserVisible = !!visible
  if (agentBrowser && !agentBrowser.isDestroyed()) {
    if (visible) {
      try { agentBrowser.setSkipTaskbar(false) } catch {}
      agentBrowser.showInactive()
    } else {
      agentBrowser.hide()
      try { agentBrowser.setSkipTaskbar(true) } catch {}
    }
  }
  updateTray()
}

function notifyAgentDone() {
  try {
    if (!Notification.isSupported || !Notification.isSupported()) return
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return

    const lastText = [...bgAgent.steps].reverse().find(s => s.type === 'text' && s.text)
    const summary  = (lastText?.text?.split('\n').find(l => l.trim()) || bgAgent.task || '')
      .trim().slice(0, 160)
    const seconds  = Math.round((bgAgent.elapsed || 0) / 1000)
    const title    = bgAgent.wasStopped
      ? 'Scout stopped'
      : `Scout finished${seconds ? ` · ${seconds}s` : ''}`

    const iconPath = path.join(__dirname, 'build', 'icon.png')
    const n = new Notification({
      title,
      body:   summary || 'Open Scout to see the result.',
      icon:   fs.existsSync(iconPath) ? iconPath : undefined,
      silent: false,
    })
    n.on('click', () => {
      if (!mainWindow) createWindow()
      else { mainWindow.show(); mainWindow.focus() }
    })
    n.show()
  } catch {}
}

async function executeToolInMain(name, input) {
  if (name.startsWith('mcp__')) return callMCPTool(name, input)

  switch (name) {
    case 'bash': return new Promise(resolve => {
      exec(input.command, { cwd: input.cwd || os.homedir(), timeout: BASH_TIMEOUT_MS, shell: AGENT_SHELL, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0 })
      })
    })

    case 'read_file':
      try { return { content: fs.readFileSync(input.path, 'utf8') } }
      catch (e) { return { error: e.message } }

    case 'write_file':
      try {
        const dir = path.dirname(input.path)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(input.path, input.content, 'utf8')
        return { success: true }
      } catch (e) { return { error: e.message } }

    case 'list_dir':
      try {
        const entries = fs.readdirSync(input.path, { withFileTypes: true })
        return { entries: entries.map(e => ({ name: e.name, isDir: e.isDirectory() })) }
      } catch (e) { return { error: e.message } }

    case 'browser_open': {
      try {
        if (!agentBrowser || agentBrowser.isDestroyed()) {
          agentBrowser = makeAgentBrowser()
        }
        await agentBrowser.loadURL(input.url)
        return { success: true, url: agentBrowser.webContents.getURL() }
      } catch (e) { return { error: e.message } }
    }

    case 'browser_action': {
      if (!agentBrowser || agentBrowser.isDestroyed()) return { error: 'No browser open. Use browser_open first.' }
      const wc = agentBrowser.webContents
      try {
        switch (input.action) {
          case 'screenshot': {
            // Capture and downscale to keep tokens low. JPEG @ 65 is plenty for UI screenshots.
            const img = await wc.capturePage()
            const resized = img.resize({ width: 1024 })
            const jpeg = resized.toJPEG(65)
            return {
              url: wc.getURL(),
              _image: { mediaType: 'image/jpeg', base64: jpeg.toString('base64') },
              dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
              summary: `Screenshot of ${wc.getURL()}`,
            }
          }
          case 'get_text':   return { text: await wc.executeJavaScript('document.body.innerText'), url: wc.getURL() }
          case 'get_url':    return { url: wc.getURL(), title: agentBrowser.getTitle() }
          case 'navigate':   await wc.loadURL(input.text); return { success: true, url: wc.getURL() }
          case 'click':      await wc.executeJavaScript(`(()=>{ const el=document.querySelector(${JSON.stringify(input.selector)}); if(!el) throw new Error('Not found'); el.click() })()`); return { success: true }
          case 'type':       await wc.executeJavaScript(`(()=>{ const el=document.querySelector(${JSON.stringify(input.selector)}); if(!el) throw new Error('Not found'); el.focus(); el.value=${JSON.stringify(input.text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})) })()`); return { success: true }
          case 'wait':       await new Promise(r => setTimeout(r, parseInt(input.text) || 1000)); return { success: true }
          case 'eval':       return { result: await wc.executeJavaScript(input.script || 'null') }
          default:           return { error: `Unknown action: ${input.action}` }
        }
      } catch (e) { return { error: e.message } }
    }

    case 'screenshot_desktop': {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1024, height: 576 } })
        if (!sources[0]) return { error: 'No screen source' }
        const jpeg = sources[0].thumbnail.toJPEG(65)
        return {
          _image: { mediaType: 'image/jpeg', base64: jpeg.toString('base64') },
          dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
          summary: 'Desktop screenshot',
        }
      } catch (e) { return { error: e.message } }
    }

    case 'show_agent_browser': {
      try { setAgentBrowserVisible(!!input.visible); return { success: true, visible: agentBrowserVisible } }
      catch (e) { return { error: e.message } }
    }

    case 'gmail_send': {
      try {
        const to      = String(input.to || '').trim()
        if (!to) return { error: 'to is required' }
        const subject = String(input.subject || '')
        const body    = String(input.body    || '')
        const cc      = String(input.cc      || '')
        const bcc     = String(input.bcc     || '')

        if (!agentBrowser || agentBrowser.isDestroyed()) agentBrowser = makeAgentBrowser()

        // Gmail's documented compose URL — opens a prefilled compose window.
        const qp = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body })
        if (cc)  qp.set('cc', cc)
        if (bcc) qp.set('bcc', bcc)
        const url = `https://mail.google.com/mail/?${qp.toString()}`

        await agentBrowser.loadURL(url)
        const wc = agentBrowser.webContents

        // Wait up to 30s for either the compose form (Send button) or a sign-in redirect.
        const ready = await wc.executeJavaScript(`
          new Promise(res => {
            const start = Date.now()
            const findSend = () => document.querySelector('div[role="button"][aria-label^="Send"]')
              || document.querySelector('div[role="button"][data-tooltip^="Send"]')
              || document.querySelector('div[role="button"][aria-label*="Enviar"]')
            const tick = () => {
              const h = location.href
              if (h.includes('accounts.google.com') || h.includes('ServiceLogin') || h.includes('/signin/')) {
                return res({ signin: true, href: h })
              }
              const s = findSend()
              if (s) return res({ ready: true })
              if (Date.now() - start > 30000) return res({ timeout: true, href: h })
              setTimeout(tick, 400)
            }
            tick()
          })
        `)

        if (ready.signin) {
          setAgentBrowserVisible(true)
          return {
            needsSignin: true,
            error: 'Gmail wants you to sign in. The browser is now visible — sign in once, then press Run again. After this you will never be asked again.',
            href: ready.href,
          }
        }
        if (ready.timeout) {
          return { error: `Gmail compose did not open within 30s. URL is now: ${ready.href}` }
        }

        // Click Send. Returns whether the post-send confirmation popped up.
        const sentResult = await wc.executeJavaScript(`
          (async () => {
            const send = document.querySelector('div[role="button"][aria-label^="Send"]')
              || document.querySelector('div[role="button"][data-tooltip^="Send"]')
              || document.querySelector('div[role="button"][aria-label*="Enviar"]')
            if (!send) return { error: 'Send button disappeared.' }
            send.click()
            // Wait a moment for the toast / confirmation
            await new Promise(r => setTimeout(r, 2500))
            const toast = document.body.innerText.match(/Message sent|Mensaje enviado|Conversation moved/i)
            return { clicked: true, confirmation: toast ? toast[0] : null }
          })()
        `)
        if (sentResult.error) return { error: sentResult.error }

        return {
          success: true,
          to, subject, body, cc, bcc,
          confirmation: sentResult.confirmation || 'Send button clicked; no explicit confirmation toast found, but Gmail typically confirms via the inbox.',
        }
      } catch (e) {
        return { error: e.message }
      }
    }

    case 'open_app': {
      try {
        const appName = input.name
        const extra   = Array.isArray(input.args) ? input.args : []
        if (!appName) return { error: 'name is required' }
        let command, args
        if (IS_MAC) {
          command = 'open'
          args    = ['-a', appName, ...extra]
        } else if (IS_WIN) {
          command = 'cmd'
          args    = ['/c', 'start', '""', appName, ...extra]
        } else {
          command = 'xdg-open'
          args    = [extra[0] || appName]
        }
        const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: IS_WIN })
        child.on('error', () => {})
        child.unref()
        return { success: true, app: appName }
      } catch (e) { return { error: e.message } }
    }

    default: return { error: `Unknown tool: ${name}` }
  }
}

// ---- Retry helpers ----
const MAX_NETWORK_RETRIES = 4
const RETRY_BASE_MS = 1000
function isRetryableStatus(s) { return s === 408 || s === 425 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504 || s === 524 || s === 529 }
function isRetryableNetworkError(e) {
  const m = String(e?.message || e || '').toLowerCase()
  return m.includes('econnreset') || m.includes('etimedout') || m.includes('eai_again') || m.includes('socket') || m.includes('aborted') || m.includes('fetch failed') || m.includes('network')
}
function isRateLimitError(msgOrErr) {
  const m = String(msgOrErr?.message || msgOrErr || '').toLowerCase()
  return m.includes('rate_limit') || m.includes('rate limit') || m.includes('429')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- Token-budget pacer ----
//
// Anthropic enforces per-minute input-token limits per org/model. Free / build
// tier 1 caps Sonnet at ~10K input TPM, Haiku at much higher. Even on Haiku we
// pace to be safe. Tracks input tokens in a rolling 60s window and *waits* before
// firing the next request if it would exceed the budget — so the model never
// returns 429 in the first place, instead of us reacting to one after the fact.
const TOKEN_BUDGETS = {
  'claude-haiku-4-5':   50000,
  'claude-sonnet-4-5':  20000,
  'claude-sonnet-4-6':   9000,  // user's tier caps at 10K, leave 10% headroom
  'default':            20000,
}
const tokenLog = []  // [{ts, model, tokens}]
function budgetFor(model) { return TOKEN_BUDGETS[model] ?? TOKEN_BUDGETS.default }
function tokensUsedLastMinute(model) {
  const now = Date.now()
  while (tokenLog.length && now - tokenLog[0].ts > 60_000) tokenLog.shift()
  return tokenLog.filter(r => r.model === model).reduce((s, r) => s + r.tokens, 0)
}
function estimateInputTokens(payload) {
  // Rough heuristic: messages JSON + system + tool defs. Images cost ~1500 fixed.
  let imgs = 0
  const walk = (v) => {
    if (!v) return
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (typeof v === 'object') {
      if (v.type === 'image') { imgs++; return }
      Object.values(v).forEach(walk)
      return
    }
  }
  walk(payload.messages)
  const sysChars = (payload.system || '').length
  const toolsChars = JSON.stringify(payload.tools || []).length
  const msgsChars = JSON.stringify(payload.messages || []).length
  // ~3.5 chars/token for English/JSON
  const textTokens = Math.ceil((sysChars + toolsChars + msgsChars) / 3.5)
  const imgTokens = imgs * 1500
  // Add 10% overhead for tool schema metadata / system framing
  return Math.ceil((textTokens + imgTokens) * 1.10)
}
async function reserveTokenBudget(model, estimated) {
  while (true) {
    const used = tokensUsedLastMinute(model)
    const budget = budgetFor(model)
    if (used + estimated <= budget) {
      tokenLog.push({ ts: Date.now(), model, tokens: estimated })
      return
    }
    // Sleep until enough oldest entries expire to free room.
    const oldest = tokenLog.find(r => r.model === model)?.ts ?? Date.now()
    const wait = Math.max(1500, 60_000 - (Date.now() - oldest) + 750)
    send('agent:update', { type: 'status', text: `Pacing for ${model} rate limit (${used}/${budget} TPM used). Waiting ${Math.round(wait/1000)}s…` })
    await sleep(Math.min(wait, 30_000))
  }
}
function actualizeBudget(model, actualTokens) {
  // Replace the most recent estimate for this model with the actual count.
  for (let i = tokenLog.length - 1; i >= 0; i--) {
    if (tokenLog[i].model === model) { tokenLog[i].tokens = actualTokens; return }
  }
}

// History compaction — keep image content blocks only in the last N tool-result rounds.
// Older screenshots are replaced with a short text placeholder so the conversation
// doesn't balloon past the input-token rate limit after a few iterations.
function compactMessages(messages, keepLastImageRounds = 2) {
  // Indices of user messages that carry tool_result blocks.
  const trIdxs = []
  messages.forEach((m, i) => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c?.type === 'tool_result')) trIdxs.push(i)
  })
  if (trIdxs.length <= keepLastImageRounds) return messages
  const keepFromIdx = trIdxs[trIdxs.length - keepLastImageRounds]
  return messages.map((m, i) => {
    if (i >= keepFromIdx) return m
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    const newContent = m.content.map(c => {
      if (c?.type !== 'tool_result' || !Array.isArray(c.content)) return c
      const stripped = c.content.map(b => b?.type === 'image' ? { type: 'text', text: '[earlier screenshot — image omitted]' } : b)
      return { ...c, content: stripped }
    })
    return { ...m, content: newContent }
  })
}

// A locally configured Anthropic key takes priority over the Supabase edge
// proxy: it works even when the Supabase project is paused/deleted, and it
// skips one network hop. Set via env or the in-app key form (settings).
function localAnthropicKey() {
  return process.env.ANTHROPIC_API_KEY || readSettings().anthropic_api_key || null
}

async function callAgentEdge(token, body, attempt = 0) {
  const apiKey = localAnthropicKey()
  const ctrl = new AbortController()
  // Per-request timeout for headers/initial response — stream itself can run longer.
  const headerTimer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    // Direct Anthropic call streams the same SSE event shapes the edge
    // function forwards, so the parser downstream doesn't care which path fed it.
    const res = apiKey
      ? await fetch('https://api.anthropic.com/v1/messages', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body:    JSON.stringify({ model: body.model, max_tokens: 16384, stream: true, system: body.system, messages: body.messages, tools: body.tools }),
          signal:  ctrl.signal,
        })
      : await fetch(`${SUPABASE_URL}/functions/v1/agent-run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    })
    clearTimeout(headerTimer)
    if (!res.ok) {
      const t = await res.text().catch(() => String(res.status))
      const err = new Error(`${apiKey ? 'Anthropic API' : 'Edge function'} ${res.status}: ${t.slice(0, 500)}`)
      err.status = res.status
      throw err
    }
    return res
  } catch (e) {
    clearTimeout(headerTimer)
    const retryable = isRetryableStatus(e.status) || isRetryableNetworkError(e) || e.name === 'AbortError'
    if (retryable && attempt < MAX_NETWORK_RETRIES) {
      const wait = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 250
      send('agent:update', { type: 'status', text: `Network blip (${e.message.slice(0, 80)}). Retrying in ${Math.round(wait/1000)}s…` })
      await sleep(wait)
      return callAgentEdge(token, body, attempt + 1)
    }
    throw e
  }
}

// Per-conversation model — starts on Haiku to fit free-tier TPM. If the user
// upgrades or wants Sonnet, set bgAgent.model before running.
const DEFAULT_AGENT_MODEL = 'claude-haiku-4-5'

async function runBgAgent(task, token) {
  bgAgent = { running: true, task, steps: [], messages: [{ role: 'user', content: task }], startedAt: Date.now(), wasStopped: false, stopReason: null, elapsed: 0, model: DEFAULT_AGENT_MODEL }
  updateTray()
  send('agent:update', { type: 'start', task })

  const MAX_ITER = 50
  let iter = 0
  let stopReason = null
  let consecutiveRateLimits = 0

  while (bgAgent.running && iter < MAX_ITER) {
    iter++

    const allTools = [...AGENT_TOOLS, ...getMCPTools()]

    let res
    try {
      const payloadMessages = compactMessages(bgAgent.messages)
      const payload = { messages: payloadMessages, tools: allTools, system: AGENT_SYSTEM, model: bgAgent.model }
      const estimate = estimateInputTokens(payload)
      await reserveTokenBudget(bgAgent.model, estimate)
      res = await callAgentEdge(token, payload)
    } catch (e) {
      const msg = e?.message || String(e)
      if (isRateLimitError(e) || isRateLimitError(msg)) {
        consecutiveRateLimits++
        // After 2 consecutive rate limits on the current model, escalate to
        // the larger budget (Sonnet 4.5 if we're on Haiku, vice versa).
        if (consecutiveRateLimits >= 2 && bgAgent.model === 'claude-haiku-4-5') {
          bgAgent.model = 'claude-sonnet-4-5'
          send('agent:update', { type: 'status', text: `Switching to ${bgAgent.model} — Haiku tier is also throttled.` })
        }
        const wait = 65_000
        send('agent:update', { type: 'status', text: `Rate limited. Waiting ${wait/1000}s…` })
        bgAgent.steps.push({ type: 'status', text: 'Rate limited. Waiting 65s…' })
        await sleep(wait)
        if (bgAgent.running && iter < MAX_ITER) continue
      }
      send('agent:update', { type: 'error', text: `Edge call failed after retries: ${msg}` })
      bgAgent.steps.push({ type: 'error', text: msg })
      break
    }
    consecutiveRateLimits = 0

    const assistantContent = []
    let currentTool = null
    let currentText = ''
    let buf = ''
    let streamErrorEvent = null
    const decoder = new TextDecoder()
    let lastChunkAt = Date.now()
    const STALL_MS = 90_000

    // Stall watchdog: if no chunks arrive for STALL_MS, force-abort the stream so we can retry.
    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > STALL_MS) {
        try { res.body?.destroy?.(new Error('Stream stalled')) } catch {}
        clearInterval(stallTimer)
      }
    }, 5000)

    try {
      for await (const chunk of res.body) {
        if (!bgAgent.running) break
        lastChunkAt = Date.now()
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()

        for (const line of lines) {
          // SSE comment heartbeats start with ":" — ignore
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { stopReason = stopReason || 'done'; break }
          let ev
          try { ev = JSON.parse(raw) } catch { continue }

          if (ev.type === 'message_start') {
            const actual = ev.message?.usage?.input_tokens
            if (actual) actualizeBudget(bgAgent.model, actual)
          } else if (ev.type === 'content_block_start') {
            if (ev.content_block?.type === 'tool_use') {
              currentTool = { id: ev.content_block.id, name: ev.content_block.name, inputRaw: '' }
            } else if (ev.content_block?.type === 'text') {
              currentText = ''
            }
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') {
              currentText += ev.delta.text
              send('agent:update', { type: 'text-delta', text: currentText })
            } else if (ev.delta?.type === 'input_json_delta' && currentTool) {
              currentTool.inputRaw += ev.delta.partial_json
            }
          } else if (ev.type === 'content_block_stop') {
            if (currentTool) {
              try { currentTool.input = JSON.parse(currentTool.inputRaw || '{}') } catch { currentTool.input = {} }
              assistantContent.push({ type: 'tool_use', id: currentTool.id, name: currentTool.name, input: currentTool.input })
              send('agent:update', { type: 'tool-call', tool: currentTool.name, input: currentTool.input, id: currentTool.id })
              currentTool = null
            } else if (currentText) {
              assistantContent.push({ type: 'text', text: currentText })
              send('agent:update', { type: 'text', text: currentText })
              bgAgent.steps.push({ type: 'text', text: currentText })
              currentText = ''
            }
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
          } else if (ev.type === 'error') {
            streamErrorEvent = ev.error?.message || JSON.stringify(ev.error || {})
          }
        }
      }
    } catch (e) {
      clearInterval(stallTimer)
      const msg = e?.message || String(e)
      // If we already collected any tool_use blocks, we can still continue safely.
      const recoverable = assistantContent.some(b => b.type === 'tool_use')
      if (!recoverable) {
        send('agent:update', { type: 'error', text: `Stream error: ${msg}. Will retry on next iteration.` })
        bgAgent.steps.push({ type: 'error', text: `Stream error: ${msg}` })
        // Don't break — let the next iter retry from the last good state
        if (iter < MAX_ITER) { await sleep(1500); continue }
        break
      }
      send('agent:update', { type: 'status', text: `Stream cut, continuing with ${assistantContent.length} blocks already received.` })
    }
    clearInterval(stallTimer)

    if (streamErrorEvent) {
      const rl = isRateLimitError(streamErrorEvent)
      send('agent:update', { type: 'error', text: `Model error: ${streamErrorEvent.slice(0, 280)}` })
      bgAgent.steps.push({ type: 'error', text: `Model error: ${streamErrorEvent.slice(0, 280)}` })
      if (rl) {
        consecutiveRateLimits++
        if (consecutiveRateLimits >= 2 && bgAgent.model === 'claude-haiku-4-5') {
          bgAgent.model = 'claude-sonnet-4-5'
          send('agent:update', { type: 'status', text: `Switching to ${bgAgent.model} after repeated rate limits.` })
        }
        send('agent:update', { type: 'status', text: 'Rate limited. Waiting 65s for the per-minute window to reset…' })
        bgAgent.steps.push({ type: 'status', text: 'Waiting 65s for rate-limit window…' })
        await sleep(65_000)
        if (!assistantContent.length) continue
      } else if (!assistantContent.length) {
        await sleep(2000); continue
      }
    } else {
      consecutiveRateLimits = 0
    }

    if (!assistantContent.length) {
      // No content at all — probably an empty stream. Retry once before giving up.
      if (iter < MAX_ITER) { await sleep(1500); continue }
      break
    }

    bgAgent.messages.push({ role: 'assistant', content: assistantContent })

    const toolCalls = assistantContent.filter(b => b.type === 'tool_use')

    // If the model hit max_tokens with no tool calls, prompt it to continue.
    if (!toolCalls.length && stopReason === 'max_tokens') {
      send('agent:update', { type: 'status', text: 'Hit token limit — continuing…' })
      bgAgent.messages.push({ role: 'user', content: 'Your previous response was cut off by the token limit. Continue from exactly where you left off.' })
      stopReason = null
      continue
    }

    if (!toolCalls.length) {
      // Genuine natural finish (end_turn / stop_sequence)
      break
    }

    const toolResults = []
    for (const tc of toolCalls) {
      if (!bgAgent.running) break
      let result
      try { result = await executeToolInMain(tc.name, tc.input) }
      catch (e) { result = { error: `Tool threw: ${e?.message || String(e)}` } }
      send('agent:update', { type: 'tool-result', tool: tc.name, result, id: tc.id })
      bgAgent.steps.push({ type: 'tool-call', tool: tc.name, input: tc.input })
      bgAgent.steps.push({ type: 'tool-result', tool: tc.name, result })

      // If the tool returned an image, send it as a proper image content block
      // so Claude can actually see it (instead of as base64 text that wastes ~6K
      // tokens per screenshot and is unreadable to the model anyway).
      let content
      if (result && result._image && !result.error) {
        const { mediaType, base64 } = result._image
        const meta = JSON.stringify({ url: result.url, summary: result.summary }).slice(0, 500)
        content = [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: meta },
        ]
      } else {
        // Strip any base64 from non-image text results too (safety net).
        const slim = result && typeof result === 'object'
          ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== '_image' && k !== 'dataUrl'))
          : result
        const resultText = result?.error ? `Error: ${result.error}` : JSON.stringify(slim, null, 2)
        content = resultText.slice(0, 6000)
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content })
    }

    if (toolResults.length) bgAgent.messages.push({ role: 'user', content: toolResults })
    stopReason = null
  }

  bgAgent.running = false
  bgAgent.elapsed = Date.now() - bgAgent.startedAt
  send('agent:update', { type: 'done', elapsed: bgAgent.elapsed, steps: bgAgent.steps, iterations: iter })
  updateTray()
  notifyAgentDone()
}

// ================================================================
// PASSIVE SCREEN MONITOR
// ================================================================

let monitorInterval   = null
let monitorFrames     = []
const MAX_FRAMES      = 30 // 5 min at 10s interval
let monitorActive     = false

async function captureFrame() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 640, height: 360 },
    })
    if (!sources[0]) return
    const jpegBuf = sources[0].thumbnail.toJPEG(60)
    const dataUrl = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`
    const timestamp  = Date.now()
    const frame      = { dataUrl, timestamp }
    monitorFrames.push(frame)
    if (monitorFrames.length > MAX_FRAMES) monitorFrames.shift()
    send('monitor:frame', { dataUrl, timestamp, total: monitorFrames.length })
  } catch {}
}

function startMonitor() {
  if (monitorInterval) return
  monitorActive   = true
  monitorFrames   = []
  captureFrame()
  monitorInterval = setInterval(captureFrame, 10000)
  updateTray()
  send('monitor:status', { active: true })
}

function stopMonitor() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null }
  monitorActive = false
  updateTray()
  send('monitor:status', { active: false })
}

// ================================================================
// SYSTEM TRAY
// ================================================================

function buildTrayIcon() {
  // macOS: use a monochrome template image so the menu bar auto-tints it
  // (white on dark menu bar, black on light) and it adapts to dark/light mode.
  if (IS_MAC) {
    const templatePath = path.join(__dirname, 'build', 'trayTemplate.png')
    if (fs.existsSync(templatePath)) {
      const img = nativeImage.createFromPath(templatePath)
      img.setTemplateImage(true)
      return img
    }
  }
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}

function buildTrayMenu() {
  const recState = macro.recorderState()
  const plyState = macro.playerState()
  const macroLabel = recState.recording
    ? `⏺ Macro recording · ${recState.event_count} events`
    : plyState.playing
      ? `▶ Replaying: ${plyState.name || 'macro'}`
      : macro.isAvailable() ? 'Macros idle' : 'Macros: native lib missing'

  return Menu.buildFromTemplate([
    { label: 'Open Scout',        click: () => { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus() } } },
    { type: 'separator' },
    { label: bgAgent.running    ? '⚙ Agent running…'  : 'Agent idle',    enabled: false },
    { label: monitorActive      ? '● Monitor active'  : 'Monitor off',   enabled: false },
    { label: macroLabel,         enabled: false },
    { label: `MCP: ${mcpClients.size} server${mcpClients.size !== 1 ? 's' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Stop Agent',        enabled: bgAgent.running,    click: () => { bgAgent.running = false; bgAgent.wasStopped = true; updateTray() } },
    { label: monitorActive ? 'Stop Monitor' : 'Start Monitor', click: () => { monitorActive ? stopMonitor() : startMonitor() } },
    { label: recState.recording
        ? 'Stop Macro Recording'
        : plyState.playing
          ? 'Stop Macro Playback'
          : 'Start Macro Recording',
      enabled: macro.isAvailable(),
      click: () => {
        if (recState.recording) macro.stopRecording()
        else if (plyState.playing) macro.stopPlay()
        else macro.startRecording()
        pushMacroState()
      } },
    { label: agentBrowserVisible ? 'Hide Agent Browser' : 'Show Agent Browser',
      enabled: !!(agentBrowser && !agentBrowser.isDestroyed()),
      click: () => setAgentBrowserVisible(!agentBrowserVisible) },
    { type: 'separator' },
    { label: 'Quit Scout',        click: () => { mcpClients.forEach(c => c.stop()); app.quit() } },
  ])
}

function setupTray() {
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('Scout')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => {
    if (!mainWindow) createWindow()
    else { mainWindow.show(); mainWindow.focus() }
  })
}

function updateTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
}

// ================================================================
// WINDOW
// ================================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 800,
    minWidth: 440,
    minHeight: 620,
    maxWidth: 620,
    title: 'Scout',
    // Dark brown instead of pure black: if the renderer ever fails to paint
    // (quarantine xattr blocking asar reads, CDN script timeout, etc.) the
    // window still looks like Scout instead of a broken pitch-black void.
    backgroundColor: '#1a1206',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.webContents.session.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      if (selectedSourceId) {
        const src = sources.find(s => s.id === selectedSourceId)
        selectedSourceId = null
        if (src) { callback({ video: src }); return }
      }
      if (sources[0]) callback({ video: sources[0] })
      else callback({})
    } catch (e) { console.error('desktopCapturer error:', e); callback({}) }
  })

  // Wait until the renderer has actually painted before revealing the window.
  // Prevents flash-of-black during first paint.
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  // Safety net: if the renderer is still hidden 4s in (renderer crashed,
  // asar quarantined, etc.), show it anyway so the user can see the fallback
  // HTML / open DevTools instead of a phantom window.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }, 4000)

  // Pipe renderer console to main stdout so field crashes are visible when Scout
  // is launched from a terminal (or when stdout is captured).
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['LOG','WARN','ERR'][level] || 'LOG'
    process.stdout.write(`[RENDERER ${lvl}] ${sourceId}:${line} ${message}\n`)
  })

  // Surface silent loadFile / renderer failures (the #1 cause of "opens black"):
  // replace the broken page with a styled fallback that names the error, so the
  // user can actually report what they're seeing instead of "the app is blank".
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[scout] did-fail-load ${code} ${desc} ${url}`)
    const safe = String(desc || 'unknown error').replace(/[<>&"']/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c])
    mainWindow.webContents.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(
        `<!doctype html><meta charset="utf-8"><title>Scout</title>
         <style>html,body{margin:0;height:100%;background:#1a1206;color:#FFD69C;
         font:14px -apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column;
         align-items:center;justify-content:center;text-align:center;padding:24px;}
         h1{color:#E4AF7A;font:600 24px -apple-system;margin:0 0 12px;}
         code{background:rgba(228,175,122,0.12);padding:4px 8px;border-radius:4px;
         color:#FFE8C7;font-family:ui-monospace,Menlo,monospace;font-size:12px;}
         p{max-width:420px;line-height:1.6;opacity:0.85;}</style>
         <h1>Scout couldn't load</h1>
         <p>${safe}</p>
         <p>On macOS this is usually quarantine. Open Terminal and run:</p>
         <p><code>xattr -dr com.apple.quarantine /Applications/Scout.app</code></p>`))
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[scout] renderer gone:', details)
  })

  mainWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
    process.stdout.write(`[PRELOAD ERROR] ${preloadPath} ${err.stack || err.message}\n`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    process.stdout.write(`[DID-FINISH-LOAD] index.html loaded\n`)
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // Keep alive in tray when window is closed (if agent/monitor/macro active)
  mainWindow.on('close', e => {
    if (bgAgent.running || monitorActive || macro.recorderState().recording || macro.playerState().playing) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

// ================================================================
// IPC HANDLERS
// ================================================================

// Recording
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } })
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
})
ipcMain.handle('set-selected-source', (_, id) => { selectedSourceId = id })

// Settings
ipcMain.handle('settings:get', (_, key) => readSettings()[key] ?? null)
ipcMain.handle('settings:set', (_, key, value) => { const d = readSettings(); d[key] = value; writeSettings(d) })

// Shell — open external URL / mailto in default app
ipcMain.handle('shell:open-external', (_, url) => { try { shell.openExternal(url); return { ok: true } } catch (e) { return { error: e.message } } })

// Floating recording overlay (transparent, always-on-top control bar)
let overlayWindow = null
function showOverlay(startedAt) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send('overlay:set-start', startedAt) } catch {}
    overlayWindow.showInactive()
    return
  }
  const primary = screen.getPrimaryDisplay()
  const width = 240, height = 56, margin = 20
  overlayWindow = new BrowserWindow({
    width, height,
    x: primary.workArea.x + primary.workArea.width - width - margin,
    y: primary.workArea.y + margin,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  try { overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))
  overlayWindow.once('ready-to-show', () => {
    try { overlayWindow.webContents.send('overlay:set-start', startedAt) } catch {}
    overlayWindow.showInactive()
  })
  overlayWindow.on('closed', () => { overlayWindow = null })
}
function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy()
  overlayWindow = null
}
ipcMain.handle('overlay:show', (_e, opts) => { showOverlay(opts?.startedAt ?? Date.now()); return { ok: true } })
ipcMain.handle('overlay:hide', () => { hideOverlay(); return { ok: true } })
ipcMain.on('overlay:stop',  () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:stop') })
ipcMain.on('overlay:pause', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:pause') })

// File save dialog
ipcMain.handle('save-file', async (event, { defaultName, buffer, mimeType, extensions }) => {
  try {
    const win    = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win || undefined, { defaultPath: defaultName, filters: [{ name: mimeType || 'File', extensions: extensions || ['*'] }] })
    if (!result.canceled && result.filePath) { fs.writeFileSync(result.filePath, Buffer.from(buffer)); return result.filePath }
  } catch (e) { console.error('save-file error:', e) }
  return null
})

// Background agent
ipcMain.handle('agent:start-bg', async (_, { task, token }) => {
  if (bgAgent.running) return { error: 'Agent already running' }
  void runBgAgent(task, token)
  return { ok: true }
})
ipcMain.handle('agent:stop-bg', () => { bgAgent.running = false; bgAgent.wasStopped = true; return { ok: true } })
ipcMain.handle('agent:get-state', () => ({ running: bgAgent.running, task: bgAgent.task, startedAt: bgAgent.startedAt }))

// ---- Macro mode (local-only record + replay) ----

function pushMacroState() {
  send('macro:state', {
    available: macro.isAvailable(),
    loadError: macro.getLoadError(),
    recorder:  macro.recorderState(),
    player:    macro.playerState(),
  })
  updateTray()
}

ipcMain.handle('macro:state', () => ({
  available: macro.isAvailable(),
  loadError: macro.getLoadError(),
  recorder:  macro.recorderState(),
  player:    macro.playerState(),
}))
ipcMain.handle('macro:list',            ()                 => macro.listMacros())
ipcMain.handle('macro:get',             (_, { id })        => macro.getMacro(id))
ipcMain.handle('macro:delete',          (_, { id })        => macro.deleteMacro(id))
ipcMain.handle('macro:rename',          (_, { id, name })  => macro.renameMacro(id, name))
ipcMain.handle('macro:start-recording', ()                 => { const r = macro.startRecording(); pushMacroState(); return r })
ipcMain.handle('macro:stop-recording',  (_, { name } = {}) => { const r = macro.stopRecording(name); pushMacroState(); return r })
ipcMain.handle('macro:play', async (_, { id, speed, hideWindow }) => {
  return playMacroWithChrome(id, { speed, hideWindow })
})
ipcMain.handle('macro:stop-play', () => { const r = macro.stopPlay(); pushMacroState(); return r })

// AI background run — instead of replaying raw input (which takes over the
// mouse/keyboard), hand a readable log of the recorded workflow to the
// background agent. It recreates the outcome with bash/browser tools while
// the user keeps working. Streams into the same agent:update UI.
ipcMain.handle('macro:ai-run', async (_, { id, token }) => {
  if (bgAgent.running) return { error: 'Agent already running — stop it first' }
  // Macro AI runs go straight to the Anthropic API — the hosted Supabase
  // proxy is not required (and may not exist). Renderer shows the one-time
  // key form when it sees this sentinel.
  if (!localAnthropicKey()) return { error: 'need_key' }
  const fmt = macro.formatMacroForAI(id)
  if (!fmt) return { error: `Macro ${id} not found` }

  const task = `You are replaying a desktop workflow the user recorded. Recreate its OUTCOME in the BACKGROUND using your tools (bash, browser, gmail_send) — do NOT simulate mouse/keyboard input.

The recording below is raw input: clicks are screen coordinates (you cannot see what was clicked), typed text is exact. Infer intent primarily from the typed text — URLs, search queries, filenames, message bodies. Keyboard shortcuts (Ctrl+L, Ctrl+C…) hint at browser/editor actions.

Hard rules:
1. Every string the user typed is ground truth — pass those exact values to your tools. Never substitute placeholders.
2. If the workflow sends email via Gmail, use the gmail_send tool with the exact recipient/subject/body — never click through Gmail's UI.
3. If intent is genuinely ambiguous, take ONE desktop screenshot for context. If still ambiguous, emit a single message starting with "NEEDS:" listing what's missing and stop.
4. Work fully in the background: hidden browser, no user interaction, no asking the user to click.
5. When the outcome is achieved, stop. Final summary: 1-2 lines with the exact values used.

--- RECORDED WORKFLOW: ${fmt.name} (${Math.round((fmt.duration_ms || 0) / 1000)}s) ---

${fmt.text}

--- END RECORDING ---`

  void runBgAgent(task, token)
  return { ok: true, task_preview: fmt.text.slice(0, 400) }
})

// Internal: wraps macro.play() with the UX chrome — minimizes Scout, shows a
// full-screen click-through "don't touch" warning overlay during replay, then
// tears both down. Used by the renderer IPC AND the scheduler tick, so the
// behavior is identical whether the user clicks "Run with AI" or a scheduled
// macro fires on its own.
async function playMacroWithChrome(id, { speed, hideWindow } = {}) {
  pushMacroState()
  const shouldHide = hideWindow !== false
  if (shouldHide && mainWindow && mainWindow.isVisible()) {
    try { mainWindow.minimize() } catch {}
  }
  const overlay = createMacroOverlay()
  try {
    const r = await macro.play(id, { speed })
    return r
  } finally {
    try { overlay?.destroy() } catch {}
    pushMacroState()
    if (shouldHide && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.restore(); mainWindow.focus() } catch {}
    }
  }
}

// "Don't touch" overlay shown across the primary display during macro replay.
// Always-on-top + transparent + click-through so synthesized AND physical
// mouse events pass through to whatever app the macro is driving. Pure
// visual deterrent — true input blocking on Win10+ requires admin.
let _macroOverlay = null
function createMacroOverlay() {
  if (_macroOverlay && !_macroOverlay.isDestroyed()) {
    try { _macroOverlay.destroy() } catch {}
  }
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const w = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width:  display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setIgnoreMouseEvents(true, { forward: false })
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;color:#FFE8C7;
      font-family:Montserrat,system-ui,sans-serif;height:100vh;overflow:hidden;
      pointer-events:none;user-select:none;-webkit-user-select:none;}
    .banner{position:absolute;top:24px;left:50%;transform:translateX(-50%);
      background:rgba(20,10,2,0.92);border:1px solid rgba(228,175,122,0.55);
      border-radius:12px;padding:14px 22px;
      box-shadow:0 8px 32px rgba(0,0,0,0.55),0 0 0 1px rgba(255,232,199,0.10) inset;
      display:flex;flex-direction:column;align-items:center;gap:4px;min-width:340px;}
    .dot{width:10px;height:10px;border-radius:50%;background:#dc2626;
      box-shadow:0 0 12px #dc2626;animation:pulse 1s ease-in-out infinite;
      position:absolute;left:14px;top:50%;transform:translateY(-50%);}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
    .ttl{font-size:13px;letter-spacing:0.08em;text-transform:uppercase;
      color:#E4AF7A;font-weight:600;}
    .sub{font-size:11px;color:rgba(255,232,199,0.65);}
    kbd{background:rgba(182,128,57,0.18);border:1px solid rgba(228,175,122,0.30);
      padding:1px 6px;border-radius:4px;font-family:'JetBrains Mono',ui-monospace;
      font-size:10px;color:#E4AF7A;}
  </style></head><body>
    <div class="banner">
      <div class="dot"></div>
      <div class="ttl">Macro running</div>
      <div class="sub">Don't touch your mouse or keyboard · <kbd>Alt+Shift+Esc</kbd> to abort</div>
    </div>
  </body></html>`
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  w.once('ready-to-show', () => w.show())
  _macroOverlay = w
  return w
}

// ---- Macro scheduler — "run this macro at a specific datetime" ----

ipcMain.handle('macro:list-schedules', () => macro.listSchedules())
ipcMain.handle('macro:schedule', (_, opts) => {
  const r = macro.scheduleMacro(opts || {})
  if (!r.error) send('macro:schedules-changed', macro.listSchedules())
  return r
})
ipcMain.handle('macro:cancel-schedule', (_, { id }) => {
  const r = macro.cancelSchedule(id)
  send('macro:schedules-changed', macro.listSchedules())
  return r
})

let _scheduleTick = null
function startScheduleTick() {
  if (_scheduleTick) return
  // 20s is fine for human-scheduled tasks. Bumping to 5s would feel snappier
  // but burns wakeups; 20s means worst-case the macro fires 20s late.
  _scheduleTick = setInterval(async () => {
    if (macro.playerState().playing || macro.recorderState().recording) return
    const due = macro.takeDueSchedules()
    if (!due.length) return
    const job = due[0]   // run one at a time to keep things sane
    macro.markSchedule(job.id, { status: 'running', started_at: Date.now() })
    send('macro:schedules-changed', macro.listSchedules())
    try {
      const r = await playMacroWithChrome(job.macro_id, { speed: job.speed })
      macro.markSchedule(job.id, {
        status: r?.error ? 'error' : 'done',
        finished_at: Date.now(),
        error: r?.error || null,
      })
    } catch (e) {
      macro.markSchedule(job.id, { status: 'error', finished_at: Date.now(), error: e.message })
    }
    macro.clearFinishedSchedules()
    send('macro:schedules-changed', macro.listSchedules())
  }, 20_000)
}

// ---- Active foreground window (for skill screen-context) ----
//
// Returns { app, title } for the currently focused window. Used by the
// recorder to bake "this skill was recorded inside <app>" into the prompt
// passed to generate-skill, so Claude can mention the app/route in the .md.
ipcMain.handle('system:get-window-info', () => getActiveWindowInfo())

function getActiveWindowInfo() {
  return new Promise(resolve => {
    if (IS_WIN) {
      // PowerShell + Win32 P/Invoke. Lighter than pulling in a native module.
      const ps = `
        $code = @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class W {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint procId);
          }
"@
        Add-Type $code -ErrorAction SilentlyContinue
        $h = [W]::GetForegroundWindow()
        $sb = New-Object Text.StringBuilder 1024
        [W]::GetWindowText($h, $sb, 1024) | Out-Null
        $title = $sb.ToString()
        $procId = 0
        [W]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
        try { $p = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $p = "" }
        Write-Output ("{0}|{1}" -f $p, $title)
      `
      execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command', ps], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null)
        const line = (stdout || '').trim().split('\n').pop() || ''
        const [appName, ...rest] = line.split('|')
        resolve({ app: (appName || '').trim(), title: rest.join('|').trim() })
      })
    } else if (IS_MAC) {
      const osa = `osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'tell application "System Events" to tell process frontApp to set t to name of front window' -e '"" & frontApp & "|" & t'`
      exec(osa, { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null)
        const line = (stdout || '').trim()
        const [appName, ...rest] = line.split('|')
        resolve({ app: appName?.trim() || '', title: rest.join('|').trim() })
      })
    } else {
      // Linux: xdotool if present, else nothing.
      exec(`xdotool getactivewindow getwindowname; xdotool getactivewindow getwindowpid`, { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null)
        const [title, pid] = (stdout || '').trim().split('\n')
        if (!pid) return resolve({ app: '', title: title || '' })
        exec(`ps -p ${pid} -o comm=`, { timeout: 2000 }, (e2, out2) =>
          resolve({ app: (out2 || '').trim(), title: title || '' }))
      })
    }
  })
}

// Monitor
ipcMain.handle('monitor:toggle', (_, { active }) => { active ? startMonitor() : stopMonitor(); return { active: monitorActive } })
ipcMain.handle('monitor:get-frames', () => monitorFrames.map(f => ({ dataUrl: f.dataUrl, timestamp: f.timestamp })))
ipcMain.handle('monitor:get-status', () => ({ active: monitorActive, frameCount: monitorFrames.length }))

// MCP
ipcMain.handle('mcp:get-status', () => getMCPStatus())

// Env file
ipcMain.handle('agent:save-env', (_, { filePath, entries }) => {
  try {
    const lines    = entries.map(({ key, value }) => `${key}=${value}`)
    const dir      = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    let existing   = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
    const existing_keys = new Set(existing.split('\n').map(l => l.split('=')[0].trim()).filter(Boolean))
    const newLines = lines.filter(l => !existing_keys.has(l.split('=')[0].trim()))
    fs.writeFileSync(filePath, existing.trimEnd() + (existing ? '\n' : '') + newLines.join('\n') + (newLines.length ? '\n' : ''), 'utf8')
    return { success: true, written: newLines.length }
  } catch (e) { return { error: e.message } }
})

// Legacy agent tool IPC (used by renderer-side agent mode)
ipcMain.handle('agent:bash', async (_, { command, cwd }) =>
  new Promise(resolve => exec(command, { cwd: cwd || os.homedir(), timeout: BASH_TIMEOUT_MS, shell: AGENT_SHELL, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0, error: err && !stdout ? err.message : null }))))

ipcMain.handle('agent:read-file',  (_, { path: p }) => { try { return { content: fs.readFileSync(p, 'utf8') } } catch (e) { return { error: e.message } } })
ipcMain.handle('agent:write-file', (_, { path: p, content }) => { try { const d = path.dirname(p); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(p, content, 'utf8'); return { success: true } } catch (e) { return { error: e.message } } })
ipcMain.handle('agent:list-dir',   (_, { path: p }) => { try { return { entries: fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })) } } catch (e) { return { error: e.message } } })
ipcMain.handle('agent:browser-open', async (_, { url }) => {
  try {
    if (!agentBrowser || agentBrowser.isDestroyed()) agentBrowser = makeAgentBrowser()
    await agentBrowser.loadURL(url)
    return { success: true, url: agentBrowser.webContents.getURL() }
  } catch (e) { return { error: e.message } }
})
ipcMain.handle('agent:browser-action', async (_, { action, selector, text, script }) => {
  if (!agentBrowser || agentBrowser.isDestroyed()) return { error: 'No browser open.' }
  const wc = agentBrowser.webContents
  try {
    switch (action) {
      case 'screenshot': { const img = await wc.capturePage(); return { dataUrl: img.toDataURL(), url: wc.getURL() } }
      case 'get_text':   return { text: await wc.executeJavaScript('document.body.innerText'), url: wc.getURL() }
      case 'get_url':    return { url: wc.getURL(), title: agentBrowser.getTitle() }
      case 'navigate':   await wc.loadURL(text); return { success: true, url: wc.getURL() }
      case 'click':      await wc.executeJavaScript(`(()=>{ const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Not found'); el.click() })()`); return { success: true }
      case 'type':       await wc.executeJavaScript(`(()=>{ const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Not found'); el.focus(); el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})) })()`); return { success: true }
      case 'wait':       await new Promise(r => setTimeout(r, parseInt(text) || 1000)); return { success: true }
      case 'eval':       return { result: await wc.executeJavaScript(script || 'null') }
      default:           return { error: `Unknown action: ${action}` }
    }
  } catch (e) { return { error: e.message } }
})

// ================================================================
// BOOT
// ================================================================

app.whenReady().then(async () => {
  // Ensures notifications and taskbar entries show "Scout" on Windows
  // instead of a generic Electron label.
  if (IS_WIN) app.setAppUserModelId('agency.orage.scout')
  createWindow()
  setupTray()

  // Load MCP servers from ~/.claude.json in background
  loadMCPServers().then(() => {
    updateTray()
    send('mcp:ready', getMCPStatus())
  })

  globalShortcut.register('Alt+Shift+R', () => {
    if (!mainWindow) { createWindow(); return }
    if (mainWindow.isMinimized() || !mainWindow.isVisible()) { mainWindow.show(); mainWindow.restore() }
    mainWindow.focus()
    mainWindow.webContents.send('hotkey-record')
  })

  // Alt+Shift+M = toggle monitor
  globalShortcut.register('Alt+Shift+M', () => {
    monitorActive ? stopMonitor() : startMonitor()
    if (!mainWindow || !mainWindow.isVisible()) { if (!mainWindow) createWindow(); mainWindow.show(); mainWindow.focus() }
  })

  // Alt+Shift+K = toggle macro recording (K = "keystrokes"). Doubles as the
  // "stop playback" key during replay so the user can always bail out without
  // touching the mouse — useful when a macro is wandering across the screen.
  globalShortcut.register('Alt+Shift+K', () => {
    if (!macro.isAvailable()) {
      // Surface the install error in the renderer so the user sees what's wrong.
      if (!mainWindow) createWindow()
      else { mainWindow.show(); mainWindow.focus() }
      send('macro:state', {
        available: false,
        loadError: macro.getLoadError(),
        recorder:  macro.recorderState(),
        player:    macro.playerState(),
      })
      return
    }
    if (macro.recorderState().recording)   macro.stopRecording()
    else if (macro.playerState().playing)  macro.stopPlay()
    else                                   macro.startRecording()
    pushMacroState()
  })

  // Alt+Shift+Esc = abort macro playback only (doesn't toggle recording).
  globalShortcut.register('Alt+Shift+Escape', () => {
    if (macro.playerState().playing) {
      macro.stopPlay()
      pushMacroState()
    }
  })

  // Catch up on any schedules whose `when` has already passed while Scout was
  // closed, then start the polling loop.
  macro.clearFinishedSchedules()
  startScheduleTick()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('hotkey-record') }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  mcpClients.forEach(c => c.stop())
})

// Only fully quit when no background tasks are running. Pending macro
// schedules also keep Scout alive so scheduled runs fire even when the window
// is closed (user expectation: "schedule it overnight, forget it").
app.on('window-all-closed', () => {
  const macroActive    = macro.recorderState().recording || macro.playerState().playing
  const pendingSchedule = macro.listSchedules().some(s => s.status === 'pending')
  if (!bgAgent.running && !monitorActive && !macroActive && !pendingSchedule && process.platform !== 'darwin') app.quit()
})
