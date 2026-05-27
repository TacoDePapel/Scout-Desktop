const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, dialog, shell, safeStorage } = require('electron')
const path = require('path')
const fs   = require('fs')
const { exec } = require('child_process')

// Single-instance guard
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

let mainWindow     = null
let selectedSourceId = null
let agentBrowser   = null

// ---- Settings (persistent JSON in userData) ----

function settingsPath() { return path.join(app.getPath('userData'), 'scout-settings.json') }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } catch { return {} }
}
function writeSettings(data) { fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2)) }

// ---- Window ----

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
    } catch (e) {
      console.error('desktopCapturer error:', e)
      callback({})
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

// ---- IPC handlers ----

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
  })
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
})

ipcMain.handle('set-selected-source', (_, id) => { selectedSourceId = id })

ipcMain.handle('settings:get', (_, key) => readSettings()[key] ?? null)
ipcMain.handle('settings:set', (_, key, value) => {
  const data = readSettings(); data[key] = value; writeSettings(data)
})

ipcMain.handle('save-file', async (event, { defaultName, buffer, mimeType, extensions }) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win || undefined, {
      defaultPath: defaultName,
      filters: [{ name: mimeType || 'File', extensions: extensions || ['*'] }],
    })
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, Buffer.from(buffer))
      return result.filePath
    }
  } catch (e) {
    console.error('save-file error:', e)
  }
  return null
})

// ---- Agent tool IPC handlers ----

ipcMain.handle('agent:bash', async (_, { command, cwd }) => {
  return new Promise(resolve => {
    exec(command, { cwd: cwd || app.getPath('home'), timeout: 60000, shell: 'powershell.exe' }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: err?.code ?? 0, error: err && !stdout ? err.message : null })
    })
  })
})

ipcMain.handle('agent:read-file', (_, { path: filePath }) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return { content }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('agent:write-file', (_, { path: filePath, content }) => {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')
    return { success: true }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('agent:list-dir', (_, { path: dirPath }) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return { entries: entries.map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })) }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('agent:save-env', (_, { filePath, entries }) => {
  try {
    const lines = entries.map(({ key, value }) => `${key}=${value}`)
    const content = lines.join('\n') + '\n'
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    let existing = ''
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8')
    const existingKeys = new Set(existing.split('\n').map(l => l.split('=')[0].trim()).filter(Boolean))
    const newLines = lines.filter(l => !existingKeys.has(l.split('=')[0].trim()))
    fs.writeFileSync(filePath, existing.trimEnd() + (existing ? '\n' : '') + newLines.join('\n') + (newLines.length ? '\n' : ''), 'utf8')
    return { success: true, written: newLines.length }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('agent:browser-open', async (_, { url }) => {
  try {
    if (!agentBrowser || agentBrowser.isDestroyed()) {
      agentBrowser = new BrowserWindow({
        width: 1280, height: 800,
        title: 'Scout Agent Browser',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
      agentBrowser.on('closed', () => { agentBrowser = null })
    }
    await agentBrowser.loadURL(url)
    return { success: true, url: agentBrowser.webContents.getURL() }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('agent:browser-action', async (_, { action, selector, text, script }) => {
  if (!agentBrowser || agentBrowser.isDestroyed()) return { error: 'No browser open. Use browser_open first.' }
  const wc = agentBrowser.webContents
  try {
    switch (action) {
      case 'screenshot': {
        const img = await wc.capturePage()
        return { dataUrl: img.toDataURL(), url: wc.getURL(), title: agentBrowser.getTitle() }
      }
      case 'get_text':
        return { text: await wc.executeJavaScript('document.body.innerText'), url: wc.getURL() }
      case 'get_html':
        return { html: await wc.executeJavaScript('document.documentElement.outerHTML'), url: wc.getURL() }
      case 'get_url':
        return { url: wc.getURL(), title: agentBrowser.getTitle() }
      case 'navigate':
        await wc.loadURL(text)
        return { success: true, url: wc.getURL() }
      case 'click':
        await wc.executeJavaScript(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)}); el.click(); return true; })()`)
        return { success: true }
      case 'type':
        await wc.executeJavaScript(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element not found'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`)
        return { success: true }
      case 'wait':
        await new Promise(r => setTimeout(r, parseInt(text) || 1000))
        return { success: true }
      case 'eval':
        return { result: await wc.executeJavaScript(script || 'null') }
      default:
        return { error: `Unknown browser action: ${action}` }
    }
  } catch (e) { return { error: e.message } }
})

// ---- Boot ----

app.whenReady().then(() => {
  createWindow()

  globalShortcut.register('Alt+Shift+R', () => {
    if (!mainWindow) { createWindow(); return }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('hotkey-record')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('hotkey-record')
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
