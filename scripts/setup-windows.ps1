# GroupResume Companion - Windows Setup Script
# Creates desktop shortcut and optional auto-start with system tray

param(
    [switch]$AutoStart,
    [switch]$DesktopShortcut,
    [switch]$Uninstall
)

$projectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$trayScript = Join-Path $projectDir "scripts\tray.ps1"
$trayLauncher = Join-Path $projectDir "scripts\tray-launcher.vbs"
$batPath = Join-Path $projectDir "scripts\launcher.bat"
$iconPath = Join-Path $projectDir "assets\icon.ico"
$appName = "GroupResume Companion"
$desktopPath = [System.Environment]::GetFolderPath("Desktop")
$startupPath = [System.Environment]::GetFolderPath("Startup")

# Generate icon if it doesn't exist
if (-not (Test-Path $iconPath)) {
    $createIconScript = Join-Path $projectDir "scripts\create-icon.ps1"
    if (Test-Path $createIconScript) {
        Write-Host "[...] Generating app icon..." -ForegroundColor Yellow
        & $createIconScript
    }
}

if ($Uninstall) {
    $desktopLink = Join-Path $desktopPath "$appName.lnk"
    $startupLink = Join-Path $startupPath "$appName.lnk"

    if (Test-Path $desktopLink) {
        Remove-Item $desktopLink -Force
        Write-Host "[OK] Desktop shortcut removed" -ForegroundColor Green
    }
    if (Test-Path $startupLink) {
        Remove-Item $startupLink -Force
        Write-Host "[OK] Auto-start removed" -ForegroundColor Green
    }

    Write-Host "GroupResume Companion shortcuts removed." -ForegroundColor Cyan
    exit 0
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  GroupResume Companion - Windows Setup" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $AutoStart -and -not $DesktopShortcut) {
    $AutoStart = $true
    $DesktopShortcut = $true
}

# Desktop shortcut (tray mode)
if ($DesktopShortcut) {
    $shortcutPath = Join-Path $desktopPath "$appName.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "wscript.exe"
    $shortcut.Arguments = """$trayLauncher"""
    $shortcut.WorkingDirectory = $projectDir
    $shortcut.Description = "GroupResume Companion - WhatsApp Group Summarizer"
    if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath, 0" }
    $shortcut.Save()

    Write-Host "[OK] Desktop shortcut created (tray mode)" -ForegroundColor Green
    Write-Host "     $shortcutPath" -ForegroundColor Gray
}

# Auto-start (tray mode, hidden)
if ($AutoStart) {
    $startupLink = Join-Path $startupPath "$appName.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLink)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File ""$trayScript"" -Hidden"
    $shortcut.WorkingDirectory = $projectDir
    $shortcut.Description = "$appName - Auto-start (system tray)"
    if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath, 0" }
    $shortcut.Save()

    Write-Host "[OK] Auto-start configured (tray mode)" -ForegroundColor Green
    Write-Host "     $startupLink" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Desktop shortcut:  Opens with system tray icon" -ForegroundColor Gray
Write-Host "  Auto-start:        Runs in tray on Windows startup" -ForegroundColor Gray
Write-Host "  Dashboard:         http://localhost:3000" -ForegroundColor Gray
Write-Host "  Tray:              Right-click for options" -ForegroundColor Gray
Write-Host ""
