' Launches the Atithi-Setu print agent with NO visible console window.
' Used by the logon startup task and by Setup.bat so the agent runs quietly
' in the background. The agent (.exe) reads its .env from this same folder.
Dim shell, fso, here, exe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
exe = here & "\AtithiSetuPrintAgent.exe"
shell.CurrentDirectory = here
' 0 = hidden window, False = don't wait
shell.Run """" & exe & """", 0, False
