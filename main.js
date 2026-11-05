/* Desktop Khalfan: the Electron shell.
 *
 * One transparent, click-through, always-on-top window over the main screen (1 px shorter than it, so Windows never
 * takes it for a full-screen app). It only takes the mouse while the cursor is on Khalfan. The pet itself lives in
 * app/pet.js; this file feeds it the cursor, the windows he can stand on, the taskbar and a few signals (idle time,
 * the foreground window, a full-screen app), and owns the tray and Ctrl+Alt+K.
 *
 *   npm start                 run him
 *   npm run review -- <name>  render a review sheet of one scenario into review/ (no live desktop needed)
 */
'use strict';
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');   // never throttled as "hidden"
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');      // his little sounds without a click first

const REVIEW = (() => { const i = process.argv.indexOf('--review'); return i > 0 ? (process.argv[i + 1] || 'all') : null; })();
if (REVIEW && /film/.test(REVIEW)) app.commandLine.appendSwitch('force-device-scale-factor', '1.5');   // films at his screen's 150%
if (!REVIEW && !app.requestSingleInstanceLock()) { app.quit(); }

// ---------------------------------------------------------------- his log (userData\khalfan.log): starts, hides, shows, quits, errors
const LOG_FILE = path.join(app.getPath('userData'), 'khalfan.log');
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  if (REVIEW) { process.stdout.write(line); return; }
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 300000) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* never let the log stop him */ }
}
// an error anywhere in here is written down, and he carries on
process.on('uncaughtException', (e) => log('uncaught', e && e.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandled rejection', e && e.stack || String(e)));

let W32 = null, ICONS = null;
try { W32 = require('./win32'); } catch (e) { log('win32 bindings failed:', e.message); }
try { ICONS = require('./icons'); } catch (e) { log('icon bindings failed:', e.message); }

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { size: 'medium', sound: true, mischief: true, visible: true };
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))); } catch (e) { /* first run */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- the window
let win = null, tray = null, myHwnd = 0, area = null;
let interactive = false, tracked = 0, hiding = false, busyHidden = false;

function hwndOf(w) {
  const b = w.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

function placeWindow() {
  const d = screen.getPrimaryDisplay();
  area = { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height - 1, work: d.workArea, scale: d.scaleFactor };
  if (win) { win.setBounds({ x: area.x, y: area.y, width: area.w, height: area.h }); coverScreen(); }
}
// over the whole main screen, the taskbar too (Electron alone stops the window at the taskbar's top, which cut him off
// there: no dangling over its edge). 1 px short of the bottom, so Windows never takes him for a full-screen app.
let coverTries = 0;
function coverScreen() {
  if (!win || win.isDestroyed() || !W32 || !myHwnd) return;
  try {
    const d = screen.getPrimaryDisplay();
    const p = screen.dipToScreenRect(null, d.bounds);
    const w = Math.floor(d.bounds.width * d.scaleFactor), h = Math.floor(d.bounds.height * d.scaleFactor) - 1;
    if (W32.placeOwn(myHwnd, p.x, p.y, w, h)) {
      coverTries = (coverTries || 0) + 1;
      if (coverTries <= 3) log('covered the screen', { x: p.x, y: p.y, w, h, try: coverTries });
    }
  } catch (e) { log('cover failed', e.message); }
}

function createWindow() {
  placeWindow();
  win = new BrowserWindow({
    x: area.x, y: area.y, width: area.w, height: area.h,
    transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false, thickFrame: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, title: 'Khalfan', enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => {
    const fs0 = fullScreenApp();
    log('ready', { visible: settings.visible, fullScreenApp: fs0, size: settings.size });
    if (settings.visible && !fs0) showWin(); else { busyHidden = !!settings.visible && fs0; win.webContents.send('visible', false); }
  });
  myHwnd = hwndOf(win);
  win.on('closed', () => { log('window closed'); win = null; });
  win.on('unresponsive', () => { log('page unresponsive'); setInteractive(false); });
  win.on('responsive', () => log('page responsive again'));
  win.webContents.on('render-process-gone', (e, d) => {
    log('page crashed', d);
    setInteractive(false);
    setTimeout(() => win && !win.isDestroyed() && win.reload(), 1500);
  });
}

// Is a full-screen app in front on his screen (a game, a video, a presentation, a browser in F11)? He steps aside.
// Decided from the window in front itself: it covers the whole main screen (taskbar too) and has no title bar.
// Windows' own "busy" flag is not trusted (an invisible overlay keeps it on; see win32.busy).
const SHELL = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow',
  'XamlExplorerHostIslandWindow_WASDK', 'MultitaskingViewFrame', 'ForegroundStaging', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow']);
let showAnywayFor = 0;                                              // he was asked to show over this full-screen window
function fullScreenApp() {
  if (!W32 || process.env.KHALFAN_SHOW_ALWAYS) return false;
  try {
    if (W32.busy()) return true;                                    // a Direct3D exclusive game, or presentation mode
    const fg = W32.foreground();
    if (!fg || !fg.rect || fg.iconic || fg.hwnd === myHwnd || SHELL.has(fg.cls) || fg.caption) return false;
    if (fg.hwnd === showAnywayFor) return false;
    const r = toDip(fg.rect);
    return r.x <= 1 && r.y <= 1 && r.x + r.w >= area.w - 1 && r.y + r.h >= area.h;
  } catch (e) { return false; }
}

let hitBox = null;                                                  // his box on screen (DIP), sent with every change
function setInteractive(on) {
  if (!win || on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}
// the safety net: the window takes the mouse only around him. If the page ever stalls with it on, main turns it off
// as soon as the cursor is away from him and no button is held, so your clicks always get through.
function guardClicks(pt) {
  if (!interactive) return;
  if (W32 && (W32.leftDown() || W32.rightDown())) return;
  const b = hitBox, m = 40;
  const x = pt.x - area.x, y = pt.y - area.y;
  if (!b || x < b.x - m || x > b.x + b.w + m || y < b.y - m || y > b.y + b.h + m) setInteractive(false);
}

// ---------------------------------------------------------------- what he can see
function toDip(r) {
  const d = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
  return { x: d.x - area.x, y: d.y - area.y, w: d.width, h: d.height };
}
function subtract(segs, a, b) {
  const out = [];
  for (const [x0, x1] of segs) {
    if (b <= x0 || a >= x1) { out.push([x0, x1]); continue; }
    if (a > x0) out.push([x0, a]);
    if (b < x1) out.push([b, x1]);
  }
  return out;
}
const isFav = () => false;                                     // (no window is special)

// the desktop's icons (the files on the desktop), read every 2 s: they hardly ever move
const iconCache = { t: 0, list: null, n: -1 };
function desktopIcons() {
  const now = Date.now();
  if (now - iconCache.t > 2000) {
    iconCache.t = now;
    try { iconCache.list = ICONS ? ICONS.listIcons() : null; } catch (e) { iconCache.list = null; }
    const n = iconCache.list ? iconCache.list.length : -1;
    if (n !== iconCache.n) { iconCache.n = n; log('desktop icons', n, iconCache.list ? '' : '(unreadable)'); }
  }
  return iconCache.list;
}
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// the top edges he can stand on (their visible parts), plus every window as a rect (for the occlusion of what he does)
function world() {
  const W = area.w, H = area.h;
  const work = area.work;
  const floorY = Math.min(H, work.y + work.height - area.y);
  const taskbar = floorY < H - 2 ? { x: work.x - area.x, y: floorY, w: work.width, h: H - floorY } : null;
  const ledges = [], rects = [], icons = [];
  let fg = null;
  if (W32) {
    const skip = new Set([myHwnd]);
    let ws = [];
    try { ws = W32.listWindows(skip); } catch (e) { ws = []; }
    const occ = [];
    for (const w of ws) {
      const r = toDip(w.rect);
      if (r.x >= W || r.x + r.w <= 0 || r.y >= H || r.y + r.h <= 0) continue;   // not on this screen
      const fav = isFav(w);
      rects.push({ hwnd: w.hwnd, x: r.x, y: r.y, w: r.w, h: r.h, fav, max: w.max, ledge: !!w.ledge, z: rects.length,
        cls: w.cls, normal: !!w.title && (!!w.ledge || !!w.max) });     // (normal: an app's own window, one his rage may strike)   // (ledge: a real window, so also a room to drop him into)
      if (w.ledge && r.y > 70 && r.y < floorY - 60) {
        let segs = [[Math.max(0, r.x), Math.min(W, r.x + r.w)]];
        for (const o of occ) if (o.y < r.y + 1 && o.y + o.h > r.y - 1) segs = subtract(segs, o.x, o.x + o.w);
        for (const [x0, x1] of segs) {
          if (x1 - x0 >= 70) ledges.push({ hwnd: w.hwnd, x0, x1, y: r.y, kind: fav ? 'fav' : 'window', title: w.title.slice(0, 60), full: x0 <= r.x + 1 && x1 >= r.x + r.w - 1 });
        }
      }
      occ.push(r);
    }
    try { fg = W32.foreground(); } catch (e) { fg = null; }
    if (fg) fg = { hwnd: fg.hwnd, fav: isFav(fg), title: fg.title.slice(0, 60), proc: fg.proc };
    // the desktop's icons: each with whether it is in the open (no window over its picture or its name)
    const list = desktopIcons();
    if (list) {
      for (const ic of list) {
        const r = toDip(ic.icon), l = toDip(ic.label);
        if (r.x >= W || r.x + r.w <= 0 || r.y >= floorY || r.y + r.h <= 0) continue;
        const both = { x: Math.min(r.x, l.x), y: r.y, w: Math.max(r.x + r.w, l.x + l.w) - Math.min(r.x, l.x), h: l.y + l.h - r.y };
        icons.push({ i: ic.i, name: ic.name.slice(0, 40), x: r.x, y: r.y, w: r.w, h: r.h, yb: l.y + l.h, open: !rects.some((q) => overlaps(q, both)) });
      }
    }
  }
  return {
    W, H, floorY, taskbar, ledges, rects, icons, fg, scale: area.scale,
    idle: W32 ? W32.idleMs() : 0,
    busy: false,
    hour: new Date().getHours(),
  };
}

// The cursor, the buttons, and the rect of the window under his feet (so he rides it smoothly): 60 a second while
// something is going on (he moves, he is on a window, he has the mouse), 30 when he is just standing about; and
// nothing is sent when nothing changed.
let paceFast = true, lastSent = '';
function tick() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const pt = screen.getCursorScreenPoint();
  guardClicks(pt);
  let tr = null;
  if (tracked && W32) {
    const r = W32.windowRect(tracked);
    tr = r ? Object.assign({ hwnd: tracked }, toDip(r)) : { hwnd: tracked, gone: true };
  }
  const d = { mx: pt.x - area.x, my: pt.y - area.y, ld: W32 ? W32.leftDown() : false, rd: W32 ? W32.rightDown() : false, tr };
  // the user pressed the button somewhere else and is dragging: his window lets go of the mouse at once
  if (interactive && d.ld && !pageDrag) { const b = hitBox; if (!b || d.mx < b.x || d.mx > b.x + b.w || d.my < b.y || d.my > b.y + b.h) setInteractive(false); }
  const key = tr ? '' : `${d.mx},${d.my},${d.ld},${d.rd}`;               // (while riding a window every tick counts)
  if (key && key === lastSent) return;
  lastSent = key;
  win.webContents.send('tick', d);
}
function tickLoop() {
  tick();
  setTimeout(tickLoop, paceFast || tracked || interactive ? 16 : 33);
}
function worldTick() {
  if (!win || win.isDestroyed()) return;
  const busy = fullScreenApp();
  // a full-screen app (a game, a video, a presentation): he steps aside, and comes back after
  if (busy && !busyHidden && win.isVisible()) { busyHidden = true; log('hide: full-screen app in front', fgName()); hideWin(); }
  else if (!busy && busyHidden) {
    busyHidden = false; showAnywayFor = 0;
    if (settings.visible) { log('show: full-screen app gone'); showWin(); win.webContents.send('event', { type: 'hello' }); }
  }
  if (!win.isVisible()) return;                                       // hidden: nothing else to look at
  win.moveTop();                                                      // above the taskbar, even after it was clicked
  coverScreen();                                                      // (cheap when already right)
  const wd = world();
  wd.busy = busy;
  win.webContents.send('world', wd);
}
// hidden, the page stops drawing altogether (its frame loop would otherwise keep running: background throttling is off)
function hideWin() { if (!win) return; win.hide(); setInteractive(false); win.webContents.send('visible', false); }
function showWin() { if (!win) return; win.webContents.send('world', world()); win.webContents.send('visible', true); win.showInactive(); coverScreen(); }

// ---------------------------------------------------------------- show / hide
function fgName() { try { const f = W32 && W32.foreground(); return f ? f.proc : ''; } catch (e) { return ''; } }
function toggle(force, why = 'toggle') {
  if (!win) return;
  const show = force != null ? force : !(settings.visible && win.isVisible());
  log(show ? 'show asked' : 'hide asked', why);
  if (show) {
    settings.visible = true; hiding = false; saveSettings();
    // asked for by name: he shows even over a full-screen app (until that app is no longer in front)
    if (busyHidden) { try { showAnywayFor = W32.foreground().hwnd; } catch (e) { showAnywayFor = 0; } busyHidden = false; }
    showWin(); win.webContents.send('event', { type: 'hello' });
  } else if (!hiding) {
    settings.visible = false; saveSettings();
    hiding = true;
    win.webContents.send('event', { type: 'bye' });                  // he waves first; the page says when he is gone
    setTimeout(() => { if (hiding && win) { hideWin(); hiding = false; } }, 2200);
  }
  buildMenu();
}

// ---------------------------------------------------------------- tray
const sendEv = (ev) => { if (win && settings.visible) win.webContents.send('event', ev); };
// the looks of his window burn (app/burn-fx.js), for the tray
const BURN_LOOKS = [['fire', 'Real fire'], ['shatter', 'Glass shatter'], ['dust', 'Dust'], ['pixel', 'Pixel fire']];
function buildMenu() {
  const size = (s, label) => ({ label, type: 'radio', checked: settings.size === s, click: () => { log('size', s); settings.size = s; saveSettings(); push(); } });
  const loginOn = app.getLoginItemSettings({ args: app.isPackaged ? [] : [app.getAppPath()] }).openAtLogin;
  const menu = Menu.buildFromTemplate([
    { label: settings.visible ? 'Hide Khalfan' : 'Show Khalfan', accelerator: 'Ctrl+Alt+K', click: () => toggle() },
    { label: 'Call him over', enabled: settings.visible, click: () => win && win.webContents.send('event', { type: 'call' }) },
    { label: 'Flying Nimbus', enabled: settings.visible, click: () => sendEv({ type: 'nimbus' }) },
    { label: 'Angry power-up', enabled: settings.visible, click: () => sendEv({ type: 'powerup' }) },
    { type: 'separator' },
    size('small', 'Small'), size('medium', 'Medium'), size('large', 'Large'),
    { type: 'separator' },
    { label: 'Sound', type: 'checkbox', checked: settings.sound, click: (i) => { settings.sound = i.checked; saveSettings(); push(); } },
    { label: 'Mischief (chases and rides your mouse)', type: 'checkbox', checked: settings.mischief, click: (i) => { settings.mischief = i.checked; saveSettings(); push(); } },
    { label: 'Rage burns a window (minimizes it)', type: 'checkbox', checked: settings.rageBurns !== false, click: (i) => { settings.rageBurns = i.checked; saveSettings(); push(); } },
    { label: 'Burn look', enabled: settings.rageBurns !== false, submenu: BURN_LOOKS.map(([k, label]) => ({ label, type: 'radio', checked: (settings.rageBurnStyle || 'dust') === k, click: () => { log('burn look', k); settings.rageBurnStyle = k; saveSettings(); push(); } })) },
    { label: 'Start with Windows', type: 'checkbox', checked: loginOn, click: (i) => {
      app.setLoginItemSettings({ openAtLogin: i.checked, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
      buildMenu();
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => { log('quit from the tray'); app.isQuitting = true; app.quit(); } },
  ]);
  if (tray) tray.setContextMenu(menu);
  return menu;
}
function push() { if (win) win.webContents.send('settings', settings); buildMenu(); }

// ---------------------------------------------------------------- events from outside (renders)
// a render finishing (ffmpeg gone for a while after running a while) makes him cheer
let ffSince = 0, ffGoneSince = 0;
function watchRenders() {
  execFile('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
    if (err) return;
    const n = (out.match(/ffmpeg\.exe/gi) || []).length;
    const now = Date.now();
    if (n > 0) { if (!ffSince) ffSince = now; ffGoneSince = 0; return; }
    if (ffSince && !ffGoneSince) ffGoneSince = now;
    if (ffSince && ffGoneSince && now - ffGoneSince > 15000) {
      if (ffGoneSince - ffSince > 60000 && win) win.webContents.send('event', { type: 'render-done' });
      ffSince = 0; ffGoneSince = 0;
    }
  });
}

// ---------------------------------------------------------------- IPC
let pageDrag = false;                                               // the page holds him with the mouse right now
ipcMain.on('interactive', (e, on, box, dragging) => { hitBox = box || null; pageDrag = !!dragging; setInteractive(!!on); });
ipcMain.on('track', (e, hwnd) => { tracked = Number(hwnd) || 0; });
ipcMain.on('pace', (e, fast) => { paceFast = !!fast; });
ipcMain.on('menu', () => { const m = buildMenu(); if (win) m.popup({ window: win }); });

// ---------------------------------------------------------------- his ultra rage: a bolt into a window, which burns away
// In his ultra rage he shoots a lightning bolt into an open window (an Explorer window, say), and it burns,
// crumbles and goes away. As the power-up builds,
// his page asks for a picture of the window (rage-shot: taken here, in memory only, never saved); at the bolt's hit it
// asks for the window to go (rage-burn): minimized, never closed, so it waits in the taskbar with nothing lost, while
// his page burns its picture away exactly where it stood. Off with the tray's "Rage burns a window".
const RAGE = require('./rage-shot');
async function rageShot(hwnd) {
  const s = await RAGE.takeShot(hwnd, W32, area);
  return s ? Object.assign({ hwnd }, s) : null;
}
ipcMain.on('rage-shot', async (e, hwnd) => {
  if (!win || e.sender !== win.webContents || settings.rageBurns === false) return;
  const t0 = Date.now();
  let shot = null;
  try { shot = await rageShot(Number(hwnd)); } catch (err) { log('rage: no picture of the window:', err.message); }
  log('rage: picture of the window', shot ? `${shot.iw}x${shot.ih}${shot.top ? ' + its title bar' : ''} in ${Date.now() - t0} ms` : 'not taken');
  if (shot && win && !win.isDestroyed()) win.webContents.send('rage', Object.assign({ type: 'shot' }, shot));
});
ipcMain.on('rage-burn', (e, hwnd) => {
  if (!win || e.sender !== win.webContents || settings.rageBurns === false || !W32) return;
  let ok = false;
  try { ok = W32.minimizeQuiet(Number(hwnd)); } catch (err) { ok = false; }
  log('rage: burned a window away (minimized, not closed):', ok);
});
ipcMain.on('gone', () => { if (hiding && win) { hideWin(); hiding = false; } });
ipcMain.on('tray-icon', (e, url) => {
  try {
    const img = nativeImage.createFromDataURL(url);
    if (tray) tray.setImage(img.resize({ width: 16, height: 16, quality: 'best' }));
  } catch (err) { /* keep the old one */ }
});
ipcMain.handle('settings', () => settings);
ipcMain.handle('first-world', () => world());

// review mode: the page draws its scenario and hands back PNG sheets
ipcMain.on('review-sheet', (e, name, url) => {
  const dir = path.join(__dirname, 'review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote review/' + name + '.png');
});
ipcMain.on('review-frame', (e, name, i, url) => {                    // a film's frames: review/film/<name>/0000.jpg..
  const dir = path.join(__dirname, 'review', 'film', String(name).replace(/[^\w-]/g, ''));
  if (i === 0 && fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^\d+\.jpg$/.test(f)) fs.unlinkSync(path.join(dir, f));   // (last run's frames)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(i).padStart(4, '0') + '.jpg'), Buffer.from(url.split(',')[1], 'base64'));
});
ipcMain.on('review-file', (e, file, url) => {                       // a film's other files (its sound track): review/film/<file>
  const dir = path.join(__dirname, 'review', 'film');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(file).replace(/[^\w.-]/g, '')), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote review/film/' + file);
});
ipcMain.on('review-done', () => { app.quit(); });
ipcMain.on('log', (e, ...a) => log('[pet]', ...a));

// ---------------------------------------------------------------- start
app.whenReady().then(() => {
  loadSettings();
  if (REVIEW) {
    placeWindow();
    win = new BrowserWindow({
      width: 1707, height: 959, show: false, paintWhenInitiallyHidden: true, frame: false, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, offscreen: true, zoomFactor: 1 },
    });
    win.loadFile(path.join(__dirname, 'app', 'index.html'), { query: { review: REVIEW } });
    setTimeout(() => app.quit(), 600000);
    return;
  }
  log('start', { electron: process.versions.electron, display: screen.getPrimaryDisplay().bounds, scale: screen.getPrimaryDisplay().scaleFactor, settings });
  createWindow();
  // nothing may open inside his window (a file dropped on him, a link): he is not a browser
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'khalfan.ico')));
  tray.setToolTip('Khalfan');
  tray.on('click', () => toggle(undefined, 'tray click'));
  buildMenu();
  require('./updater')({ log, tray: () => tray, quitting: () => { app.isQuitting = true; } });
  if (!globalShortcut.register('Control+Alt+K', () => toggle(undefined, 'Ctrl+Alt+K'))) log('Ctrl+Alt+K is taken by another app');
  tickLoop();
  setInterval(worldTick, 250);
  setInterval(watchRenders, 10000);
  screen.on('display-metrics-changed', placeWindow);
  screen.on('display-added', placeWindow);
  screen.on('display-removed', placeWindow);
});
app.on('second-instance', () => toggle(true, 'started again (shortcut)'));
app.on('window-all-closed', () => { log('all windows closed: quitting'); app.quit(); });
app.on('will-quit', () => { if (!REVIEW) log('quit'); globalShortcut.unregisterAll(); });
