/* his updates: the installed Khalfan looks at this repo's GitHub Releases a little after he starts and every few hours.
 * A new version downloads quietly in the background; then he says so by the clock and restarts into it a few seconds
 * later (the installer runs silently, his settings stay). Run from source (npm start), he never updates himself.
 * No network, no new version, GitHub down: he only notes it in his log and carries on.
 */
'use strict';
const { app } = require('electron');

module.exports = function startUpdates({ log, tray, quitting }) {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log('updates: not available:', e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;                       // (if he is quit before the restart below)
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (i) => log('updates: downloading', i.version));
  autoUpdater.on('update-not-available', () => log('updates: up to date', app.getVersion()));
  autoUpdater.on('error', (e) => log('updates: could not check:', String(e && e.message || e).split('\n')[0]));
  autoUpdater.on('update-downloaded', (i) => {
    log('updates: ready', i.version, '- restarting into it');
    const t = tray();
    try { if (t) t.displayBalloon({ title: 'Khalfan ' + i.version, content: 'A new Khalfan is here. He will be right back.', iconType: 'info' }); } catch (e) { /* no balloon */ }
    setTimeout(() => { quitting(); autoUpdater.quitAndInstall(true, true); }, 8000);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* logged by 'error' */ });
  setTimeout(check, 20 * 1000);
  setInterval(check, 4 * 60 * 60 * 1000);
};
