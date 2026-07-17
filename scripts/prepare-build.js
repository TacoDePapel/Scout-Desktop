#!/usr/bin/env node
/*
 * Runs before packaging. Generates a per-build INSTALLATION_SECRET (used to
 * HMAC the license activation blob so a leaked activation.bin from one
 * build cannot be replayed on another) and writes it to
 * lib/generated-build-info.js.
 *
 * Env inputs (both optional):
 *   SCOUT_INSTALLATION_SECRET  — override the auto-generated secret. Must be
 *                                at least 32 chars. Reuse it across rebuilds
 *                                of the same "shipped version" so activation
 *                                blobs remain valid after in-place upgrades.
 *   SCOUT_OWNER_MACHINE_HASH   — if set, the built app runs only on the one
 *                                machine whose fingerprint hash matches this.
 *                                Get the hash from a target machine's
 *                                userData/log.txt after one failed launch.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const GENERATED = path.join(ROOT, 'lib', 'generated-build-info.js')

const explicitSecret = process.env.SCOUT_INSTALLATION_SECRET
const explicitOwner = process.env.SCOUT_OWNER_MACHINE_HASH

const secret =
  explicitSecret && explicitSecret.length >= 32
    ? explicitSecret
    : crypto.randomBytes(32).toString('hex')

const owner = (explicitOwner || '').trim()

const body = `// AUTO-GENERATED at build time by scripts/prepare-build.js.
// DO NOT COMMIT. The INSTALLATION_SECRET below is unique per build and is
// what makes a leaked activation.bin non-portable.

module.exports = {
  BUILD_INSTALLATION_SECRET: ${JSON.stringify(secret)},
  BUILD_OWNER_MACHINE_HASH: ${JSON.stringify(owner)},
  BUILD_TIMESTAMP_MS: ${Date.now()},
}
`

fs.writeFileSync(GENERATED, body, 'utf8')
console.log(
  `[prepare] wrote ${path.relative(ROOT, GENERATED)} ` +
    `(secret=${secret.slice(0, 8)}…, owner=${owner ? owner.slice(0, 8) + '…' : 'unset'})`
)
