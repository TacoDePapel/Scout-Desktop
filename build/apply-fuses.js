/*
 * Post-pack hook: flip Electron Fuses on the packed binary before the
 * installer wraps it. These flags are compiled into the electron.exe
 * itself and cannot be re-enabled without a hex editor + resigning.
 *
 * See https://www.electronjs.org/docs/latest/tutorial/fuses. The set below
 * is the "lockdown for shipped desktop app" preset:
 *
 *   RunAsNode                              → OFF   (blocks ELECTRON_RUN_AS_NODE)
 *   EnableCookieEncryption                 → ON    (encrypt local cookies at rest)
 *   EnableNodeOptionsEnvironmentVariable   → OFF   (blocks NODE_OPTIONS)
 *   EnableNodeCliInspectArguments          → OFF   (blocks --inspect / --inspect-brk)
 *   EnableEmbeddedAsarIntegrityValidation  → ON    (verifies asar hash at load)
 *   OnlyLoadAppFromAsar                    → ON    (refuses to run app from a dir)
 *   LoadBrowserProcessSpecificV8Snapshot   → OFF   (no per-window snapshot smuggling)
 *   GrantFileProtocolExtraPrivileges       → OFF   (file:// windows aren't privileged)
 */

const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack(context) {
  const appOut = context.appOutDir
  const productName = context.packager.appInfo.productFilename
  const platform = context.electronPlatformName

  let electronBinary
  if (platform === 'win32') {
    electronBinary = path.join(appOut, `${productName}.exe`)
  } else if (platform === 'darwin') {
    electronBinary = path.join(
      appOut,
      `${productName}.app`,
      'Contents',
      'MacOS',
      productName
    )
  } else {
    electronBinary = path.join(appOut, productName.toLowerCase())
  }

  console.log(`[fuses] flipping fuses on ${electronBinary}`)

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })

  console.log('[fuses] done')
}
