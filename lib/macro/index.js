// Scout Macro Mode — local-only record + replay of keyboard / mouse input.
//
// Purpose: a sign-in-free, fully offline "press record, do stuff, press play,
// Scout does it" mode. Sits next to the cloud-AI skill pipeline; never touches
// Supabase. Macros are saved as plain JSON in userData/macros/.
//
// Native deps (loaded lazily, guarded):
//   - uiohook-napi:           global keyboard + mouse hook (capture)
//   - @nut-tree-fork/nut-js:  input synthesis (replay)
//
// If either native binary is missing for the current Electron ABI, the rest
// of the app still boots — macro IPC just returns { error: ... } and the
// renderer shows an install hint instead of crashing the renderer.

const { app } = require('electron')
const fs   = require('fs')
const path = require('path')

let uIOhook = null
let UiohookKey = null
let nut = null
let loadError = null
let triedLoad = false

function tryLoad() {
  if (triedLoad) return
  triedLoad = true
  try {
    const u = require('uiohook-napi')
    uIOhook = u.uIOhook
    UiohookKey = u.UiohookKey
  } catch (e) {
    loadError = `uiohook-napi failed to load: ${e.message}. Run "npm install" inside the Scout folder, then restart.`
    return
  }
  try {
    nut = require('@nut-tree-fork/nut-js')
    // nut-js defaults add a ~100ms autoDelay between actions — kills replay
    // fidelity, especially for typing. Drop to zero so timing comes from the
    // recorded event timestamps instead.
    nut.mouse.config.autoDelayMs    = 0
    nut.keyboard.config.autoDelayMs = 0
  } catch (e) {
    loadError = `@nut-tree-fork/nut-js failed to load: ${e.message}. Run "npm install" inside the Scout folder, then restart.`
    nut = null
  }
}

function isAvailable() { tryLoad(); return !loadError && !!uIOhook && !!nut }
function getLoadError() { tryLoad(); return loadError }

// ================================================================
// STORE
// ================================================================

function macrosDir() {
  const d = path.join(app.getPath('userData'), 'macros')
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}

function listMacros() {
  try {
    // Skip internal files (_schedules.json lives in the same dir) — without
    // this they show up as phantom "Untitled macro · 0 events" rows.
    const files = fs.readdirSync(macrosDir()).filter(f => f.endsWith('.json') && !f.startsWith('_'))
    const out = []
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(macrosDir(), f), 'utf8'))
        if (!m || !m.id) continue
        out.push({
          id:           m.id,
          name:         m.name || 'Untitled macro',
          created_at:   m.created_at,
          duration_ms:  m.duration_ms,
          event_count:  m.events?.length || 0,
        })
      } catch {}
    }
    return out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
  } catch { return [] }
}

function getMacro(id) {
  try { return JSON.parse(fs.readFileSync(path.join(macrosDir(), `${id}.json`), 'utf8')) }
  catch { return null }
}

function saveMacro(macro) {
  fs.writeFileSync(path.join(macrosDir(), `${macro.id}.json`), JSON.stringify(macro, null, 2))
  return macro
}

function deleteMacro(id) {
  try { fs.unlinkSync(path.join(macrosDir(), `${id}.json`)); return true }
  catch { return false }
}

function renameMacro(id, name) {
  const m = getMacro(id); if (!m) return null
  m.name = String(name || '').slice(0, 120) || 'Untitled macro'
  return saveMacro(m)
}

// ================================================================
// RECORDER
// ================================================================

let recording = null

function startRecording() {
  if (!isAvailable()) return { error: getLoadError() || 'Native input library not loaded' }
  if (recording) return { error: 'Already recording' }

  const startedAt = Date.now()
  const events = []

  const handlers = {
    keydown: (e) => events.push({ k: 'kd', t: Date.now() - startedAt, key: e.keycode }),
    keyup:   (e) => events.push({ k: 'ku', t: Date.now() - startedAt, key: e.keycode }),
    mousedown: (e) => events.push({ k: 'md', t: Date.now() - startedAt, x: e.x, y: e.y, b: e.button }),
    mouseup:   (e) => events.push({ k: 'mu', t: Date.now() - startedAt, x: e.x, y: e.y, b: e.button }),
    mousemove: (e) => {
      // Mouse-move floods events. Coalesce: if the previous event is also
      // a move within the last 40ms, just update its coords + time instead
      // of pushing a new one. Keeps macros small without losing fidelity.
      const last = events[events.length - 1]
      const now  = Date.now() - startedAt
      if (last && last.k === 'mm' && (now - last.t < 40)) {
        last.t = now; last.x = e.x; last.y = e.y; return
      }
      events.push({ k: 'mm', t: now, x: e.x, y: e.y })
    },
    wheel: (e) => events.push({ k: 'wh', t: Date.now() - startedAt, x: e.x, y: e.y, d: e.rotation || 1, dir: e.direction }),
  }

  for (const [evName, fn] of Object.entries(handlers)) uIOhook.on(evName, fn)
  try { uIOhook.start() }
  catch (e) {
    // Detach the handlers we just attached, otherwise we'll re-bind them on retry.
    for (const [evName, fn] of Object.entries(handlers)) uIOhook.off(evName, fn)
    return { error: `Could not start input hook: ${e.message}` }
  }

  recording = { startedAt, events, handlers }
  return { ok: true, started_at: startedAt }
}

function stopRecording(name) {
  if (!recording) return { error: 'Not recording' }
  try { uIOhook.stop() } catch {}
  for (const [evName, fn] of Object.entries(recording.handlers)) {
    try { uIOhook.off(evName, fn) } catch {}
  }

  const macro = {
    id:          'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name:        (name || `Macro · ${new Date().toLocaleString()}`).slice(0, 120),
    created_at:  Date.now(),
    duration_ms: Date.now() - recording.startedAt,
    events:      recording.events,
  }
  recording = null
  saveMacro(macro)
  return macro
}

function recorderState() {
  return recording
    ? { recording: true, event_count: recording.events.length, started_at: recording.startedAt }
    : { recording: false }
}

// ================================================================
// PLAYER
// ================================================================

let playing   = null
let abortPlay = false

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Translate uiohook button index → nut-js Button.
// libuiohook: 1 = LEFT, 2 = RIGHT, 3 = MIDDLE (HID convention)
function nutButton(b) {
  if (!nut) return null
  if (b === 2) return nut.Button.RIGHT
  if (b === 3) return nut.Button.MIDDLE
  return nut.Button.LEFT
}

// Map uiohook UiohookKey → nut-js Key for the keys we know about. Anything
// outside this map gets dropped during replay (logged once). Built lazily
// because UiohookKey isn't required until first use.
let _keymap = null
function keymap() {
  if (_keymap) return _keymap
  if (!UiohookKey || !nut) return null
  const m = new Map()
  const link = (uhName, nutName) => {
    if (UiohookKey[uhName] != null && nut.Key[nutName] != null) {
      m.set(UiohookKey[uhName], nut.Key[nutName])
    }
  }
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') link(c, c)
  for (const c of '0123456789')                   link(c, `Num${c}`)
  for (let i = 1; i <= 12; i++)                   link(`F${i}`, `F${i}`)
  link('Enter', 'Enter');     link('Space', 'Space');     link('Tab', 'Tab')
  link('Backspace','Backspace'); link('Escape','Escape')
  link('Shift','LeftShift');  link('Ctrl','LeftControl'); link('Alt','LeftAlt')
  link('Meta','LeftSuper')
  link('ShiftRight','RightShift'); link('CtrlRight','RightControl')
  link('AltRight','RightAlt');     link('MetaRight','RightSuper')
  link('ArrowUp','Up'); link('ArrowDown','Down')
  link('ArrowLeft','Left'); link('ArrowRight','Right')
  link('Home','Home'); link('End','End')
  link('PageUp','PageUp'); link('PageDown','PageDown')
  link('Insert','Insert'); link('Delete','Delete')
  link('CapsLock','CapsLock')
  link('Comma','Comma'); link('Period','Period'); link('Slash','Slash')
  link('Semicolon','Semicolon'); link('Quote','Quote')
  link('BracketLeft','LeftBracket'); link('BracketRight','RightBracket')
  link('Backslash','Backslash')
  link('Minus','Minus'); link('Equal','Equal'); link('Backquote','Grave')
  _keymap = m
  return m
}

async function dispatchOne(ev) {
  switch (ev.k) {
    case 'mm':
      await nut.mouse.setPosition(new nut.Point(ev.x, ev.y))
      return
    case 'md':
      await nut.mouse.setPosition(new nut.Point(ev.x, ev.y))
      await nut.mouse.pressButton(nutButton(ev.b))
      return
    case 'mu':
      await nut.mouse.releaseButton(nutButton(ev.b))
      return
    case 'wh': {
      // libuiohook direction: 3 = down, 4 = up. Rotation magnitude is the click count.
      const amt = Math.max(1, Math.abs(ev.d || 1))
      if (ev.dir === 4) await nut.mouse.scrollUp(amt)
      else              await nut.mouse.scrollDown(amt)
      return
    }
    case 'kd': {
      const k = keymap()?.get(ev.key)
      if (k != null) await nut.keyboard.pressKey(k)
      return
    }
    case 'ku': {
      const k = keymap()?.get(ev.key)
      if (k != null) await nut.keyboard.releaseKey(k)
      return
    }
  }
}

async function play(id, opts = {}) {
  if (!isAvailable()) return { error: getLoadError() || 'Native input library not loaded' }
  if (playing)        return { error: 'Already playing a macro' }
  const macro = getMacro(id)
  if (!macro) return { error: `Macro ${id} not found` }

  const speed = Math.max(0.1, Math.min(10, Number(opts.speed) || 1))
  abortPlay = false
  playing = { id, name: macro.name, startedAt: Date.now() }

  // Brief lead-in so the user can release their physical click on the
  // Play button before synthetic input starts firing.
  await sleep(400)

  try {
    let lastT = 0
    for (const ev of macro.events) {
      if (abortPlay) break
      const delay = Math.max(0, (ev.t - lastT) / speed)
      if (delay > 0) await sleep(delay)
      lastT = ev.t
      try { await dispatchOne(ev) } catch (e) {
        // One bad event shouldn't kill the whole replay (e.g. unsupported key).
        // Log on stdout so debugging is possible without UI noise.
        process.stdout.write?.(`[macro] dispatch ${ev.k} failed: ${e.message}\n`)
      }
    }
    return { ok: true, completed: !abortPlay, aborted: abortPlay }
  } catch (e) {
    return { error: e.message }
  } finally {
    playing = null
  }
}

function stopPlay() { abortPlay = true; return { ok: true } }

function playerState() {
  return playing
    ? { playing: true, id: playing.id, name: playing.name, started_at: playing.startedAt }
    : { playing: false }
}

// ================================================================
// AI FORMATTER — macro events → human-readable workflow log
// ================================================================
//
// The raw event stream is keycodes + coordinates — meaningless to a language
// model on its own. This walks the events and reconstructs what the user
// *did*: text they typed, where they clicked, how long they paused. The
// output feeds the background agent so it can recreate the workflow with
// its own tools (bash, browser) instead of replaying raw input.

// Reverse UiohookKey lookup (keycode → name), built lazily like keymap().
let _keyNames = null
function keyNames() {
  if (_keyNames) return _keyNames
  if (!UiohookKey) return null
  const m = new Map()
  for (const [name, code] of Object.entries(UiohookKey)) {
    if (typeof code === 'number' && !m.has(code)) m.set(code, name)
  }
  _keyNames = m
  return m
}

// Printable output for a key name, honoring shift for letters/symbols.
const SHIFT_SYMBOLS = {
  '1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')',
  'Comma':'<','Period':'>','Slash':'?','Semicolon':':','Quote':'"',
  'BracketLeft':'{','BracketRight':'}','Backslash':'|',
  'Minus':'_','Equal':'+','Backquote':'~',
}
const PLAIN_SYMBOLS = {
  'Comma':',','Period':'.','Slash':'/','Semicolon':';','Quote':"'",
  'BracketLeft':'[','BracketRight':']','Backslash':'\\',
  'Minus':'-','Equal':'=','Backquote':'`','Space':' ',
}
function printableFor(name, shift) {
  if (!name) return null
  if (name.length === 1 && name >= 'A' && name <= 'Z') return shift ? name : name.toLowerCase()
  if (name.length === 1 && name >= '0' && name <= '9') return shift ? SHIFT_SYMBOLS[name] : name
  if (shift && SHIFT_SYMBOLS[name] != null) return SHIFT_SYMBOLS[name]
  if (PLAIN_SYMBOLS[name] != null) return PLAIN_SYMBOLS[name]
  return null
}

const MODIFIER_KEYS = new Set(['Shift','ShiftRight','Ctrl','CtrlRight','Alt','AltRight','Meta','MetaRight'])

function fmtOffset(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function formatMacroForAI(macroOrId) {
  tryLoad()
  const m = typeof macroOrId === 'string' ? getMacro(macroOrId) : macroOrId
  if (!m) return null
  const names = keyNames() || new Map()

  const lines = []
  let typed = ''           // pending typed-text buffer
  let typedStart = 0
  const heldMods = new Set()
  let lastEventT = 0
  let lastClick = null

  const flushTyped = () => {
    if (!typed) return
    lines.push(`[${fmtOffset(typedStart)}] Typed: "${typed}"`)
    typed = ''
  }
  const notePause = (t) => {
    const gap = t - lastEventT
    if (gap > 3000) { flushTyped(); lines.push(`[${fmtOffset(lastEventT)}] (paused ${Math.round(gap / 1000)}s)`) }
  }

  for (const ev of m.events || []) {
    if (ev.k === 'mm') continue           // raw cursor motion carries no intent
    notePause(ev.t)
    lastEventT = ev.t

    switch (ev.k) {
      case 'kd': {
        const name = names.get(ev.key) || `key#${ev.key}`
        if (MODIFIER_KEYS.has(name)) { heldMods.add(name); break }
        const nonShift = [...heldMods].filter(k => !k.startsWith('Shift'))
        if (nonShift.length) {
          flushTyped()
          const combo = [...nonShift.map(k => k.replace('Right','')), name].join('+')
          lines.push(`[${fmtOffset(ev.t)}] Pressed ${combo}`)
          break
        }
        const shift = [...heldMods].some(k => k.startsWith('Shift'))
        const ch = printableFor(name, shift)
        if (ch != null) { if (!typed) typedStart = ev.t; typed += ch; break }
        if (name === 'Backspace' && typed) { typed = typed.slice(0, -1); break }
        flushTyped()
        lines.push(`[${fmtOffset(ev.t)}] Pressed ${name}`)
        break
      }
      case 'ku': {
        const name = names.get(ev.key)
        if (name && MODIFIER_KEYS.has(name)) heldMods.delete(name)
        break
      }
      case 'md': {
        flushTyped()
        const btn = ev.b === 2 ? 'Right-clicked' : ev.b === 3 ? 'Middle-clicked' : 'Clicked'
        // Same button+spot within 500ms of the previous click → double-click.
        if (lastClick && lastClick.b === ev.b && ev.t - lastClick.t < 500 &&
            Math.abs(ev.x - lastClick.x) < 4 && Math.abs(ev.y - lastClick.y) < 4 &&
            lines[lastClick.line] && !lines[lastClick.line].includes('Double')) {
          lines[lastClick.line] = lines[lastClick.line].replace(btn, `Double-${btn.toLowerCase()}`)
        } else {
          lines.push(`[${fmtOffset(ev.t)}] ${btn} at (${ev.x}, ${ev.y})`)
          lastClick = { t: ev.t, x: ev.x, y: ev.y, b: ev.b, line: lines.length - 1 }
        }
        break
      }
      case 'wh': {
        flushTyped()
        const dir = ev.dir === 4 ? 'up' : 'down'
        const prev = lines[lines.length - 1]
        if (prev && prev.endsWith(`Scrolled ${dir}`)) break   // collapse scroll runs
        lines.push(`[${fmtOffset(ev.t)}] Scrolled ${dir}`)
        break
      }
    }
  }
  flushTyped()

  return {
    name: m.name,
    duration_ms: m.duration_ms,
    text: lines.join('\n') || '(no meaningful events captured)',
  }
}

// ================================================================
// SCHEDULER — "run this macro at a specific time"
// ================================================================
//
// Persisted as a single JSON file (schedules.json) next to the macro files.
// The main process polls listDueSchedules() on a timer and fires play() for
// any whose `when` <= now. Marked done/missed after run.

function schedulesPath() { return path.join(macrosDir(), '_schedules.json') }

function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(schedulesPath(), 'utf8')) || [] }
  catch { return [] }
}

function writeSchedules(list) {
  fs.writeFileSync(schedulesPath(), JSON.stringify(list, null, 2))
}

function listSchedules() {
  // Annotate with macro name so the UI doesn't have to cross-reference.
  const all = loadSchedules()
  return all.map(s => {
    const m = getMacro(s.macro_id)
    return { ...s, macro_name: m?.name || '(deleted)' }
  }).sort((a, b) => a.when - b.when)
}

function scheduleMacro({ macro_id, when, speed }) {
  if (!getMacro(macro_id)) return { error: `Macro ${macro_id} not found` }
  const ts = Number(when)
  if (!ts || ts < Date.now() - 60_000) return { error: 'Schedule time must be in the future' }
  const s = {
    id:         's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    macro_id,
    when:       ts,
    speed:      Math.max(0.1, Math.min(10, Number(speed) || 1)),
    status:     'pending',          // pending | running | done | missed | cancelled | error
    created_at: Date.now(),
  }
  const all = loadSchedules()
  all.push(s)
  writeSchedules(all)
  return s
}

function cancelSchedule(id) {
  const all = loadSchedules()
  const i = all.findIndex(s => s.id === id)
  if (i < 0) return false
  if (all[i].status === 'pending') all[i].status = 'cancelled'
  writeSchedules(all)
  return true
}

function clearFinishedSchedules() {
  // Keep the JSON from growing forever — drop anything terminal older than 7d.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000
  const all = loadSchedules().filter(s =>
    s.status === 'pending' || s.created_at > cutoff
  )
  writeSchedules(all)
}

function markSchedule(id, patch) {
  const all = loadSchedules()
  const i = all.findIndex(s => s.id === id)
  if (i < 0) return null
  all[i] = { ...all[i], ...patch }
  writeSchedules(all)
  return all[i]
}

// Returns schedules that are due (when <= now) and still pending.
// Caller is responsible for marking them as `running`/`done` afterward.
function takeDueSchedules() {
  const now = Date.now()
  const all = loadSchedules()
  const due = all.filter(s => s.status === 'pending' && s.when <= now)
  return due
}

// ================================================================
// EXPORTS
// ================================================================

module.exports = {
  isAvailable, getLoadError,
  listMacros, getMacro, deleteMacro, renameMacro, formatMacroForAI,
  startRecording, stopRecording, recorderState,
  play, stopPlay, playerState,
  listSchedules, scheduleMacro, cancelSchedule, clearFinishedSchedules,
  takeDueSchedules, markSchedule,
}
