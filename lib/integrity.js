// Anti-debug + anti-tamper guard for packaged builds.
//
// Blocks:
//   - Any --inspect / --inspect-brk / --remote-debugging-port argv
//   - NODE_OPTIONS env carrying an inspector flag
//   - ELECTRON_RUN_AS_NODE (would let attackers use our shipped Node runtime
//     to run arbitrary scripts against the ASAR)
//   - devtools opening on any BrowserWindow spawned by the app
//   - missing/renamed ASAR
//
// All checks are no-ops when app.isPackaged is false, so `npm start` stays
// usable.

const { app, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const INSPECTOR_ARG = /^--inspect(-brk)?(=.*)?$|^--remote-debugging-port(=.*)?$/i
const INSPECTOR_ENV = /(--inspect(-brk)?(=\S*)?|--remote-debugging-port(=\S*)?)/i

function logLine(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'log.txt')
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
  try { console.log(msg) } catch {}
}

function detectDebugArgs() {
  for (const a of process.argv.slice(1)) {
    if (INSPECTOR_ARG.test(a)) return `argv: ${a}`
  }
  for (const a of process.execArgv) {
    if (INSPECTOR_ARG.test(a)) return `execArgv: ${a}`
  }
  const nodeOpts = process.env.NODE_OPTIONS || ''
  if (INSPECTOR_ENV.test(nodeOpts)) return `NODE_OPTIONS: ${nodeOpts}`
  if (process.env.ELECTRON_RUN_AS_NODE === '1') return 'ELECTRON_RUN_AS_NODE=1'
  return null
}

function assertAsarPresent() {
  if (!app.isPackaged) return null
  const asarPath = path.join(process.resourcesPath, 'app.asar')
  try {
    const stat = fs.statSync(asarPath)
    if (!stat.isFile()) return `expected file at ${asarPath}, got directory`
    if (stat.size < 1024) return `app.asar suspiciously small (${stat.size} bytes)`
  } catch (err) {
    return `app.asar missing at ${asarPath}: ${String(err)}`
  }
  return null
}

function refuseDevtools(win) {
  if (!app.isPackaged) return
  const wc = win.webContents
  wc.on('devtools-opened', () => {
    logLine('[integrity] devtools opened in packaged build — closing')
    try { wc.closeDevTools() } catch {}
  })
  wc.on('before-input-event', (event, input) => {
    const isDevtools =
      (input.key === 'I' && (input.control || input.meta) && input.shift) ||
      input.key === 'F12'
    if (isDevtools) event.preventDefault()
  })
}

let installed = false
function installWindowGuards() {
  if (installed) return
  installed = true
  if (!app.isPackaged) return
  app.on('browser-window-created', (_ev, win) => {
    refuseDevtools(win)
  })
}

// Sync preflight run before any other bootstrap work. Returns true if the
// process is clean; calls app.quit() and returns false otherwise.
function verifyIntegrityOrQuit() {
  if (!app.isPackaged) {
    logLine('[integrity] unpackaged build — skipping checks')
    return true
  }
  const debugHit = detectDebugArgs()
  if (debugHit) {
    logLine(`[integrity] FAIL debug flag detected: ${debugHit}`)
    try {
      dialog.showErrorBox(
        'Scout — integrity check failed',
        'Scout cannot run under a debugger or with an inspector attached.\n\n' +
          `Detected: ${debugHit}`
      )
    } catch {}
    app.quit()
    return false
  }
  const asarHit = assertAsarPresent()
  if (asarHit) {
    logLine(`[integrity] FAIL asar check: ${asarHit}`)
    try {
      dialog.showErrorBox(
        'Scout — integrity check failed',
        "Scout's application bundle appears to be missing or modified.\n\n" +
          `Detail: ${asarHit}`
      )
    } catch {}
    app.quit()
    return false
  }
  logLine('[integrity] OK')
  return true
}

module.exports = { verifyIntegrityOrQuit, installWindowGuards }
