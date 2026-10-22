# GroupResume Companion - System Tray Application
# Runs the Node.js server in background with a system tray icon

param(
    [switch]$Hidden
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$serverScript = Join-Path $projectDir "dist\server.js"
$dashboardUrl = "http://localhost:3000"
$appName = "GroupResume Companion"
$script:serverProcess = $null
$script:isExiting = $false

# ── Create App Icon Programmatically ──────────────────────

function New-AppIcon {
    $bmp = New-Object System.Drawing.Bitmap(64, 64)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Circle background (indigo #6366f1)
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 99, 102, 241))
    $g.FillEllipse($bgBrush, 2, 2, 60, 60)

    # Chat bubble shape (white)
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillEllipse($whiteBrush, 14, 14, 36, 28)

    # Bubble tail
    $tailPoints = @(
        (New-Object System.Drawing.Point(22, 38)),
        (New-Object System.Drawing.Point(18, 48)),
        (New-Object System.Drawing.Point(32, 38))
    )
    $g.FillPolygon($whiteBrush, $tailPoints)

    # Text lines inside bubble
    $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 99, 102, 241))
    $g.FillRectangle($lineBrush, 20, 22, 24, 3)
    $g.FillRectangle($lineBrush, 20, 28, 18, 3)
    $g.FillRectangle($lineBrush, 20, 34, 21, 3)

    $g.Dispose()
    $bgBrush.Dispose()
    $whiteBrush.Dispose()
    $lineBrush.Dispose()

    $iconHandle = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
    $bmp.Dispose()
    return $icon
}

# ── Server Process Management ─────────────────────────────

function Start-ServerProcess {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        Write-Host "[Tray] Server already running (PID: $($script:serverProcess.Id))"
        return
    }

    Write-Host "[Tray] Starting server..."

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "node"
    $startInfo.Arguments = """$serverScript"""
    $startInfo.WorkingDirectory = $projectDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["GROUPRESUME_HIDDEN"] = "1"

    $script:serverProcess = [System.Diagnostics.Process]::Start($startInfo)
    Write-Host "[Tray] Server started (PID: $($script:serverProcess.Id))"

    # Show notification
    $script:trayIcon.ShowBalloonTip(
        3000,
        $appName,
        "Server started. Dashboard: $dashboardUrl",
        [System.Windows.Forms.ToolTipIcon]::Info
    )
}

function Stop-ServerProcess {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        Write-Host "[Tray] Stopping server (PID: $($script:serverProcess.Id))..."

        try {
            # Kill the node process tree
            $procId = $script:serverProcess.Id
            taskkill /PID $procId /T /F 2>$null | Out-Null
        } catch {
            try { $script:serverProcess.Kill() } catch {}
        }

        Write-Host "[Tray] Server stopped"
    }
    $script:serverProcess = $null
}

function Restart-ServerProcess {
    $script:trayIcon.ShowBalloonTip(
        2000,
        $appName,
        "Restarting server...",
        [System.Windows.Forms.ToolTipIcon]::Info
    )

    Stop-ServerProcess
    Start-Sleep -Seconds 2
    Start-ServerProcess
}

function Get-ServerStatus {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        try {
            $response = Invoke-RestMethod -Uri "$dashboardUrl/api/status" -Method GET -TimeoutSec 3 -ErrorAction Stop
            return "connected"
        } catch {
            return "starting"
        }
    }
    return "stopped"
}

function Open-Dashboard {
    Start-Process $dashboardUrl
}

# ── Build System Tray ─────────────────────────────────────

function Initialize-Tray {
    # Try to use the real .ico file; fall back to programmatic icon
    $icoPath = Join-Path $projectDir "assets\icon.ico"
    if (Test-Path $icoPath) {
        $icon = New-Object System.Drawing.Icon($icoPath, 32, 32)
    } else {
        $icon = New-AppIcon
    }

    $script:trayIcon = New-Object System.Windows.Forms.NotifyIcon
    $script:trayIcon.Icon = $icon
    $script:trayIcon.Text = "$appName`nClique para abrir"
    $script:trayIcon.Visible = $true

    # Context menu
    $contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

    # Title (disabled, bold)
    $titleItem = New-Object System.Windows.Forms.ToolStripMenuItem("GroupResume Companion")
    $titleItem.Enabled = $false
    $titleItem.Font = New-Object System.Drawing.Font($titleItem.Font, [System.Drawing.FontStyle]::Bold)
    $contextMenu.Items.Add($titleItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Open Dashboard
    $openItem = New-Object System.Windows.Forms.ToolStripMenuItem("Abrir Dashboard")
    $openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
    $openItem.Add_Click({ Open-Dashboard })
    $contextMenu.Items.Add($openItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Status
    $script:statusItem = New-Object System.Windows.Forms.ToolStripMenuItem("Status: Verificando...")
    $script:statusItem.Enabled = $false
    $contextMenu.Items.Add($script:statusItem) | Out-Null

    # Restart Server
    $restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Reiniciar Servidor")
    $restartItem.Add_Click({ Restart-ServerProcess })
    $contextMenu.Items.Add($restartItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Auto-start toggle
    $startupPath = [System.Environment]::GetFolderPath("Startup")
    $startupLink = Join-Path $startupPath "$appName.lnk"
    $autoStartExists = Test-Path $startupLink
    $autoStartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Iniciar com Windows")
    $autoStartItem.Checked = $autoStartExists
    $autoStartItem.Add_Click({
        param($sender)
        $startupPath = [System.Environment]::GetFolderPath("Startup")
        $startupLink = Join-Path $startupPath "$appName.lnk"

        if ($sender.Checked) {
            # Remove auto-start
            if (Test-Path $startupLink) { Remove-Item $startupLink -Force }
            $sender.Checked = $false
            $script:trayIcon.ShowBalloonTip(2000, $appName, "Auto-start disabled", [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
            # Add auto-start
            $trayScript = Join-Path $projectDir "scripts\tray.ps1"
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($startupLink)
            $shortcut.TargetPath = "powershell.exe"
            $shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File ""$trayScript"" -Hidden"
            $shortcut.WorkingDirectory = $projectDir
            $shortcut.Description = "$appName - Auto-start"
            $shortcut.Save()
            $sender.Checked = $true
            $script:trayIcon.ShowBalloonTip(2000, $appName, "Auto-start enabled", [System.Windows.Forms.ToolTipIcon]::Info)
        }
    })
    $contextMenu.Items.Add($autoStartItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Quit
    $quitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Sair")
    $quitItem.Add_Click({
        $script:isExiting = $true
        Stop-ServerProcess
        $script:trayIcon.Visible = $false
        $script:trayIcon.Dispose()
        if (Test-Path $lockFile) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
        [System.Windows.Forms.Application]::Exit()
    })
    $contextMenu.Items.Add($quitItem) | Out-Null

    $script:trayIcon.ContextMenuStrip = $contextMenu

    # Double-click opens dashboard
    $script:trayIcon.Add_DoubleClick({ Open-Dashboard })

    # Left-click also opens dashboard
    $script:trayIcon.Add_Click({
        param($sender, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            Open-Dashboard
        }
    })

    # Status update timer (every 10 seconds)
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 10000
    $timer.Add_Tick({
        $status = Get-ServerStatus
        switch ($status) {
            "connected" {
                $script:statusItem.Text = "Status: Conectado"
                $script:trayIcon.Text = "$appName`nConectado"
            }
            "starting" {
                $script:statusItem.Text = "Status: Iniciando..."
                $script:trayIcon.Text = "$appName`nIniciando..."
            }
            "stopped" {
                $script:statusItem.Text = "Status: Parado"
                $script:trayIcon.Text = "$appName`nParado"
                if (-not $script:isExiting) {
                    Start-ServerProcess
                }
            }
        }
    })
    $timer.Start()
}

# ── Main ──────────────────────────────────────────────────

# Single instance check using a lock file with PID verification
$lockFile = Join-Path $projectDir "data\tray.lock"
$dataDir = Join-Path $projectDir "data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

$alreadyRunning = $false
if (Test-Path $lockFile) {
    $lockPid = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($lockPid) {
        $existingProc = Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue
        if ($existingProc -and -not $existingProc.HasExited) {
            $alreadyRunning = $true
        }
    }
}

if ($alreadyRunning) {
    Write-Host "[Tray] Another instance is already running (PID: $lockPid). Opening dashboard..."
    Start-Process $dashboardUrl
    exit 0
}

# Write our PID to the lock file
Set-Content -Path $lockFile -Value $PID -Force

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GroupResume Companion - System Tray" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Kill any existing node server on port 3000
try {
    $existingPid = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
    if ($existingPid) {
        Write-Host "[Tray] Killing existing process on port 3000 (PID: $existingPid)..."
        taskkill /PID $existingPid /F 2>$null | Out-Null
        Start-Sleep -Seconds 1
    }
} catch {}

Initialize-Tray
Start-ServerProcess

Write-Host "[Tray] System tray icon active"
Write-Host "[Tray] Right-click the icon for options"
Write-Host "[Tray] Double-click to open dashboard"
Write-Host ""

# Auto-open dashboard on first start (wait for server to be ready)
$openTimer = New-Object System.Windows.Forms.Timer
$openTimer.Interval = 2000
$script:openAttempts = 0
$openTimer.Add_Tick({
    $script:openAttempts++
    try {
        $response = Invoke-RestMethod -Uri "$dashboardUrl/api/status" -Method GET -TimeoutSec 2 -ErrorAction Stop
        if ($response.status) {
            Open-Dashboard
            $openTimer.Stop()
            $openTimer.Dispose()
        }
    } catch {
        if ($script:openAttempts -ge 15) {
            $openTimer.Stop()
            $openTimer.Dispose()
            Write-Host "[Tray] Could not auto-open dashboard (server timeout)"
        }
    }
})
$openTimer.Start()

# Hide console window if -Hidden flag is set
if ($Hidden) {
    $consoleWindow = [System.Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate(
        [Action] { }
    )
    Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class ConsoleWindow {
            [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
            [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }
"@
    $hwnd = [ConsoleWindow]::GetConsoleWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
        [ConsoleWindow]::ShowWindow($hwnd, 0) | Out-Null
    }
}

# Run the message loop (keeps the tray icon alive)
[System.Windows.Forms.Application]::Run()
