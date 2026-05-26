const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, dialog, shell } = require('electron')
const path = require('path')
const fs   = require('fs')

// Single-instance guard
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

let mainWindow     = null
let selectedSourceId = null

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
