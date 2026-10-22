' GroupResume Companion — Hidden Launcher
' Starts the server without showing a console window
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\.."
WshShell.Run "cmd /c node dist/server.js", 0, False
