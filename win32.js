/* Desktop Khalfan: the little bit of Windows he needs to see, through koffi.
 *
 * Read only. He looks at the windows, the taskbar, the cursor and how long since the last input; he never clicks,
 * types, moves the mouse, or moves, closes or deletes anything.
 *
 * Rects come back in physical pixels (Electron is per-monitor DPI aware); main.js turns them into DIP.
 */
'use strict';
const koffi = require('koffi');
const path = require('path');

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

const RECT = koffi.struct('KRECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const LASTINPUTINFO = koffi.struct('KLASTINPUTINFO', { cbSize: 'uint', dwTime: 'uint' });

// HWNDs are passed as pointer-sized integers, so they compare as plain numbers in JS
const EnumProc = koffi.proto('bool __stdcall KEnumProc(intptr_t hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(KEnumProc *cb, intptr_t lParam)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ KRECT *rect)');
const GetWindowLongW = user32.func('long __stdcall GetWindowLongW(intptr_t hwnd, int index)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint *pid)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint flags)');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vk)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ KLASTINPUTINFO *lii)');
const DwmRect = dwmapi.func('DwmGetWindowAttribute', 'long', ['intptr_t', 'uint', koffi.out(koffi.pointer(RECT)), 'uint']);
const DwmInt = dwmapi.func('DwmGetWindowAttribute', 'long', ['intptr_t', 'uint', koffi.out(koffi.pointer('int')), 'uint']);
const GetTickCount = kernel32.func('uint __stdcall GetTickCount()');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint access, bool inherit, uint pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint flags, _Out_ uint16_t *buf, _Inout_ uint *size)');
const SHQueryUserNotificationState = shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *state)');

const GWL_STYLE = -16, GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000, WS_CAPTION = 0x00C00000;
const WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TRANSPARENT = 0x20;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
const SM_SWAPBUTTON = 23;

// shell and system windows that are never ledges (the taskbar is read from the work area instead)
const SKIP_CLASS = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland',
  'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow', 'Shell_InputSwitchTopLevelWindow', 'tooltips_class32',
  'MultitaskingViewFrame', 'ForegroundStaging', 'ApplicationManager_ImmersiveShellWindow', 'EdgeUiInputTopWndClass',
  'Internet Explorer_Hidden', 'SysShadow', 'IME', 'MSCTFIME UI', 'Xaml_WindowedPopupClass',
]);

const buf16 = new Uint16Array(512);
function str16(n) { return String.fromCharCode.apply(null, buf16.subarray(0, Math.max(0, n))); }
function className(h) { return str16(GetClassNameW(h, buf16, 256)); }
function title(h) { return str16(GetWindowTextW(h, buf16, 256)); }

const procCache = new Map();
function procName(h) {
  const pid = [0];
  GetWindowThreadProcessId(h, pid);
  const id = pid[0];
  if (procCache.has(id)) return procCache.get(id);
  let name = '';
  const ph = OpenProcess(0x1000, false, id);                       // PROCESS_QUERY_LIMITED_INFORMATION
  if (ph) {
    const size = [512];
    if (QueryFullProcessImageNameW(ph, 0, buf16, size)) name = path.basename(str16(size[0])).toLowerCase();
    CloseHandle(ph);
  }
  if (procCache.size > 400) procCache.clear();
  procCache.set(id, name);
  return name;
}

function frameRect(h) {
  const r = {};
  if (DwmRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 && r.right > r.left) return r;
  const r2 = {};
  return GetWindowRect(h, r2) ? r2 : null;
}
function cloaked(h) {
  const v = [0];
  return DwmInt(h, DWMWA_CLOAKED, v, 4) === 0 && v[0] !== 0;
}

/* Every top-level window a person would call a window, from the top of the z-order down.
 * skipHwnds: his own windows. Returns [{hwnd, rect(px), cls, title, proc, max, ledge}] where ledge says whether its
 * top edge could hold him (the others still hide what is below them). */
let out = [], skipNow = new Set();
// one callback, registered once (it runs four times a second)
const enumCb = koffi.register((h) => { visit(h); return true; }, koffi.pointer(EnumProc));
function listWindows(skipHwnds) {
  out = []; skipNow = skipHwnds;
  EnumWindows(enumCb, 0);
  return out;
}
function visit(h) {
  try {
    if (skipNow.has(h) || !IsWindowVisible(h) || IsIconic(h) || cloaked(h)) return;
    const style = GetWindowLongW(h, GWL_STYLE) >>> 0, ex = GetWindowLongW(h, GWL_EXSTYLE) >>> 0;
    if (style & WS_CHILD) return;
    const r = frameRect(h);
    if (!r || r.right - r.left < 40 || r.bottom - r.top < 40) return;
    const cls = className(h);
    if (SKIP_CLASS.has(cls)) return;
    const tool = (ex & WS_EX_TOOLWINDOW) && !(ex & WS_EX_APPWINDOW);
    const ghost = (ex & WS_EX_TRANSPARENT) || ((ex & WS_EX_NOACTIVATE) && !(ex & WS_EX_APPWINDOW));
    if (ghost) return;                                             // click-through overlays (and other pets) hide nothing
    const t = title(h);
    const max = IsZoomed(h);
    const ledge = !tool && !max && t.length > 0;
    out.push({ hwnd: h, rect: r, cls, title: t, proc: procName(h), max, ledge, caption: !!(style & WS_CAPTION) });
  } catch (e) { /* a window that went away mid-walk */ }
}

function windowRect(h) {
  if (!h || !IsWindow(h) || !IsWindowVisible(h) || IsIconic(h) || cloaked(h)) return null;
  return frameRect(h);
}

function foreground() {
  let h = GetForegroundWindow();
  if (!h) return null;
  const root = GetAncestor(h, 2);                                  // GA_ROOT
  if (root) h = root;
  const style = GetWindowLongW(h, GWL_STYLE) >>> 0;
  return { hwnd: h, cls: className(h), title: title(h), proc: procName(h), rect: frameRect(h), caption: !!(style & WS_CAPTION), iconic: IsIconic(h) };
}

// the physical left button, whichever way round the buttons are set (looked up every few seconds)
let swapped = false, swapT = 0;
function swap() {
  const now = Date.now();
  if (now - swapT > 5000) { swapT = now; swapped = !!GetSystemMetrics(SM_SWAPBUTTON); }
  return swapped;
}
function leftDown() { return (GetAsyncKeyState(swap() ? 0x02 : 0x01) & 0x8000) !== 0; }
function rightDown() { return (GetAsyncKeyState(swap() ? 0x01 : 0x02) & 0x8000) !== 0; }

// milliseconds since the last keyboard or mouse input anywhere
function idleMs() {
  const lii = { cbSize: 8, dwTime: 0 };
  if (!GetLastInputInfo(lii)) return 0;
  return ((GetTickCount() - lii.dwTime) >>> 0);
}

// Only the sure signs from Windows: a Direct3D exclusive full-screen game (3) or presentation mode (4). Its broad
// "busy" (2) is NOT used: an invisible overlay over the screen (NVIDIA's, on some PCs) sets it all the time, and
// it hid Khalfan for good. main.js checks the window in front itself (see fullScreenApp there).
function busy() {
  const s = [0];
  if (SHQueryUserNotificationState(s) !== 0) return false;
  return s[0] === 3 || s[0] === 4;
}

// his own window, sized exactly (physical pixels): Electron squeezes a window into the work area, which would cut him off
// at the top of the taskbar. Only ever called on his own window; it keeps its place in the z-order and never activates.
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint flags)');
function placeOwn(hwnd, x, y, w, h) {
  const r = {};
  if (GetWindowRect(hwnd, r) && r.left === x && r.top === y && r.right - r.left === w && r.bottom - r.top === h) return false;
  // SWP_NOSENDCHANGING: Chromium's own position check would squeeze it straight back above the taskbar
  SetWindowPos(hwnd, 0, x, y, w, h, 0x0004 | 0x0010 | 0x0400);     // SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING
  return true;
}

/* His ultra rage "burns a window away": the window is minimized, never closed, so it waits in the
 * taskbar with nothing in it lost. Its shrink-to-the-taskbar animation is turned off for the moment (his page is
 * burning its picture where it stood) and back on a second later, for when you restore it. */
const ShowWindowAsync = user32.func('bool __stdcall ShowWindowAsync(intptr_t hwnd, int cmd)');
const DwmSetInt = dwmapi.func('DwmSetWindowAttribute', 'long', ['intptr_t', 'uint', koffi.pointer('int'), 'uint']);
const DWMWA_TRANSITIONS_FORCEDISABLED = 3, SW_MINIMIZE = 6;
function minimizeQuiet(h) {
  if (!h || !IsWindow(h) || IsIconic(h)) return false;
  let off = -1;
  try { off = DwmSetInt(h, DWMWA_TRANSITIONS_FORCEDISABLED, new Int32Array([1]), 4); } catch (e) { off = -1; }
  const ok = ShowWindowAsync(h, SW_MINIMIZE);
  if (off === 0) setTimeout(() => { try { DwmSetInt(h, DWMWA_TRANSITIONS_FORCEDISABLED, new Int32Array([0]), 4); } catch (e) { /* gone */ } }, 1000);
  return !!ok;
}

module.exports = { listWindows, windowRect, foreground, leftDown, rightDown, idleMs, busy, placeOwn, minimizeQuiet };

if (require.main === module) {
  const t0 = Date.now();
  const ws = listWindows(new Set());
  console.log('listWindows', ws.length, 'windows in', Date.now() - t0, 'ms');
  for (const w of ws.slice(0, 25)) console.log(String(w.hwnd).padStart(9), w.ledge ? 'LEDGE' : '     ', w.max ? 'MAX' : '   ', JSON.stringify(w.rect), w.proc, '|', w.cls, '|', w.title.slice(0, 50));
  console.log('foreground', foreground());
  console.log('idle ms', idleMs(), 'left down', leftDown(), 'busy', busy());
  const t1 = Date.now();
  for (let i = 0; i < 100; i++) windowRect(ws[0].hwnd);
  console.log('100 windowRect in', Date.now() - t1, 'ms');
  const t2 = Date.now();
  for (let i = 0; i < 10; i++) listWindows(new Set());
  console.log('10 listWindows in', Date.now() - t2, 'ms');
}
