#!/usr/bin/env node
/*
 * End-to-end hardened Windows build.
 *
 *   1. prepare-build.js   → writes fresh INSTALLATION_SECRET into
 *                           lib/generated-build-info.js
 *   2. Backs up the main-process JS files to .build-backup/ and rewrites
 *      the originals via javascript-obfuscator with aggressive settings.
 *   3. Runs `electron-builder --win`, which fires:
 *        - build/apply-fuses.js as afterPack (locks Electron Fuses)
 *   4. Restores originals from .build-backup/ (always, even on crash).
 *
 * Skip obfuscation with SCOUT_SKIP_OBFUSCATE=1 for packaging smoke tests.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const BACKUP_DIR = path.join(ROOT, '.build-backup')

// Files to obfuscate. Renderer.js is deliberately excluded — its code runs
// against the DOM and aggressive control-flow flattening can break browser
// APIs. Add it here only after a manual smoke test.
const OBFUSCATE_TARGETS = [
  'main.js',
  'preload.js',
  'lib/license.js',
  'lib/integrity.js',
  'lib/generated-build-info.js',
]

// If lib/macro/ exists, add its .js files.
function collectMacroJs() {
  const macroDir = path.join(ROOT, 'lib', 'macro')
  if (!fs.existsSync(macroDir)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(path.relative(ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  walk(macroDir)
  return out
}

const OBFUSCATE_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  target: 'node',
  sourceMap: false,
}

function runStep(name, cmd, args) {
  console.log(`\n=== ${name} ===`)
  console.log(`> ${cmd} ${args.join(' ')}`)
  const isWin = process.platform === 'win32'
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  })
  if (res.status !== 0) {
    throw new Error(`step "${name}" failed (exit ${res.status})`)
  }
}

function backupTargets(targets) {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  for (const rel of targets) {
    const src = path.join(ROOT, rel)
    if (!fs.existsSync(src)) continue
    const dst = path.join(BACKUP_DIR, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  console.log(`[backup] ${targets.length} file(s) copied to ${path.relative(ROOT, BACKUP_DIR)}/`)
}

function restoreTargets(targets) {
  let restored = 0
  for (const rel of targets) {
    const dst = path.join(ROOT, rel)
    const src = path.join(BACKUP_DIR, rel)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
      restored += 1
    }
  }
  console.log(`[restore] ${restored} file(s) restored from backup`)
}

function obfuscateInPlace(targets) {
  if (process.env.SCOUT_SKIP_OBFUSCATE === '1') {
    console.log('[obfuscate] SCOUT_SKIP_OBFUSCATE=1 — skipping')
    return
  }
  let JsObf
  try {
    JsObf = require('javascript-obfuscator')
  } catch (err) {
    throw new Error(
      'javascript-obfuscator not installed. Run `npm install` first.\n' +
        (err && err.message ? err.message : String(err))
    )
  }
  const t0 = Date.now()
  for (const rel of targets) {
    const full = path.join(ROOT, rel)
    if (!fs.existsSync(full)) continue
    const source = fs.readFileSync(full, 'utf8')
    const result = JsObf.obfuscate(source, OBFUSCATE_OPTIONS)
    fs.writeFileSync(full, result.getObfuscatedCode(), 'utf8')
    console.log(`[obfuscate] ${rel}`)
  }
  console.log(
    `[obfuscate] ${targets.length} file(s) rewritten in ${Math.round((Date.now() - t0) / 100) / 10}s`
  )
}

function main() {
  const targets = [...OBFUSCATE_TARGETS, ...collectMacroJs()]

  runStep('prepare-build', 'node', ['scripts/prepare-build.js'])
  backupTargets(targets)

  let builderError = null
  try {
    obfuscateInPlace(targets)
    const platformArg = process.env.SCOUT_BUILD_TARGET || '--win'
    runStep('electron-builder', 'npx', ['electron-builder', platformArg])
  } catch (err) {
    builderError = err
  } finally {
    restoreTargets(targets)
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  }

  if (builderError) {
    console.error('\n[build-secure] FAILED:', builderError.message)
    process.exit(1)
  }
  console.log('\n[build-secure] OK — installer(s) written to dist/')
}

main()
