/* Desktop Khalfan: the desktop's icons (the files on your desktop), read from Explorer's icon list.
 *
 * Read only. The list view lives in explorer.exe, so each icon's rectangle is fetched through a small block of
 * memory in that process (the usual LVM_GETITEMRECT dance). Nothing is ever moved, opened or renamed.
 * Rects come back in physical pixels; main.js turns them into DIP and decides which are in the open.
 */
'use strict';
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const RECT = koffi.struct('IRECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('IPOINT', { x: 'long', y: 'long' });

const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(const uint16_t *cls, const uint16_t *title)');
const FindWindowExW = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, const uint16_t *cls, const uint16_t *title)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const SendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint msg, uintptr_t wParam, intptr_t lParam, uint flags, uint timeout, _Out_ uintptr_t *result)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint *pid)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ IPOINT *pt)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ IRECT *r)');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint access, bool inherit, uint pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const VirtualAllocEx = kernel32.func('intptr_t __stdcall VirtualAllocEx(intptr_t h, intptr_t addr, size_t size, uint type, uint protect)');
const VirtualFreeEx = kernel32.func('bool __stdcall VirtualFreeEx(intptr_t h, intptr_t addr, size_t size, uint type)');
const WriteProcessMemory = kernel32.func('bool __stdcall WriteProcessMemory(intptr_t h, intptr_t addr, const void *buf, size_t size, _Out_ size_t *written)');
const ReadProcessMemory = kernel32.func('bool __stdcall ReadProcessMemory(intptr_t h, intptr_t addr, _Out_ void *buf, size_t size, _Out_ size_t *read)');

const LVM_GETITEMCOUNT = 0x1004, LVM_GETITEMRECT = 0x100E, LVM_GETITEMTEXTW = 0x1073, LVIR_ICON = 1, LVIR_LABEL = 2;
const LVIF_TEXT = 0x0001, LVITEM_SIZE = 88, TEXT_MAX = 120;              // LVITEMW on 64-bit Windows
const SMTO_ABORTIFHUNG = 0x0002;
const PROCESS_VM_OPERATION = 0x0008, PROCESS_VM_READ = 0x0010, PROCESS_VM_WRITE = 0x0020;
const MEM_COMMIT = 0x1000, MEM_RELEASE = 0x8000, PAGE_READWRITE = 0x04;

const wstr = (s) => { const a = new Uint16Array(s.length + 1); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
const W_PROGMAN = wstr('Progman'), W_DEFVIEW = wstr('SHELLDLL_DefView'), W_LIST = wstr('SysListView32'), W_WORKERW = wstr('WorkerW');

// the desktop's icon list: under Progman, or (with wallpaper tricks) under one of the WorkerW windows
function findListView() {
  const prog = FindWindowW(W_PROGMAN, null);
  if (prog) {
    const dv = FindWindowExW(prog, 0, W_DEFVIEW, null);
    if (dv) { const lv = FindWindowExW(dv, 0, W_LIST, null); if (lv) return lv; }
  }
  let w = 0;
  for (let i = 0; i < 64; i++) {
    w = FindWindowExW(0, w, W_WORKERW, null);
    if (!w) break;
    const dv = FindWindowExW(w, 0, W_DEFVIEW, null);
    if (dv) { const lv = FindWindowExW(dv, 0, W_LIST, null); if (lv) return lv; }
  }
  return 0;
}

function send(hwnd, msg, wParam, lParam) {
  const out = [0];
  if (!SendMessageTimeoutW(hwnd, msg, wParam, lParam, SMTO_ABORTIFHUNG, 200, out)) return null;
  return out[0];
}

/* Every icon on the desktop: [{i, icon: {left, top, right, bottom}, label: {...}}] in physical screen pixels,
 * or null when the desktop's icons are hidden or Explorer could not be read. */
function listIcons() {
  const lv = findListView();
  if (!lv || !IsWindowVisible(lv)) return null;
  const n = send(lv, LVM_GETITEMCOUNT, 0, 0);
  if (n == null || n <= 0 || n > 400) return n === 0 ? [] : null;
  const pid = [0];
  GetWindowThreadProcessId(lv, pid);
  const ph = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, pid[0]);
  if (!ph) return null;
  const out = [];
  let mem = 0;
  const SIZE = LVITEM_SIZE + TEXT_MAX * 2;
  try {
    mem = VirtualAllocEx(ph, 0, SIZE, MEM_COMMIT, PAGE_READWRITE);
    if (!mem) return null;
    const origin = { x: 0, y: 0 };
    ClientToScreen(lv, origin);
    const buf = Buffer.alloc(SIZE);
    const got = [0];
    const rectOf = (i, which) => {
      buf.fill(0, 0, 16); buf.writeInt32LE(which, 0);                 // RECT.left carries LVIR_*
      if (!WriteProcessMemory(ph, mem, buf, 16, got)) return null;
      if (!send(lv, LVM_GETITEMRECT, i, mem)) return null;
      if (!ReadProcessMemory(ph, mem, buf, 16, got)) return null;
      return { left: buf.readInt32LE(0) + origin.x, top: buf.readInt32LE(4) + origin.y, right: buf.readInt32LE(8) + origin.x, bottom: buf.readInt32LE(12) + origin.y };
    };
    const textOf = (i) => {                                           // the file's name (for the log and his favourites)
      buf.fill(0);
      buf.writeUInt32LE(LVIF_TEXT, 0); buf.writeInt32LE(i, 4);
      buf.writeBigUInt64LE(BigInt(mem) + BigInt(LVITEM_SIZE), 24); buf.writeInt32LE(TEXT_MAX, 32);
      if (!WriteProcessMemory(ph, mem, buf, SIZE, got)) return '';
      const len = send(lv, LVM_GETITEMTEXTW, i, mem);
      if (!len || !ReadProcessMemory(ph, mem, buf, SIZE, got)) return '';
      return buf.toString('utf16le', LVITEM_SIZE, LVITEM_SIZE + Math.min(len, TEXT_MAX) * 2);
    };
    for (let i = 0; i < n; i++) {
      const icon = rectOf(i, LVIR_ICON);
      if (!icon || icon.right <= icon.left) continue;
      const label = rectOf(i, LVIR_LABEL);
      out.push({ i, icon, label, name: textOf(i) });
    }
  } finally {
    if (mem) VirtualFreeEx(ph, mem, 0, MEM_RELEASE);
    CloseHandle(ph);
  }
  return out;
}

/* The names of the selected icons on the desktop (what is being dragged from it), or []. Read only, like listIcons. */
const LVM_GETITEMSTATE = 0x102C, LVIS_SELECTED = 0x0002;
function selectedNames() {
  const lv = findListView();
  if (!lv || !IsWindowVisible(lv)) return [];
  const n = send(lv, LVM_GETITEMCOUNT, 0, 0);
  if (!n || n <= 0 || n > 400) return [];
  const sel = [];
  for (let i = 0; i < n; i++) { const st = send(lv, LVM_GETITEMSTATE, i, LVIS_SELECTED); if (st != null && (st & LVIS_SELECTED)) sel.push(i); }
  if (!sel.length) return [];
  const pid = [0];
  GetWindowThreadProcessId(lv, pid);
  const ph = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, pid[0]);
  if (!ph) return [];
  const SIZE = LVITEM_SIZE + TEXT_MAX * 2, out = [];
  let mem = 0;
  try {
    mem = VirtualAllocEx(ph, 0, SIZE, MEM_COMMIT, PAGE_READWRITE);
    if (!mem) return [];
    const buf = Buffer.alloc(SIZE), got = [0];
    for (const i of sel.slice(0, 50)) {
      buf.fill(0);
      buf.writeUInt32LE(LVIF_TEXT, 0); buf.writeInt32LE(i, 4);
      buf.writeBigUInt64LE(BigInt(mem) + BigInt(LVITEM_SIZE), 24); buf.writeInt32LE(TEXT_MAX, 32);
      if (!WriteProcessMemory(ph, mem, buf, SIZE, got)) continue;
      const len = send(lv, LVM_GETITEMTEXTW, i, mem);
      if (!len || !ReadProcessMemory(ph, mem, buf, SIZE, got)) continue;
      out.push(buf.toString('utf16le', LVITEM_SIZE, LVITEM_SIZE + Math.min(len, TEXT_MAX) * 2));
    }
  } finally {
    if (mem) VirtualFreeEx(ph, mem, 0, MEM_RELEASE);
    CloseHandle(ph);
  }
  return out;
}

module.exports = { listIcons, selectedNames };

if (require.main === module) {
  const t0 = Date.now();
  const icons = listIcons();
  console.log('icons:', icons ? icons.length : icons, 'in', Date.now() - t0, 'ms');
  for (const ic of (icons || []).slice(0, 12)) console.log(ic.i, JSON.stringify(ic.name), 'icon', JSON.stringify(ic.icon), 'label', JSON.stringify(ic.label));
  const t1 = Date.now();
  for (let k = 0; k < 10; k++) listIcons();
  console.log('10 reads in', Date.now() - t1, 'ms');
}
