const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, dialog, shell, safeStorage, Tray, Menu, nativeImage } = require('electron')
const path    = require('path')
const fs      = require('fs')
const os      = require('os')
const { exec, spawn } = require('child_process')

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
          clientInfo: { name: 'Scout', version: '2.0.0' },
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
  try {
    const raw     = fs.readFileSync(configPath, 'utf8')
    const config  = JSON.parse(raw)
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
  } catch {}
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

const SUPABASE_URL = 'https://wmicxsafqbixedpjhchc.supabase.co'

const AGENT_TOOLS = [
  {
    name: 'bash',
    description: 'Run a PowerShell command on the user\'s Windows computer. Returns stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to run' },
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
]

const AGENT_SYSTEM = `You are Scout Agent, an AI assistant embedded in a Windows 11 desktop app. You execute tasks on the user's computer using available tools.

Rules:
- Plan first, then act efficiently.
- After browser_open, always take a screenshot to see the page state.
- Use PowerShell syntax in bash commands.
- If a tool returns an error, explain it and try an alternative.
- When done, give a concise summary of what was accomplished.`

let bgAgent = {
  running:   false,
  task:      '',
  steps:     [],
  messages:  [],
  startedAt: 0,
}

async function executeToolInMain(name, input) {
  if (name.startsWith('mcp__')) return callMCPTool(name, input)

  switch (name) {
    case 'bash': return new Promise(resolve => {
      exec(input.command, { cwd: input.cwd || os.homedir(), timeout: 60000, shell: 'powershell.exe' }, (err, stdout, stderr) => {
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
          agentBrowser = new BrowserWindow({ width: 1280, height: 800, title: 'Scout Agent Browser', webPreferences: { contextIsolation: true } })
          agentBrowser.on('closed', () => { agentBrowser = null })
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
          case 'screenshot': { const img = await wc.capturePage(); return { dataUrl: img.toDataURL(), url: wc.getURL() } }
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
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
        if (!sources[0]) return { error: 'No screen source' }
        return { dataUrl: sources[0].thumbnail.toDataURL() }
      } catch (e) { return { error: e.message } }
    }

    default: return { error: `Unknown tool: ${name}` }
  }
}

async function runBgAgent(task, token) {
  bgAgent = { running: true, task, steps: [], messages: [{ role: 'user', content: task }], startedAt: Date.now() }
  updateTray()
  send('agent:update', { type: 'start', task })

  const MAX_ITER = 30
  let iter = 0

  while (bgAgent.running && iter < MAX_ITER) {
    iter++

    const allTools = [...AGENT_TOOLS, ...getMCPTools()]

    let res
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/agent-run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ messages: bgAgent.messages, tools: allTools, system: AGENT_SYSTEM }),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => String(res.status))
        send('agent:update', { type: 'error', text: `Edge function error (${res.status}): ${t}` })
        break
      }
    } catch (e) {
      send('agent:update', { type: 'error', text: 'Network error: ' + e.message })
      break
    }

    const assistantContent = []
    let currentTool = null
    let currentText = ''
    let buf = ''
    const decoder = new TextDecoder()

    try {
      for await (const chunk of res.body) {
        if (!bgAgent.running) break
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break
          let ev
          try { ev = JSON.parse(raw) } catch { continue }

          if (ev.type === 'content_block_start') {
            if (ev.content_block?.type === 'tool_use') {
              currentTool = { id: ev.content_block.id, name: ev.content_block.name, inputRaw: '' }
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
          }
        }
      }
    } catch (e) {
      send('agent:update', { type: 'error', text: 'Stream error: ' + e.message })
      break
    }

    if (!assistantContent.length) break
    bgAgent.messages.push({ role: 'assistant', content: assistantContent })

    const toolCalls = assistantContent.filter(b => b.type === 'tool_use')
    if (!toolCalls.length) break

    const toolResults = []
    for (const tc of toolCalls) {
      if (!bgAgent.running) break
      const result = await executeToolInMain(tc.name, tc.input)
      send('agent:update', { type: 'tool-result', tool: tc.name, result, id: tc.id })
      bgAgent.steps.push({ type: 'tool-call', tool: tc.name, input: tc.input })
      bgAgent.steps.push({ type: 'tool-result', tool: tc.name, result })
      const resultText = result?.error ? `Error: ${result.error}` : JSON.stringify(result, null, 2)
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: resultText.slice(0, 20000) })
    }

    if (toolResults.length) bgAgent.messages.push({ role: 'user', content: toolResults })
  }

  bgAgent.running = false
  bgAgent.elapsed = Date.now() - bgAgent.startedAt
  send('agent:update', { type: 'done', elapsed: bgAgent.elapsed, steps: bgAgent.steps })
  updateTray()
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
    const dataUrl    = sources[0].thumbnail.toDataURL()
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
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Scout',        click: () => { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus() } } },
    { type: 'separator' },
    { label: bgAgent.running    ? '⚙ Agent running…'  : 'Agent idle',    enabled: false },
    { label: monitorActive      ? '● Monitor active'  : 'Monitor off',   enabled: false },
    { label: `MCP: ${mcpClients.size} server${mcpClients.size !== 1 ? 's' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Stop Agent',        enabled: bgAgent.running,    click: () => { bgAgent.running = false; updateTray() } },
    { label: monitorActive ? 'Stop Monitor' : 'Start Monitor', click: () => { monitorActive ? stopMonitor() : startMonitor() } },
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
    backgroundColor: '#000000',
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

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // Keep alive in tray when window is closed (if agent/monitor active)
  mainWindow.on('close', e => {
    if (bgAgent.running || monitorActive) {
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
ipcMain.handle('agent:stop-bg', () => { bgAgent.running = false; return { ok: true } })
ipcMain.handle('agent:get-state', () => ({ running: bgAgent.running, task: bgAgent.task, startedAt: bgAgent.startedAt }))

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
  new Promise(resolve => exec(command, { cwd: cwd || os.homedir(), timeout: 60000, shell: 'powershell.exe' }, (err, stdout, stderr) =>
    resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0, error: err && !stdout ? err.message : null }))))

ipcMain.handle('agent:read-file',  (_, { path: p }) => { try { return { content: fs.readFileSync(p, 'utf8') } } catch (e) { return { error: e.message } } })
ipcMain.handle('agent:write-file', (_, { path: p, content }) => { try { const d = path.dirname(p); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(p, content, 'utf8'); return { success: true } } catch (e) { return { error: e.message } } })
ipcMain.handle('agent:list-dir',   (_, { path: p }) => { try { return { entries: fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })) } } catch (e) { return { error: e.message } } })
ipcMain.handle('agent:browser-open',   async (_, { url }) => { try { if (!agentBrowser || agentBrowser.isDestroyed()) { agentBrowser = new BrowserWindow({ width: 1280, height: 800, title: 'Scout Agent Browser', webPreferences: { contextIsolation: true } }); agentBrowser.on('closed', () => { agentBrowser = null }) } await agentBrowser.loadURL(url); return { success: true, url: agentBrowser.webContents.getURL() } } catch (e) { return { error: e.message } } })
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

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('hotkey-record') }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  mcpClients.forEach(c => c.stop())
})

// Only fully quit when no background tasks are running
app.on('window-all-closed', () => {
  if (!bgAgent.running && !monitorActive && process.platform !== 'darwin') app.quit()
})
