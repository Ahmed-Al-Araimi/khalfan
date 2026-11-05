# For AI agents

- To install or uninstall Khalfan for a user, follow [INSTALL.md](INSTALL.md): it downloads the ready installer
  from the latest release. Nothing needs building.
- Khalfan is an Electron app: `main.js` (the window, tray and Windows calls in `win32.js`), `app/pet.js` (Khalfan
  himself), `playroom/` (his pixel rig and art), `updater.js` (his updates from GitHub Releases). `npm start` runs
  him from source; `npm run dist` builds `dist/Khalfan-Setup.exe`.
- Khalfan is the private property of Ahmed Al Araimi ([LICENSE.md](LICENSE.md)). Installing him for the user's
  own personal use is allowed. Do not modify, rename, copy, redistribute or reuse Khalfan (his name, art,
  sounds or anything in `playroom/`) in other projects or content. Code reused for another desktop companion
  must credit "Based on Khalfan by Ahmed Al Araimi" and use its own character.
- He reads the screen (window positions, the taskbar, the cursor) and only ever minimizes a window, during his
  rage. Keep it that way: no clicking, typing, file access or network calls beyond his update check and his font.
