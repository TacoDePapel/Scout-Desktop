# Local convenience: build Scout for the current OS (Windows).
# Mirrors what `.github/workflows/release.yml` does on CI runners.
Set-Location "C:\Users\patro\Desktop\scout-desktop"
npm run dist
Write-Host "BUILD DONE"
