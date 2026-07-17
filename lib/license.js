// Proprietary-build license / machine-binding gate.
//
// Two modes, chosen by presence of the SCOUT_OWNER_MACHINE_HASH build-time
// env var:
//
//   1. Fixed-owner mode (SCOUT_OWNER_MACHINE_HASH set): app only runs on
//      the one machine whose fingerprint hash matches. Anywhere else it
//      refuses to boot and copies the current machine's hash to clipboard.
//
//   2. First-boot-lock mode (unset at build): the first machine to launch
//      the app writes an HMAC-signed activation blob to userData. Every
//      subsequent boot must produce the same machine fingerprint, verified
//      via HMAC with the per-build INSTALLATION_SECRET baked in.
//
// The INSTALLATION_SECRET is generated per build (see scripts/prepare-build.js)
// so a leaked activation.bin from one build can't be replayed on another.

const { app, dialog, safeStorage, clipboard } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const {
  BUILD_INSTALLATION_SECRET,
  BUILD_OWNER_MACHINE_HASH,
} = require('./generated-build-info')

const OWNER_HASH = (BUILD_OWNER_MACHINE_HASH || '').trim()
const INSTALL_SECRET = BUILD_INSTALLATION_SECRET || ''
const LICENSE_DISABLED = process.env.SCOUT_DEV_UNLOCKED === '1'

const ACTIVATION_FILE = 'activation.bin'
const ACTIVATION_VERSION = 1

function logLine(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'log.txt')
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
  try { console.log(msg) } catch {}
}

function activationPath() {
  return path.join(app.getPath('userData'), ACTIVATION_FILE)
}

function machineFingerprint() {
  const parts = [
    os.hostname() || '',
    (os.userInfo({ encoding: 'utf8' }).username) || '',
    (os.cpus()[0] && os.cpus()[0].model || '').trim(),
    `${os.arch()}/${os.platform()}/${os.release()}`,
  ]
  const nets = os.networkInterfaces()
  let mac = ''
  for (const name of Object.keys(nets).sort()) {
    const ifs = nets[name] || []
    for (const i of ifs) {
      if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') {
        mac = i.mac
        break
      }
    }
    if (mac) break
  }
  parts.push(mac)
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

function hmac(payload) {
  const key = INSTALL_SECRET || 'scout-fallback-secret-do-not-ship'
  return crypto.createHmac('sha256', key).update(payload).digest('hex')
}

function readActivation() {
  try {
    const raw = fs.readFileSync(activationPath())
    let text
    if (safeStorage.isEncryptionAvailable()) {
      try {
        text = safeStorage.decryptString(raw)
      } catch {
        text = raw.toString('utf8')
      }
    } else {
      text = raw.toString('utf8')
    }
    const parsed = JSON.parse(text)
    if (parsed.v !== ACTIVATION_VERSION) return null
    if (typeof parsed.fingerprint_hash !== 'string') return null
    if (typeof parsed.hmac !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeActivation(blob) {
  const text = JSON.stringify(blob)
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.from(text, 'utf8')
  fs.mkdirSync(path.dirname(activationPath()), { recursive: true })
  fs.writeFileSync(activationPath(), buf)
}

function showUnauthorizedDialog(currentHash, reason) {
  const message =
    reason === 'wrong-machine'
      ? 'This copy of Scout is licensed to a different machine.'
      : 'Scout could not verify its license on this machine.'
  const detail =
    `Reason: ${reason}\n` +
    `Machine hash: ${currentHash}\n\n` +
    `Contact the vendor with this hash to request a build authorised for this device.`
  try {
    dialog.showErrorBox('Scout — license check failed', `${message}\n\n${detail}`)
  } catch {}
  try { clipboard.writeText(currentHash) } catch {}
}

// Blocking startup gate. Call from bootstrap after app is ready.
// Calls app.quit() and returns false if unauthorised; returns true on success.
function verifyLicenseOrQuit() {
  if (LICENSE_DISABLED && !app.isPackaged) {
    logLine('[license] dev unlock — skipping check (unpackaged build)')
    return true
  }

  const current = machineFingerprint()

  if (OWNER_HASH) {
    if (current !== OWNER_HASH) {
      logLine(`[license] FAIL fixed-owner mismatch current=${current} expected=${OWNER_HASH}`)
      showUnauthorizedDialog(current, 'wrong-machine')
      app.quit()
      return false
    }
    logLine('[license] OK fixed-owner match')
    return true
  }

  const existing = readActivation()
  if (existing) {
    const expectedHmac = hmac(`${existing.fingerprint_hash}|${ACTIVATION_VERSION}`)
    if (existing.hmac !== expectedHmac) {
      logLine('[license] FAIL activation blob HMAC mismatch (tampered or foreign build)')
      showUnauthorizedDialog(current, 'tampered-activation')
      app.quit()
      return false
    }
    if (existing.fingerprint_hash !== current) {
      logLine(`[license] FAIL machine mismatch bound=${existing.fingerprint_hash} current=${current}`)
      showUnauthorizedDialog(current, 'wrong-machine')
      app.quit()
      return false
    }
    logLine('[license] OK bound-machine match')
    return true
  }

  const blob = {
    v: ACTIVATION_VERSION,
    fingerprint_hash: current,
    hmac: hmac(`${current}|${ACTIVATION_VERSION}`),
    bound_at_ms: Date.now(),
  }
  try {
    writeActivation(blob)
  } catch (err) {
    logLine(`[license] FAIL could not persist activation: ${String(err)}`)
    showUnauthorizedDialog(current, 'cannot-write-activation')
    app.quit()
    return false
  }
  logLine(`[license] OK first-boot bind fp=${current}`)
  return true
}

function currentMachineHash() {
  return machineFingerprint()
}

module.exports = { verifyLicenseOrQuit, currentMachineHash }
