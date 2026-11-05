/* The picture of the window his ultra rage strikes (main process; in memory only, never saved).
 *
 * A window's own picture (Windows' window capture) is clean, with nothing of his in front of it, but for a window with
 * a standard title bar it comes without that bar. Then the bar's strip is cut from a picture of the screen and handed
 * over with it, and his page puts the two together. Returns { body, top, topH, x, y, w, h } (data URLs; DIP, relative
 * to his window) or null.
 */
'use strict';
const { desktopCapturer, screen } = require('electron');

async function takeShot(hwnd, W32, area) {
  const r = W32 && W32.windowRect(hwnd);
  if (!r) return null;
  const d = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
  const sc = (area && area.scale) || screen.getPrimaryDisplay().scaleFactor || 1;
  const ox = area ? area.x : 0, oy = area ? area.y : 0;
  const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(d.width * sc), height: Math.round(d.height * sc) }, fetchWindowIcons: false });
  const s = wins.find((x) => x.id.startsWith(`window:${hwnd}:`));
  if (!s || s.thumbnail.isEmpty()) return null;
  const sz = s.thumbnail.getSize();
  const shot = { body: 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(90).toString('base64'), top: null, topH: 0,
    x: d.x - ox, y: d.y - oy, w: d.width, h: d.height, iw: sz.width, ih: sz.height };
  // the picture, at the window's width, is shorter than the window: its title bar is missing (at the top)
  const bodyH = sz.height * (d.width / sz.width);
  const missing = d.height - bodyH;
  if (missing > 2) {
    const disp = screen.getDisplayMatching({ x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) });
    const ds = disp.scaleFactor || sc;
    const scr = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(disp.size.width * ds), height: Math.round(disp.size.height * ds) } });
    const src = scr.find((x) => String(x.display_id) === String(disp.id)) || scr[0];
    if (src && !src.thumbnail.isEmpty()) {
      const tz = src.thumbnail.getSize(), k = tz.width / disp.size.width;
      const crop = { x: Math.round((d.x - disp.bounds.x) * k), y: Math.round((d.y - disp.bounds.y) * k), width: Math.round(d.width * k), height: Math.round(missing * k) };
      crop.x = Math.max(0, Math.min(tz.width - 1, crop.x)); crop.y = Math.max(0, Math.min(tz.height - 1, crop.y));
      crop.width = Math.max(1, Math.min(tz.width - crop.x, crop.width)); crop.height = Math.max(1, Math.min(tz.height - crop.y, crop.height));
      shot.top = 'data:image/jpeg;base64,' + src.thumbnail.crop(crop).toJPEG(90).toString('base64');
      shot.topH = missing;
    }
  }
  return shot;
}

module.exports = { takeShot };
