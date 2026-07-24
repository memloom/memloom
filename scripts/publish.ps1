# Publish every public package to npm in dependency order, with one OTP code.
# Usage:  .\scripts\publish.ps1 -Otp 123456
# pnpm handles the order (core -> server/mcp -> cli), rewrites workspace:* to real
# versions, and skips packages whose version is already on the registry, so a rerun
# after a mid-way OTP expiry is safe.
param([Parameter(Mandatory = $true)][string]$Otp)

pnpm -r publish --access public --otp $Otp
