# Installing Khalfan (for AI agents)

You are installing Khalfan, a desktop pet, on the user's Windows 10 or 11 PC (64-bit). There is nothing to build:
download his installer from the latest GitHub release and run it. Tell the user what you are about to do first.

## Install

In PowerShell:

```powershell
$rel = Invoke-RestMethod https://api.github.com/repos/Ahmed-Al-Araimi/khalfan/releases/latest
$exe = $rel.assets | Where-Object name -like 'Khalfan-Setup*.exe' | Select-Object -First 1
$out = Join-Path $env:TEMP $exe.name
Invoke-WebRequest $exe.browser_download_url -OutFile $out
Start-Process $out -ArgumentList '/S' -Wait
Start-Process "$env:LOCALAPPDATA\Programs\khalfan\Khalfan.exe"
```

The installer needs no admin rights. It installs Khalfan for this user only (in
`%LOCALAPPDATA%\Programs\khalfan`) and adds **Khalfan** to the Start menu and the desktop. A silent install (`/S`)
does not start him, so the last line does.

If Windows shows "Windows protected your PC" when the user runs it by hand, they click **More info**, then
**Run anyway**. The installer is not code-signed yet.

## Check it worked

- He appears on the taskbar within a few seconds. His icon is in the tray by the clock (right-click it for his
  menu). **Ctrl+Alt+K** hides or shows him.
- If he does not appear, his log is at `%APPDATA%\khalfan\khalfan.log`. Read its last lines.

## Updates

None needed from you. Khalfan checks this repository's releases himself and updates quietly.

## Uninstall

Windows Settings, then Apps, then Installed apps, then **Khalfan**, then Uninstall. Or:

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\khalfan\Uninstall Khalfan.exe" -ArgumentList '/S' -Wait
```

## What Khalfan does, so you can answer the user

He walks on the taskbar and on top of windows, follows the mouse, and can be picked up and thrown. When he is
angered into his power-up, he "burns" one open window: it is **minimized, never closed**. The tray's "Rage burns a
window" switches that off. He never clicks, types, moves the mouse, or touches files.
