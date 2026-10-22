' GroupResume Companion — Tray Launcher
' Starts the system tray app without showing a console window
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
trayScript = scriptDir & "\tray.ps1"
WshShell.CurrentDirectory = fso.GetParentFolderName(scriptDir)
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayScript & """ -Hidden", 0, False
