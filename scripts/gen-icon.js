// Generates build/icon.png (1024×1024) plus the macOS tray template pair.
// Pure Node.js + zlib — no external image deps, so this works on every CI
// runner (Windows, macOS, Linux) without an `npm install` of a native lib.
const zlib = require('zlib')
const fs   = require('fs')
const path = require('path')

// ---- CRC32 ----
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// ---- PNG builder ----
function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii')
  const crc   = crc32(Buffer.concat([typeB, data]))
  const out   = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeB.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc, 8 + data.length)
  return out
}
function makePNG(size, pixel) {
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8; ihdrData[9] = 6 // RGBA

  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0 // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size)
      const o = y * (1 + size * 4) + 1 + x * 4
      raw[o] = r; raw[o+1] = g; raw[o+2] = b; raw[o+3] = a
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- Scout icon design ----
// Dark navy background · subtle gold ring · red record circle in centre
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)) }
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function scoutPixel(x, y, S) {
  const cx = S / 2, cy = S / 2
  const d  = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
  const nd = d / (S / 2) // 0 = centre, 1 = corner

  // Background color — dark navy #1C2540
  let r = 28, g = 37, b = 64, a = 255

  // Outer circle clip (entire icon is a disc)
  const outerR = S * 0.490
  if (d > outerR) {
    return [0, 0, 0, 0] // transparent outside
  }

  // Subtle gold halo ring just inside the edge
  const ringOuter = S * 0.486
  const ringInner = S * 0.448
  if (d >= ringInner && d <= ringOuter) {
    const t = smoothstep(ringInner, ringOuter, d)
    r = Math.round(lerp(28,  182, t))
    g = Math.round(lerp(37,  128, t))
    b = Math.round(lerp(64,   57, t))
    return [r, g, b, 255]
  }

  // Red record circle — radius 30 % of canvas, hard AA edge
  const circR = S * 0.295
  if (d <= circR + 1.5) {
    const aa = smoothstep(circR + 1.5, circR - 0.5, d)
    // Slight gradient: brighter top-left
    const highlight = 1 - 0.15 * ((x - cx) / circR + 0.5) * 0.5
    const rr = Math.round(lerp(r, 222 * highlight, aa))
    const rg = Math.round(lerp(g, 45, aa))
    const rb = Math.round(lerp(b, 45, aa))
    return [rr, rg, rb, 255]
  }

  return [r, g, b, a]
}

// ---- macOS tray template (monochrome, alpha-only) ----
// macOS menu-bar icons must be template images: pure black pixels with alpha,
// and the system auto-tints them for light/dark menu bars.
// Design: a solid disc with a small hole in the center — reads clearly at 16px.
function trayTemplatePixel(x, y, S) {
  const cx = S / 2, cy = S / 2
  const d  = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
  const outerR = S * 0.46
  const innerR = S * 0.16

  if (d > outerR + 0.8) return [0, 0, 0, 0]
  if (d < innerR - 0.8) return [0, 0, 0, 0]

  let alpha = 255
  if (d > outerR - 0.5)      alpha = Math.round(255 * smoothstep(outerR + 0.8, outerR - 0.5, d))
  else if (d < innerR + 0.5) alpha = Math.round(255 * smoothstep(innerR - 0.8, innerR + 0.5, d))

  return [0, 0, 0, alpha]
}

// ---- Write files ----
const outDir = path.join(__dirname, '..', 'build')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

const iconPng = makePNG(1024, scoutPixel)
fs.writeFileSync(path.join(outDir, 'icon.png'), iconPng)
console.log('✓ build/icon.png generated (1024×1024)')

// macOS template tray icon — 16×16 standard + 32×32 @2x (retina)
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'),    makePNG(16, trayTemplatePixel))
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), makePNG(32, trayTemplatePixel))
console.log('✓ build/trayTemplate.png + @2x generated (macOS template)')
