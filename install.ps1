# Antigravity Mobile Remote Installer for Windows PowerShell
$Host.UI.RawUI.WindowTitle = "Antigravity Mobile Remote Installer"

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "   🚀 Antigravity Mobile Remote - Windows PowerShell Setup" -ForegroundColor Magenta
Write-Host "=======================================================" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not installed or not found in PATH." -ForegroundColor Red
    Write-Host "Please download and install Node.js (v18+) from https://nodejs.org" -ForegroundColor Yellow
    Read-Host "Press Enter to exit..."
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
node scripts\installer.js
