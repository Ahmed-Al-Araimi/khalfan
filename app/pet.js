/* Desktop Khalfan: the pet.
 *
 * The same Khalfan as the videos: drawn live by the pixel rig (../playroom/js/rig.js) from a pose of numbers each
 * frame, with his data from ../playroom/data/khalfan-data.js. The handling (pick up, swing, throw, bounce, moods,
 * temper) comes from his original game, moved from the room onto the desktop.
 *
 * The world is in rig cells (1 cell = CELLPX device pixels, 2 DIP at medium). He stands on platforms:
 *   the taskbar's top edge (the floor), and the visible top edge of every window (main.js finds them)
 * Modes:
 *   free   standing, walking, running, sitting (legs dangling), asleep, peeking out of the taskbar
 *   clip   one of the library moves
 *   held   picked up with the mouse, or riding the cursor by his kumma (mischief)
 *   air    thrown, falling, or jumping on purpose; he can catch a ledge on the way
 *   hang   hanging from a window's top edge by his hands; then he climbs up or drops
 * His mischief is visual only: he never clicks, types, moves the mouse, or moves or closes anything.
 */
(function () {
  'use strict';
  const R = window.KRig, KM = R.M;
  const desk = window.desk || null;
  const REVIEW = new URLSearchParams(location.search).get('review');

  // ---------------------------------------------------------------- maths (k2anim's helpers)
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ss = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
  const easeIO = (t) => { t = clamp(t); return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; };
  const win = (t, a, b) => (b > a ? clamp((t - a) / (b - a)) : +(t >= a));
  const bump = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a)));
  const wrapd = (a) => R.pyMod(a + 180, 360) - 180;
  const sind = (d) => Math.sin(d * Math.PI / 180), cosd = (d) => Math.cos(d * Math.PI / 180);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const approach = (v, to, step) => (v < to ? Math.min(to, v + step) : Math.max(to, v - step));

  // ---------------------------------------------------------------- data
  async function gunzipB64(b64) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  let D = null, BASE = null, NUMKEYS = null;
  const CLIPS = {};
  let EXSPR = [];
  function decodeClip(c) {
    const n = c.n;
    const num = {};
    for (const [k, v] of Object.entries(c.num_fields)) {
      if (Array.isArray(v)) {
        const a = new Float32Array(n);
        let acc = 0;
        for (let i = 0; i < n; i++) { acc += v[i]; a[i] = acc / 100; }
        num[k] = a;
      } else num[k] = v;
    }
    const sw = {};
    for (const [k, runs] of Object.entries(c.switches)) {
      const a = new Array(n);
      let r = 0;
      for (let i = 0; i < n; i++) { while (r + 1 < runs.length && runs[r + 1][0] <= i) r++; a[i] = runs[r][1]; }
      sw[k] = a;
    }
    c.nums = num; c.sw = sw;
    delete c.num_fields; delete c.switches;
    return c;
  }
  function clipPose(c, t) {
    const f = t * D.fps;
    let i0 = Math.floor(f);
    const w = f - i0;
    if (c.loop) i0 = R.pyMod(i0, c.n); else i0 = clamp(i0, 0, c.n - 1);
    const i1 = c.loop ? (i0 + 1) % c.n : Math.min(i0 + 1, c.n - 1);
    const p = {};
    for (const k of NUMKEYS) {
      const v = c.nums[k];
      p[k] = (typeof v === 'number') ? v : lerp(v[i0], v[i1], w);
    }
    for (const k in c.sw) p[k] = c.sw[k][i0];
    p.kfree = null;
    if (c.kfree) {
      const a = c.kfree[i0], b = c.kfree[i1];
      if (a && b) p.kfree = a.map((v, j) => (j === 3 && Math.abs(b[j] - v) > 180 ? v : lerp(v, b[j], w)));
      else p.kfree = a ? a.slice() : null;
    }
    p.props = c.props ? (c.props[i0] || []) : [];
    return p;
  }

  // ---------------------------------------------------------------- palettes (his classic outfit)
  const LUTS = new Map();
  function lutFor(over) {
    const key = JSON.stringify(over);
    let L = LUTS.get(key);
    if (L) return L;
    const lut = new Uint8ClampedArray(256 * 4);
    R.KEYS.forEach((k, i) => {
      if (!i) return;
      const c = over[k] || R.T.PAL[k];
      lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2]; lut[i * 4 + 3] = 255;
    });
    L = { key, lut };
    LUTS.set(key, L);
    return L;
  }
  const baseLut = () => lutFor({});
  function lutForKind(kind, clip) {
    if (kind === 'arm' && clip && clip.sleeves) return lutFor({ D: R.T.PAL[clip.sleeves[0]], d: R.T.PAL[clip.sleeves[1]] });
    return baseLut();
  }
  function sprCanvas(spr, L) {
    const m = spr._cv || (spr._cv = {});
    let cvs = m[L.key];
    if (cvs) return cvs;
    cvs = document.createElement('canvas');
    cvs.width = spr.w; cvs.height = spr.h;
    const g2 = cvs.getContext('2d');
    const img = g2.createImageData(spr.w, spr.h);
    const a = spr.a, d = img.data, lut = L.lut;
    for (let k = 0; k < a.length; k++) {
      const v = a[k];
      if (v) { const j = k * 4, s = v * 4; d[j] = lut[s]; d[j + 1] = lut[s + 1]; d[j + 2] = lut[s + 2]; d[j + 3] = 255; }
    }
    g2.putImageData(img, 0, 0);
    m[L.key] = cvs;
    return cvs;
  }

  // ---------------------------------------------------------------- settings, the screen, the world
  const S = { size: 'medium', sound: true, mischief: true };
  const SIZE_DIP = { small: 1.4, medium: 2.0, large: 2.7 };            // DIP per rig cell (he is ~52 cells tall)
  let DPR = window.devicePixelRatio || 1, CELLPX = 3;
  const cv = document.getElementById('stage');
  const g = cv.getContext('2d');
  function cellPx() { return Math.max(1, Math.round(SIZE_DIP[S.size] * DPR)); }  // whole device pixels per cell: crisp
  const kDip = () => DPR / CELLPX;                                     // DIP -> cells

  // platforms: the floor (the taskbar's top edge, or the screen's bottom) and the visible top edges of windows
  const WD = { W: 853, H: 479, floor: null, plats: [], rects: [], taskbar: null, fg: null, idle: 0, hour: 12, raw: null };
  WD.floor = { id: 'floor', kind: 'floor', hwnd: 0, x0: 0, x1: WD.W, y: WD.H - 1 };
  WD.plats = [WD.floor];

  const KH = {
    x: 200, yaw: 0, yawTarget: 0, faceUsAt: 0, dist: 0, speed: 0, lastDir: 1,
    plat: null, missing: 0,
    mode: 'free', clip: null, clipT: 0, clipPrev: 0, anchor: 0, clipMirror: false, clipUntil: 0,
    jump: null, leap: null, landT: -9, landHard: 0.5, walkTo: null, held: null, air: null, hang: null, dizzyUntil: 0,
    pose: null, blend: null,
    spring: { st: [0, 0, 0, 0, 0, 0], hist: [] },
    pokes: [], react: null, blinkAt: 2, blinkT: null, idleSince: 0, lastStepPh: 0, turnPh: 0,
    limb: null, fun: 0, fear: 0, after: null, ghosts: [], hitUntil: 0, shake: null,
    anger: 0, angerStage: 0, rage: null, rageOnLand: false, bubble: null, fury: 0,
    sit: null, sitW: 0, sink: 0, peek: null, gone: false, sayOnLand: null, wobbleT: -9,
    wvx: 0, wvy: 0,
  };
  let NBX = null;                                                        // the Flying Nimbus (../playroom/js/nimbus.js), made at boot
  const groundY = () => (KH.plat || WD.floor).y;
  const EDGE = 7;                                                       // he keeps this far from a ledge's end
  // the walkable range of a ledge: a desktop icon is small, he stands right on it
  const qlo = (Q) => Q.x0 + (Q.kind === 'icon' ? 4 : EDGE);
  const qhi = (Q) => Q.x1 - (Q.kind === 'icon' ? 4 : EDGE);
  const standable = (Q) => Q.kind !== 'bar';

  function applyWorld(raw) {
    WD.raw = raw;
    const k = kDip();
    WD.W = raw.W * k; WD.H = raw.H * k;
    WD.floor = { id: 'floor', kind: raw.taskbar ? 'taskbar' : 'floor', hwnd: 0, x0: 0, x1: WD.W, y: raw.floorY * k };
    WD.taskbar = raw.taskbar ? { x: raw.taskbar.x * k, y: raw.taskbar.y * k, w: raw.taskbar.w * k, h: raw.taskbar.h * k } : null;
    WD.bar = { id: 'bar', kind: 'bar', hwnd: 0, x0: 0, x1: WD.W, y: 0 };   // the top of the screen: a bar to hang from
    WD.plats = [WD.floor].concat(raw.ledges.map((l) => ({
      id: l.hwnd + ':' + Math.round(l.x0), hwnd: l.hwnd, kind: l.kind, x0: l.x0 * k, x1: l.x1 * k, y: l.y * k, full: l.full, title: l.title,
    })));
    WD.rects = raw.rects.map((r) => ({ hwnd: r.hwnd, x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k, fav: r.fav, max: r.max, ledge: r.ledge !== false, z: r.z, cls: r.cls || '', normal: !!r.normal }));
    // the desktop's icons (the files): the picture is a square the icon cell's height, centred in the cell. Each one in
    // the open is a little ledge; those too near the top of the screen are only for hands (he would stand off the top)
    WD.icons = [];
    for (const ic of raw.icons || []) {
      if (!ic.open) continue;
      const side = ic.h * k, cx = (ic.x + ic.w / 2) * k;
      WD.icons.push({ id: 'icon:' + ic.name, kind: 'icon', hwnd: 0, name: ic.name, cx, x0: cx - side / 2, x1: cx + side / 2, y: ic.y * k, h: side, rung: 0, col: null,
        ax: ic.x * k, aw: ic.w * k, yb: (ic.yb || ic.y + ic.h * 2.2) * k });   // (the whole cell, the name included: never his to click)
    }
    // columns: icons stacked over each other (the usual desktop grid), bottom first; the rungs of a ladder
    WD.cols = [];
    for (const ic of WD.icons.slice().sort((a, b) => b.y - a.y)) {
      let col = WD.cols.find((c) => Math.abs(c.cx - ic.cx) < 4 && ic.y < c.icons[c.icons.length - 1].y - 20 && ic.y > c.icons[c.icons.length - 1].y - 90);
      if (!col) { col = { cx: ic.cx, icons: [] }; WD.cols.push(col); }
      ic.col = col; ic.rung = col.icons.length; col.icons.push(ic);
    }
    for (const ic of WD.icons) if (ic.y >= 58 && ic.x1 - ic.x0 >= 10) WD.plats.push(ic);
    // walls: the visible sides of the windows he could stand on top of (climbed hand over hand, see wallPose)
    WD.walls = [];
    for (const r of WD.rects) {
      if (r.max || !WD.plats.some((Q) => Q.hwnd === r.hwnd)) continue;
      for (const side of [-1, 1]) {
        const x = side < 0 ? r.x : r.x + r.w;
        if (x < 14 || x > WD.W - 14) continue;
        WD.walls.push({ hwnd: r.hwnd, x, side, y0: r.y, y1: Math.min(r.y + r.h, WD.floor.y), z: r.z, rect: r });
      }
    }
    // rooms: dropped inside a window, he stands on its bottom edge (its sill). Kept apart from WD.plats: only the window
    // he is in counts, so nothing ever lands on, leaps to or catches a window's bottom edge from outside it
    WD.rooms = new Map();
    for (const r of WD.rects) {
      if (!r.ledge || r.max || r.w < 90) continue;
      const Q = roomFloor(r.hwnd, r.x, r.y, r.w, r.h);
      if (Q) WD.rooms.set(r.hwnd, Q);
    }
    WD.idle = raw.idle; WD.hour = raw.hour;
    const prevFg = WD.fg;
    WD.fg = raw.fg;
    if (prevFg && raw.fg && prevFg.hwnd !== raw.fg.hwnd) BR.fgChanged = T;
    // a window you touch while he is charged, instead of giving him his coffee, is the one he burns next
    if (KH.rage && !KH.rage.out && raw.fg && (!prevFg || prevFg.hwnd !== raw.fg.hwnd)) KH.rage.touched = raw.fg.hwnd;
    rebind();
  }
  // a window's inside as a room (cells): its bottom edge to stand and sit on, its sides and title bar to bounce off
  function roomFloor(hwnd, x, y, w, h) {
    const fy = Math.min(y + h - 1, WD.floor.y - 1), top = Math.max(y, 0) + 16;
    const x0 = Math.max(0, x) + 2, x1 = Math.min(WD.W, x + w) - 2;
    if (fy - top < 64 || x1 - x0 < 60) return null;                     // too small to stand up in
    return { id: 'room:' + hwnd, kind: 'room', hwnd, x0, x1, y: fy, top };
  }
  // the room his feet are in at (x, y): the frontmost window there, if it is one he can be dropped into
  function roomAt(x, y) {
    for (const r of WD.rects) {                                          // (front to back)
      if (x < r.x || x > r.x + r.w || y - 20 < r.y || y - 20 > r.y + r.h) continue;
      const Q = WD.rooms.get(r.hwnd);
      return Q && x > Q.x0 + 4 && x < Q.x1 - 4 && y > Q.top + 4 && y < Q.y + 2 ? Q : null;
    }
    return null;
  }
  const inRoom = () => !!(KH.plat && KH.plat.kind === 'room');
  // is the point (x, y) in the open, with no window in front of window z over it?
  function openAt(x, y, z) {
    for (const r of WD.rects) if (r.z < z && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return false;
    return true;
  }
  // can he climb this wall from ledge Q? the foot of the wall must be on Q, and the edge open all the way up
  function wallFrom(w, Q) {
    if (!Q || Q.y <= w.y0 + 60 || Q.y > w.y1 + 40) return false;          // (a window floating a little above his ledge is fine)
    const bx = w.x + w.side * 11;                                       // where he stands, just outside the window
    if (bx < qlo(Q) || bx > qhi(Q)) return false;
    for (let y = w.y0 + 2; y < Q.y - 2; y += 18) if (!openAt(w.x - w.side * 5, y, w.z) || !openAt(w.x + w.side * 5, y, w.z)) return false;
    const top = WD.plats.find((P2) => P2.hwnd === w.hwnd && (w.side < 0 ? Math.abs(P2.x0 - w.x) < 3 : Math.abs(P2.x1 - w.x) < 3));
    return top ? { w, bx, top } : false;
  }
  // after a refresh: the same window (or icon) under his feet or hands, else he falls
  function rebind() {
    const P = KH.plat;
    if (!P || P === WD.floor || P.id === 'floor') { KH.plat = WD.floor; KH.missing = 0; trackPlat(); return; }
    const x = KH.mode === 'hang' && KH.hang ? KH.hang.hx : KH.x;
    let best = null, bd = 1e9;
    if (P.kind === 'room') {                                            // the same window's inside (its top ledge shares the hwnd)
      best = WD.rooms.get(P.hwnd) || null;
      bd = best ? 0 : 1e9;
    } else if (P.kind === 'icon' || P.kind === 'bar') {
      best = P.kind === 'bar' ? WD.bar : WD.plats.find((Q) => Q.id === P.id) || null;
      bd = best ? 0 : 1e9;
    } else {
      for (const Q of WD.plats) {
        if (Q.hwnd !== P.hwnd) continue;
        const d = x < Q.x0 ? Q.x0 - x : x > Q.x1 ? x - Q.x1 : 0;
        if (d < bd) { bd = d; best = Q; }
      }
    }
    if (best && bd < 4) {
      KH.plat = best; KH.missing = 0;
      if (KH.hang) KH.hang.P = best;
      if (KH.climb) KH.climb.col = best.col || KH.climb.col;
      if (KH.hide) KH.hide.icon = WD.icons.find((ic) => ic.id === KH.hide.icon.id) || KH.hide.icon;
      return;
    }
    // gone, minimised, maximised or covered: give it half a second (windows animate), then fall
    KH.missing++;
    if (KH.missing >= 2) loseFooting('gone');
  }
  function trackPlat() { if (desk) desk.track(KH.plat && KH.plat.hwnd ? KH.plat.hwnd : 0); }

  // the fast path: the window under him moved (60 Hz), so he rides it
  let lastTr = null;
  function onTrackedRect(tr, dt) {
    const P = KH.plat;
    if (!tr || !P || !P.hwnd || tr.hwnd !== P.hwnd) { lastTr = null; return; }
    if (tr.gone) { lastTr = null; loseFooting('gone'); return; }
    const k = kDip();
    if (lastTr && lastTr.hwnd === tr.hwnd) {
      const dx = (tr.x - lastTr.x) * k, dy = (tr.y - lastTr.y) * k;
      if (P.kind === 'room') {                                           // in a room: its floor and walls from the rect itself,
        const N = roomFloor(P.hwnd, tr.x * k, tr.y * k, tr.w * k, tr.h * k);   // so a window resized from any side carries him too
        if (!N) { lastTr = null; loseFooting('gone'); return; }
        P.x0 = N.x0; P.x1 = N.x1; P.y = N.y; P.top = N.top;
        if (dx) { KH.x += dx; KH.anchor += dx; if (KH.hang) KH.hang.hx += dx; if (KH.rage) KH.rageShiftX = (KH.rageShiftX || 0) + dx; }
        if (KH.mode === 'free') KH.x = clamp(KH.x, qlo(P), qhi(P));        // a side pulled in pushes him along
      } else if (dx || dy) {
        P.x0 += dx; P.x1 += dx; P.y += dy;
        KH.x += dx; KH.anchor += dx;
        if (KH.hang) KH.hang.hx += dx;
        if (KH.wallc) { KH.wallc.wf.w.x += dx; KH.wallc.wf.w.y0 += dy; KH.wallc.y += dy; }
        if (KH.rage) KH.rageShiftX = (KH.rageShiftX || 0) + dx;
      }
      const ivx = dt > 0 ? dx / dt : 0, ivy = dt > 0 ? dy / dt : 0;
      KH.wvx = lerp(KH.wvx, ivx, 0.35); KH.wvy = lerp(KH.wvy, ivy, 0.35);
      // a dead stop = the window still for three ticks in a row right after moving fast (one missed tick is not a stop)
      if (Math.hypot(ivx, ivy) < 40) KH.stillTicks = (KH.stillTicks || 0) + 1;
      else { KH.stillTicks = 0; KH.moveV = [KH.wvx, KH.wvy]; }
      const mv = KH.moveV || [0, 0];
      const stopped = KH.stillTicks === 3 ? Math.hypot(mv[0], mv[1]) : 0;
      windowShake(Math.hypot(KH.wvx, KH.wvy), stopped, mv[0], mv[1]);
    }
    lastTr = tr;
  }

  // ---------------------------------------------------------------- poses (k2anim ports)
  function P(kw) { return Object.assign({}, BASE, { expr: 'rest', mouth: null, eyes: null, brow: null, hl: 'rest', hr: 'rest', kfree: null, props: [] }, kw); }
  const armZ = (yaw) => { const s = sind(yaw); return s > 0.45 ? [1, 0] : s < -0.45 ? [0, 1] : [0, 0]; };
  function stand(yaw = 0, x = 0, y = 0) {
    const c = cosd(yaw), s = sind(yaw);
    const p = P({ x, y, yaw });
    p.flx = -4 * c; p.frx = 4 * c; p.fly = p.fry = 0;
    if (Math.abs(s) > 0.3) { p.flx += 1.2 * s; p.frx -= 1.2 * s; }
    p.hlx = -8.4 * c + 0.8 * s; p.hrx = 8.4 * c + 0.8 * s;
    p.hly = p.hry = -4.1;
    [p.zl, p.zr] = armZ(yaw);
    return p;
  }
  function breathe(p, t, amt = 1, rate = 2.4) {
    const w = 2 * Math.PI / rate;
    p.bdy += 0.35 * amt * Math.sin(w * t);
    p.hdy += 0.25 * amt * Math.sin(w * (t - 0.18));
    p.hly += 0.3 * amt * Math.sin(w * (t - 0.1));
    p.hry += 0.3 * amt * Math.sin(w * (t - 0.1));
  }
  function gait(p, dist, yaw, stride, stance, lift, bob, arm, lean, run = 0) {
    const s = sind(yaw);
    const dirx = s >= 0 ? 1 : -1;
    const A = stance * stride / 2;
    const phase = dist / stride;
    const offs = {};
    for (const [key, ph0] of [['l', 0], ['r', 0.5]]) {
      const f = R.pyMod(phase + ph0, 1);
      let off, up;
      if (f < stance) { off = A - 2 * A * (f / stance); up = 0; } else { const gg = (f - stance) / (1 - stance); off = -A + 2 * A * ss(gg); up = lift * Math.sin(Math.PI * gg); }
      offs[key] = off;
      p['f' + key + 'x'] += dirx * off * Math.abs(s);
      p['f' + key + 'y'] -= up;
    }
    p.y -= bob * (0.5 - 0.5 * Math.cos(4 * Math.PI * phase)) + run * 2.2 * Math.abs(Math.sin(2 * Math.PI * phase));
    p.lean += lean * dirx * Math.abs(s);
    p.hdy += 0.5 * Math.sin(4 * Math.PI * phase - 0.6);
    for (const [key, other] of [['l', 'r'], ['r', 'l']]) {
      const o = offs[other] / Math.max(A, 1e-6);
      p['h' + key + 'x'] += dirx * arm * o * Math.abs(s);
      p['h' + key + 'y'] -= run * 2.0 * Math.max(0, o);
    }
    const c2 = cosd(yaw) ** 2;
    if (c2 > 0.01) {
      const sw = Math.sin(2 * Math.PI * phase);
      p.x += 0.45 * sw * c2;
      p.lean += 1.8 * sw * c2;
      p.hly -= arm * 0.8 * Math.max(0, sw) * c2;
      p.hry -= arm * 0.8 * Math.max(0, -sw) * c2;
    }
    if (run) { p.hly -= 1.5 * run; p.hry -= 1.5 * run; p.hem = run; }
    return phase;
  }
  function mixPose(a, b, w) {
    if (w >= 1) return b;
    if (w <= 0) return a;
    const q = Object.assign({}, w > 0.5 ? b : a);
    for (const k of NUMKEYS) {
      if (k === 'yaw') q.yaw = a.yaw + wrapd(b.yaw - a.yaw) * w;
      else q[k] = lerp(a[k], b[k], w);
    }
    return q;
  }
  function mirrorPose(p, cx) {
    const q = Object.assign({}, p);
    q.x = 2 * cx - p.x; q.pvx = -p.pvx; q.rot = -p.rot; q.yaw = -p.yaw; q.lean = -p.lean;
    q.hrot = -p.hrot; q.hdx = -p.hdx; q.kdx = -p.kdx; q.krot = -p.krot; q.look = -p.look;
    q.hlx = -p.hrx; q.hly = p.hry; q.hrx = -p.hlx; q.hry = p.hly; q.hla = -p.hra; q.hra = -p.hla;
    q.zl = p.zr; q.zr = p.zl; q.zhl = p.zhr; q.zhr = p.zhl; q.hl = p.hr; q.hr = p.hl;
    q.flx = -p.frx; q.fly = p.fry; q.frx = -p.flx; q.fry = p.fly; q.fla = -p.fra; q.fra = -p.fla;
    if (Array.isArray(p.eyes)) q.eyes = [p.eyes[1], p.eyes[0]];
    if (p.kfree) { const k = p.kfree.slice(); k[0] = 2 * cx - k[0]; k[2] = -k[2]; k[3] = -k[3]; if (k.length > 4) k[4] = -k[4]; q.kfree = k; }
    if (p.props && p.props.length) q.props = p.props.map(([n, hold, home]) => [n, hold ? (hold === 'l' ? 'r' : 'l') : hold, home ? [2 * cx - home[0], home[1]] : home]);
    return q;
  }
  // where his hands are in his own frame (for hanging by them)
  function handsLocal(p) {
    const q = R.full(Object.assign({}, p, { x: 0, y: 0, rot: 0, sx: 1, sy: 1 }));
    const MB = R.mm(R.rootMatrix(q), R.bodyMatrix(q));
    const a = KM.ap(MB, q.hlx, q.hly), b = KM.ap(MB, q.hrx, q.hry);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  // ---------------------------------------------------------------- the cursor
  const mouse = { x: -999, y: -999, in: false, ld: false, rd: false, hist: [], moveT: -9, stillSince: 0 };

  // ---------------------------------------------------------------- sound (quiet: he lives beside your work)
  const AUD = { ctx: null, master: null, buf: {}, peak: {} };
  function audioInit() {
    if (AUD.ctx) { if (AUD.ctx.state === 'suspended') AUD.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || REVIEW) return;
    AUD.ctx = new AC();
    AUD.master = AUD.ctx.createGain();
    AUD.master.gain.value = 0.32;
    AUD.master.connect(AUD.ctx.destination);
    for (const [kind, [peak, b64]] of Object.entries(D.sounds)) {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      AUD.peak[kind] = peak;
      AUD.ctx.decodeAudioData(bin.buffer).then((b) => { AUD.buf[kind] = b; }).catch(() => {});
    }
    const o = AUD.ctx.createOscillator(), lfo = AUD.ctx.createOscillator(), lg = AUD.ctx.createGain(), wg = AUD.ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 600;
    lfo.frequency.value = 6.5; lg.gain.value = 9;
    lfo.connect(lg); lg.connect(o.frequency);
    wg.gain.value = 0;
    o.connect(wg); wg.connect(AUD.master);
    o.start(); lfo.start();
    AUD.wo = o; AUD.wg = wg;
    const nb = AUD.ctx.createBuffer(1, AUD.ctx.sampleRate * 2, AUD.ctx.sampleRate);
    const ch = nb.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    AUD.noise = nb;
    const rs = AUD.ctx.createBufferSource(), rf = AUD.ctx.createBiquadFilter(), rgn = AUD.ctx.createGain();
    rs.buffer = nb; rs.loop = true; rf.type = 'lowpass'; rf.frequency.value = 520; rf.Q.value = 0.8; rgn.gain.value = 0;
    rs.connect(rf); rf.connect(rgn); rgn.connect(AUD.master); rs.start();
    AUD.roarG = rgn; AUD.roarF = rf;
  }
  function whistle(level, pitch, loud = 0.05) {
    if (!AUD.wg) return;
    const now = AUD.ctx.currentTime;
    AUD.wg.gain.setTargetAtTime(S.sound ? clamp(level) * loud : 0, now, 0.06);
    AUD.wo.frequency.setTargetAtTime(clamp(pitch, 260, 2600), now, 0.05);
  }
  // where a sound goes: the speakers, or, in a review film (no live sound there), the film's list of sounds, which
  // filmSound plays into the film's own sound track afterwards (AUD.out)
  function sndOut() {
    if (AUD.out) return AUD.out;
    return S.sound && AUD.ctx ? { ac: AUD.ctx, dest: AUD.master, at: AUD.ctx.currentTime } : null;
  }
  const sndRec = (...a) => { if (!AUD.rec) return false; AUD.rec.push([T, ...a]); return true; };
  function sfx(kind, gain = 1) {
    if (sndRec('sfx', kind, gain)) return;
    const o = sndOut();
    if (!o || !AUD.buf[kind]) return;
    const src = o.ac.createBufferSource();
    src.buffer = AUD.buf[kind];
    const g2 = o.ac.createGain();
    g2.gain.value = Math.min(1.6, gain * Math.min(1, AUD.peak[kind] || 1) / 0.9);
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.06;
    src.connect(g2); g2.connect(o.dest);
    src.start(o.at);
  }

  // ---------------------------------------------------------------- particles
  let parts = [];
  const SMALL = {};
  const circ = R.memo((r) => {
    const n = Math.ceil(r) * 2 + 1;
    const s = new R.Spr(n, n, n / 2, n / 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) <= r) s.a[j * n + i] = R.IDX.V;
    return s;
  });
  const PX = {};
  const pxSpr = (k, n = 1) => PX[k + n] || (PX[k + n] = R.sprite(Array(n).fill(k.repeat(n))));
  const SMOKE_LUT = () => lutFor({ V: [116, 106, 100] });
  const STEAM_LUT = () => lutFor({ V: [250, 250, 248] });
  const DUST_LUT = () => lutFor({ V: [214, 206, 196] });
  function puff(x, y, n = 6, spread = 1) {
    for (let k = 0; k < n; k++) {
      const side = k % 2 ? 1 : -1;
      parts.push({ kind: 'dust', t0: T, x: x + side * (2 + Math.random() * 4), y: y - 0.5, vx: side * (8 + Math.random() * 10) * spread, vy: -(3 + Math.random() * 5), life: 0.35 + Math.random() * 0.25, size: 1.6 + Math.random() * 1.2 });
    }
  }
  function floaty(kind, x, y, n = 3) {
    for (let k = 0; k < n; k++) parts.push({ kind, t0: T + k * 0.12, x: x + (Math.random() - 0.5) * 14, y: y - Math.random() * 6, vx: (Math.random() - 0.5) * 6, vy: -10 - Math.random() * 6, life: 1.1 });
  }
  function particleItems(t) {
    const out = [];
    parts = parts.filter((q) => t - q.t0 <= q.life);
    for (const q of parts) {
      const age = t - q.t0;
      if (age < 0) continue;
      const f = age / q.life;
      const x = q.x + q.vx * age;
      let y = q.y + q.vy * age;
      if (q.kind === 'dust') { y += 6 * age * age; out.push({ spr: circ(Math.round((q.size * (1 - f) + 0.4) * 2) / 2), M: KM.T(x, y), L: DUST_LUT() }); }
      else if (q.kind === 'heart') out.push({ spr: SMALL.heart, M: KM.T(x + 1.5 * Math.sin(age * 9), y) });
      else if (q.kind === 'sweatfly') out.push({ spr: SMALL.sweat, M: KM.T(Math.round(x), Math.round(y + 70 * age * age)), alpha: 1 - ss((f - 0.6) / 0.4) });
      else if (q.kind === 'star') out.push({ spr: SMALL.star, M: KM.T(x, y) });
      else if (q.kind === 'spark') out.push({ spr: f < 0.55 ? SMALL.spark : SMALL.spark_s, M: KM.T(x, y) });
      else if (q.kind === 'note') out.push({ spr: SMALL.note, M: KM.T(x + 1.2 * Math.sin(age * 7), y) });
      else if (q.kind === 'zed') { const s = 0.6 + 0.6 * f; out.push({ spr: SMALL.zed, M: KM.mul(KM.T(x + 2 * Math.sin(age * 3), y), KM.S(s, s)), alpha: 1 - f * f }); }
      else if (q.kind === 'qmark' || q.kind === 'excl') out.push({ spr: SMALL[q.kind], M: KM.T(x, q.y - 3 * ss(age / 0.2)), alpha: 1 - ss((age - q.life + 0.25) / 0.25) });
      else if (q.kind === 'ember') out.push({ spr: pxSpr(q.c), M: KM.T(Math.round(x + 1.5 * Math.sin(age * 9 + q.ph)), Math.round(y - 20 * age * age)) });
      else if (q.kind === 'rock') out.push({ spr: pxSpr(q.c, 2), M: KM.T(Math.round(x), Math.round(Math.min(q.floor - 1, y + 160 * age * age))) });
      else if (q.kind === 'smoke') {
        const r = q.size * (0.7 + 1.6 * f);
        out.push({ spr: circ(Math.max(0.5, Math.round(r * 2) / 2)), M: KM.T(x + 2 * Math.sin(age * 3 + q.ph), y), L: SMOKE_LUT(), alpha: 0.55 * (1 - f) });
      } else if (q.kind === 'steam') {
        const r = q.size * (0.6 + 1.5 * f);
        out.push({ spr: circ(Math.max(0.5, Math.round(r * 2) / 2)), M: KM.T(x, y - 14 * age * age), L: STEAM_LUT(), alpha: 0.85 * (1 - f) });
      }
    }
    return out;
  }
  // a little ? or ! over his head
  function mark(kind, dur = 1.0) {
    const top = KH.pose ? KM.ap(R.rootMatrix(R.full(KH.pose)), 0, -60) : [KH.x, groundY() - 60];
    parts = parts.filter((q) => q.kind !== 'qmark' && q.kind !== 'excl');
    parts.push({ kind, t0: T, x: top[0] + 4, y: top[1], vx: 0, vy: 0, life: dur });
  }

  // ---------------------------------------------------------------- clips (the library moves)
  let T = 0;
  // moves that read well on a ledge: no set pieces (bench, bar, wall, box), not flying off across the screen
  const DESK_MOVES = ['wave-bow', 'hand-signs', 'presenter', 'think-idea', 'attitude', 'kumma-tip', 'kumma-off', 'joy-wonder', 'pride-love',
    'playful', 'talk-look', 'groove-loop', 'dance-loop', 'shuffle-loop', 'disco-loop', 'robot-loop', 'silly-loop', 'balance', 'squash-pop',
    'celebrate', 'power-up', 'hero-stance', 'reading', 'football', 'wizard', 'chef', 'pirate', 'cyber-guardian', 'breakdance', 'sit-poses',
    'lie-back', 'turnaround', 'annoyed-happy', 'surprise', 'cartwheel-flip', 'roll-recover', 'leap-tuck', 'space',
    // the game's set pieces and flights too; the
    // feelings (sad-cry, angry-calm, scared) and peek-sneak's door are only played from the tray's Moves menu
    'bench-sit', 'bar-hang', 'push-pull', 'detective', 'dash-brake', 'hero-flight', 'cape-hero', 'ninja'];
  const SLEEPY_MOVES = ['sleepy', 'lie-back', 'reading', 'sit-poses'];
  // the anchor range on platform Q where clip c fits (its extent, mirrored or not), or null
  function clipRange(c, Q, mirror) {
    let b0 = c.bbox[0] - c.x0, b1 = c.bbox[1] - c.x0;
    if (mirror) [b0, b1] = [-b1, -b0];
    const lo = Q.x0 + 3 - b0, hi = Q.x1 - 3 - b1;
    if (lo > hi) return null;
    if (Q.y + c.bbox[2] < (Q.kind === 'room' ? Q.top : 2)) return null;  // would go off the top of the screen (or out of his room)
    return [lo, hi];
  }
  function playMove(key, opts = {}) {
    const c = CLIPS[key];
    if (c && NBX && NBX.active()) { NBX.leave(key); return true; }      // off the Nimbus first, then the move
    if (!c || KH.mode !== 'free' || KH.rage) return false;
    const Q = KH.plat || WD.floor;
    let mirror = opts.mirror != null ? opts.mirror : Math.random() < 0.5;
    let rg = clipRange(c, Q, mirror);
    if (!rg) { mirror = !mirror; rg = clipRange(c, Q, mirror); }
    if (!rg) return false;
    const want = clamp(KH.x, rg[0], rg[1]);
    KH.sit = null; KH.peek = null;
    const go = () => { if (KH.mode === 'free' && KH.plat === Q) startClip(c, KH.x, mirror, opts.dur); };
    if (Math.abs(want - KH.x) > 2) KH.walkTo = { x: want, speed: 15, then: go };
    else go();
    return true;
  }
  function startClip(c, anchor, mirror, dur) {
    KH.blend = KH.pose ? { from: KH.pose, t0: T, dur: 0.22 } : null;
    KH.mode = 'clip'; KH.clip = c; KH.clipT = 0; KH.clipPrev = -1e-6; KH.anchor = anchor; KH.clipMirror = !!mirror;
    KH.clipUntil = c.loop ? (dur || rnd(6, 10)) : c.dur;
    KH.walkTo = null; KH.jump = null; KH.idleSince = T;
  }
  function endClip(toFree = true) {
    const c = KH.clip;
    if (!c) return;
    if (toFree && KH.pose) {
      const m = KH.clipMirror ? -1 : 1;
      const endX = c.loop ? KH.anchor : KH.anchor + (c.x1 - c.x0) * m;
      const Q = KH.plat || WD.floor;
      KH.x = clamp(endX, qlo(Q), qhi(Q));
      KH.yaw = wrapd(KH.pose.yaw);
      KH.yawTarget = 0;
      KH.blend = { from: KH.pose, t0: T, dur: 0.3 };
    }
    KH.mode = 'free'; KH.clip = null; KH.idleSince = T;
  }
  function clipRoomPose(c, t) {
    let q = clipPose(c, t);
    const dx = KH.anchor - c.x0, fy = groundY();
    q.x += dx; q.y += fy;
    if (q.kfree) { q.kfree = q.kfree.slice(); q.kfree[0] += dx; q.kfree[1] += fy; }
    if (q.props && q.props.length) q.props = q.props.map(([n, h, home]) => [n, h, home ? [home[0] + dx, home[1] + fy] : home]);
    if (KH.clipMirror) q = mirrorPose(q, KH.anchor);
    return q;
  }
  function clipExtras(c, t) {
    const i = c.loop ? R.pyMod(Math.round(t * D.fps), c.n) : clamp(Math.round(t * D.fps), 0, c.n - 1);
    const fr = c.frames[i];
    const dx = KH.anchor - c.x0, fy = groundY();
    let base = KM.T(dx, fy);
    if (KH.clipMirror) base = KM.mul(KM.mul(KM.T(KH.anchor, 0), KM.S(-1, 1)), KM.mul(KM.T(-KH.anchor, 0), base));
    const out = {};
    for (const k in fr) {
      out[k] = fr[k].map((it) => ({ spr: EXSPR[it[0]], M: KM.mul(base, it.slice(1)) }));
    }
    return out;
  }

  // ---------------------------------------------------------------- the free pose: standing, walking, sitting, peeking
  function idleYaw(t) {
    if (KH.after && KH.after.kind === 'grumpy' && KH.after.turn != null) return KH.after.turn;
    if (KH.lookYaw && t < KH.lookYaw.until) return KH.lookYaw.yaw;
    if (!mouse.in || KH.sit || KH.sink > 4) return 0;
    const dx = mouse.x - KH.x;
    if (Math.abs(dx) > 420) return 0;
    return clamp(dx * 0.1, -18, 18);                                     // a little toward the cursor; he still faces us
  }

  // ---------------------------------------------------------------- his gaze: his head follows the cursor anywhere on the screen
  // In every direction (right, left, up, down, the corners), his head turns the way the cursor goes.
  // The rig turns the head with the body, so the head's own turn (hyaw) and nod (hpitch) are drawn by swapping the head
  // and kumma pictures in khalfanItems. Up and down: his eyes, the head's height, the kumma's tilt (more of its top when
  // he looks down); in a corner the head also rolls a little toward the cursor. A spring moves it, so it lags and settles.
  const GZ = { yaw: 0, vyaw: 0, up: 0, vup: 0, w: 0, moving: false };
  const GAZE_EYES = new Set(['rest', 'neutral', 'curious', 'sneaky', 'determined', 'focus', 'thinking', 'intrigued', 'wonder']);
  function gazeWeight(t) {
    if (KH.gone || KH.rage || KH.emote || KH.nimbus) return 0;
    if (KH.mode === 'clip') return 0;                                    // a move has its own head
    if (KH.mode === 'held') return KH.held && KH.held.ride ? 0 : 0.6;   // held: he looks up at your hand
    if (KH.mode === 'air') return 0.35;
    if (KH.mode === 'hang') return KH.hang && KH.hang.rear ? 0 : 0.9;
    if (KH.mode === 'wall') return 0.55;
    if (KH.sit && KH.sit.sleep) return 0;
    if (KH.reach || KH.leap || t < KH.dizzyUntil || KH.coffee) return 0;
    let w = 1 - 0.55 * clamp(KH.speed / 20);                            // walking: mostly where he goes
    if (KH.react) w *= 0.4;                                              // a reaction's face wins while it runs
    return w;
  }
  function gazeStep(p, t, dt) {
    const GR = KH.gazeRect;                                            // the paper he is thinking over with you (KhalfanHands)
    const onPaper = GR && mouse.in && mouse.x >= GR.x && mouse.x <= GR.x + GR.w && mouse.y >= GR.y && mouse.y <= GR.y + GR.h;
    const fresh = !!GR || (mouse.in && t - mouse.moveT < 8);          // a cursor left still a while: he loses interest
    GZ.w = approach(GZ.w, fresh ? (GR ? 1 : gazeWeight(t)) : 0, dt / 0.35);
    let ty = 0, tu = 0;
    if (fresh) {
      const hp = KM.ap(R.rootMatrix(R.full(p)), 0, -34);              // his eyes
      const gx = GR && !onPaper ? GR.x + GR.w / 2 : mouse.x, gy = GR && !onPaper ? GR.y + GR.h * 0.55 : mouse.y;   // on the paper: what you point at
      const dx = gx - hp[0], dy = gy - hp[1], d = Math.hypot(dx, dy);
      const reach = clamp((d - 6) / 30);                               // right on his face: he looks straight out at you
      ty = 44 * Math.tanh(dx / 55) * reach;
      tu = clamp(-dy / Math.max(d, 1) * 1.35, -1, 1) * reach;
    }
    const sub = Math.max(1, Math.ceil(dt * 120)), h = dt / sub;
    for (let i = 0; i < sub; i++) {
      GZ.vyaw += ((ty - GZ.yaw) * 260 - GZ.vyaw * 26) * h; GZ.yaw += GZ.vyaw * h;
      GZ.vup += ((tu - GZ.up) * 260 - GZ.vup * 26) * h; GZ.up += GZ.vup * h;
    }
    GZ.moving = GZ.w > 0.02 && (Math.abs(GZ.vyaw) > 6 || Math.abs(GZ.vup) > 0.1 || Math.abs(ty - GZ.yaw) > 1.5 || Math.abs(tu - GZ.up) > 0.03);
    const w = GZ.w;
    if (w < 0.01) return p;
    const q = Object.assign({}, p);
    const off = clamp(GZ.yaw - p.yaw, -42, 42) * w;
    q.hyaw = Math.round(off / 2) * 2;                                    // in 2° steps: fewer head pictures to make
    const up = GZ.up * w;
    q.hpitch = up;
    q.hdy -= 1.3 * up;
    q.hrot += 7 * clamp(GZ.yaw / 40, -1, 1) * up;                       // a corner: the head rolls toward it
    if (w > 0.5 && !KH.react && !q.eyes && GAZE_EYES.has(q.expr)) {
      if (up > 0.42) q.eyes = 'lookup'; else if (up < -0.42) q.eyes = 'lookdown';
    }
    const tot = p.yaw + off;
    if (w > 0.5 && Math.abs(cosd(tot)) > 0.8) q.look = Math.abs(GZ.yaw) > 7 ? Math.sign(GZ.yaw) * Math.sign(cosd(tot)) : 0;
    return q;
  }
  // the worn kumma's apparent tilt for a head yaw (the rig's kummaTilt, which it keeps to itself)
  function kummaTiltFor(yaw) {
    const K = R.K;
    yaw = R.wrap(yaw);
    if (yaw >= 0) return K.KTILT * cosd(yaw);
    const d = -yaw;
    if (d <= K.KL_TURN) return K.KTILT + (-K.KL_BACK - K.KTILT) * ss(d / K.KL_TURN);
    if (d <= 90) return -K.KL_BACK;
    return -K.KL_BACK + (K.KL_BACK - K.KTILT) * ss((d - 90) / 90);
  }
  // the head and the kumma, turned and nodded on their own (see the gaze above)
  function turnHead(items, p) {
    const hy = R.wrap(R.pyRound(p.yaw + (p.hyaw || 0)));
    const q = R.full(p);
    let eyes = q.eyes, mouth = q.mouth;
    if (q.blink > 0.5) eyes = 'closed'; else if (q.blink > 0.2) eyes = 'half';
    if (q.talk > 0) mouth = R.T.MOUTH_CYCLE[Math.trunc(q.talk * 9) % R.T.MOUTH_CYCLE.length];
    for (const it of items) {
      if (it.kind === 'head') { it.spr = R.head(hy, q.expr, mouth, eyes, Math.trunc(R.pyRound(q.look)), q.brow, 1, false, false, p.hatHair || null, q.kfree == null); it.yaw = hy; }
      else if (it.kind === 'kumma' && !it.free) {
        const tilt = R.pyRound(kummaTiltFor(hy));                        // (tilt is the kumma's worn angle, not a nod)
        it.spr = R.kumma(R.pyRound(hy), tilt); it.yaw = hy; it.tilt = tilt;
      }
    }
  }
  function freePose(t, dt) {
    const Q = KH.plat || WD.floor;
    const gy = Q.y;
    let dir = 0;
    if (KH.rage) KH.walkTo = null;
    if (KH.walkTo) {
      const tx = clamp(KH.walkTo.x, qlo(Q), qhi(Q));
      const ex = tx - KH.x;
      if (Math.abs(ex) < 1.2 || (KH.walkTo.near && Math.abs(ex) < KH.walkTo.near)) {
        const then = KH.walkTo.then;
        KH.walkTo = null;
        if (then) then(t);
      } else dir = Math.sign(ex);
    }
    const sitting = KH.sit && KH.sitW > 0.02;
    const moving = dir !== 0 && !sitting;
    const target = moving ? (KH.walkTo.speed || 15) : 0;
    KH.speed += clamp(target - KH.speed, -110 * dt, 80 * dt);
    if (moving) { KH.yawTarget = dir * 70; KH.faceUsAt = t + 0.6; KH.lastDir = dir; KH.idleSince = t; }
    else if (t > KH.faceUsAt) KH.yawTarget = idleYaw(t);
    if (KH.speed > 0.05) {
      const nx = clamp(KH.x + KH.lastDir * KH.speed * dt, qlo(Q), qhi(Q));
      KH.dist += Math.abs(nx - KH.x);
      KH.x = nx;
    }
    if (moving && KH.after && KH.after.kind !== 'grumpy') KH.after = null;
    const dyaw = wrapd(KH.yawTarget - KH.yaw);
    const step = Math.sign(dyaw) * Math.min(Math.abs(dyaw), 560 * dt);
    KH.yaw = wrapd(KH.yaw + step);

    const p = stand(KH.yaw, KH.x, gy);
    const asleep = KH.sit && KH.sit.sleep;
    breathe(p, t, asleep ? 1.4 : 1, asleep ? 3.6 : 2.4);
    const walkW = clamp(KH.speed / 6);
    if (walkW > 0) {
      const k = clamp((KH.speed - 15) / 17);
      const q = Object.assign({}, p);
      const ph = gait(q, KH.dist, KH.yaw, lerp(11, 22, k), lerp(0.6, 0.42, k), lerp(1.9, 3.6, k), lerp(0.75, 0.6, k), lerp(2.6, 3.4, k), lerp(2.5, 10, k), k);
      Object.assign(p, mixPose(p, q, walkW));
      const half = Math.floor(ph * 2);
      if (half !== KH.lastStepPh && walkW > 0.5) { KH.lastStepPh = half; sfx('step', KH.speed > 30 ? 0.22 : 0.14); }
    } else if (Math.abs(step) / Math.max(dt, 1e-3) > 40) {
      KH.turnPh += dt * 3.0;
      const f = R.pyMod(KH.turnPh, 1), k = Math.floor(KH.turnPh) % 2;
      const lift = bump(f, 0, 0.62) * 1.6;
      if (k === 0) p.fly -= lift; else p.fry -= lift;
      p.y -= bump(f, 0, 0.62) * 0.5;
    }
    // a little hop on the spot (anticipation crouch first)
    if (KH.jump) {
      const J = KH.jump, u = t - J.t0;
      const d = 1.8 * bump(u, -0.16, 0.02) + 1.6 * bump(u, J.dur, J.dur + 0.22);
      const sq = 0.09 * bump(u, -0.16, 0.02) + 0.1 * bump(u, J.dur, J.dur + 0.2);
      p.y += d; p.sy -= sq; p.sx += sq * 0.6; p.fly -= d; p.fry -= d;
      const f = win(u, 0, J.dur);
      if (f > 0 && f < 1) {
        const s = Math.sin(Math.PI * f);
        p.y -= J.h * s;
        p.fly -= 1.6 * s; p.fry -= 1.6 * s;
        p.hem = Math.max(p.hem, 0.9 * s);
        p.hly -= 3 * s; p.hry -= 3 * s; p.hlx -= 2 * s; p.hrx += 2 * s;
        if (J.reach) { p.hlx = lerp(p.hlx, -24, s); p.hly = lerp(p.hly, -24, s); p.hrx = lerp(p.hrx, 24, s); p.hry = lerp(p.hry, -24, s); p.zl = p.zr = 1; p.hl = p.hr = 'open'; }
      }
      if (!J.landed && u >= J.dur) { J.landed = true; sfx('land', 0.5); puff(p.x, gy, 4); }
      if (u > J.dur + 0.25) KH.jump = null;
    }
    // the crouch before a big jump to another ledge
    if (KH.leap) {
      const Lp = KH.leap, u = t - Lp.t0, c = ss(u / Math.min(0.2, Lp.charge));
      const big = Lp.kind === 'super' ? 1.6 : 1;
      p.y += 2.4 * c * big; p.fly -= 2.4 * c * big; p.fry -= 2.4 * c * big; p.sy -= 0.1 * c * big; p.sx += 0.06 * c * big;
      p.hlx -= 4 * c; p.hrx += 4 * c; p.hly += 2 * c; p.hry += 2 * c;
      p.yaw = KH.yaw = lerp(KH.yaw, Lp.dir * 30, c);
      p.expr = 'determined';
      if (Lp.kind === 'super') {                                          // charging up: trembling, sparks gathering
        p.x += 0.4 * Math.sin(t * 60) * c;
        if (Math.floor(u / 0.12) !== Lp.sparkK) { Lp.sparkK = Math.floor(u / 0.12); parts.push({ kind: 'spark', t0: T, x: p.x + rnd(-16, 16), y: p.y - rnd(0, 40), vx: 0, vy: -20, life: 0.4 }); }
      }
    }
    // reaching up for the ledge over his head: arms up beside the kumma, up on his toes, looking up at it
    if (KH.reach) {
      const u = t - KH.reach.t0, a = ss(u / 0.2), toes = bump(u, 0.12, 0.34);
      p.hlx = lerp(p.hlx, -24, a); p.hly = lerp(p.hly, -42, a); p.hrx = lerp(p.hrx, 24, a); p.hry = lerp(p.hry, -42, a);
      if (a > 0.4) { p.zl = p.zr = 1; p.hl = p.hr = 'open'; }
      p.y -= 2.2 * toes; p.fly += 0.2 * toes; p.fry += 0.2 * toes;
      p.yaw = KH.yaw = lerp(KH.yaw, 0, a);
    }
    // landing squash
    const lu = t - KH.landT;
    if (lu < 0.45) {
      const d = 3.2 * KH.landHard * bump(lu, 0, 0.42);
      p.y += d; p.fly -= d; p.fry -= d; p.sy -= 0.12 * KH.landHard * bump(lu, 0, 0.4); p.sx += 0.08 * KH.landHard * bump(lu, 0, 0.4);
    }
    // sitting on the ledge, legs dangling over it (bench-sit's pose)
    KH.sitW = approach(KH.sitW, KH.sit && !moving && !KH.jump && !KH.leap ? 1 : 0, dt / 0.32);
    if (KH.sitW > 0) {
      const w = ss(KH.sitW);
      const q = Object.assign({}, p);
      const sw = asleep ? 0.15 * Math.sin(t * 1.1) : Math.sin(t * 2.5 + (KH.sit ? KH.sit.ph : 0));
      q.y = gy + 0.6 - 3 * bump(KH.sitW, 0.15, 0.85);                      // a little hop up onto the edge
      q.hlx = -10.4; q.hly = 2.2; q.hrx = 10.4; q.hry = 2.2; q.zl = q.zr = 0; q.hl = q.hr = 'rest';   // hands on the edge beside him
      q.flx = -3.4; q.frx = 3.4; q.fly = 6.2 + 1.3 * sw; q.fry = 6.2 - 1.3 * sw;                           // legs dangling over it, swinging
      q.yaw = clamp(q.yaw, -26, 26); q.lean = 0;
      if (asleep) { q.hrot = 9 + 1.5 * Math.sin(t * 1.7); q.hdy += 1.1; q.lean = 2; }
      Object.assign(p, mixPose(p, q, w));
    }
    // peeking out from behind the taskbar: he sinks under its top edge (drawn clipped there)
    if (KH.sink > 0.01) {
      p.y += KH.sink;
      // peeking: his hands grip the taskbar's edge either side of his face
      const grip = (Q.kind === 'icon' ? 0 : 1) * clamp((KH.sink - 8) / 14) * (1 - clamp((KH.sink - 44) / 10));   // (a file is too narrow to grip)
      if (grip > 0) {
        const by = -KH.sink + 2.5;                                        // just over the edge, in his body's frame (hips 4 up)
        p.hlx = lerp(p.hlx, -21, grip); p.hly = lerp(p.hly, by, grip); p.hrx = lerp(p.hrx, 21, grip); p.hry = lerp(p.hry, by, grip);
        if (grip > 0.5) { p.zl = p.zr = 1; p.zhl = p.zhr = 2; p.hl = p.hr = 'fist'; }
      }
    }

    // face, eyes, mouth
    p.expr = p.expr === 'determined' && KH.leap ? 'determined' : 'rest';
    if (KH.sit && KH.sitW > 0.5) p.expr = KH.sit.face || 'rest';
    if (asleep) { p.expr = 'asleep'; if (T - (KH.sit.zT || 0) > 1.5) { KH.sit.zT = T; const hp = KM.ap(R.rootMatrix(R.full(p)), 8, -50); parts.push({ kind: 'zed', t0: T, x: hp[0], y: hp[1], vx: 6, vy: -9, life: 1.8 }); } }
    if (KH.peek) p.expr = KH.peek.face || 'sneaky';
    if (t < KH.dizzyUntil) { p.expr = 'dizzy'; p.hrot += 5 * Math.sin(t * 9); }
    if (KH.react && t - KH.react.t0 < KH.react.dur) {
      const u = t - KH.react.t0, Rc = KH.react;
      p.expr = Rc.face;
      if (Rc.hop) { const s = bump(u, 0.05, 0.35); p.y -= 3 * s; p.fly -= 1 * s; p.fry -= 1 * s; }
      if (Rc.shake) p.hrot += 6 * Math.sin(u * 30) * (1 - u / Rc.dur);
      if (Rc.sigh) {                                                      // shoulders drop with a long breath out
        const b2 = bump(u, 0.05, 0.75);
        p.y += 1.0 * b2; p.fly -= 1.0 * b2; p.fry -= 1.0 * b2; p.hly += 1.4 * b2; p.hry += 1.4 * b2; p.hdy += 0.6 * b2; p.sy *= 1 - 0.03 * b2;
      }
      if (Rc.wave) { const a = ss(win(u, 0, 0.15)) * (1 - ss(win(u, Rc.dur - 0.2, Rc.dur))); p.hrx = lerp(p.hrx, 24, a); p.hry = lerp(p.hry, -17, a); p.zr = 1; p.hr = 'open'; p.hra = 18 * Math.sin(u * 2 * Math.PI * 2.4) * a; }
      if (Rc.arms) { const a = ss(win(u, 0, 0.12)) * (1 - ss(win(u, Rc.dur - 0.25, Rc.dur))); p.hlx = lerp(p.hlx, -26, a); p.hly = lerp(p.hly, -24, a); p.hrx = lerp(p.hrx, 26, a); p.hry = lerp(p.hry, -24, a); if (a > 0.5) { p.hl = p.hr = 'open'; p.zl = p.zr = 1; } }
      if (Rc.windmill) { const a = 1 - u / Rc.dur; p.hlx = -16 + 4 * Math.sin(u * 18); p.hly = -12 + 6 * Math.cos(u * 18); p.hrx = 16 - 4 * Math.sin(u * 18 + 1); p.hry = -12 + 6 * Math.cos(u * 18 + 1); p.zl = p.zr = 1; p.hl = p.hr = 'open'; p.lean += 6 * Math.sin(u * 11) * a; }
      if (Rc.yawn) { p.mouth = 'yawn'; p.eyes = 'closed'; p.hry = lerp(p.hry, -12, bump(u, 0, Rc.dur)); p.hrx = lerp(p.hrx, 4, bump(u, 0, Rc.dur)); p.zr = 2; }
      if (Rc.toss) {                                                      // catching a crumpled card and throwing it off the screen
        const d = Rc.toss, k = d > 0 ? 'r' : 'l';
        const catchA = ss(win(u, 0, 0.2)), wind = ss(win(u, 0.28, 0.52)), thr = ss(win(u, 0.52, 0.66)), back = ss(win(u, 0.95, Rc.dur));
        let hx = lerp(d * 22, d * 27, wind), hy = lerp(-24, -40, wind);   // up beside his head to catch it, then wound up high (out past his curls)
        hx = lerp(hx, d * 30, thr); hy = lerp(hy, -14, thr);             // the throw: out and down
        const a = catchA * (1 - back);
        p['h' + k + 'x'] = lerp(p['h' + k + 'x'], hx, a); p['h' + k + 'y'] = lerp(p['h' + k + 'y'], hy, a);
        if (a > 0.4) { p['z' + k] = 1; p['h' + k] = u < 0.6 ? 'fist' : 'open'; }
        p.lean += d * (-4 * wind + 9 * thr) * (1 - back);
        p.y -= 1.6 * bump(u, 0.5, 0.75);
        p.expr = u < 0.26 ? 'surprise' : u < 0.55 ? 'determined' : u < 0.95 ? 'yay' : 'happy';
      }
      if (Rc.read) {                                                      // leaning over to read the file's name, tapping it
        const a = ss(win(u, 0, 0.25)) * (1 - ss(win(u, Rc.dur - 0.3, Rc.dur)));
        p.hdy += 1.6 * a; p.hrot += 4 * a; p.eyes = 'lookdown';
        p.hlx = lerp(p.hlx, -9, a); p.hly = lerp(p.hly, -2, a); p.hrx = lerp(p.hrx, 9, a); p.hry = lerp(p.hry, -2, a);
        const tap = Math.max(0, Math.sin(u * 9)) * a;
        p.fry -= 1.4 * tap;
        if (u > 0.4 && Math.floor(u * 9 / Math.PI) !== Rc.tapK && Math.sin(u * 9) > 0.95) { Rc.tapK = Math.floor(u * 9 / Math.PI); sfx('tick', 0.12); }
      }
    } else KH.react = null;
    if (t >= KH.dizzyUntil && !KH.rage) afterPose(p, t);
    if (!KH.rage && KH.angerStage >= 1 && t >= KH.dizzyUntil) {          // still cross: it shows until it cools off
      if (KH.angerStage >= 2) {
        p.expr = Math.floor(t / 0.5) % 2 ? 'furious' : 'angry'; p.mouth = 'bigah';
        p.hlx = -13; p.hly = -8; p.hrx = 13; p.hry = -8; p.hl = p.hr = 'fist'; p.zl = p.zr = 1;
        p.x += 0.3 * Math.sin(t * 50);
      } else { p.expr = 'angry'; p.mouth = 'puff'; }
      if (KH.after && KH.after.kind === 'again') KH.after = null;
    }
    // the cursor over him: he knows what is coming (a grin, hands up a little)
    if (!asleep && !KH.after && !KH.react && !KH.rage && KH.angerStage < 1 && t >= KH.dizzyUntil && !KH.peek && mouse.in && !drag && hitKhalfan(mouse.x, mouse.y)) {
      p.expr = 'grin'; if (!sitting) { p.hly -= 1.4; p.hry -= 1.4; }
    }
    if (!asleep) {
      if (t > KH.blinkAt) { KH.blinkT = t; KH.blinkAt = t + 1.8 + Math.random() * 3.2; }
      if (KH.blinkT != null && t - KH.blinkT < 0.14) p.blink = bump(t - KH.blinkT, 0, 0.14) * 1.2;
      // (his eyes and head on the cursor: gazeStep, after the pose)
    }
    if (KH.reach && !KH.rage) { p.expr = 'determined'; p.eyes = 'lookup'; p.look = 0; }
    if (KH.rage) emotePose(p, t);
    if (NBX && KH.nimbus) NBX.pose(p, t);
    return p;
  }

  // ---------------------------------------------------------------- handling him (from his original game)
  const LIMB_KEYS = ['hlx', 'hly', 'hrx', 'hry', 'flx', 'fly', 'frx', 'fry'];
  const LIMB_BASE = {
    surprise: [-19, -16, 19, -16, -5.5, 0.5, 5.5, 0.5],
    nervous: [-15, -10, 15, -10, -3.6, 1.2, 3.6, 1.2],
    joy: [-18, -12, 18, -12, -4.5, 0.6, 4.5, 0.6],
    scared: [-17, -18, 17, -18, -4, 0, 4, 0],
    high: [-16, -13, 16, -13, -3.8, 0.6, 3.8, 0.6],
    bored: [-3.6, -7.6, 3.6, -7.0, -3.2, 1.4, 3.2, 1.4],
    floor: [-14, -6, 14, -6, -3.2, 3.4, 3.2, 3.4],
    dizzy: [-10, -1, 10, -1, -3.4, 1.8, 3.4, 1.8],
    air: [-17, -13, 17, -13, -4, 1.0, 4, 1.0],
    fall: [-21, -19, 21, -19, -4.6, 0.2, 4.6, 0.2],
    leap: [-12, -16, 18, -8, -4, -2.5, 4, 0.5],
    tuck: [-6, -1.5, 6, -1.5, -3, -5, 3, -5],
    ride: [-19, -10, 16, -26, -3.6, 1.2, 3.6, 1.2],
  };
  function limbTarget(base) {
    const b = LIMB_BASE[base] || LIMB_BASE.nervous, o = {};
    LIMB_KEYS.forEach((k, i) => { o[k] = b[i]; });
    return o;
  }
  function limbsFrom(p) {
    KH.limb = {};
    for (const k of LIMB_KEYS) KH.limb[k] = [p[k], 0];
  }
  function limbsStep(p, tgt, dt, stiff = 170, damp = 12) {
    if (!KH.limb) limbsFrom(p);
    const sub = 3, h = Math.min(dt, 1 / 30) / sub;
    for (const k of LIMB_KEYS) {
      const s = KH.limb[k];
      for (let i = 0; i < sub; i++) { s[1] += (-(s[0] - tgt[k]) * stiff - s[1] * damp) * h; s[0] += s[1] * h; }
      p[k] = s[0];
    }
  }
  function addPhysics(tgt, rotDeg, ax, ay, vx, vy, sag = 1) {
    const a = rotDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const gx = s, gy = c;
    const bax = c * ax + s * ay, bay = -s * ax + c * ay;
    const bvx = c * vx + s * vy, bvy = -s * vx + c * vy;
    const lagx = clamp(-bax * 0.0026 - bvx * 0.012, -7, 7), lagy = clamp(-bay * 0.0026 - bvy * 0.012, -7, 7);
    for (const side of ['l', 'r']) {
      tgt['h' + side + 'x'] += lagx + gx * 3 * sag; tgt['h' + side + 'y'] += lagy + (gy - 1) * 3 * sag;
      tgt['f' + side + 'x'] += 0.6 * lagx + gx * 2.2 * sag; tgt['f' + side + 'y'] += 0.4 * lagy + (gy - 1) * 2.2 * sag;
    }
  }
  const KUMMA_PTS = [[0, -52], [-14, -40], [14, -40]], FOOT_PTS = [[-4, 0], [4, 0], [-10, -5], [10, -5]];
  function lowest(p, pts) {
    const MR = R.rootMatrix(R.full(p));
    let low = -1e9;
    for (const [lx, ly] of pts) low = Math.max(low, KM.ap(MR, lx, ly)[1]);
    return low;
  }
  function hitstop(t, d) { KH.hitUntil = Math.max(KH.hitUntil, t + d); }
  function shake(t, amp) {
    const left = KH.shake ? KH.shake.amp * Math.exp(-(t - KH.shake.t0) * 10) : 0;
    if (amp > left) KH.shake = { t0: t, amp };
  }
  function bonk(t, A, side, sp) {
    A.bonkT = t; A.bonkSide = side;
    sfx('thud', 0.8); sfx('boing', 0.5);
    hitstop(t, 0.06); shake(t, clamp(sp / 500, 0.4, 1.2));
    floaty('star', A.x, A.y - (side === 'top' ? 52 : 40), 3);
    if (!A.self) addAnger(side === 'side' ? 0.45 : 0.2);
    if (side === 'side') { A.sideBonk = true; KH.fear += 0.4; } else { A.trick = null; KH.fun += 0.2; }
  }
  function settleMood(H, want, t) {
    if (want === H.mood) { H.cand = null; return H.mood; }
    if (H.cand !== want) { H.cand = want; H.candT = t; }
    if (!H.mood || t - H.candT > 0.14 || want === 'dizzy' || want === 'scared') {
      H.mood = want; H.moodT = t; H.cand = null;
      if (want === 'joy') sfx('heart', 0.2);
      else if (want === 'scared') sfx('boing', 0.25);
      else if (want === 'bored') sfx('tick', 0.2);
    }
    return H.mood;
  }

  // ---------------------------------------------------------------- his temper (from his original game), and his few words
  // What he says: «بسك» and «لا تخليني أعصب», «هلا» «يلا» «زين» «باي باي»
  // Poked and shaken he gets cross in steps (a pout and «بسك», then fists up, shouting «لا تخليني أعصب»). Left alone a
  // second he cools off, a step at a time: a huff of steam out of his kumma and a pout, then a sigh, and he is himself
  // again (about 4 s from a shout). Pushed past that he blows: the game's angry power-up, below.
  const LINES = { hello: 'هلا', go: 'يلا', good: 'زين', bye: 'باي باي', angry1: 'بسك', angry2: 'لا تخليني أعصب' };
  let VEIN = null;
  const veinSpr = () => VEIN || (VEIN = R.sprite(['.R.R.', 'RR.RR', '.....', 'RR.RR', '.R.R.']));
  const backOut = (x, s = 1.7) => { x = clamp(x) - 1; return 1 + x * x * ((s + 1) * x + s); };
  function say(text, stage = 0) { KH.bubble = { text, t0: T, dur: stage === 2 ? 2.3 : 1.9, stage }; sfx('talk', 0.5); }
  function addAnger(v) {
    if (KH.rage || v <= 0) return;
    KH.anger = Math.min(3.2, KH.anger + v);
    KH.lastAngerT = T;
    if (KH.anger >= 1 && KH.angerStage < 1) { KH.angerStage = 1; say(LINES.angry1, 1); }
    if (KH.anger >= 2 && KH.angerStage < 2) { KH.angerStage = 2; say(LINES.angry2, 2); sfx('stomp', 0.5); }
    if (KH.anger >= 3 && KH.angerStage < 3) {
      KH.angerStage = 3;
      if (KH.mode === 'held') KH.held.breakFree = true;               // he wriggles free, and blows when he lands
      else if ((KH.mode === 'free' && !KH.nimbus) || KH.mode === 'clip') blowUp();
      else KH.rageOnLand = true;                                        // in the air, hanging, climbing: once he is on his feet
    }
  }
  function blowUp() {
    KH.anger = 0; KH.angerStage = 0; KH.bubble = null;
    if (!KH.rage) playEmote();
  }
  function coolDown(dt) {
    if (KH.rage || KH.mode === 'air' || !KH.anger) return;
    if (KH.mode === 'held' && KH.held && (KH.held.energy || 0) > 70) return;   // still being swung about
    if (T - (KH.lastAngerT || -9) < 1.0) return;
    const before = KH.angerStage;
    KH.anger = Math.max(0, KH.anger - dt * 0.7);
    if (KH.anger < 0.6) KH.angerStage = 0;
    else if (KH.anger < 1.6) KH.angerStage = Math.min(KH.angerStage, 1);
    else if (KH.anger < 2.6) KH.angerStage = Math.min(KH.angerStage, 2);
    if (KH.angerStage < before) calmStep(KH.angerStage);
  }
  function calmStep(stage) {
    if (KH.bubble && KH.bubble.stage > stage) KH.bubble = null;
    if (KH.pose) {                                                      // a puff of steam out from under the kumma
      const q = R.full(KH.pose), hm = R.mm(R.rootMatrix(q), R.headMatrix(q));
      for (const sd of [-1, 1]) {
        for (let j = 0; j < (stage === 0 ? 4 : 6); j++) {
          const [sx0, sy0] = KM.ap(hm, sd * 21, -33);
          parts.push({ kind: 'steam', t0: T + j * 0.03, x: sx0, y: sy0, vx: sd * (30 + Math.random() * 30), vy: -(10 + Math.random() * 20), life: 0.5 + Math.random() * 0.3, size: 1.4 + Math.random() });
        }
      }
    }
    if (stage === 0) { KH.react = { t0: T, dur: 1.0, face: 'relief', sigh: true }; sfx('whoosh', 0.3); }   // a sigh: back to himself
    else sfx('whoosh', 0.22);                                           // a huff: down to a pout
  }

  // ---------------------------------------------------------------- the angry power-up (the game's)
  // Ahmed's 60-frame sheet, cut down to its effects (the gold aura, the ring, the
  // rocks, the sparks, the blue lightning; behind and in front of him: ../playroom/data/khalfan-emote-angry.js), with
  // the rig standing in the drawn boy's place. He simmers, squeezes, the ring winds up, the gold aura bursts and flashes
  // navy and white, a bolt turns him white, and he floats in blue lightning, still angry, until he is given a coffee: tap
  // the bubble, or drag the finjan from it onto him. On the desktop its light stays round him (never your whole screen),
  // and if no coffee comes he gets over it by himself after a while. KH.rage holds it while it plays.
  const EM = window.KHALFAN_EMOTE_ANGRY || null;
  let EMIMG = null;
  if (EM) { EMIMG = new Image(); EMIMG.src = EM.src; }
  const EM_SEQ = { parts: [[1, 16, 0.11], [17, 42, 0.085], [43, 60, 0.09]], loop: [49, 60, 0.09],
    navy: new Set([24, 30, 40]), white: new Set([27, 36, 37, 42]), gold: [17, 42], blue: 43 };
  const EM_TL = (() => {                                                // (first frame, last, seconds a frame), then back and forth
    const steps = [];
    let t = 0;
    for (const [a, b, d] of EM_SEQ.parts) for (let f = a; f <= b; f++) { steps.push([t, f]); t += d; }
    const [la, lb, ld] = EM_SEQ.loop, seq = [];
    for (let f = la; f <= lb; f++) seq.push(f);
    for (let f = lb - 1; f > la; f--) seq.push(f);
    return { steps, intro: t, seq, ld };
  })();
  const EM_WAIT = 30;                                                   // seconds he waits for his coffee before letting it go
  function playEmote() {
    if (!EM || KH.rage || KH.gone) return false;
    if (KH.mode === 'held' || KH.mode === 'air' || KH.mode === 'hang' || KH.mode === 'wall') { KH.rageOnLand = true; return false; }
    if (KH.mode === 'clip') endClip();
    KH.rage = { key: 'angry', t0: T, frame: 1, ff: 1, last: 0, flash: null, glow: 0, glowCol: null, nextCrackle: 0, acc: 0, hover: 0, out: false,
      awaiting: false, askedT: null, prompt: null, cup: null, served: false, serveT: null, cupFrom: null, sipped: 0, aah: false, hopped: false, gone: false };
    KH.walkTo = null; KH.jump = null; KH.after = null; KH.react = null; KH.sit = null; KH.peek = null; KH.leap = null; KH.reach = null; KH.later = null;
    KH.yawTarget = 0; KH.faceUsAt = 0; KH.lookYaw = null;               // he turns to face us for it
    KH.rageOnLand = false;
    FX.shots.clear();
    audioInit();
    return true;
  }
  function stopEmote() {                                                // over it by himself: out in a puff of smoke, and a sigh
    const E = KH.rage;
    if (!E) return;
    KH.rage = null; KH.anger = 0; KH.angerStage = 0;
    const cx = KH.x, cy = groundY() - 26 - (E.hover || 0);
    for (let j = 0; j < 16; j++) {
      const a = (j / 16) * Math.PI * 2;
      parts.push({ kind: 'smoke', t0: T, x: cx + Math.cos(a) * 12, y: cy + Math.sin(a) * 18, vx: Math.cos(a) * 22, vy: Math.sin(a) * 12 - 14,
        life: 0.8 + Math.random() * 0.3, size: 2.2 + Math.random() * 1.2, ph: Math.random() * 6 });
    }
    sfx('whoosh', 0.5);
    KH.react = { t0: T, dur: 1.1, face: 'relief', sigh: true };
    BR.next = Math.max(BR.next, T + rnd(2, 4));
  }
  function emoteStep(t, dt) {
    const E = KH.rage, q = EM_SEQ, tl = EM_TL;
    const u = t - E.t0, v = E.served ? t - E.serveT : -1;               // since the coffee
    if (v >= SV.END) {                                                  // himself again, and happy
      KH.rage = null; KH.anger = 0; KH.angerStage = 0;
      KH.react = { t0: t, dur: 1.4, face: 'happy' };
      BR.next = Math.max(BR.next, t + rnd(2, 4));
      return;
    }
    if (E.awaiting && t - E.askedT > EM_WAIT) { stopEmote(); return; }
    if (v >= SV.FLY && !E.out) {                                        // the cup in his hands: the power goes out of him in steam
      E.out = true; E.hover0 = E.hover;
      const cx = KH.x, cy = groundY() - (26 + E.hover);
      for (let j = 0; j < 22; j++) {
        const a = (j / 22) * Math.PI * 2;
        parts.push({ kind: 'steam', t0: T, x: cx + Math.cos(a) * 12, y: cy + Math.sin(a) * 18, vx: Math.cos(a) * 46, vy: Math.sin(a) * 30 - 18,
          life: 0.55 + Math.random() * 0.3, size: 2.2 + Math.random() * 1.4 });
      }
      sfx('whoosh', 0.7); sfx('clink', 0.5);
    }
    let f = tl.steps[0][1];
    if (u < tl.intro) {
      let i = 0;
      for (let j = 0; j < tl.steps.length; j++) { if (tl.steps[j][0] <= u) { f = tl.steps[j][1]; i = j; } else break; }
      const nx = tl.steps[i + 1];
      E.ff = nx && nx[1] === f + 1 ? f + (u - tl.steps[i][0]) / (nx[0] - tl.steps[i][0]) : f;
    } else { f = tl.seq[Math.floor((u - tl.intro) / tl.ld) % tl.seq.length]; E.ff = f; }   // he holds it
    E.frame = f;
    E.awaiting = !E.served && u >= tl.intro + 0.3;
    if (E.awaiting && E.askedT == null) { E.askedT = t; sfx('pop', 0.5); sfx('clink', 0.4); }
    E.flash = E.out ? null : q.navy.has(f) ? 'navy' : q.white.has(f) ? 'white' : null;
    const goldOn = !E.out && f >= q.gold[0] && f <= q.gold[1], blueOn = !E.out && f >= q.blue;
    const calm = v < 0 ? 0 : ss(win(v, SV.FLY, SV.FLY + 1.1));          // the coffee taking effect
    E.glow = lerp(E.glow, (goldOn || blueOn ? 1 : f > 8 ? 0.3 : 0) * (1 - calm), 1 - Math.exp(-dt * 8));
    E.glowCol = f >= q.blue ? [120, 180, 255] : [255, 196, 70];
    if (f !== E.last && !E.out) {                                       // a sound and a jolt as each drawing lands
      if (f <= 16 && f % 3 === 0) sfx('tick', 0.3);
      if (f === 9) sfx('stomp', 0.5);
      if (f === 17) { sfx('whoosh', 0.7); shake(t, 0.6); }
      if (f === 21) { sfx('thud', 0.8); shake(t, 1.0); hitstop(t, 0.05); }
      if (E.flash === 'navy') sfx('blip', 0.3);
      if (E.flash === 'white') sfx('shimmer', 0.25);
      if (f === q.blue && E.last < q.blue) { thunder(); hitstop(t, 0.1); shake(t, 1.4); E.boltT = t; sfx('sparkle', 0.5); }
      E.last = f;
    }
    if (goldOn && Math.random() < dt * 2.5) { shake(t, 0.3); sfx('stomp', 0.25); }
    if (blueOn && t >= E.nextCrackle) {                                 // the lightning crackles; only now and then while he waits
      const hold = u >= tl.intro;
      E.nextCrackle = t + (hold ? 0.9 + Math.random() * 1.2 : 0.12 + Math.random() * 0.2);
      sfx('tick', hold ? 0.12 : 0.3);
    }
    if (E.glow > 0.4) {                                                 // sparks rising off him: gold, then blue
      E.acc += (goldOn ? 22 : 14) * dt;
      while (E.acc >= 1) {
        E.acc -= 1;
        parts.push({ kind: 'ember', t0: T, x: KH.x + (Math.random() * 2 - 1) * 26, y: groundY() - Math.random() * 50,
          vx: (Math.random() * 2 - 1) * 8, vy: -(30 + Math.random() * 40), life: 0.5 + Math.random() * 0.4,
          c: goldOn ? ['G', 'Y', 'W'][Math.floor(Math.random() * 3)] : ['B', 'b', 'W'][Math.floor(Math.random() * 3)], ph: Math.random() * 6 });
      }
    }
    strikeStep(t, E);                                                    // his ultra rage strikes a window
  }
  // his pose and face for each of the sheet's drawings: standing as the drawn boy stands (fists at his sides); in the
  // white form he floats as high as the drawn boy
  const EM_SCREAM = new Set([21, 25, 26, 33, 38, 39]);                 // eyes squeezed shut and roaring, as on the sheet
  function emotePose(p, t) {
    const E = KH.rage, f = E.frame, u = t - E.t0;
    p.blink = 0; p.talk = 0; p.look = 0;
    if (E.out) {                                                        // the coffee: he settles to the ledge and drinks it
      const v = t - E.serveT;
      E.hover = (E.hover0 || 0) * (1 - ss((v - SV.FLY) / 0.3));
      p.y -= E.hover;
      coffeePose(p, t, v);
      return;
    }
    const fist = (x, y) => { p.hlx = -x; p.hly = y; p.hrx = x; p.hry = y; p.hl = p.hr = 'fist'; p.zl = p.zr = 1; };
    const crouch = (c) => { p.y += c; p.fly -= c; p.fry -= c; };
    const tremble = (a) => { p.x += a * Math.sin(t * 53); p.hdy += 0.6 * a * Math.sin(t * 41); };
    E.hover = 0;
    if (f <= 8) {                                                       // simmering: a pout, then clenched teeth
      p.expr = 'angry'; p.mouth = f <= 4 ? 'pout' : 'teeth'; p.eyes = f <= 2 ? 'open' : null;
      fist(9.5, -2.5);
      if (f >= 3) tremble(0.3);
    } else if (f <= 16) {                                               // squeezing: eyes shut tight, shoulders up
      p.expr = 'furious';
      fist(9, -3.4); p.hdy += 0.7; crouch(0.6); tremble(0.5);
    } else if (f <= 20) {                                               // the ring winds up round him, his mouth opens
      p.expr = 'furious'; p.mouth = f >= 19 ? 'bigah' : 'teeth';
      fist(10, -2.4); crouch(0.8); tremble(0.6);
    } else if (f <= 42) {                                               // powered up, roaring
      p.expr = EM_SCREAM.has(f) ? 'furious' : 'angry'; p.mouth = E.flash ? 'teeth' : 'bigah';
      fist(10.5, -2.2); crouch(0.6); p.hdy -= 0.4;
      if (f === 21) { p.sx = 1.06; p.sy = 0.94; }                        // the burst
      tremble(0.45);
    } else {                                                            // the white form: he floats, arms down, a cold glare
      p.expr = 'angry'; p.mouth = 'frown';
      fist(9.6, -2.2); p.flx = -3.4; p.frx = 3.4;
      if (E.whiteT == null) E.whiteT = u;
      E.hover = ((EM && EM.hover[f - 1]) || 6) * ss((u - E.whiteT) / 0.25);
      p.y -= E.hover;
      strikePose(p, t, E);
    }
  }
  // the forms: the whole of him redrawn in one set of colours, by palette key
  const lum = (c) => (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / 255;
  const FORMS = {
    white(k, c) {                                                       // white all over, navy lines, the kumma's pattern in blue
      if (k === 'O' || k === 'E') return [28, 42, 108];
      if (k === 'R' || k === 'r' || k === 'M') return [64, 96, 196];
      if (k === 'H') return [238, 243, 255];                            // his hair white, its curls blue
      if (k === 'h') return [120, 150, 218];
      const w = ss((lum(c) - 0.2) / 0.55);
      return [Math.round(182 + 73 * w), Math.round(204 + 51 * w), Math.round(246 + 9 * w)];
    },
    navy(k, c) {                                                        // the navy flash: a navy figure in pale blue lines
      if (k === 'O' || k === 'E') return [156, 192, 255];
      if (k === 'W') return [240, 246, 255];
      return lum(c) > 0.5 ? [36, 46, 112] : [22, 28, 76];
    },
    flash(k, c) {                                                       // the white flash in the gold aura: cream, golden lines
      if (k === 'O' || k === 'E') return [178, 122, 42];
      if (k === 'R' || k === 'r') return [232, 190, 104];
      return lum(c) > 0.5 ? [255, 251, 236] : [246, 230, 186];
    },
  };
  const FORM_LUTS = new Map();
  function formLut(L, form) {
    const key = L.key + '|' + form;
    let F = FORM_LUTS.get(key);
    if (F) return F;
    const lut = new Uint8ClampedArray(L.lut.length);
    R.KEYS.forEach((k, i) => {
      if (!i) return;
      const c = FORMS[form](k, [L.lut[i * 4], L.lut[i * 4 + 1], L.lut[i * 4 + 2]]);
      lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2]; lut[i * 4 + 3] = 255;
    });
    F = { key, lut };
    FORM_LUTS.set(key, F);
    return F;
  }
  function emoteForm(items) {
    const E = KH.rage;
    if (!E || E.out) return items;
    const form = E.frame >= EM_SEQ.blue ? 'white' : E.flash === 'navy' ? 'navy' : E.flash === 'white' ? 'flash' : null;
    return form ? items.map((it) => Object.assign({}, it, { L: formLut(it.L || baseLut(), form) })) : items;
  }
  function drawEmoteFx(C, front) {                                      // this drawing's effects, round his feet on his ledge
    const E = KH.rage;
    if (!E || E.out || !EMIMG || !EMIMG.complete) return;
    const m = EM, k = (E.frame - 1) * m.per + (front ? 1 : 0), c = k % m.cols, r = Math.floor(k / m.cols);
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    g.imageSmoothingEnabled = false;
    g.drawImage(EMIMG, c * m.tw, r * m.th, m.tw, m.th, KH.x - m.anchor[0], groundY() - m.anchor[1], m.tw, m.th);
  }
  // its light: the air dims and glows round him only, the white flash and the bolt's flash too (never your whole screen)
  function drawEmoteLight(C, t, front) {
    const E = KH.rage, x = KH.x, fy = groundY(), cy = fy - 26;
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    const halo = (r, rgb, a) => {
      const gr = g.createRadialGradient(x, cy, 4, x, cy, r);
      gr.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(x - r, cy - r, r * 2, r * 2);
    };
    if (!front) {
      const dim = E.flash === 'navy' ? 0.32 : 0.1 * E.glow;
      if (dim > 0.01) halo(120, '12,8,30', dim * 1.6);
      if (E.glow > 0.02) {                                              // the glow round him and on his ledge
        const [r0, g0, b0] = E.glowCol, rr = 58;
        g.save(); g.globalCompositeOperation = 'lighter';
        const gr = g.createRadialGradient(x, cy, 2, x, cy, rr);
        gr.addColorStop(0, `rgba(${r0},${g0},${b0},${(0.34 * E.glow).toFixed(3)})`); gr.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
        g.fillStyle = gr; g.fillRect(x - rr, cy - rr, rr * 2, rr * 2);
        const gf = g.createRadialGradient(x, fy, 1, x, fy, 44);
        gf.addColorStop(0, `rgba(${r0},${g0},${b0},${(0.38 * E.glow).toFixed(3)})`); gf.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
        g.fillStyle = gf; g.translate(x, fy); g.scale(1, 0.3); g.translate(-x, -fy); g.fillRect(x - 44, fy - 44, 88, 88);
        g.restore();
      }
      return;
    }
    if (E.flash === 'white') halo(110, '255,250,230', 0.3);
    if (E.boltT != null && t - E.boltT < 0.3) {                         // he turns white: a bolt from high above him onto him
      const age = t - E.boltT, hy = fy - 56;
      if (!E.bolt || t - (E.boltAt || 0) > 0.045) { E.bolt = makeBolt(x + (Math.random() * 2 - 1) * 14, Math.max(-2, hy - 120), x, hy, 7, 5); E.boltAt = t; }
      if (Math.floor(age / 0.04) % 3 !== 2) strokeBolt(E.bolt, '#FFFFFF', 'rgba(140,190,255,0.75)', 2.0);
      halo(115, '220,235,255', 0.85 * Math.exp(-age * 12));
    }
  }


  // ---------------------------------------------------------------- his ultra rage strikes a window
  // In the white form he turns on a
  // window (an Explorer window first, else the one in front; the window he stands on only when it
  // is the only one), raises his hand, and a bolt of his lightning hits it. Main took a picture of it as the power built;
  // at the hit main minimizes the real window (never closes it: it waits in the taskbar, nothing in it lost) and this
  // page burns its picture away where it stood, in the look picked in the tray (app/burn-fx.js). All of it is drawn on
  // a layer over the whole screen (FX).
  // Off with the tray's "Rage burns a window" (S.rageBurns).
  const STRIKE_AT = 4.4, CHARGE = 0.3, BOLT = 0.45;
  const FX = { cv: null, g: null, shots: new Map(), burn: null, on: false };
  function fxLayer() {
    if (FX.cv) return FX.g;
    const c = document.createElement('canvas');
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '4', display: 'none' });
    document.body.appendChild(c);
    FX.cv = c; FX.g = c.getContext('2d');
    return FX.g;
  }
  const dip = (cells) => cells / kDip();
  function strikeTarget(also = () => true) {
    const ok = WD.rects.filter((r) => also(r) && r.normal && !r.fav && r.w > 110 && r.h > 80 && r.x + r.w > 30 && r.x < WD.W - 30 && r.y < WD.floor.y - 30 && r.y + r.h > 20);
    if (!ok.length) return null;
    const rank = (r) => (r.cls === 'CabinetWClass' ? 0 : 50) + r.z + (KH.plat && KH.plat.hwnd === r.hwnd ? 20 : 0);
    return ok.sort((a, b) => rank(a) - rank(b))[0];
  }
  function strikeHand(p, dir) {                                          // his striking hand, in page pixels
    const q = R.full(p), k = dir > 0 ? 'r' : 'l';
    const [hx, hy] = KM.ap(R.mm(R.rootMatrix(q), R.bodyMatrix(q)), q['h' + k + 'x'], q['h' + k + 'y']);
    return [dip(hx), dip(hy)];
  }
  // called from emoteStep: the picture asked for as the white form comes, the strike a moment later, the hit
  function strikeStep(t, E) {
    if (E.out) return;
    if (!E.strikeAsked && E.frame >= EM_SEQ.gold[0] && S.rageBurns !== false) {   // (asked at the gold burst: a first picture can take a second)
      E.strikeAsked = true;
      const tg = strikeTarget();
      if (tg) { E.target = tg; if (desk && desk.rageShot && !REVIEW) desk.rageShot(tg.hwnd); }
    }
    const u = t - E.t0;
    const touched = () => E.touched != null ? strikeTarget((r) => r.hwnd === E.touched && !(E.missed && E.missed.has(r.hwnd))) : null;
    if (E.touched != null && E.touched !== E.touchShot) {                // (its picture asked for at once, so the bolt need not wait)
      E.touchShot = E.touched;
      if (touched() && desk && desk.rageShot && !REVIEW) desk.rageShot(E.touched);
    }
    if (E.target && !E.strike && u >= STRIKE_AT) {
      const tg = touched() || E.target;
      if (tg !== E.target) { E.target = tg; E.touched = null; }
      E.strike = { t0: t, tg, dir: dip(tg.x + tg.w / 2) >= dip(KH.x) ? 1 : -1, hit: false, fired: false };
      sfx('sparkle', 0.4);
    }
    // A grudge: while he is still raging, a window he burned that comes back from the taskbar is struck
    // again, as often as it comes back. A coffee ends it (so does his calming down by himself); each new strike starts
    // his patience for the coffee over.
    // And not only that one: while he rages, every window is his, one at a time: one that was open
    // already, one you open while he is still angry, one that was not there when he got angry. A window whose picture
    // never came is left alone (he would only strike it over and over).
    if (S.rageBurns !== false && u >= STRIKE_AT && (!E.strike || (E.strike.hit && E.strike.done)) && t - (E.lastHitT || -9) > 0.5) {
      const free = (r) => !(E.missed && E.missed.has(r.hwnd)) && !(E.burnedAt && t - (E.burnedAt.get(r.hwnd) ?? -9) < 1.2);   // (one just burned may still be in the last list from main)
      const back = touched() || (E.grudge && WD.rects.find((r) => E.grudge.has(r.hwnd) && free(r))) || strikeTarget(free);
      if (back) {
        if (back.hwnd === E.touched) E.touched = null;
        E.target = back;
        if (desk && desk.rageShot && !REVIEW) desk.rageShot(back.hwnd);
        E.strike = { t0: t, tg: back, dir: dip(back.x + back.w / 2) >= dip(KH.x) ? 1 : -1, hit: false, fired: false, again: true };
        if (E.awaiting) E.askedT = t;
        mark('excl', 0.7); sfx('stomp', 0.4);
      }
    }
    const St = E.strike;
    if (!St || St.hit) return;
    const v = t - St.t0;
    if (v >= CHARGE && !St.fired) { St.fired = true; thunder(); sfx('thud', 0.7); shake(t, 1.0); hitstop(t, 0.06); }
    if (v >= CHARGE + 0.08) {
      const shot = FX.shots.get(St.tg.hwnd);
      if (shot || v > CHARGE + (St.again ? 2.2 : 1.2)) {                // (it waits a moment for the window's picture)
        St.hit = true; St.hitT = t;
        if (shot) {
          startBurn(shot, St.impact || [shot.x + shot.w / 2, shot.y + shot.h / 2]);
          FX.shots.delete(St.tg.hwnd);                                    // (a fresh picture next time it comes back)
          (E.grudge || (E.grudge = new Set())).add(St.tg.hwnd); E.lastHitT = t;
          (E.burnedAt || (E.burnedAt = new Map())).set(St.tg.hwnd, t);
          if (desk && desk.rageBurn && !REVIEW) desk.rageBurn(St.tg.hwnd);
          if (REVIEW && RV.burned) RV.burned(St.tg.hwnd);
          shake(t, 0.8);
        } else (E.missed || (E.missed = new Set())).add(St.tg.hwnd);
        if (!shot) E.lastHitT = t;
      }
    }
  }
  // his pose while he strikes: turned a little toward it, the hand raised at it, open, a kick as the bolt leaves it
  function strikePose(p, t, E) {
    const St = E.strike;
    if (!St) return;
    const v = t - St.t0, a = ss(v / 0.2) * (1 - ss((v - CHARGE - BOLT - 0.15) / 0.35));
    if (a <= 0) return;
    const d = St.dir, k = d > 0 ? 'r' : 'l';
    p['h' + k + 'x'] = lerp(p['h' + k + 'x'], d * 26, a); p['h' + k + 'y'] = lerp(p['h' + k + 'y'], -24, a);
    if (a > 0.3) { p['h' + k] = 'open'; p['z' + k] = 1; }
    p.lean += d * 6 * a; p.yaw = d * 14 * a;
    p.expr = 'furious'; p.mouth = v > CHARGE ? 'bigah' : 'teeth';
    if (v > CHARGE && v < CHARGE + 0.12) p.x -= d * 1.4 * Math.sin((v - CHARGE) / 0.12 * Math.PI);
  }

  // the bolt: a jagged line from his hand to the hit, redrawn every few hundredths of a second, with two branches
  function boltPath(a, b, jag) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(4, Math.round(len / 26));
    const nx = -(b[1] - a[1]) / (len || 1), ny = (b[0] - a[0]) / (len || 1), pts = [a.slice()];
    for (let i = 1; i < n; i++) {
      const f = i / n, j = (Math.random() * 2 - 1) * jag * Math.sin(Math.PI * f) + (Math.random() * 2 - 1) * 3;
      pts.push([a[0] + (b[0] - a[0]) * f + nx * j, a[1] + (b[1] - a[1]) * f + ny * j]);
    }
    pts.push(b.slice());
    return pts;
  }
  function strokeBoltOn(ctx, pts, w) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [col, lw] of [['rgba(110,160,255,.28)', w * 5.5], ['rgba(160,205,255,.6)', w * 2.6], ['#ffffff', w]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    }
  }
  function glowAt(ctx, x, y, r, rgb, a) {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  function drawStrikeBolt(ctx, t) {
    const E = KH.rage, St = E && E.strike;
    if (!St || St.done || !KH.pose) return;
    const v = t - St.t0;
    const hand = strikeHand(KH.pose, St.dir);
    const tg = FX.shots.get(St.tg.hwnd) || { x: dip(St.tg.x), y: dip(St.tg.y), w: dip(St.tg.w), h: dip(St.tg.h) };
    if (!St.impact) St.impact = [clamp(hand[0], tg.x + tg.w * 0.12, tg.x + tg.w * 0.88), clamp(hand[1], tg.y + tg.h * 0.18, tg.y + tg.h * 0.82)];
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    if (v < CHARGE) glowAt(ctx, hand[0], hand[1], 8 + 18 * (v / CHARGE), '150,200,255', 0.55 * (v / CHARGE));   // gathering in his hand
    else if (v < CHARGE + BOLT || !St.hit) {
      if (!St.pts || t - St.ptsT > 0.045) {
        St.pts = boltPath(hand, St.impact, 22); St.ptsT = t;
        St.br = [0, 1].map(() => { const i = 1 + Math.floor(Math.random() * (St.pts.length - 2)), o = St.pts[i], a = Math.atan2(St.impact[1] - hand[1], St.impact[0] - hand[0]) + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5);
          return boltPath(o, [o[0] + Math.cos(a) * (40 + Math.random() * 60), o[1] + Math.sin(a) * (40 + Math.random() * 60)], 10); });
      }
      if (Math.floor((v - CHARGE) / 0.04) % 4 !== 3) {
        for (const b of St.br) strokeBoltOn(ctx, b, 1.2);
        strokeBoltOn(ctx, St.pts, 2.4);
      }
      glowAt(ctx, hand[0], hand[1], 26, '170,210,255', 0.5);
      glowAt(ctx, St.impact[0], St.impact[1], 70, '200,225,255', 0.45);
    } else St.done = true;
    if (St.hitT != null) { const age = t - St.hitT; if (age < 0.5) glowAt(ctx, St.impact[0], St.impact[1], 170, '255,250,235', 0.85 * Math.exp(-age * 7)); }   // the flash of the hit
    ctx.restore();
  }

  // the burn itself is app/burn-fx.js, in four looks: real fire, glass shatter, dust, pixel fire, picked in the
  // tray's "Burn look" (S.rageBurnStyle). Dust is the default.
  function startBurn(shot, impact) {
    const KB = window.KhalfanBurn, St = KH.rage && KH.rage.strike;
    if (!KB) return;
    FX.burn = KB.start(S.rageBurnStyle || 'dust', shot, impact, T, {
      dpr: DPR, cell: 1 / kDip(), dir: St ? St.dir : 1, floor: dip(WD.floor.y),
      audio: AUD.ctx ? { ctx: AUD.ctx, master: AUD.master, on: !!S.sound } : null,
    });
    if (!FX.burn) sfx('whoosh', 0.9);
  }
  function drawBurn(ctx, t) {
    if (FX.burn && !window.KhalfanBurn.draw(ctx, FX.burn, t)) FX.burn = null;
  }
  const fxActive = () => !!((KH.rage && KH.rage.strike && !KH.rage.strike.done) || FX.burn);
  function fxFrame(t) {
    const active = fxActive();
    let ctx = null;
    if (REVIEW) {                                                        // (on a clear layer of its own, as live, then over the stage)
      if (!active) return;
      ctx = fxLayer();
      if (FX.cv.width !== cv.width || FX.cv.height !== cv.height) { FX.cv.width = cv.width; FX.cv.height = cv.height; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, FX.cv.width, FX.cv.height);
    } else {
      if (!active) { if (FX.on) { FX.g.setTransform(1, 0, 0, 1, 0, 0); FX.g.clearRect(0, 0, FX.cv.width, FX.cv.height); FX.cv.style.display = 'none'; FX.on = false; } return; }
      ctx = fxLayer();
      const W = Math.round(innerWidth * DPR), H = Math.round(innerHeight * DPR);
      if (FX.cv.width !== W || FX.cv.height !== H) { FX.cv.width = W; FX.cv.height = H; }
      if (!FX.on) { FX.cv.style.display = 'block'; FX.on = true; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    }
    ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawBurn(ctx, t);
    drawStrikeBolt(ctx, t);
    ctx.restore();
    if (REVIEW) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(FX.cv, 0, 0); g.restore(); }
  }

  // ---------------------------------------------------------------- the coffee that calms him (the game's)
  // a bubble with a steaming finjan pops up over him; drag the cup onto him (or tap the bubble) and it flies to his hands;
  // the power goes out of him in steam, he sips twice with his eyes shut, then "aah", hearts, a happy hop
  const SV = { FLY: 0.3, SIP1: 0.6, SIP2: 1.3, AAH: 1.8, HOP: 2.6, GONE: 3.0, END: 3.5 };
  const brew = () => KH.rage || null;
  function coffeePose(p, t, v) {
    const G0 = brew();
    if (v >= SV.GONE && !G0.gone) { G0.gone = true; const [hx, hy] = KM.ap(R.mm(R.rootMatrix(R.full(p)), R.bodyMatrix(R.full(p))), -9.6, -3.4); floaty('spark', hx, hy - 4, 4); sfx('sparkle', 0.4); }
    // the cup is held at his chest, then up beside his face, tipped to his mouth
    const atMouth = ss(win(v, SV.SIP1 - 0.25, SV.SIP1)) * (1 - ss(win(v, SV.AAH - 0.2, SV.AAH + 0.05)));
    p.hlx = lerp(-9.6, -17.5, atMouth); p.hly = lerp(-3.4, -11.5, atMouth); p.hl = 'open'; p.zl = 1;
    G0.sip = atMouth;
    const tip = bump(v, SV.SIP1, SV.SIP1 + 0.45) + bump(v, SV.SIP2, SV.SIP2 + 0.45);   // he tips his head back to drink
    p.hrot -= 5 * tip; p.hdy -= 0.6 * tip;
    for (const [k, at] of [[1, SV.SIP1], [2, SV.SIP2]]) if (v >= at && G0.sipped < k) { G0.sipped = k; sfx('sip', 0.7); }
    if (v < SV.SIP1 - 0.25) p.expr = 'surprise';                        // a coffee? for me?
    else if (v < SV.AAH) p.expr = 'calm';                               // eyes shut, drinking it in
    else if (v < SV.HOP) {
      p.expr = 'relief';
      if (!G0.aah) {
        G0.aah = true; sfx('heart', 0.45);
        const top = KM.ap(R.rootMatrix(R.full(p)), 0, -50); floaty('heart', top[0], top[1], 3);
      }
      const ex = bump(v, SV.AAH, SV.AAH + 0.6);                         // a long breath out
      p.sy = (p.sy || 1) * (1 - 0.04 * ex); p.hdy += 0.5 * ex;
    } else {
      p.expr = 'happy';
      const hp = bump(v, SV.HOP, SV.HOP + 0.36);
      p.y -= 4 * hp; p.fly -= 1.3 * hp; p.fry -= 1.3 * hp;
      if (!G0.hopped) { G0.hopped = true; sfx('hop', 0.45); }
    }
  }
  // give him the coffee: a tap on the bubble, or the cup dropped on him; dropped anywhere else it floats back
  function giveCoffee(d) {
    const G0 = brew();
    if (!G0 || G0.served) return;
    const c = G0.cup, fy = groundY();
    const onHim = c && Math.abs(c.x - KH.x) < 32 && c.y > fy - 70 - (G0.hover || 0) && c.y < fy + 6;
    if (!d.moved || onHim) {
      G0.served = true; G0.serveT = T; G0.awaiting = false;
      G0.cupFrom = c ? [c.x, c.y] : G0.prompt ? [G0.prompt.x, G0.prompt.cy] : [KH.x, fy - 70];
      G0.cup = null;
      sfx('pop', 0.5);
      BR.touched = T;
    } else if (c) { c.held = false; c.ret = T; c.rx = c.x; c.ry = c.y; sfx('tick', 0.3); }
  }
  // is (x, y) on the coffee bubble?
  function overCoffee(x, y) {
    const B = brew();
    if (!B || !B.awaiting || !B.prompt) return false;
    const P0 = B.prompt;
    return Math.abs(x - P0.x) < P0.w / 2 + 4 && Math.abs(y - P0.y) < P0.h / 2 + 6;
  }
  let FJ = null;
  const finjanSpr = () => FJ || (FJ = R.sprite(R.T.FINJAN, 3.5, 5));
  function drawFinjan(C, x, y, k, t, steam = true) {                    // the cup, its bottom at (x, y), with two curls of steam
    drawItems([{ spr: finjanSpr(), M: KM.mul(KM.T(x, y), KM.S(k, k)) }], C);
    if (!steam) return;
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    const u2 = Math.max(1, Math.round(k / 2)), a0 = g.globalAlpha;
    for (const sd of [-1, 1]) {
      for (let j = 0; j < 5; j++) {
        const yy = y - 5.6 * k - j * 1.5 * u2 - ((t * 6) % 1.5) * u2;
        const xx = x + sd * 1.3 * k + 1.1 * u2 * Math.sin(j * 1.3 + t * 5 + sd);
        g.globalAlpha = a0 * 0.85 * (1 - j / 5);
        g.fillRect(Math.round(xx), Math.round(yy), u2, u2);
      }
    }
    g.globalAlpha = a0;
  }

  function drawCoffee(C, t) {
    const G0 = brew();
    if (!G0) return;
    const fy = groundY(), k = 2;
    const lift = (G0.hover || 0) + 4;                                    // over him as he floats in the power-up
    const hands = [KH.x - 4, fy - 25 - lift];
    if (G0.awaiting) {
      const age = t - G0.askedT;
      // the shared pixel bubble (playroom/js/bubble.js): pops in by steps, bobs a cell, hops when he has waited a while
      const grow = window.KhalfanBubble.grow(age), w = Math.round(22 * grow), h = Math.round(19 * grow);
      const top = KH.pose ? KM.ap(R.rootMatrix(R.full(KH.pose)), 0, -52) : [KH.x, fy - 56 - lift];   // over his kumma
      const tx = Math.round(clamp(top[0], w / 2 + 4, WD.W - w / 2 - 4));
      const hop = age > 3 && ((age - 3) % 1.2) < 0.1 ? 1 : 0;
      const y1 = Math.max(Math.round(top[1]) - 4, h + 3) + Math.round(Math.sin(t * 3)) - hop, y0 = y1 - h + 1, x0 = tx - (w >> 1);
      G0.prompt = { x: tx, y: (y0 + y1) / 2, w, h, cy: y1 - 2 };
      g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
      window.KhalfanBubble.box(g, x0, y0, w, h, 1, { side: 'down', at: tx - x0 });
      if (!G0.cup && grow >= 1) drawFinjan(C, tx, y1 - 2, k, t);
      if (!G0.cup && age > 2.5) {                                       // the hint: a ghost cup slides down to his hands now and then
        const ph2 = ((age - 2.5) % 1.8) / 1.8;
        if (ph2 < 0.7) {
          const f2 = ss(ph2 / 0.7);
          g.globalAlpha = 0.5 * (1 - f2 * f2);
          drawFinjan(C, lerp(tx, hands[0], f2), lerp(y1 - 2, hands[1], f2) - 10 * Math.sin(Math.PI * f2), k * lerp(1, 0.8, f2), t, false);
          g.globalAlpha = 1;
        }
      }
    } else G0.prompt = null;
    if (G0.cup) {                                                       // in your hand, or floating back to the bubble
      const c = G0.cup;
      let cx = c.x, cy = c.y;
      if (!c.held && c.ret != null) {
        const f2 = ss((t - c.ret) / 0.25);
        const P0 = G0.prompt || { x: KH.x, cy: fy - 66 };
        cx = lerp(c.rx, P0.x, f2); cy = lerp(c.ry, P0.cy, f2);
        if (f2 >= 1) G0.cup = null;
      }
      drawFinjan(C, cx, cy, k, t);
    }
    if (G0.served && t - G0.serveT < SV.FLY) {                          // given: it flies to his hands
      const f2 = ss((t - G0.serveT) / SV.FLY);
      drawFinjan(C, lerp(G0.cupFrom[0], hands[0], f2), lerp(G0.cupFrom[1], hands[1], f2) - 10 * Math.sin(Math.PI * f2), k * lerp(1, 0.7, f2), t);
    }
  }
  // the finjan in his left hand while he drinks, a size up so it reads, tipped as he sips
  function drawCupInHand(q, C, t) {
    const B = brew();
    if (!B || !B.out || T - B.serveT < SV.FLY || T - B.serveT >= SV.GONE) return;
    const [hx, hy] = KM.ap(R.mm(R.rootMatrix(q), R.bodyMatrix(q)), q.hlx, q.hly);
    const tilt = 38 * (B.sip || 0), k = 1.6;
    drawItems([{ spr: finjanSpr(), M: KM.mul(KM.mul(KM.T(hx + 0.5, hy + 1.6), KM.R(tilt)), KM.S(k, k)) }], C);
    if ((B.sip || 0) < 0.3) {                                           // steam off it while he holds it at his chest
      g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (let j = 0; j < 4; j++) {
        g.globalAlpha = 0.8 * (1 - j / 4);
        g.fillRect(Math.round(hx + 0.8 * Math.sin(j * 1.4 + t * 5)), Math.round(hy - 6 - j * 1.4 - (t * 6) % 1.4), 1, 1);
      }
      g.globalAlpha = 1;
    }
  }
  function makeBolt(x0, y0, x1, y1, step = 6, jag = 4.5) {
    const pts = [[x0, y0]];
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let i = 1; i < n; i++) {
      const f = i / n;
      pts.push([x0 + (x1 - x0) * f + (Math.random() * 2 - 1) * jag, y0 + (y1 - y0) * f + (Math.random() * 2 - 1) * jag * 0.3]);
    }
    pts.push([x1, y1]);
    return pts.map(([x, y]) => [Math.round(x) + 0.5, Math.round(y) + 0.5]);
  }
  function strokeBolt(pts, core, glow, w) {
    g.lineJoin = 'miter'; g.lineCap = 'square';
    for (const [col, lw] of [[glow, w * 2.6], [core, w]]) {
      g.strokeStyle = col; g.lineWidth = lw;
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    }
  }
  function drawTemperMarks(q, t, level, C) {
    const MR = R.rootMatrix(q);
    const [bx, by] = KM.ap(MR, 0, -14), [hx, hy] = KM.ap(MR, 0, -34);
    const fl = Math.floor(t * 14) % 2;
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    g.fillStyle = 'rgba(46,28,18,0.85)';
    for (const sd of [-1, 1]) for (let k = 0; k < 3; k++) {
      const x = bx + sd * (17 + k * 2.5 + fl), y = by - 6 + k * 3 + (fl ? 1 : 0);
      g.fillRect(Math.round(x), Math.round(y), 1, 4);
    }
    if (level >= 2) {
      g.fillStyle = '#E5322D';
      for (let k = 0; k < 7; k++) {
        const a = -Math.PI * (0.08 + 0.84 * k / 6) + 0.12 * Math.sin(t * 9 + k);
        const r0 = 31 + fl, r1 = r0 + 4;
        for (let r = r0; r <= r1; r += 1) g.fillRect(Math.round(hx + Math.cos(a) * r * 1.15), Math.round(hy + Math.sin(a) * r), 1, 1);
      }
    }
  }
  function thunder() {
    if (!S.sound || !AUD.ctx || !AUD.noise) return;
    const c = AUD.ctx, now = c.currentTime;
    const crack = c.createBufferSource(); crack.buffer = AUD.noise;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = c.createGain();
    cg.gain.setValueAtTime(0.0001, now); cg.gain.exponentialRampToValueAtTime(0.8, now + 0.005); cg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    crack.connect(hp); hp.connect(cg); cg.connect(AUD.master); crack.start(now); crack.stop(now + 0.3);
    const rum = c.createBufferSource(); rum.buffer = AUD.noise; rum.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, now); lp.frequency.exponentialRampToValueAtTime(110, now + 1.6);
    const rg = c.createGain();
    rg.gain.setValueAtTime(0.0001, now); rg.gain.exponentialRampToValueAtTime(0.9, now + 0.03); rg.gain.exponentialRampToValueAtTime(0.001, now + 2.4);
    rum.connect(lp); lp.connect(rg); rg.connect(AUD.master); rum.start(now); rum.stop(now + 2.5);
  }
  function roar(level) {
    if (!AUD.roarG) return;
    const now = AUD.ctx.currentTime;
    AUD.roarG.gain.setTargetAtTime(S.sound ? clamp(level) * 0.4 : 0, now, 0.08);
    AUD.roarF.frequency.setTargetAtTime(420 + 260 * Math.random(), now, 0.05);
  }

  // a speech bubble over his head, in pixels on his grid (playroom/js/bubble.js, the game's too); the angry one has a
  // red rim, red words and a throbbing anger mark, and it trembles a cell
  function drawBubble(headM, C) {
    const B = KH.bubble;
    if (!B) return;
    const u = T - B.t0;
    if (u > B.dur) { KH.bubble = null; return; }
    const KB = window.KhalfanBubble, angry = B.stage === 2, look = angry ? KB.ANGRY : KB.PLAIN;
    const fs = 7.2, grow = KB.grow(u);
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    g.font = `800 ${fs}px Alexandria, "Segoe UI", sans-serif`;
    g.direction = 'rtl';
    const tw = g.measureText(B.text).width;
    const bw = Math.round((Math.ceil(tw) + 8) * grow), bh = Math.round((Math.ceil(fs) + 7) * grow);
    const head = KM.ap(headM, 0, -14), top = KM.ap(headM, 0, -36);   // his face; just over his kumma
    let cx = head[0], cy = top[1] - bh / 2 - 4, tail = 'down';
    if (cy - bh / 2 < 3) {                                               // no room above him: beside his face instead
      tail = head[0] > WD.W / 2 ? 'right' : 'left';
      cx = head[0] + (tail === 'left' ? 1 : -1) * (bw / 2 + 30); cy = head[1];
    }
    cx = clamp(cx, bw / 2 + 4, WD.W - bw / 2 - 4); cy = clamp(cy, bh / 2 + 4, WD.H - bh / 2 - 4);
    const ease = B.px == null ? 1 : 1 - Math.exp(-Math.max(0, T - B.pt) * 7);
    B.px = B.px == null ? cx : lerp(B.px, cx, ease); B.py = B.py == null ? cy : lerp(B.py, cy, ease); B.pt = T;
    const jx = angry ? Math.round(0.7 * Math.sin(T * 53)) : 0, jy = angry ? Math.round(0.7 * Math.sin(T * 41)) : 0;
    const x0 = Math.round(B.px - bw / 2) + jx, y0 = Math.round(B.py - bh / 2) + jy;
    const tl = tail === 'down' ? { side: 'down', at: Math.round(bw / 2 + (head[0] - B.px) * 0.3) } : { side: tail, at: Math.round(bh / 2) + 1 };
    g.save();
    g.globalAlpha = 1 - ss((u - (B.dur - 0.25)) / 0.25);
    KB.box(g, x0, y0, bw, bh, 1, tl, look);
    if (grow >= 1) {
      g.fillStyle = look.text; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(B.text, x0 + bw / 2, y0 + (bh - 1) / 2);
      if (angry) KB.mark(g, x0 + bw - 1, y0, 1, T);
    }
    g.restore();
  }

  // ---------------------------------------------------------------- held: picked up with the mouse, or riding the cursor
  const VS = 0.45;                                                      // desktop cells are bigger than the game room's
  function heldPose(t, dt) {
    const H = KH.held;
    const vx0 = 0 - H.pvx, vy0 = -20 - H.pvy;
    const L = Math.max(6, Math.hypot(vx0, vy0));
    const eq = Math.atan2(vx0, vy0) * 180 / Math.PI;
    let phi = (H.rot - eq) * Math.PI / 180;
    if (clockNow() - (H.pt || 0) > 0.05) { H.vx *= 0.7; H.vy *= 0.7; H.ax = 0; H.ay = 0; }
    const ax = (H.ax || 0) * VS * (H.ride ? 0.35 : 1);
    if (dt > 0) {
      const sub = 4, h = dt / sub, damp = H.ride ? 4.2 : 2.2;            // riding by his kumma: a gentle dangle, not a spin
      for (let k = 0; k < sub; k++) {
        const acc = -(320 / L) * Math.sin(phi) - damp * H.w + (ax / L) * Math.cos(phi) * 0.5;
        H.w += acc * h;
        phi += H.w * h;
      }
      if (H.ride) { if (Math.abs(phi) > 0.9) { phi = Math.sign(phi) * 0.9; H.w *= 0.3; } }
    }
    H.ax = (H.ax || 0) * 0.8; H.ay = (H.ay || 0) * 0.8;
    H.rot = eq + phi * 180 / Math.PI;
    const p = stand(0, 0, 0);
    p.pvx = H.pvx; p.pvy = H.pvy; p.rot = H.rot;
    let tx = mouse.x - H.pvx, ty = mouse.y - H.pvy;
    const fl = WD.floor.y - 2;
    p.x = tx; p.y = ty;
    const low = lowest(p, KUMMA_PTS.concat(FOOT_PTS));
    if (low > fl) ty -= low - fl;
    p.x = clamp(tx, -30, WD.W + 30); p.y = ty;
    const hgt = fl - lowest(p, KUMMA_PTS.concat(FOOT_PTS));
    const hvx = H.vx * VS, hvy = H.vy * VS;
    const E0 = Math.hypot(hvx, hvy) + Math.abs(H.w) * L * 0.6;
    H.energy = lerp(H.energy || 0, E0, 1 - Math.exp(-dt * 5));
    const E = H.energy;
    H.still = E < 28 ? (H.still || 0) + dt : 0;
    const spin = Math.abs(H.w);
    H.spinAcc = Math.max(0, (H.spinAcc || 0) + (spin > 6 ? dt : -dt * 0.5));
    if (!H.ride) addAnger(dt * (clamp((E - 90) / 300) * 0.42 + (spin > 6 ? 0.25 : 0)));
    const u = t - H.t0;
    let want;
    if (H.ride) want = E > 300 ? 'scared' : 'joy';                          // his own idea: it is all fun
    else if (H.spinAcc > 1.6) want = 'dizzy';
    else if (u < 0.45) want = 'surprise';
    else if (E > 340 || (hgt > 140 && E > 140)) want = 'scared';
    else if (E > 75) want = 'joy';
    else if (hgt < 9) want = 'floor';
    else if (hgt > 120) want = 'high';
    else if (H.still > 1.2) want = 'bored';
    else want = 'nervous';
    const mood = settleMood(H, want, t);
    if (!H.ride) {
      if (mood === 'joy') KH.fun += dt;
      else if (mood === 'scared') { KH.fear += dt * 0.4; KH.fun += dt * 0.4; }
      else if (mood === 'dizzy') KH.fun += dt * 0.3;
      else if (mood === 'high') KH.fear += dt * 0.5;
    }
    const tgt = limbTarget(H.ride ? 'ride' : mood === 'surprise' && (H.caught || H.glad) ? 'joy' : mood);
    const mt = t - (H.moodT || H.t0);
    if (H.ride) {                                                          // one hand on his kumma, the other waving, legs kicking
      tgt.hly += 3 * Math.sin(t * 8); tgt.hlx += 2 * Math.sin(t * 8 + 1);
      const k = Math.sin(t * 7);
      tgt.fly += 1.8 * k; tgt.fry -= 1.8 * k;
    } else if (mood === 'joy') {
      const k = Math.sin(t * 9);
      tgt.fly += 1.6 * k; tgt.fry -= 1.6 * k; tgt.hly += 2.2 * Math.sin(t * 7); tgt.hry += 2.2 * Math.sin(t * 7 + 0.6);
    } else if (mood === 'scared' || mood === 'high') {
      const r = mood === 'scared' ? 15 : 9;
      tgt.fly += -1 + 2.2 * Math.sin(t * r); tgt.fry += -1 + 2.2 * Math.sin(t * r + Math.PI);
      tgt.flx += 1.2 * Math.cos(t * r); tgt.frx += 1.2 * Math.cos(t * r + Math.PI);
      if (mood === 'scared') { tgt.hlx += 2.5 * Math.sin(t * 17); tgt.hrx -= 2.5 * Math.sin(t * 17 + 1); }
    } else if (mood === 'floor' && Math.abs(hvx) > 30) {
      H.runPh = (H.runPh || 0) + Math.abs(hvx) * dt / 7;
      const d = Math.sign(hvx);
      tgt.fly -= 2.6 * Math.max(0, Math.sin(H.runPh)); tgt.fry -= 2.6 * Math.max(0, Math.sin(H.runPh + Math.PI));
      tgt.flx += d * 2 * Math.cos(H.runPh); tgt.frx += d * 2 * Math.cos(H.runPh + Math.PI);
      const stp = Math.floor(H.runPh / Math.PI);
      if (stp !== H.runStep) { H.runStep = stp; sfx('step', 0.15); }
    } else if (mood === 'bored') {
      tgt.fry -= 1.6 * Math.max(0, Math.sin(t * 4.2));
    }
    const stg = KH.angerStage;
    if (stg >= 1 && !H.ride) {
      const w = stg >= 2 ? 1 : 0.6;
      tgt.hly += 3.5 * w * Math.sin(t * 15); tgt.hry += 3.5 * w * Math.sin(t * 15 + Math.PI);
      tgt.fly += 2.2 * w * Math.sin(t * 12); tgt.fry -= 2.2 * w * Math.sin(t * 12);
    }
    addPhysics(tgt, H.rot, ax, (H.ay || 0) * VS, hvx, hvy, mood === 'dizzy' ? 2 : 1);
    limbsStep(p, tgt, dt);
    p.hl = p.hr = mood === 'bored' ? 'rest' : 'open';
    p.zl = p.zr = 1;
    if (H.ride) p.hr = 'fist';
    p.fla = clamp(KH.limb.flx[1] * 1.5, -14, 14); p.fra = clamp(KH.limb.frx[1] * 1.5, -14, 14);
    const pop = bump(u, 0, 0.26);
    const st = 0.13 * clamp((E - 60) / 420) + 0.2 * pop;
    p.sy = 1 + st; p.sx = 1 - st * 0.55;
    p.hem = 0.6 + 1.1 * clamp(E / 320);
    p.hrot = clamp(-H.w * 2.6, -12, 12) + (mood === 'bored' ? 6 : 0);
    p.look = Math.abs(hvx) > 40 ? Math.sign(hvx) : 0;
    p.expr = H.ride ? (Math.floor(mt / 0.6) % 2 ? 'yay' : 'laugh') : {
      dizzy: 'dizzy', surprise: H.caught ? 'relief' : H.glad ? 'yay' : 'surprise', scared: 'scared',
      joy: Math.floor(mt / 0.55) % 2 ? 'yay' : 'laugh', floor: Math.abs(hvx) > 30 ? 'laugh' : 'curious', high: 'worried',
      bored: mt > 2.2 ? 'whatever' : 'bored', nervous: 'nervous',
    }[mood];
    if (mood === 'high' && !H.ride) p.eyes = 'lookdown';
    if (stg >= 1 && !H.ride) {
      if (stg >= 2) { p.expr = Math.floor(t / 0.5) % 2 ? 'furious' : 'angry'; p.mouth = 'bigah'; }
      else { p.expr = 'angry'; p.mouth = 'puff'; }
      p.eyes = null;
      p.hl = p.hr = 'fist';
    }
    H.dizzy = mood === 'dizzy' && stg < 1 && !H.ride;
    whistle(clamp((E - 90) / 320) * 0.9, 480 + hgt * 3 + clamp(-hvy, -300, 300) * 0.6);
    return p;
  }

  // ---------------------------------------------------------------- air: thrown, falling, or a jump he meant
  const GRAV = 520;
  // what he lands on: the highest ledge under him. A jump aimed at one file lands on that file only (not on the files
  // above it in the same column), and a hop down off a file falls through it
  function supportBelow(x, yFrom, only, skip) {
    let best = WD.floor;
    for (const Q of WD.plats) {
      if (Q === WD.floor || Q === skip || (only && Q.kind === 'icon' && Q !== only)) continue;
      if (x >= Q.x0 + 2 && x <= Q.x1 - 2 && Q.y >= yFrom - 1 && Q.y < best.y) best = Q;
    }
    return best;
  }
  function startAir(o) {
    KH.air = Object.assign({ rot: 0, w: 0, t0: T, vx: 0, vy: 0, canCatch: true, bounces: 0 }, o);
    KH.mode = 'air'; KH.held = null; KH.hang = null; KH.sit = null; KH.sitW = 0; KH.peek = null; KH.sink = 0; KH.leap = null; KH.jump = null;
    KH.walkTo = null;
    if (KH.clip) { KH.clip = null; }
    KH.plat = WD.floor; trackPlat(); lastTr = null;
    KH.air.lowPrev = o.y;
    KH.air.ygPrev = o.y - 46;
    if (o.leap) Object.assign(KH.air, { exact: true, tau: 0, x0: o.x, y0: o.y, vy0: o.vy });
  }
  function airPose(t, dt) {
    const A = KH.air;
    if (dt > 0) {
      if (A.exact) {                                                      // a jump he planned: the exact arc, so he lands where he aimed
        A.tau += dt;
        A.x = A.x0 + A.vx * A.tau; A.y = A.y0 + A.vy0 * A.tau + 0.5 * GRAV * A.tau * A.tau; A.vy = A.vy0 + GRAV * A.tau;
      } else {
        const apex = A.leap ? 0 : Math.exp(-((A.vy / 70) ** 2));
        A.vy += GRAV * (1 - 0.55 * apex) * dt;
        A.x += A.vx * dt; A.y += A.vy * dt;
      }
      if (A.trick) {
        A.rot = A.trick.rot0 + A.trick.dir * 360 * easeIO(clamp((t - A.trick.t0) / A.trick.dur));
        A.w = 0;
      } else {
        const target = Math.round(A.rot / 360) * 360;
        A.w += (-(A.rot - target) * 26 - A.w * 5.5) * dt;
        A.rot += A.w * dt;
      }
      const sp = Math.abs(A.vx);
      if (A.x < 10 || A.x > WD.W - 10) {
        A.exact = false;
        A.vx = -A.vx * 0.45; A.x = clamp(A.x, 10, WD.W - 10);
        if (sp > 300) bonk(t, A, 'side', sp); else sfx('thud', 0.3);
      }
      const RMa = A.room ? WD.rooms.get(A.room) : null;
      if (A.room && !RMa) A.room = null;                                  // the window went while he was falling in it
      if (RMa) {                                                          // in a room: its sides and its title bar
        const lx = RMa.x0 + 10, hx = RMa.x1 - 10;
        if (A.x < lx || A.x > hx) {
          A.exact = false;
          A.vx = -A.vx * 0.45; A.x = clamp(A.x, lx, hx);
          if (sp > 300) bonk(t, A, 'side', sp); else sfx('thud', 0.3);
        }
        if (A.y - 52 < RMa.top && A.vy < 0) {
          const s2 = Math.abs(A.vy);
          A.vy = s2 * 0.3; A.y = RMa.top + 52;
          if (s2 > 250) bonk(t, A, 'top', s2);
        }
      }
      if (A.y - 52 < 4 && A.vy < 0) {
        // the top of the screen, reached gently: he grabs it like a monkey bar instead of bonking it
        if (A.canCatch && !A.trick && Math.abs(A.vy) < 560 && Math.abs(A.vx) < 520 && WD.bar) { startHang(WD.bar, A, t); return hangPose(t, 0); }
        const s2 = Math.abs(A.vy);
        A.vy = s2 * 0.3; A.y = 4 + 52;
        if (s2 > 250) bonk(t, A, 'top', s2);
      }
    }
    const p = stand(0, A.x, A.y);
    p.pvx = 0; p.pvy = -20; p.rot = A.rot;
    const speed = Math.hypot(A.vx, A.vy);
    const tuck = A.trick && (t - A.trick.t0) / A.trick.dur < 0.82;
    const base = tuck ? 'tuck' : A.leap ? 'leap' : (A.fall && A.vy > 60) ? 'fall' : 'air';
    const tgt = limbTarget(base);
    if (A.leap && A.vx < 0) { const tl = tgt.hlx, tly = tgt.hly; tgt.hlx = -tgt.hrx; tgt.hly = tgt.hry; tgt.hrx = -tl; tgt.hry = tly; }
    addPhysics(tgt, A.rot, 0, 0, A.vx * VS, A.vy * VS, tuck ? 0 : 1);
    if ((!A.trick && A.hard) || (A.fall && A.vy > 60)) {
      tgt.hlx += 2.5 * Math.sin(t * 17); tgt.hrx -= 2.5 * Math.sin(t * 17 + 1);
      tgt.fly += 1.5 * Math.sin(t * 15); tgt.fry -= 1.5 * Math.sin(t * 15);
    }
    limbsStep(p, tgt, dt, 200, 13);
    p.hl = p.hr = 'open'; p.zl = p.zr = 1;
    p.hem = 0.8 + 0.9 * clamp(speed / 500);
    if (A.leap) { p.yaw = clamp(A.vx * 0.12, -35, 35); [p.zl, p.zr] = [1, 1]; }
    const a = A.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const bvx = c * A.vx + s * A.vy, bvy = -s * A.vx + c * A.vy;
    const e = 0.14 * clamp((speed - 160) / 520);
    const ex = e * Math.abs(bvx) / (speed + 1e-6), ey = e * Math.abs(bvy) / (speed + 1e-6);
    p.sx = 1 + ex - ey * 0.5; p.sy = 1 + ey - ex * 0.5;
    if (A.bonkT != null) {
      const b = bump(t - A.bonkT, 0, 0.2);
      if (A.bonkSide === 'side') { p.sx *= 1 - 0.32 * b; p.sy *= 1 + 0.16 * b; } else { p.sy *= 1 - 0.3 * b; p.sx *= 1 + 0.16 * b; }
    }
    if (A.bounceT != null) { const b = bump(t - A.bounceT, 0, 0.16); p.sy *= 1 - 0.26 * b; p.sx *= 1 + 0.2 * b; }
    p.expr = A.trick ? ((t - A.trick.t0) / A.trick.dur < 0.6 ? 'determined' : 'happy')
      : A.bonkT != null && t - A.bonkT < 0.7 ? 'dizzy'
      : A.leap ? (A.vy < 0 ? 'determined' : 'yay')
      : A.fall ? (A.vy > 120 ? 'scared' : 'surprise')
      : A.hard ? 'scared' : (A.vy < -40 ? 'yay' : 'surprise');
    if (!A.self) { if (A.hard) KH.fear += dt; else if (!A.trick) KH.fun += dt * 0.8; }
    if (!A.self) whistle(clamp((speed - 160) / 400), 640 - A.vy * 0.8);
    // catching a ledge on the way: rising up past its edge, or falling past its corner
    const yg = A.y - 46;
    if (A.canCatch && dt > 0 && !A.trick && WD.bar && yg < 14 && Math.abs(A.vy) < 90 && Math.abs(A.vx) < 520 && t - A.t0 > 0.2) { startHang(WD.bar, A, t); return hangPose(t, 0); }
    if (A.canCatch && dt > 0 && t - A.t0 > 0.1 && !A.trick) {
      for (const Q of WD.plats) {
        if (Q === WD.floor) continue;
        const inside = A.x >= Q.x0 - 3 && A.x <= Q.x1 + 3;
        const nearEnd = !inside && ((A.x > Q.x1 && A.x < Q.x1 + 18) || (A.x < Q.x0 && A.x > Q.x0 - 18));
        const crossUp = A.vy < 0 && A.vy > -460 && A.ygPrev > Q.y && yg <= Q.y;
        const crossDown = A.vy > 0 && A.ygPrev < Q.y && yg >= Q.y;
        const atApex = Math.abs(A.vy) < 90 && yg - Q.y > -2 && yg - Q.y < 5;   // topping out a hand's width short: still a grab
        if (((crossUp || atApex) && inside) || (crossDown && nearEnd)) {
          if (Math.abs(A.vx) < 700 && Math.abs(A.vy) < 800 && Math.random() < 0.88) { startHang(Q, A, t); return hangPose(t, 0); }
        }
      }
    }
    A.ygPrev = yg;
    // touching down on whatever is under him
    const lowF = lowest(p, FOOT_PTS), lowK = lowest(p, KUMMA_PTS);
    const RMs = A.room ? WD.rooms.get(A.room) : null;
    const Q = RMs && RMs.y >= A.lowPrev - 1 ? RMs : supportBelow(A.x, A.lowPrev, A.only, A.skip);
    A.lowPrev = Math.max(lowF, lowK);
    const fy = Q.y;
    if (Math.max(lowF, lowK) >= fy && A.vy > 0) {
      const over = Math.max(lowF, lowK) - fy;
      const impact = A.vy;
      const upright = Math.abs(wrapd(A.rot)) < 50 && lowK < fy - 4;
      const bounceAt = A.self ? 1e9 : 380;
      if ((impact > bounceAt && A.bounces < 2) || !upright) {
        A.y -= over;
        A.exact = false;
        A.vy = -Math.max(upright ? 0 : 150, impact * 0.34);
        A.vx *= 0.6;
        A.bounces++;
        A.bounceT = t;
        A.lowPrev = fy - 1;
        if (!upright && !A.trick) A.w += (wrapd(A.rot) > 0 ? -1 : 1) * 260;    // rolls back onto his feet: the kumma never touches down
        sfx('boing', clamp(impact / 600, 0.3, 0.8)); puff(p.x, fy, 5, 0.8);
        if (impact > 600) { hitstop(t, 0.05); shake(t, 0.8); }
        return p;
      }
      A.y -= over;
      return land(t, dt, p, A, impact, Q);
    }
    if (A.y > WD.H + 120) { respawn(); return freePose(t, dt); }
    return p;
  }
  function land(t, dt, p, A, impact, Q) {
    const fy = Q.y;
    KH.mode = 'free'; KH.air = null;
    KH.plat = Q; trackPlat(); lastTr = null;
    KH.x = clamp(A.x, qlo(Q), qhi(Q));
    KH.yaw = 0; KH.yawTarget = 0; KH.speed = 0;
    KH.landT = t;
    const hardSelf = clamp((impact - 300) / 500);
    if (KH.rageOnLand) {
      KH.rageOnLand = false; KH.fun = 0; KH.fear = 0; KH.limb = null; KH.after = null;
      KH.landHard = 0.8; sfx('land', 0.8); puff(KH.x, fy, 8, 1.2);
      KH.blend = { from: Object.assign({}, p, { y: fy, rot: wrapd(A.rot), pvx: 0, pvy: -20, sx: 1, sy: 1 }), t0: t, dur: 0.18 };
      blowUp();
      return freePose(t, dt);
    }
    KH.after = null;
    if (A.self) {                                                         // his own jump or fall: a cushioned landing
      KH.landHard = 0.45 + 0.9 * hardSelf;
      sfx('land', 0.4 + 0.4 * hardSelf); puff(KH.x, fy, 5 + Math.round(6 * hardSelf), 0.8 + hardSelf);
      if (A.fall && hardSelf > 0.4) KH.react = { t0: t + 0.2, dur: 1.0, face: 'relief' };
      else if (A.leap) KH.react = { t0: t + 0.15, dur: 0.6, face: 'proud' };
      if (KH.sayOnLand) { const s = KH.sayOnLand; KH.sayOnLand = null; setTimeout(() => say(s), 250); }
    } else {
      const hard = clamp((impact - 300) / 500);
      KH.landHard = 0.5 + hard;
      const rough = hard > 0.6 || A.hard || A.sideBonk;
      if (A.trick && !rough) {
        KH.after = { kind: 'tada', t0: t, dur: 1.4 };
        sfx('land', 0.6); sfx('tada', 0.5); puff(KH.x, fy, 6); floaty('spark', KH.x, fy - 48, 5);
        KH.fun += 1.5;
      } else if (rough) {
        KH.dizzyUntil = t + 1.2 + hard; sfx('thud', 0.8); puff(KH.x, fy, 10, 1.4); floaty('star', KH.x, fy - 50, 2);
        addAnger(0.3);
        hitstop(t, 0.07); shake(t, 1.2);
      } else {
        sfx('land', 0.7); puff(KH.x, fy, 6);
        if (A.dizzy) KH.dizzyUntil = t + 1.3;
      }
      if (!KH.after) {
        if (rough || KH.fear > KH.fun + 0.5) KH.after = { kind: 'grumpy', t0: t + (rough ? 1.2 + hard : 0.2), dur: 5 };
        else if (KH.fun > 0.35) KH.after = { kind: 'again', t0: Math.max(t, KH.dizzyUntil), dur: 7 };
      }
      BR.touched = t;
    }
    if (Q.kind === 'room') {                                              // dropped into a window: a look round his new room
      KH.roomSince = t; KH.roomNew = true; KH.roomStay = null;
      if (!KH.after && !A.hard && t >= KH.dizzyUntil) { KH.react = { t0: t + 0.25, dur: 1.1, face: 'curious' }; KH.lookYaw = { yaw: pick([-20, 20]), until: t + 1.2 }; }
    }
    KH.fun = 0; KH.fear = 0;
    KH.limb = null;
    whistle(0, 500);
    if (A.thenLand) KH.pendingThen = A.thenLand;
    KH.blend = { from: Object.assign({}, p, { y: fy, rot: wrapd(A.rot), pvx: 0, pvy: -20, sx: 1, sy: 1 }), t0: t, dur: 0.18 };
    BR.next = Math.max(BR.next, t + rnd(1.5, 3));
    return freePose(t, dt);
  }
  // after a ride: a ta-da, "again!" with his arms up for you, or a sulk with his back half turned
  function afterPose(p, t) {
    const AF = KH.after;
    if (!AF) return;
    const u = t - AF.t0;
    const near = mouse.in && Math.abs(mouse.x - KH.x) < 46 && mouse.y > groundY() - 95 && mouse.y < groundY() + 10;
    if (u > AF.dur) { KH.after = AF.kind === 'tada' && near ? { kind: 'again', t0: t - 0.9, dur: 6 } : null; return; }
    if (u < 0) return;
    const armsUp = (f, wave) => {
      p.hlx = lerp(p.hlx, -28, f); p.hly = lerp(p.hly, -25, f); p.hrx = lerp(p.hrx, 28, f); p.hry = lerp(p.hry, -25, f);
      if (f > 0.5) { p.hl = p.hr = 'open'; p.zl = p.zr = 1; }
      if (wave) { p.hla = 12 * Math.sin(t * 12) * f; p.hra = -12 * Math.sin(t * 12 + 0.8) * f; }
    };
    if (AF.kind === 'tada') {
      armsUp(ss(win(u, 0.02, 0.16)) * (1 - ss(win(u, AF.dur - 0.25, AF.dur))), false);
      const hp = bump(u, 0.06, 0.36);
      p.y -= 3 * hp; p.fly -= hp; p.fry -= hp;
      p.expr = u < 0.9 ? 'triumph' : 'proud';
    } else if (AF.kind === 'again') {
      if (u < 0.9) {
        const hp = bump(u, 0.05, 0.38) + bump(u, 0.46, 0.8);
        p.y -= 3.5 * hp; p.fly -= 1.2 * hp; p.fry -= 1.2 * hp;
        armsUp(ss(win(u, 0, 0.12)), true);
        p.expr = 'yay';
        if (!AF.hop1 && u > 0.05) { AF.hop1 = true; sfx('hop', 0.3); }
        if (!AF.hop2 && u > 0.46) { AF.hop2 = true; sfx('hop', 0.3); }
      } else if (near) {
        armsUp(1, false);
        const bo = Math.max(0, Math.sin(t * 10));
        p.y -= 1.4 * bo; p.fly -= 0.6 * bo; p.fry -= 0.6 * bo;
        p.look = mouse.x > KH.x ? 1 : -1;
        p.expr = Math.floor(t * 2.2) % 3 ? 'grin' : 'yay';
        AF.dur = Math.max(AF.dur, u + 1.5);
      } else p.expr = 'happy';
    } else if (AF.kind === 'grumpy') {
      if (!AF.stomped) { AF.stomped = true; sfx('stomp', 0.5); }
      p.hlx = -3.6; p.hly = -7.6; p.hrx = 3.6; p.hry = -7.0; p.hl = p.hr = 'rest'; p.zl = p.zr = 1;
      p.expr = u < 1.2 ? 'huff' : 'sideeye';
      AF.turn = near && u < AF.dur - 0.3 ? (mouse.x > KH.x ? -32 : 32) : 0;
    }
  }

  // ---------------------------------------------------------------- hanging from a window's top edge
  function startHang(Q, A, t) {
    const hx = clamp(A.x, Q.x0 + 4, Q.x1 - 4);
    const user = !A.self;
    const meant = !!A.leap;                                               // a jump that aimed for the edge: straight up and over
    const bar = Q.kind === 'bar';                                         // the top of the screen: nothing to climb onto, he drops
    KH.hang = { P: Q, hx, t0: t, ang: clamp(wrapd(A.rot) + A.vx * 0.04, -40, 40), w: clamp(A.vx / 60, -3, 3),
      dur: bar ? rnd(1.8, 3.4) : meant ? rnd(0.5, 0.9) : user ? rnd(1.6, 3.2) : rnd(1.4, 2.6), user, then: A.thenLand,
      next: bar ? 'drop' : user || meant ? 'climb' : (Math.random() < 0.75 ? 'climb' : 'drop'),
      travel: bar ? (A.x < WD.W / 2 ? 1 : -1) : 0, rear: rearLedge(Q) };
    KH.mode = 'hang'; KH.air = null;
    KH.plat = Q; trackPlat(); lastTr = null;
    KH.limb = null;
    sfx('grab', 0.7);
    if (user) { KH.fun += 0.6; BR.touched = t; }
    KH.blend = KH.pose ? { from: KH.pose, t0: t, dur: KH.hang.rear ? 0.18 : 0.08 } : null;
    whistle(0, 500);
  }
  // he hangs off this end of the ledge on purpose (to climb down)
  function hangOff(Q, side, t) {
    const x = side > 0 ? Q.x1 - 2 : Q.x0 + 2;
    KH.hang = { P: Q, hx: x, t0: t, ang: side * 8, w: side * 1.5, dur: rnd(1.2, 2.4), user: false, next: Math.random() < 0.7 ? 'drop' : 'climb', self: true, rear: rearLedge(Q) };
    KH.mode = 'hang'; KH.sit = null; KH.sitW = 0;
    KH.limb = null;
    KH.blend = KH.pose ? { from: KH.pose, t0: t, dur: 0.35 } : null;
    sfx('scuff', 0.3);
  }
  // ---------------------------------------------------------------- the hang on a window's edge
  // From behind, both hands on the edge beside his head (no arms), he swings like a pendulum
  // from his hands (his dishdasha trailing, his body leaning into it, a little pump at the bottom to keep it going);
  // to get up he pulls himself up, springs off his hands, turns round in the air and lands on the edge facing us, a
  // squash and a puff. (The taskbar keeps the chin-up, the top of the screen the monkey bars, files the old hang.)
  const rearLedge = (Q) => !!(Q && (Q.kind === 'window' || Q.kind === 'fav'));
  const RG = { HY: -37, HX: 26 };                                      // his hands on the edge, in his frame: by his kumma, either side
  const RC = { PULL: 0.24, LAND: 0.82, SETTLE: 1.05 };                 // the getting up: the pull, the jump and turn, the landing
  const RS = { CYCLE: 1.95, TRIES: 2, HEAVE: 0.3, PADDLE: 2.2, SWAY: 2, SWAYT: 1.9 };   // the struggle: its cycle, the tries that fail, when he heaves, the kicking, the slow sway (deg, s)
  function rearHangPose(t, dt) {
    const Hg = KH.hang, Q = Hg.P;
    Hg.hx = clamp(Hg.hx, 30, WD.W - 30);
    const c = Hg.climbT != null ? t - Hg.climbT : -1;
    // the swing is only what his struggling (or a fling) gives it, and it settles fast ("don't make it swing like he is
    // in the wind"); it dies as he pulls up
    if (!Hg.grips) Hg.grips = { l: [Hg.hx + RG.HX, Q.y + 0.5], r: [Hg.hx - RG.HX, Q.y + 0.5] };   // his hands' places on the edge
    // about 5 s from catching the edge to standing: two tries that fail and
    // the third gets him up, so a hang that lasts more than a quick pull lasts exactly RS.TRIES cycles
    if (!Hg.fit) { Hg.fit = true; if (Hg.dur > 0.5) Hg.dur = RS.TRIES * RS.CYCLE; }
    // the struggle is one smooth cycle (RS): a beat hanging, heave up with his feet kicking, hold, sink back with a
    // little bounce; a drop of sweat as he sinks. The struggle
    // sound, without a voice.
    const u = t - Hg.t0, cyc = u % RS.CYCLE, nTry = Math.floor((u - RS.HEAVE) / RS.CYCLE);
    if (c < 0 && dt > 0 && u >= RS.HEAVE && nTry !== Hg.cyc) { Hg.cyc = nTry; Hg.sweatAt = t + 0.7; }
    if (Hg.sweatAt && t >= Hg.sweatAt) { Hg.sweatAt = 0; rhSweat(Hg, t); }
    let phi = Hg.ang * Math.PI / 180;
    if (dt > 0) {
      const sub = 4, h = dt / sub;
      for (let k = 0; k < sub; k++) {
        const acc = -(GRAV / 30) * Math.sin(phi) - (c >= 0 ? 9 : 2.6) * Hg.w;
        Hg.w += acc * h; phi += Hg.w * h;
      }
    }
    Hg.ang = phi * 180 / Math.PI;
    let drop = false;
    if (c < 0 && dt > 0 && t - Hg.t0 > Hg.dur && !REVIEW_HOLD.hang) {
      if (Hg.next === 'climb') { Hg.climbT = t; Hg.sweatAt = 0; sfx('grab', 0.35); } else drop = true;
    }
    if (c < RC.PULL) {
      // hanging (and pulling up): from behind, turning about the middle of his hands
      const up = c >= 0 ? ss(c / RC.PULL) : 0;
      const p = stand(180, 0, 0);
      // the effort: up in 0.3 s, held, down by 0.95 s, a little dip and back (eased all the way: no shakes)
      const ce = cyc - RS.HEAVE;
      const effort = (ss(ce / 0.3) * (1 - ss((ce - 0.55) / 0.4)) - 0.18 * bump(ce, 0.95, 1.35)) * (1 - up);
      const upY = c >= 0 ? Math.pow(clamp(c / RC.PULL), 3) : 0;         // (faster and faster: it ends at the jump's speed)
      const hy = RG.HY + 4 * effort + 16 * upY;                          // (pulling: his body rises toward his hands)
      p.hlx = RG.HX; p.hly = hy + 4; p.hrx = -RG.HX; p.hry = hy + 4; p.hl = p.hr = 'rest'; p.zl = p.zr = 2;   // (body frame: 4 below his root's)
      // the struggle, smooth (like the ledge hangs of games and cartoons):
      // in the effort his feet kick in even strokes below his hem, one then the other, toes swinging (lifted only a
      // little: higher, his dishdasha hides them); at rest they hang and trail a beat behind his slow sway; a soft
      // breath; his head tips up as he pulls
      const ef = Math.max(0, effort), rest = (1 - ef) * (1 - up), ph = u * Math.PI * 2 * RS.PADDLE;
      const sway = RS.SWAY * Math.sin(u * Math.PI * 2 / RS.SWAYT) * (1 - up), lag = RS.SWAY * Math.sin(u * Math.PI * 2 / RS.SWAYT - 0.9);
      Hg.env = ef;
      p.flx += 1.8 * Math.cos(ph) * ef - 0.35 * lag * rest; p.frx += 1.8 * Math.cos(ph + Math.PI) * ef - 0.35 * lag * rest;
      p.fly -= 0.9 * (0.5 + 0.5 * Math.sin(ph)) * ef; p.fry -= 0.9 * (0.5 + 0.5 * Math.sin(ph + Math.PI)) * ef;
      p.fla = 14 * Math.sin(ph) * ef; p.fra = 14 * Math.sin(ph + Math.PI) * ef;
      p.hem = 0.2 + 0.6 * ef;
      p.lean = clamp(-Hg.w * 4, -6, 6) - 0.6 * lag * rest + 1.2 * Math.sin(ph) * ef;
      p.hrot = -3 * ef + 0.5 * lag;
      p.sy = 1 + 0.05 * up + 0.02 * ef + 0.012 * Math.sin(u * Math.PI * 2 / 2.2) * rest;
      p.expr = 'effort';
      p.pvx = 0; p.pvy = hy; p.rot = Hg.ang * (1 - up) + sway + 0.8 * Math.sin(ph) * ef;
      p.x = Hg.hx; p.y = Q.y - hy;
      return drop ? dropFromHang(t, p, Hg) : p;
    }
    // the jump: off his hands, up in an arc, turning round in the air, and down onto the edge facing us
    const y0 = Q.y - (RG.HY + 16), sj = clamp((c - RC.PULL) / (RC.LAND - RC.PULL));
    if (!Hg.hopped) { Hg.hopped = true; sfx('hop', 0.45); }
    const yaw = 180 * (1 - ss((sj - 0.1) / 0.75));
    const p = stand(yaw, 0, 0);
    p.x = Hg.hx;
    if (c < RC.LAND) {
      p.y = lerp(y0, Q.y, sj) - 24 * 4 * sj * (1 - sj);
      const tuck = bump(sj, 0.1, 0.9);
      p.fly -= 2.5 * tuck; p.fry -= 2.5 * tuck; p.hem = 0.6 * tuck;
      p.hly -= 5 * bump(sj, 0, 0.4); p.hry -= 5 * bump(sj, 0, 0.4);  // (pushing off, then his hands out for the landing)
      p.sy = 1 + 0.06 * bump(sj, 0, 0.5); p.sx = 1 - 0.04 * bump(sj, 0, 0.5);
      p.expr = sj < 0.6 ? 'determined' : 'happy';
      return p;
    }
    // landed: a squash, a puff, a settle
    if (!Hg.landed) { Hg.landed = true; sfx('scuff', 0.45); puff(Hg.hx, Q.y, 7, 1); }
    const v = (c - RC.LAND) / (RC.SETTLE - RC.LAND);
    p.y = Q.y; p.sy = 1 - 0.15 * (1 - ss(v)) + 0.03 * bump(v, 0.5, 1); p.sx = 1 + 0.08 * (1 - ss(v));
    p.expr = 'happy';
    if (v >= 1) return finishClimb(t, p, Q, Hg);
    return p;
  }
  // a review film's sound track: its listed sounds played into an offline context: review/film/<name>.wav
  // (t0: the film's first frame)
  async function filmSound(name, ev, t0, dur) {
    const sr = 44100, keep = AUD.buf;
    const ac = new OfflineAudioContext(1, Math.ceil(sr * dur), sr), m = ac.createGain();
    m.gain.value = 0.32; m.connect(ac.destination);
    AUD.buf = {};
    for (const [k, [peak, b64]] of Object.entries(D.sounds)) {
      try { AUD.buf[k] = await ac.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer); AUD.peak[k] = peak; } catch (e) { /* (a sound that will not decode is left out) */ }
    }
    for (const [te, what, ...a] of ev) {
      AUD.out = { ac, dest: m, at: Math.max(0, te - t0) };
      if (what === 'sfx') sfx(...a);
    }
    AUD.out = null;
    desk.reviewFile(name + '.wav', wavURL(await ac.startRendering()));
    AUD.buf = keep;
  }
  function wavURL(b) {                                                 // mono 16-bit WAV, raised to a peak of 0.7 (a preview)
    const d = b.getChannelData(0), n = d.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    let pk = 1e-6;
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i]));
    const k = 0.7 / pk;
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, b.sampleRate, true); v.setUint32(28, b.sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, clamp(d[i] * k, -1, 1) * 32767, true);
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return 'data:audio/wav;base64,' + btoa(s);
  }
  function rhSweat(Hg, t) {                                            // a few drops flying off his head
    const p = KH.pose;
    if (!p) return;
    const [cx, cy] = KM.ap(R.rootMatrix(R.full(p)), 0, -30);
    const sd = -1;                                                     // (on his left: the worry lines are on his right)
    parts.push({ kind: 'sweatfly', t0: t, x: cx + sd * 18, y: cy - 8, vx: sd * 10, vy: -12, life: 0.75 });
  }
  const RHM = {};
  // the three worry lines of cartoons and anime, fanning
  // out from the top corner of his kumma on his right while he hangs: they fade in as he catches the edge, step one
  // cell further out while he heaves (and back), and go as he climbs. Still, never shaking.
  const worrySpr = () => RHM.worry || (RHM.worry = (() => {          // three ink strokes (O) fanning out, the kumma's corner at the middle
    const n = 12, rows = Array.from({ length: n }, () => Array(n).fill('.'));
    for (const a of [75, 40, 5]) for (let r = 4; r <= 10.5; r += 0.25) rows[n - 1 - Math.round(r * Math.sin(a * Math.PI / 180))][Math.round(r * Math.cos(a * Math.PI / 180))] = 'O';
    return R.sprite(rows.map((r) => r.join('')), 0, n);
  })());
  const KCORN = new Map();
  function kummaCorner(spr) {                                          // the top of the kumma's rightmost column, in its frame
    if (KCORN.has(spr.id)) return KCORN.get(spr.id);
    let c = null;
    for (let x = spr.w - 1; x >= 0 && !c; x--) for (let y = 0; y < spr.h; y++) if (spr.a[y * spr.w + x]) { c = [x + 1 - spr.ox, y - spr.oy]; break; }
    KCORN.set(spr.id, c);
    return c;
  }
  function rearHangFx(items, t) {
    const Hg = KH.hang, out = [];
    const km = items.find((it) => it.kind === 'kumma');
    if (!Hg || !km) return out;
    const c = Hg.climbT != null ? t - Hg.climbT : -1;
    const a = ss((t - Hg.t0) / 0.25) * (c < 0 ? 1 : 1 - ss(c / 0.15));
    const kc = kummaCorner(km.spr);
    if (a <= 0 || !kc) return out;
    const [x, y] = KM.ap(km.M, kc[0], kc[1]), push = (Hg.env || 0) > 0.5 ? 1 : 0;
    out.push({ spr: worrySpr(), M: KM.T(Math.round(x) + push, Math.round(y) - push), alpha: a });
    return out;
  }
  const rhOn = () => KH.mode === 'hang' && KH.hang && KH.hang.rear;
  // his hands beside his head with no arms; while they hold the edge they stay put on it (fixed on the ledge), upright,
  // a size bigger, whatever his body does under them. They are always BEHIND his head (the head is always in front;
  // the hands show on the left and the right), peeking out either side of it
  const RG_HAND = 1.4;
  function rhTrim(items) {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'arm') items.splice(i, 1);
    const Hg = KH.hang, G = Hg && Hg.grips;
    const off = Hg && Hg.climbT != null ? ss((T - Hg.climbT - RC.PULL) / 0.15) : 0;   // (his hands leaving the edge as he springs)
    if (!G || off >= 1) return;
    const hands = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'hand' && G[it.side]) {
        const sq = RG_HAND + 0.07 * (Hg.env || 0);                     // (gripping harder as he pulls)
        const Mg = [sq, 0, 0, sq, G[it.side][0], G[it.side][1]];
        it.M = off > 0 ? Mg.map((v, j) => v + (it.M[j] - v) * off) : Mg; hands.push(it); items.splice(i, 1);
      }
    }
    const hi = items.findIndex((it) => it.kind === 'head');
    items.splice(hi < 0 ? 0 : hi, 0, ...hands);                         // (under his head and his kumma)
  }
  let HANDS_UP = null;                                                  // the hands' place in his frame when he hangs
  function hangPose(t, dt) {
    if (KH.hang.rear) return rearHangPose(t, dt);
    const Hg = KH.hang, Q = Hg.P;
    Hg.hx = clamp(Hg.hx, 27, WD.W - 27);                                 // both hands on the screen (a file column hugs the edge)
    const L = 30;
    let phi = Hg.ang * Math.PI / 180;
    if (dt > 0) {
      const sub = 4, h = dt / sub;
      for (let k = 0; k < sub; k++) { const acc = -(GRAV / L) * Math.sin(phi) - 1.4 * Hg.w; Hg.w += acc * h; phi += Hg.w * h; }
    }
    Hg.ang = phi * 180 / Math.PI;
    const u = t - Hg.t0;
    const p = stand(0, 0, 0);
    p.hlx = -24; p.hly = -46; p.hrx = 24; p.hry = -46; p.zl = p.zr = 1; p.hl = p.hr = 'fist';
    // on the taskbar's edge he hangs in a chin-up (arms bent): straight-armed, the screen's bottom would cut his face
    const chin = Q === WD.floor && Hg.climbT == null;
    if (chin) { p.hly = p.hry = -34; p.hlx = -26; p.hrx = 26; }
    // climbing: a pull-up (hands come down to his shoulders), then he swings up onto the ledge
    let pull = 0, next = null;
    if (Hg.climbT != null) {
      const c = t - Hg.climbT;
      pull = ss(c / 0.45);
      p.hly = lerp(-46, -33, pull); p.hlx = lerp(-24, -26, pull); p.hrx = lerp(24, 26, pull); p.hry = p.hly;
      p.fly = -4.5 * pull; p.fry = -4.5 * pull;
      p.expr = 'effort';
      if (c >= 0.45) next = 'up';
    } else {
      const kick = Math.sin(t * 7.5);
      const lively = Hg.user ? 1 : 0.6;
      // monkey bars along the top of the screen: hand over hand, one hand a little higher, then the other
      if (Hg.travel && dt > 0) {
        const nx = Hg.hx + Hg.travel * 24 * dt;
        if (nx < 30 || nx > WD.W - 30) Hg.travel = -Hg.travel; else Hg.hx = nx;
        const ph = Math.sin(t * 6.5);
        p.hly = -46 - 3 * Math.max(0, ph); p.hry = -46 - 3 * Math.max(0, -ph);
        Hg.w += 0.6 * Math.cos(t * 6.5) * dt;
      }
      p.fly = -0.4 - 1.8 * Math.max(0, kick) * lively; p.fry = -0.4 - 1.8 * Math.max(0, -kick) * lively;
      p.flx = -3.6 + 1.2 * Math.cos(t * 7.5) * lively; p.frx = 3.6 + 1.2 * Math.cos(t * 7.5 + Math.PI) * lively;
      p.hem = 0.5 + 0.3 * Math.abs(Math.sin(phi));
      p.expr = u < 0.5 ? (Hg.user ? 'relief' : 'determined') : u > Hg.dur - 0.6 && Hg.next === 'drop' ? 'nervous' : Math.floor(u / 1.2) % 2 ? 'effort' : 'determined';
      if (u > 0.6 && Math.floor(u / 1.5) % 2) p.eyes = 'lookdown';
      p.hrot = clamp(-Hg.w * 3, -10, 10);
      if (dt > 0 && u > Hg.dur && !REVIEW_HOLD.hang) {
        if (Hg.next === 'climb') { Hg.climbT = t; sfx('scuff', 0.4); }
        else next = 'drop';
      }
    }
    const [lx, ly] = HANDS_UP || (HANDS_UP = handsLocal(p));
    const hl = pull || chin ? handsLocal(p) : [lx, ly];
    p.pvx = hl[0]; p.pvy = hl[1]; p.rot = Hg.ang * (1 - pull);
    p.x = Hg.hx - hl[0]; p.y = Q.y - hl[1];
    if (next === 'up') return finishClimb(t, p, Q, Hg);                  // (only once he is placed: the blend starts from here)
    if (next === 'drop') return dropFromHang(t, p, Hg);
    return p;
  }
  function finishClimb(t, p, Q, Hg) {
    KH.mode = 'free'; KH.hang = null;
    KH.plat = Q; trackPlat();
    KH.x = clamp(Hg.hx, qlo(Q), qhi(Q));
    KH.landT = t; KH.landHard = 0.35;
    KH.yaw = 0; KH.yawTarget = 0; KH.speed = 0;
    KH.blend = { from: Object.assign({}, p), t0: t, dur: 0.28 };
    sfx('hop', 0.4);
    if (Hg.user) KH.react = { t0: t + 0.3, dur: 1.0, face: 'proud', arms: true };
    if (Hg.then) KH.pendingThen = Hg.then;
    BR.next = Math.max(BR.next, t + rnd(1, 2.5));
    return freePose(t, 0);
  }
  function dropFromHang(t, p, Hg) {
    const w = Hg.w;
    const from = Object.assign({}, p);
    startAir({ x: Hg.hx, y: p.y, vx: w * 30, vy: 20, rot: 0, self: true, fall: false, canCatch: false });
    KH.air.t0 = t;
    KH.blend = { from, t0: t, dur: 0.15 };
    sfx('whoosh', 0.3);
    return airPose(t, 0);
  }
  function loseFooting(why) {
    if (KH.mode === 'held' || KH.mode === 'air') return;
    const p = KH.pose;
    if (KH.mode === 'clip') endClip(false);
    const x = KH.mode === 'hang' && KH.hang ? KH.hang.hx : KH.mode === 'wall' && KH.wallc ? KH.wallc.wf.w.x + KH.wallc.wf.w.side * 9 : KH.x;
    const y = p ? p.y : groundY();
    if (KH.mode === 'wall') KH.wallc = null;
    startAir({ x, y: KH.mode === 'hang' || KH.mode === 'wall' ? y : groundY(), vx: KH.wvx * 0.6, vy: why === 'thrown' ? Math.min(-140, KH.wvy) : 0, self: why !== 'thrown', fall: true, canCatch: true });
    KH.plat = WD.floor; trackPlat(); lastTr = null;
    if (why === 'thrown') { KH.air.self = false; KH.air.fall = false; sfx('whoosh', 0.5); }
    else { mark('excl', 0.8); sfx('boing', 0.35); }
    KH.blend = p ? { from: p, t0: T, dur: 0.1 } : null;
  }
  // the window under him dragged about: he wobbles, and a hard shake throws him off
  function windowShake(v, prevV, pvx, pvy) {
    if (KH.mode !== 'free' && KH.mode !== 'clip' && KH.mode !== 'hang') return;
    // a window stopped dead under him keeps him going (inertia); a wild shake throws him anyway
    const stop = prevV > 600;
    if (v > 1600 || stop) {
      const vx = stop ? pvx : KH.wvx, vy = stop ? pvy : KH.wvy;
      if (KH.mode === 'hang') { const Hg = KH.hang; Hg.w += clamp(-vx / 120, -6, 6); if (v > 2000) { const p = KH.pose; dropFromHang(T, p || stand(), Hg); KH.air.vx = vx * 0.7; KH.air.self = false; } return; }
      loseFooting('thrown');
      KH.air.vx = clamp(vx * 0.8, -900, 900); KH.air.vy = clamp(Math.min(vy * 0.7, 0) - 180, -700, -120);
      KH.fun += 0.8;
      return;
    }
    if (v > 450 && T - KH.wobbleT > 0.8 && KH.mode === 'free') {
      KH.wobbleT = T;
      KH.sit = null;
      KH.react = { t0: T, dur: 0.9, face: v > 900 ? 'scared' : 'surprise', windmill: true };
    }
  }

  // ---------------------------------------------------------------- climbing: files, columns of files, the taskbar's edge, window sides
  // something to do a moment from now, once he is standing free again (dropped if he is picked up or thrown first)
  function later(sec, fn) { KH.later = { at: T + sec, fn }; }
  // a ledge just over his head (the next file up a column, a window edge close above): no jump, he stretches up on his
  // toes, grabs it and pulls himself up. opts.next 'drop' + opts.hangFor: he only hangs there (a ledge too high to stand on)
  function reachable(cur, Q) {
    const up = cur.y - Q.y;
    return up >= 14 && up <= 48 && Q.x1 - 3 > qlo(cur) && Q.x0 + 3 < qhi(cur);
  }
  function climbUpTo(Q, then, opts = {}) {
    if (KH.mode !== 'free') return false;
    const cur = KH.plat || WD.floor;
    if (!reachable(cur, Q)) return false;
    const hx = clamp(Q.kind === 'icon' ? Q.cx : clamp(KH.x, Q.x0 + 8, Q.x1 - 8), qlo(cur), qhi(cur));
    KH.sit = null; KH.peek = null;
    const go = () => { if (KH.mode === 'free' && KH.plat === cur) { KH.reach = Object.assign({ t0: T, Q, then }, opts); KH.walkTo = null; } };
    if (Math.abs(hx - KH.x) > 1.5) KH.walkTo = { x: hx, speed: 15, then: go }; else go();
    return true;
  }
  function grabFromReach(t) {
    const Rc = KH.reach;
    KH.reach = null;
    const Q = Rc.Q;
    if (!WD.plats.includes(Q) && !WD.icons.includes(Q)) return;
    const pullNow = (Rc.next || 'climb') === 'climb';
    KH.hang = { P: Q, hx: clamp(KH.x, Q.x0 + 3, Q.x1 - 3), t0: t, ang: 0, w: pullNow ? 0 : 0.8 * (Math.random() < 0.5 ? -1 : 1),
      dur: Rc.hangFor || 0.3, user: false, next: Rc.next || 'climb', then: Rc.then, self: true, rear: rearLedge(Q),
      climbT: pullNow ? t - (rearLedge(Q) ? 0 : 0.2) : null };          // straight into the pull-up (on a window: the jump up)
    KH.mode = 'hang'; KH.limb = null;
    KH.plat = Q; trackPlat(); lastTr = null;
    KH.blend = KH.pose ? { from: KH.pose, t0: t, dur: pullNow ? 0.18 : 0.24 } : null;
    sfx('grab', 0.45);
  }
  // hanging on the edge he stands on (the taskbar's top, a window's top, a file), legs dangling over it, then back up
  function dangle(t) {
    const Q = KH.plat || WD.floor;
    if (KH.mode !== 'free') return;
    const hx = Q.kind === 'icon' ? Q.cx : KH.x;
    KH.hang = { P: Q, hx, t0: t, ang: 0, w: 1.2 * (Math.random() < 0.5 ? -1 : 1), dur: rnd(2.2, 4), user: false,
      next: Q.kind === 'icon' && Math.random() < 0.3 ? 'drop' : 'climb', self: true, rear: rearLedge(Q) };
    KH.mode = 'hang'; KH.sit = null; KH.sitW = 0; KH.limb = null; KH.walkTo = null;
    KH.blend = KH.pose ? { from: KH.pose, t0: t, dur: 0.4 } : null;
    sfx('scuff', 0.3);
  }
  // a column of files climbed like a ladder: onto the bottom one, then hand over hand up the rungs (a look up and a
  // breath between them); at the top he hangs from the last one he can only reach, or sits on top, proud
  function climbColumn(col) {
    if (KH.mode !== 'free' || !col || !WD.cols.includes(col)) return false;
    const rungs = col.icons;
    const on = rungs.indexOf(KH.plat);
    if (on < 0) {
      const first = rungs.find((ic) => WD.plats.includes(ic));
      if (!first) return false;
      return goTo(first, first.cx, 15, () => later(rnd(0.4, 0.9), () => climbColumn(col)));
    }
    const next = rungs[on + 1];
    if (!next) { sitDown(rnd(10, 22), 'proud'); sfx('tada', 0.25); return true; }
    if (WD.plats.includes(next)) {
      KH.lookYaw = { yaw: 0, until: T + 0.6 };
      return climbUpTo(next, () => later(rnd(0.25, 0.8), () => climbColumn(col)));
    }
    // the last rung is too near the top of the screen to stand on: he hangs from it, kicking, then lets go
    return climbUpTo(next, null, { next: 'drop', hangFor: rnd(2, 3.4) });
  }
  // down a column: little hops from file to file
  function hopDown() {
    const Q = KH.plat;
    if (!Q || Q.kind !== 'icon' || KH.mode !== 'free') return false;
    const below = Q.col && Q.col.icons[Q.col.icons.indexOf(Q) - 1];
    const tgt = below && WD.plats.includes(below) ? below : null;
    KH.sit = null; KH.peek = null;
    KH.jump = null;
    const p = KH.pose;
    startAir({ x: Q.cx, y: Q.y - 0.01, vx: tgt ? 0 : (Q.cx < WD.W / 2 ? 30 : -30), vy: -150, self: true, canCatch: false, skip: Q, only: tgt });
    KH.air.thenLand = tgt ? () => later(rnd(0.3, 0.8), () => { if (Math.random() < 0.7) hopDown(); }) : null;
    KH.blend = p ? { from: p, t0: T, dur: 0.1 } : null;
    sfx('hop', 0.3);
    return true;
  }
  // his favourite files first: his own (a name with Khalfan in it), then the ones in a column he can climb
  function iconScore(ic) {
    let s = 1;
    if (/khalfan|خلفان/i.test(ic.name || '')) s *= 5;
    if (ic.col && ic.col.icons.length > 1) s *= 1.5;
    return s;
  }
  function visitIcon(t, what) {
    const icons = WD.icons.filter((ic) => WD.plats.includes(ic));
    if (!icons.length) return false;
    const ic = weighted(icons, iconScore);
    const act = what || weighted(['climb', 'sit', 'peek', 'read'], (a) => ({ climb: ic.col && ic.col.icons.length > 1 ? 4 : 0, sit: 3, peek: 2.5, read: 1.5 })[a]);
    if (act === 'climb') return climbColumn(ic.col);
    const after = {
      sit: () => later(rnd(0.3, 0.8), () => sitDown(rnd(12, 30), /khalfan/i.test(ic.name) ? 'proud' : Math.random() < 0.4 ? 'whistle' : null)),
      peek: () => later(rnd(0.4, 1.0), () => startPeek()),
      read: () => later(0.3, () => readIcon()),
    }[act];
    if (KH.plat === ic) { after(); return true; }
    return goTo(ic, ic.cx, 15, after);
  }
  // up the side of a window, hand over hand on its edge, then a pull-up onto its top. He climbs nearly facing us (turned
  // only a little towards the edge: he faces us), both hands on the window's side, the feet stepping up
  function startWall(wf, then) {
    if (KH.mode !== 'free') return false;
    const cur = KH.plat || WD.floor;
    KH.sit = null; KH.peek = null;
    const go = () => {
      if (KH.mode !== 'free' || KH.plat !== cur) return;
      KH.wallc = { wf, y: cur.y, t0: T, then };
      KH.mode = 'wall'; KH.walkTo = null; KH.limb = null;
      KH.plat = wf.top; trackPlat(); lastTr = null;
      KH.blend = KH.pose ? { from: KH.pose, t0: T, dur: 0.25 } : null;
      sfx('scuff', 0.35);
    };
    KH.walkTo = { x: clamp(wf.bx, qlo(cur), qhi(cur)), speed: 15, then: go };
    return true;
  }
  function wallFor(cur, Q) {
    for (const w of WD.walls) { const f = wallFrom(w, cur); if (f && (!Q || f.top === Q)) return f; }
    return null;
  }
  function wallPose(t, dt) {
    const Wc = KH.wallc, w = Wc.wf.w, side = w.side;
    const u = t - Wc.t0, ph = Math.sin(u * 10);
    if (dt > 0 && u > 0.25) Wc.y -= 84 * dt * (0.4 + 0.6 * Math.max(0, ph));   // a pull, a reach, a pull
    const p = stand(-side * 22, w.x + side * 9, Wc.y);
    const near = side < 0 ? 'r' : 'l', far = side < 0 ? 'l' : 'r';
    p['h' + near + 'x'] = -side * 21; p['h' + near + 'y'] = -26 - 7 * ph;     // the near hand high on the edge, beside his head
    p['h' + far + 'x'] = -side * 12; p['h' + far + 'y'] = -17 + 6 * ph;       // the far hand across at chest height
    p.zl = p.zr = 1; p.hl = p.hr = 'fist';
    p.fly = -2.6 * Math.max(0, ph); p.fry = -2.6 * Math.max(0, -ph);
    p.flx -= side * 2; p.frx -= side * 2;
    p.hem = 0.4;
    p.expr = u < 0.6 ? 'determined' : Math.floor(u / 0.9) % 2 ? 'effort' : 'determined';
    if (Math.floor(u * 10 / Math.PI) !== Wc.stepK) { Wc.stepK = Math.floor(u * 10 / Math.PI); if (u > 0.3) sfx('step', 0.1); }
    // his hands at the top: he grabs the top edge by the corner and pulls himself up onto it
    if (Wc.y - 36 <= w.y0) {
      const top = Wc.wf.top;
      KH.hang = { P: top, hx: side < 0 ? top.x0 + 6 : top.x1 - 6, t0: t, ang: 0, w: 0, dur: 0.3, user: false, next: 'climb', then: Wc.then, self: true, climbT: t - 0.15 };
      KH.mode = 'hang'; KH.wallc = null; KH.limb = null;
      KH.blend = { from: Object.assign({}, p), t0: t, dur: 0.18 };
      sfx('grab', 0.45);
    }
    return p;
  }
  // standing on a file, he leans over to look at its name, curious, and taps it with his foot
  function readIcon() {
    if (KH.mode !== 'free') return;
    KH.react = { t0: T, dur: 1.8, face: Math.random() < 0.5 ? 'curious' : 'thinking', read: true };
    mark('qmark', 1.2);
  }

  // ---------------------------------------------------------------- the kumma's follow-through (xrender's spring)
  function springStep(M, dt, reset) {
    const Sg = KH.spring;
    const x = M[4], y = M[5], a = Math.atan2(M[1], M[0]);
    if (reset) { Sg.st = [0, 0, 0, 0, 0, 0]; Sg.hist = []; return [0, 0, 0]; }
    const H = Sg.hist;
    if (H.length) { const last = H[H.length - 1]; if (Math.hypot(x - last.x, y - last.y) > 25) H.length = 0; }
    let aa = a;
    if (H.length) { const la = H[H.length - 1].a; aa = la + R.pyMod(a - la + Math.PI, 2 * Math.PI) - Math.PI; }
    H.push({ x, y, a: aa, dt });
    if (H.length > 3) H.shift();
    if (H.length < 3) return Sg.st.slice(0, 3);
    const [h0, h1, h2] = H;
    const d1 = Math.max(h1.dt, 1e-3), d2 = Math.max(h2.dt, 1e-3), dm = (d1 + d2) / 2;
    const ax = ((h2.x - h1.x) / d2 - (h1.x - h0.x) / d1) / dm * VS;
    const ay = ((h2.y - h1.y) / d2 - (h1.y - h0.y) / d1) / dm * VS;
    const al = ((h2.a - h1.a) / d2 - (h1.a - h0.a) / d1) / dm;
    Sg.ax = lerp(Sg.ax || 0, ax, 0.6); Sg.ay = lerp(Sg.ay || 0, ay, 0.6);
    const ca = Math.cos(-a), sa = Math.sin(-a);
    const lx = ca * Sg.ax - sa * Sg.ay, ly = sa * Sg.ax + ca * Sg.ay;
    let [dx, dy, dr, vx, vy, vr] = Sg.st;
    const k = 324, cc = 12.6, mmm = 0.3, kr = 200, cr = 9, mr = 1.6, mra = 0.25;
    const sub = 4, h = Math.min(dt, 1 / 30) / sub;
    for (let i = 0; i < sub; i++) {
      vx += (-k * dx - cc * vx - mmm * lx) * h;
      vy += (-k * dy - cc * vy - mmm * ly) * h;
      vr += (-kr * dr - cr * vr - mr * lx - mra * (al * 180 / Math.PI) * 0.01) * h;
      dx += vx * h; dy += vy * h; dr += vr * h;
    }
    dx = clamp(dx, -2.5, 2.5); dy = clamp(dy, -4, 1); dr = clamp(dr, -14, 14);
    Sg.st = [dx, dy, dr, vx, vy, vr];
    return [dx, dy, dr];
  }

  // ---------------------------------------------------------------- what is drawn
  const SIGN_HANDS = new Set(['thumb', 'thumbdown', 'peace']);
  function khalfanItems(p, extra, clip, ex) {
    const items = R.parts(p, { extra, hair: p.hatHair || null });      // (hatHair: curls while his kumma is off)
    if (p.hyaw || p.hpitch) turnHead(items, p);
    for (const it of items) {
      if (it.kind === 'hand' && SIGN_HANDS.has(it.shape)) it.M = KM.mul(it.M, KM.S(1.5, 1.5));
      it.L = lutForKind(it.kind, clip);
    }
    const back = [], mid = [], front = [];
    if (ex) { back.push(...ex.back || []); mid.push(...ex.mid || []); front.push(...ex.front || []); }
    for (const it of back.concat(mid, front)) if (!it.L) it.L = baseLut();
    const bi = items.findIndex((it) => it.kind === 'body');
    return back.concat(items.slice(0, bi + 1), mid, items.slice(bi + 1), front);
  }
  function drawItems(list, base) {
    for (const it of list) {
      if (!it.spr) continue;
      const m = R.mm(base, it.M);
      g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (it.alpha != null) {
        const a0 = g.globalAlpha;
        g.globalAlpha = a0 * it.alpha;
        g.drawImage(sprCanvas(it.spr, it.L || baseLut()), -it.spr.ox, -it.spr.oy);
        g.globalAlpha = a0;
      } else g.drawImage(sprCanvas(it.spr, it.L || baseLut()), -it.spr.ox, -it.spr.oy);
    }
  }
  // a soft shadow on the ledge under him (on a window's title bar or the taskbar)
  function drawShadow(p, C) {
    const q = R.full(p);
    const MR = R.rootMatrix(q);
    let fy = groundY();
    if (KH.mode === 'air' || KH.mode === 'held' || KH.mode === 'hang') {
      const cx0 = KM.ap(MR, 0, -20)[0];
      fy = supportBelow(cx0, KM.ap(MR, 0, 0)[1] - 2).y;
    }
    const lowestY = Math.max(KM.ap(MR, q.flx, q.fly)[1], KM.ap(MR, q.frx, q.fry)[1], KM.ap(MR, 0, -20)[1] + 6);
    const kk = clamp(1 - Math.max(0, fy - lowestY) / 90);
    if (kk < 0.03 || KH.sink > 3) return;
    const cx = KM.ap(MR, 0, -20)[0];
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    g.fillStyle = `rgba(20,12,8,${(0.2 * kk).toFixed(3)})`;
    g.beginPath();
    g.ellipse(cx, fy, 13 * (0.55 + 0.45 * kk), 1.8 * (0.6 + 0.4 * kk), 0, 0, Math.PI * 2);
    g.fill();
  }

  // ---------------------------------------------------------------- the pointer: poke, pick up, throw
  let drag = null, cupDrag = null;                                       // (cupDrag: the finjan taken from his coffee bubble)
  let manualClock = false;
  const clockNow = () => (manualClock ? T : performance.now() / 1000);
  // the things you click on stay yours, even with him in front of them: the taskbar's buttons, and every file and its name
  function userTargetAt(x, y) {
    if (drag) return false;
    if (WD.floor.kind === 'taskbar' && y >= WD.floor.y) return true;
    for (const ic of WD.icons) if (x > ic.ax && x < ic.ax + ic.aw && y > ic.y - 2 && y < ic.yb) return true;
    return false;
  }
  function hitKhalfan(x, y) {
    if (!KH.pose || KH.gone) return false;
    if (KH.sink > 0.5 && y > groundY()) return false;
    const q = R.full(KH.pose);
    const inv = KM.inv(R.rootMatrix(q));
    const [lx, ly] = KM.ap(inv, x, y);
    return lx > -15 && lx < 15 && ly > -52 && ly < 5;
  }
  function grabAt(x0, y0, caught) {
    if (KH.mode === 'clip') endClip(false);
    const q = R.full(KH.pose);
    const inv = KM.inv(R.rootMatrix(Object.assign({}, q, { sx: 1, sy: 1 })));
    const [lx, ly] = KM.ap(inv, x0, y0);
    const glad = !!(KH.after && KH.after.kind === 'again');
    KH.held = { pvx: lx, pvy: ly, rot: q.rot || 0, w: 0, t0: T, vx: 0, vy: 0, caught, glad };
    KH.blend = { from: KH.pose, t0: T, dur: 0.12 };
    KH.mode = 'held'; KH.walkTo = null; KH.jump = null; KH.air = null; KH.hang = null; KH.after = null; KH.leap = null; KH.wallc = null; KH.reach = null; KH.later = null;
    KH.sit = null; KH.sitW = 0; KH.peek = null; KH.sink = 0;
    KH.plat = WD.floor; trackPlat(); lastTr = null;
    if (!caught) { KH.fun = glad ? 0.5 : 0; KH.fear = 0; }
    limbsFrom(KH.pose);
    sfx('grab', 0.7);
    if (caught) sfx('pop', 0.4); else if (glad) sfx('heart', 0.25);
    BR.touched = T;
  }
  function throwHeld(soft) {
    if (KH.mode !== 'held') return;
    const H = KH.held;
    const q = R.full(KH.pose);
    const com = KM.ap(R.rootMatrix(q), 0, -20);
    const vx = H.vx * 0.85, vy = H.vy * 0.85;
    const speed = Math.hypot(vx, vy);
    const k = speed > 1100 ? 1100 / speed : 1;
    const ry = com[1] + 20;
    startAir({ x: com[0], y: ry, vx: vx * k, vy: vy * k, rot: H.rot, w: H.w * 57.3, hard: speed > 700, self: !!soft || !!H.ride, canCatch: true });
    const A = KH.air;
    A.dizzy = (H.spinAcc || 0) > 1.0;
    // let go inside a window (dropped, or a gentle toss): he is in its room. He falls to its bottom edge, bounces off its
    // sides and its title bar, and stays in there; thrown hard, he flies out across the screen as before
    const room = speed * k < 520 ? roomAt(com[0], ry) : null;
    if (room) { A.room = room.hwnd; A.canCatch = false; A.lowPrev = Math.min(A.lowPrev, room.y - 1); }
    if (!A.room && !A.self && A.vy < -220 && Math.abs(A.vx) < 0.6 * Math.abs(A.vy)) {
      // tossed straight up: he makes a flip of it, topping out under the screen's top, timed to land on his feet
      const sim = (vy0) => {
        let y = A.y, v = vy0, tt = 0, top = y;
        const fy = supportBelow(A.x, A.y).y;
        while (tt < 5) { v += GRAV * (1 - 0.55 * Math.exp(-((v / 70) ** 2))) / 240; y += v / 240; tt += 1 / 240; top = Math.min(top, y); if (v > 0 && y >= fy) break; }
        return [top, tt];
      };
      const ceil = 16 + 52;
      let [top, tt] = sim(A.vy);
      for (let i = 0; i < 40 && top < ceil; i++) { A.vy *= 0.92; A.vx *= 0.92; [top, tt] = sim(A.vy); }
      A.trick = { t0: T, dur: Math.max(0.35, tt - 0.05), rot0: A.rot, dir: A.vx >= 0 ? 1 : -1 };
      A.hard = false; A.canCatch = false;
      sfx('spin', 0.45);
    }
    if (speed > 260) sfx('whoosh', 0.5);
  }
  function poke() {
    const now = T;
    KH.pokes = KH.pokes.filter((x) => now - x < 2.2);
    KH.pokes.push(now);
    const n = KH.pokes.length;
    const top = KH.pose ? KM.ap(R.rootMatrix(R.full(KH.pose)), 0, -50) : [KH.x, 70];
    BR.touched = now;
    if (KH.mode === 'clip') return;
    if (KH.mode === 'hang') { dropFromHang(now, KH.pose, KH.hang); KH.air.fall = true; mark('excl', 0.6); return; }
    if (KH.sit && KH.sit.sleep) { wake(now, true); return; }
    if (KH.peek) { KH.peek = null; KH.react = { t0: now, dur: 0.9, face: 'laugh', hop: true }; sfx('pop', 0.5); return; }
    if (KH.after && KH.after.kind === 'grumpy') {
      KH.after = null; KH.pokes = [];
      KH.react = { t0: now, dur: 0.9, face: 'laugh', hop: true }; sfx('pop', 0.5); floaty('heart', top[0], top[1], 3);
      return;
    }
    addAnger(0.22);
    if (KH.rage) return;
    if (n >= 7) { KH.react = { t0: now, dur: 1.6, face: 'dizzy', shake: true }; KH.dizzyUntil = now + 1.6; sfx('spin', 0.5); floaty('star', top[0], top[1], 3); KH.pokes = []; }
    else if (n >= 4) { KH.react = { t0: now, dur: 1.2, face: 'huff', shake: true }; sfx('stomp', 0.45); }
    else { KH.react = { t0: now, dur: 0.7, face: n === 1 ? 'happy' : 'laugh', hop: true }; sfx(n === 1 ? 'pop' : 'blip', 0.5); floaty('heart', top[0], top[1], 2); }
  }
  function heldMove(x, y, now) {
    const H = KH.held;
    if (H.pt != null) {
      const dtp = Math.max(1e-3, now - H.pt);
      const vx = (x - H.px) / dtp, vy = (y - H.py) / dtp;
      H.ax = clamp((vx - H.vx) / dtp, -9000, 9000);
      H.ay = clamp((vy - H.vy) / dtp, -9000, 9000);
      H.vx = lerp(H.vx, vx, 0.35); H.vy = lerp(H.vy, vy, 0.35);
    }
    H.pt = now; H.px = x; H.py = y;
  }
  const toCells = (cx, cy) => [cx * kDip(), cy * kDip()];
  cv.addEventListener('pointerdown', (e) => {
    audioInit();
    const [x, y] = toCells(e.clientX, e.clientY);
    mouse.x = x; mouse.y = y; mouse.in = true;
    if (e.button === 2) { if (desk) desk.menu(); return; }
    if (e.button === 0 && overCoffee(x, y)) {                          // the coffee: take the cup from the bubble
      cv.setPointerCapture(e.pointerId);
      cupDrag = { x0: x, y0: y, sx: e.clientX, sy: e.clientY, moved: false };
      brew().cup = { x, y, held: true };
      sfx('clink', 0.45);
      return;
    }
    if (e.button === 0 && NBX && KH.nimbus && (hitKhalfan(x, y) || onCloud(x, y))) {   // on his cloud: drag him through the air
      cv.setPointerCapture(e.pointerId);
      NBX.down(x, y, e); NBA.drag = true;
      return;
    }
    if (e.button !== 0 || !hitKhalfan(x, y)) return;
    cv.setPointerCapture(e.pointerId);
    if (KH.rage) { shake(T, 0.5); sfx('thud', 0.35); return; }        // not now
    if (KH.mode === 'air' || KH.mode === 'hang') { drag = { x0: x, y0: y, sx: e.clientX, sy: e.clientY, moved: true }; grabAt(x, y, KH.mode === 'air'); return; }
    if (KH.mode === 'held') return;
    drag = { x0: x, y0: y, sx: e.clientX, sy: e.clientY, moved: false };
  });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = toCells(e.clientX, e.clientY);
    mouse.x = x; mouse.y = y; mouse.in = true;
    if (NBA.drag) { NBX.move(x, y, e); cv.style.cursor = 'grabbing'; return; }
    if (cupDrag) {
      const B = brew();
      if (B && B.cup) { B.cup.x = x; B.cup.y = y; }
      if (!cupDrag.moved && Math.hypot(e.clientX - cupDrag.sx, e.clientY - cupDrag.sy) > 5) cupDrag.moved = true;
      cv.style.cursor = 'grabbing';
      return;
    }
    if (!drag) { cv.style.cursor = hitKhalfan(x, y) || overCoffee(x, y) ? 'grab' : 'default'; return; }
    cv.style.cursor = 'grabbing';
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) { drag.moved = true; grabAt(drag.x0, drag.y0, false); }
    if (KH.mode === 'held' && KH.held && !KH.held.ride) heldMove(x, y, clockNow());
  });
  function pointerEnd() {
    if (NBA.drag) { NBA.drag = false; cv.style.cursor = 'default'; if (NBX) NBX.up(); return; }
    if (cupDrag) { const d = cupDrag; cupDrag = null; cv.style.cursor = 'default'; giveCoffee(d); return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    cv.style.cursor = 'default';
    if (!d.moved) { poke(); return; }
    throwHeld();
  }
  cv.addEventListener('pointerup', pointerEnd);
  cv.addEventListener('pointercancel', pointerEnd);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------- the Flying Nimbus (the game's)
  // Khalfan's golden cloud: ../playroom/js/nimbus.js and its 60-frame cloud, by reference. He whistles with a hand up,
  // points, the cloud streaks in from the edge of your screen, brakes beside him, he hops on. On the desktop he never
  // reads your keys and a tap anywhere else is your own click, so you fly him by dragging him (or the cloud) through
  // the air and letting go; left alone he flies a little tour of your screen and lands on a ledge (his favourite window,
  // the window you use, the taskbar). The tray's "Flying Nimbus" calls it and sends it away; now and then, when you
  // have stepped back from the PC a moment, he calls it himself.
  const NB_DATA = window.KHALFAN_NIMBUS || null;
  const NB_S = { size: 1, run: false, face: 'rest' };                  // the module's own settings: desktop cells are rig cells
  const NBA = { next: 0, legs: 0, target: null, landSet: false, drag: false, aimT: 0 };
  const nbMed = (a) => { const q = a.slice().sort((u, v) => u - v); return q[q.length >> 1]; };
  const NB_BOTTOM = NB_DATA ? nbMed(NB_DATA.bottom) : 21.5, NB_PARK = 3;
  function makeNimbus() {
    if (!window.KhalfanNimbus || !NB_DATA) return null;
    return window.KhalfanNimbus({
      KH, S: NB_S, g, keys: new Set(),
      get T() { return T; },
      get RM() { const Q = KH.plat || WD.floor; return { W: WD.W, H: WD.H, WALK: { x0: qlo(Q), x1: qhi(Q) } }; },
      floorY: () => groundY(), inputDir: () => [0, 0],
      sfx, whistle, puff, floaty, poke, audioInit, hitKhalfan,
      playClip: (k) => playMove(k), endClip: () => endClip(),
      refreshUI() {}, plate() {}, redraw() {},
    });
  }
  function nimbusCall() {
    if (!NBX || KH.gone || KH.rage) return false;
    if (NBX.active()) { if (NBX.state.phase === 'ride') { NBX.leave(null); NBA.target = null; } return true; }   // again: back down
    if (KH.mode === 'clip') endClip();
    if (KH.mode !== 'free') return false;
    if (KH.sit && KH.sit.sleep) wake(T, false);
    KH.sit = null; KH.peek = null; KH.sink = 0; KH.leap = null; KH.reach = null; KH.later = null; KH.jump = null;
    NBX.call();
    if (!NBX.active()) return false;
    KH.nimbus = true;
    Object.assign(NBA, { next: 0, legs: 3 + Math.floor(Math.random() * 3), target: null, landSet: false });
    BR.nimbusCool = T + rnd(1200, 2400);
    return true;
  }
  // the ledge under the cloud as it comes down: the highest one under his feet (not a file: too small for a cloud)
  function landingUnder(x, y) {
    let best = WD.floor;
    for (const Q of WD.plats) if (Q !== WD.floor && Q.kind !== 'icon' && standable(Q) && Q.x1 - Q.x0 > 60 && x >= Q.x0 + 12 && x <= Q.x1 - 12 && Q.y >= y - 3 && Q.y < best.y) best = Q;
    return best;
  }
  function nimbusStep(t, dt) {
    if (!NBX) return;
    if (NBX.active() && KH.mode !== 'free') NBX.reset();               // knocked off it somehow: the cloud is gone
    NBX.step(t, dt);
    const NB = NBX.state;
    KH.nimbus = !!NB;
    if (!NB) { NBA.landSet = false; return; }
    if (NB.phase === 'ride' && KH.plat !== WD.floor) { KH.plat = WD.floor; trackPlat(); lastTr = null; }   // up and away: the whole screen is his
    if (NB.phase === 'land' && !NBA.landSet) {                          // coming down: onto the ledge under the cloud
      NBA.landSet = true;
      KH.plat = landingUnder(NB.feetX, NB.feetY); trackPlat(); lastTr = null;
    }
    if (NB.phase === 'ride') nimbusPilot(t, NB);
  }
  // left alone on it, he flies himself: a few swoops round your screen (now and then past your cursor, never onto it),
  // then over to a ledge he likes, and down
  function nimbusPilot(t, NB) {
    if (NB.drag || NBA.drag) { NBA.next = t + 4; NBA.target = null; return; }   // you are flying him: he leaves it to you a while
    if (t < NBA.next) return;
    const yTop = 110, yLow = WD.floor.y - NB_PARK - NB_BOTTOM - 4;
    if (NBA.legs > 0) {
      NBA.legs--;
      let gx = rnd(100, WD.W - 100), gy = rnd(yTop + 20, yLow);
      if (mouse.in && Math.random() < 0.35) { gx = clamp(mouse.x + pick([-90, 90]), 100, WD.W - 100); gy = clamp(mouse.y - 40, yTop, yLow); }
      NB.goal = { x: gx, y: gy };
      NBA.next = t + rnd(2.4, 4.2);
    } else if (!NBA.target) {
      const cands = WD.plats.filter((Q) => Q.kind !== 'icon' && standable(Q) && Q.x1 - Q.x0 > 90);
      const Q = weighted(cands, platScore) || WD.floor;
      NBA.target = Q; NBA.aimT = t;
      NB.goal = { x: clamp(rnd(Q.x0 + 40, Q.x1 - 40), 100, WD.W - 100), y: clamp(Q.y - NB_PARK - NB_BOTTOM - 2, yTop, yLow) };
    } else if (!NB.goal || t - NBA.aimT > 6) { NBX.leave(null); NBA.target = null; NBA.next = t + 1e9; }
  }
  // is (x, y) on the cloud? (the module's own test, for his window taking the mouse)
  function onCloud(x, y) {
    const NB = NBX && NBX.state;
    if (!NB || !NB.spawned) return false;
    const k = NB.frame - 1, cy = NB.y + NB.bobY + NB.dip;
    return Math.abs(x - NB.x) < NB_DATA.bodyW[k] * 0.5 && y > cy + NB_DATA.deck[k] - 2 && y < cy + NB_DATA.bottom[k] + 2;
  }

  // ---------------------------------------------------------------- his routines (the brain)
  // A quiet buddy and a pestering kid: he potters about, sits on your windows, peeks out of the taskbar, jumps to the
  // window you are using, sleeps when you are away, and (mischief) chases your cursor and rides it by his kumma.
  const BR = { next: 4, touched: 0, fgChanged: null, chaseUntil: 0, chaseCool: 6, rideCool: 25, focusCool: 0, attnCool: 600,
    typingSince: null, keyT: -99, lastIdle: 0, wasAway: false, clicks: [], lastLd: false, leapCool: 0, peekCool: 20, hangCool: 25, yawnCool: 30, newWinCool: 0, seenHwnds: null,
    iconCool: 8, wallCool: 20, iconsOpen: 0, lastClickT: -99, hoverIconT: null, nudgeCool: 0, nimbusCool: 900 };
  function platScore(Q) {
    if (Q === WD.floor) return 1;
    let s = 1;
    if (Q.kind === 'fav') s *= 4;                                      // his favourite window
    if (WD.fg && Q.hwnd === WD.fg.hwnd) s *= 2;
    if (Q.x1 - Q.x0 < 90) s *= 0.4;
    return s;
  }
  function weighted(items, wfn) {
    const ws = items.map(wfn), sum = ws.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    let r = Math.random() * sum;
    for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  }
  // can he jump from here to (x, y)? returns the take-off velocity or null.
  //   land   up to 230 cells up: he lands on top
  //   catch  up to 340: the jump tops out with his hands at the edge; he grabs it and pulls himself up
  //   super  higher still: he charges up first, then one big jump
  function leapPlan(x0, y0, x1, y1, kind = 'land') {
    const dx = x1 - x0;
    if (Math.abs(dx) > 520) return null;
    const apexY = kind === 'catch' ? y1 - 3 : kind === 'super' ? y1 - 26
      : Math.max(60, Math.min(y0, y1) - (22 + 0.12 * Math.abs(dx) + Math.max(0, y0 - y1) * 0.08));
    if (apexY >= y0 || apexY < 56) return null;
    const vy = -Math.sqrt(2 * GRAV * (y0 - apexY));
    const tUp = -vy / GRAV, tDown = kind === 'catch' ? 0 : Math.sqrt(2 * Math.max(0, y1 - apexY) / GRAV);
    const vx = dx / (tUp + tDown);
    if (Math.abs(vx) > 520) return null;
    return { vx, vy, tt: tUp + tDown };
  }
  function goTo(Q, x, speed = 15, then = null) {
    if (KH.mode !== 'free') return false;
    KH.sit = null; KH.peek = null;
    const cur = KH.plat || WD.floor;
    if (Q === cur) { KH.walkTo = { x, speed, then }; return true; }
    // a ledge just over his head: he reaches up for it; a high one with a climbable side: up the side
    if (reachable(cur, Q) && Math.random() < 0.8) return climbUpTo(Q, then);
    const up = cur.y - Q.y;
    if (up > 150) { const wf = wallFor(cur, Q); if (wf && Math.random() < 0.75) return startWall(wf, then); }
    // pick the take-off spot on this ledge nearest the landing spot, walk there, then leap
    const kind = up <= 230 ? 'land' : up <= 340 ? 'catch' : 'super';
    let tx = clamp(x, qlo(Q) + 2, qhi(Q) - 2), ty = Q.y;
    if (kind === 'catch') {                                              // aim for the end of the edge nearest him
      tx = KH.x <= Q.x0 + 20 ? Q.x0 + 16 : KH.x >= Q.x1 - 20 ? Q.x1 - 16 : clamp(KH.x, Q.x0 + 16, Q.x1 - 16);
      ty = Q.y + 46;
    }
    const fromX = clamp(tx, qlo(cur), qhi(cur));
    let best = null;
    for (const off of [0, -60, 60, -140, 140, -260, 260]) {
      const sx = clamp(fromX + off, qlo(cur), qhi(cur));
      const plan = leapPlan(sx, cur.y, tx, ty, kind);
      if (plan && (!best || Math.abs(sx - KH.x) < Math.abs(best.sx - KH.x))) best = { sx, plan };
      if (best && off === 0) break;
    }
    if (!best) return false;
    const leapNow = () => {
      if (KH.mode !== 'free' || !WD.plats.includes(Q)) return;
      const plan = leapPlan(KH.x, groundY(), tx, ty, kind);
      if (!plan) return;
      KH.leap = { t0: T, plan, Q, tx, kind, charge: kind === 'super' ? 0.6 : 0.2, dir: Math.sign(tx - KH.x) || 1, then };
      sfx('scuff', 0.3);
    };
    KH.walkTo = { x: best.sx, speed: Math.abs(best.sx - KH.x) > 160 ? 32 : speed, then: leapNow };
    return true;
  }
  function launchLeap(t) {
    const L = KH.leap;
    KH.leap = null;
    const p = KH.pose;
    startAir({ x: KH.x, y: groundY() - 0.01, vx: L.plan.vx, vy: L.plan.vy, self: true, leap: true, canCatch: L.kind === 'catch', only: L.Q.kind === 'icon' ? L.Q : null, skip: (KH.plat && KH.plat.kind === 'icon') ? KH.plat : null });
    KH.air.thenLand = L.then;
    sfx('jump', 0.45);
    if (L.kind === 'super') { puff(KH.x, groundY(), 10, 1.5); floaty('spark', KH.x, groundY() - 20, 4); }
    if (Math.abs(L.plan.vx) > 300 || L.plan.vy < -420) sfx('whoosh', 0.3);
    KH.blend = p ? { from: p, t0: t, dur: 0.08 } : null;
    BR.leapCool = t + rnd(6, 14);
  }
  function sitDown(dur = rnd(12, 35), face = null) {
    if (KH.mode !== 'free') return;
    KH.walkTo = null;
    KH.sit = { t0: T, until: T + dur, ph: Math.random() * 6, face, sleep: false };
    sfx('sit', 0.35);
  }
  function standUp() { if (KH.sit) { KH.sit = null; } }
  function sleep() {
    if (KH.mode !== 'free') return;
    if (!KH.sit) sitDown(1e9);
    KH.sit.sleep = true; KH.sit.until = 1e9; KH.sit.sleepT = T;
    sfx('tick', 0.15);
  }
  function wake(t, poked) {
    if (!KH.sit || !KH.sit.sleep) return;
    const long = t - (KH.sit.sleepT || t) > 40;
    KH.sit = null;
    KH.react = { t0: t, dur: 0.8, face: 'startle', hop: true };
    mark('excl', 0.7);
    sfx('boing', 0.3);
    if (long || poked) setTimeout(() => { if (!KH.rage) say(LINES.hello); }, 700);
    BR.next = t + rnd(2, 4);
  }
  // peekaboo behind whatever he stands on: the taskbar, a window's top edge, a file. He sinks behind its edge (drawn cut
  // off there), moves along behind it (behind files he pops up behind another file), peeks out, ducks if you come close
  function startPeek() {
    const Q = KH.plat || WD.floor;
    if (KH.mode !== 'free' || (Q === WD.floor && WD.floor.kind !== 'taskbar')) return false;
    KH.sit = null; KH.walkTo = null;
    KH.peek = { t0: T, stage: 'duck', next: T + 0.3, ducks: 0, face: 'sneaky' };
    sfx('whoosh', 0.25);
    return true;
  }
  function peekStep(t, dt) {
    const Pk = KH.peek;
    if (!Pk) { KH.sink = approach(KH.sink, 0, dt * 120); return; }
    const Q = KH.plat || WD.floor, ey = Q.y;
    const near = mouse.in && Math.abs(mouse.x - KH.x) < 50 && mouse.y > ey - 110 && mouse.y < ey + 30;
    if (Pk.stage === 'duck') {
      KH.sink = approach(KH.sink, 58, dt * 300);
      if (t > Pk.next && KH.sink >= 57) {
        Pk.stage = 'under'; Pk.next = t + rnd(0.8, 1.8); Pk.dx = rnd(-160, 160);
        if (Q.kind === 'icon') {                                          // whack-a-mole: he comes up behind another file
          const others = WD.icons.filter((ic) => ic !== Q && WD.plats.includes(ic));
          if (others.length && Math.random() < 0.8) { const ic = pick(others); KH.plat = ic; KH.x = ic.cx; }
        }
      }
    } else if (Pk.stage === 'under') {
      KH.sink = 58;
      if (Q.kind !== 'icon') {
        const tx = clamp(KH.x + Pk.dx, Q.x0 + 30, Q.x1 - 30);
        KH.x = approach(KH.x, tx, dt * 90);
      }
      if (t > Pk.next && !near) { Pk.stage = 'rise'; Pk.next = t + rnd(2.2, 4); sfx('blip', 0.2); }
    } else if (Pk.stage === 'rise') {
      KH.sink = approach(KH.sink, 17, dt * 40);                            // just his kumma and his eyes over the edge
      KH.lookYaw = { yaw: 0, until: t + 0.1 };
      Pk.face = 'sneaky';
      if (near) { Pk.ducks++; if (Pk.ducks >= 3) { Pk.stage = 'pop'; } else { Pk.stage = 'duck'; Pk.next = t + 0.2; sfx('whoosh', 0.25); } }
      else if (t > Pk.next) Pk.stage = 'pop';
    } else if (Pk.stage === 'pop') {
      KH.sink = approach(KH.sink, 0, dt * 260);
      Pk.face = Pk.ducks >= 3 ? 'laugh' : 'cheeky';
      if (KH.sink <= 0) {
        KH.peek = null;
        KH.jump = { t0: t, dur: 0.32, h: 6, reach: Pk.ducks >= 3 };
        sfx('pop', 0.4);
        BR.next = t + rnd(3, 6);
      }
    }
  }
  function nearestPlatUnder(x, y) {
    let best = null;
    for (const Q of WD.plats) if (x >= Q.x0 + 4 && x <= Q.x1 - 4 && Q.y >= y - 4 && (!best || Q.y < best.y)) best = Q;
    return best || WD.floor;
  }
  function startRide(t) {
    // a jump up at the cursor; he catches it by the top of his kumma and hangs there
    KH.sit = null; KH.walkTo = null;
    KH.jump = { t0: t + 0.16, dur: 0.3, h: 10, reach: true, thenRide: true };
    mark('excl', 0.5);
  }
  function beginRide(t) {
    KH.held = { pvx: 0, pvy: -50, rot: 0, w: 0, t0: t, vx: 0, vy: 0, ride: true, until: t + rnd(7, 16) };
    KH.blend = { from: KH.pose, t0: t, dur: 0.15 };
    KH.mode = 'held'; KH.jump = null; KH.plat = WD.floor; trackPlat();
    limbsFrom(KH.pose);
    sfx('grab', 0.6); sfx('heart', 0.25);
    BR.rideCool = t + rnd(150, 300);
  }

  // out of a window's room: a hop off its bottom edge, and down he drops onto whatever is below it
  function hopOut(t) {
    const Q = KH.plat;
    if (KH.mode !== 'free' || !Q || Q.kind !== 'room') return false;
    KH.sit = null; KH.roomStay = null; KH.walkTo = null;
    KH.react = { t0: t, dur: 0.45, face: 'determined' };
    later(0.3, () => {
      if (!inRoom() || KH.mode !== 'free') return;
      const dir = KH.x - Q.x0 < Q.x1 - KH.x ? 1 : -1;                     // toward the middle of the screen side
      const p = KH.pose;
      startAir({ x: KH.x, y: groundY() - 0.01, vx: dir * rnd(30, 70), vy: -170, self: true, fall: false, canCatch: true });
      KH.blend = p ? { from: p, t0: T, dur: 0.08 } : null;
      sfx('jump', 0.4);
    });
    return true;
  }
  function chooseAction(t) {
    const Q = KH.plat || WD.floor;
    const late = WD.hour >= 23 || WD.hour < 5;
    const opts = [];
    opts.push(['wander', 26]);
    opts.push(['sit', late ? 30 : 16]);
    opts.push(['look', 10]);
    if (t > BR.leapCool && WD.plats.length > 1) opts.push(['leap', 18]);
    if (Q === WD.floor && WD.floor.kind === 'taskbar' && t > BR.peekCool) opts.push(['peek', 8]);
    if (Q !== WD.floor && Q.kind !== 'icon' && t > BR.peekCool) opts.push(['peek', 5]);                // behind a window's top edge
    if (Q !== WD.floor && Q.kind !== 'icon' && t > BR.hangCool) opts.push(['hangoff', 7]);
    if (t > BR.hangCool && Q.kind !== 'icon') opts.push(['dangle', Q === WD.floor ? 5 : 4]);           // over the taskbar's edge, a window's edge
    const wallHere = t > BR.wallCool && Q.kind !== 'icon' ? wallFor(Q, null) : null;
    if (wallHere) opts.push(['wall', 9]);
    // the files on the desktop, whenever they are in the open: his favourite playground
    const openIcons = WD.icons.filter((ic) => WD.plats.includes(ic));
    if (openIcons.length && Q.kind !== 'icon' && t > BR.iconCool) opts.push(['icons', 22]);
    if (Q.kind === 'icon') {
      opts.length = 0;                                                    // standing on a file: file things
      opts.push(['sit', 18], ['look', 6], ['read', 10], ['peek', 12], ['dangle', 7], ['hopdown', 10], ['wander', 3]);
      const nxt = Q.col && Q.col.icons[Q.col.icons.indexOf(Q) + 1];
      if (nxt) opts.push(['climbcol', 14]);
    }
    if (Q.kind === 'room') {                                              // in a window's room: he makes himself at home
      opts.length = 0;
      if (KH.roomNew) {                                                   // first: off to the nearer corner, to sit by the edge
        KH.roomNew = false;
        const dl = KH.x - Q.x0, dr = Q.x1 - KH.x, side = dl < dr ? -1 : 1;
        const sit = () => { if (inRoom() && KH.mode === 'free') sitDown(rnd(25, 50), Math.random() < 0.4 ? 'soft' : null); };
        if (Math.min(dl, dr) < 170 && Math.random() < 0.75) KH.walkTo = { x: side < 0 ? qlo(Q) + 3 : qhi(Q) - 3, speed: 15, then: sit };
        else sit();
        BR.next = t + 4;
        return;
      }
      opts.push(['sit', 30], ['wander', 8], ['look', 10]);
      if (t > BR.hangCool) opts.push(['dangle', 6]);                    // hanging off the window's bottom edge, then back in
      if (t - (KH.roomSince || t) > (KH.roomStay || (KH.roomStay = rnd(80, 200)))) opts.push(['leave', 40]);
    }
    if (t > BR.yawnCool && (late || Math.random() < 0.3)) opts.push(['yawn', late ? 10 : 3]);
    if (NBX && S.mischief && t > BR.nimbusCool && WD.idle > 20000 && WD.idle < 180000 && Q.kind !== 'room' && Q.kind !== 'icon') opts.push(['nimbus', 6]);
    const a = weighted(opts, (o) => o[1]);
    const act = a ? a[0] : 'wander';
    if (act === 'wall') {
      startWall(wallHere, () => later(rnd(0.4, 1), () => { if (Math.random() < 0.6) sitDown(rnd(10, 25), 'proud'); }));
      BR.wallCool = t + rnd(60, 150); BR.next = t + 12;
    } else if (act === 'icons') {
      visitIcon(t); BR.iconCool = t + rnd(25, 70);
      BR.next = t + rnd(6, 10);
    } else if (act === 'climbcol') {
      climbColumn(Q.col); BR.next = t + rnd(5, 9);
    } else if (act === 'hopdown') {
      hopDown(); BR.next = t + rnd(4, 8);
    } else if (act === 'read') {
      readIcon(); BR.next = t + rnd(3, 6);
    } else if (act === 'dangle') {
      dangle(t); BR.hangCool = t + rnd(40, 100);
      BR.next = t + rnd(6, 10);
    } else if (act === 'wander') {
      const run = Math.random() < 0.25;
      const x = clamp(KH.x + rnd(-1, 1) * rnd(40, 260), qlo(Q), qhi(Q));
      KH.walkTo = { x, speed: run ? 32 : 15 };
      BR.next = t + rnd(4, 9);
    } else if (act === 'sit') {
      sitDown(late ? rnd(25, 60) : rnd(10, 30), Math.random() < 0.3 ? 'whistle' : null);
      BR.next = KH.sit ? KH.sit.until + rnd(1, 3) : t + 3;
    } else if (act === 'look') {
      KH.lookYaw = { yaw: pick([-22, 22]), until: t + rnd(0.8, 1.6) };
      if (Math.random() < 0.4) KH.react = { t0: t + 0.3, dur: 1.0, face: pick(['curious', 'intrigued', 'thinking']) };
      BR.next = t + rnd(3, 7);
    } else if (act === 'leap') {
      const cands = WD.plats.filter((P2) => P2 !== Q && P2.x1 - P2.x0 > 40);
      const tgt = weighted(cands, platScore);
      if (tgt && goTo(tgt, rnd(tgt.x0 + 20, tgt.x1 - 20))) { if (Math.random() < 0.25) say(LINES.go); }
      BR.next = t + rnd(6, 12);
    } else if (act === 'peek') {
      startPeek(); BR.peekCool = t + (Q.kind === 'icon' ? rnd(15, 40) : rnd(60, 160));
      BR.next = t + 12;
    } else if (act === 'hangoff') {
      const side = KH.x - Q.x0 < Q.x1 - KH.x ? -1 : 1;
      const ex = side > 0 ? qhi(Q) : qlo(Q);
      KH.walkTo = { x: ex, speed: 15, then: () => { if (KH.mode === 'free' && KH.plat === Q) hangOff(Q, side, T); } };
      BR.hangCool = t + rnd(50, 120);
      BR.next = t + 10;
    } else if (act === 'nimbus') {
      if (!nimbusCall()) BR.nimbusCool = t + 120;
      BR.next = t + 6;
    } else if (act === 'leave') {
      hopOut(t); BR.next = t + rnd(4, 8);
    } else if (act === 'yawn') {
      KH.react = { t0: t, dur: 1.6, face: 'yawning', yawn: true };
      BR.yawnCool = t + rnd(40, 120);
      BR.next = t + rnd(3, 6);
    }
  }

  function brain(t, dt) {
    // the cursor's motion, the clicks, the keyboard (only that a key was pressed, never which)
    const idle = WD.idle;
    const mh = mouse.hist;
    const recentMove = mh.length > 1 ? Math.hypot(mh[mh.length - 1][1] - mh[0][1], mh[mh.length - 1][2] - mh[0][2]) : 0;
    if (idle < 400 && t - mouse.moveT > 0.6 && !mouse.ld) { if (BR.typingSince == null) BR.typingSince = t; BR.keyT = t; }
    if (t - BR.keyT > 3) BR.typingSince = null;
    const typing = BR.typingSince != null && t - BR.typingSince > 4;
    const away = idle > 180000;

    if (KH.mode === 'held' && KH.held && KH.held.ride) {
      const H = KH.held;
      if ((mouse.ld && !BR.lastLd) || t > H.until || !mouse.in) {     // a click (or he has had enough): he lets go
        throwHeld(true);
        KH.air.fall = false;
        if (Math.random() < 0.5) KH.sayOnLand = null;
      }
    }
    if (mouse.ld && !BR.lastLd) BR.lastClickT = t;
    // manners: your cursor heading for the file (or the bit of taskbar) he is on means you want it. He gets out of the way
    // rather than make you click round him: a duck to another file, a hop off, or back up from dangling over the taskbar
    if (mouse.in && !drag && t > BR.nudgeCool && !KH.rage) {
      const Q = KH.plat;
      // the file under the cursor, if he is standing, hanging or sitting over it (a column's files are closer together
      // than he is tall, so standing on one he covers the one above)
      let overIt = false;
      if (KH.pose && (KH.mode === 'free' || KH.mode === 'hang')) {
        const ic = WD.icons.find((c) => mouse.x > c.ax && mouse.x < c.ax + c.aw && mouse.y > c.y - 2 && mouse.y < c.yb);
        if (ic) {
          const cs = [[-15, -52], [15, -52], [-15, 5], [15, 5]].map(([lx, ly]) => KM.ap(R.rootMatrix(R.full(KH.pose)), lx, ly));
          const bx0 = Math.min(...cs.map((c) => c[0])), bx1 = Math.max(...cs.map((c) => c[0])), by0 = Math.min(...cs.map((c) => c[1])), by1 = Math.max(...cs.map((c) => c[1]));
          overIt = mouse.x > bx0 - 6 && mouse.x < bx1 + 6 && mouse.y > by0 - 6 && mouse.y < by1 + 6;   // the cursor on a file, and on him
        }
      }
      const dangling = KH.mode === 'hang' && KH.hang && KH.hang.P === WD.floor && mouse.y > WD.floor.y - 6 && Math.abs(mouse.x - KH.hang.hx) < 40;
      // in a window's room he sits in front of its buttons: the cursor resting on him a while (not grabbing) moves him on
      const roomHover = inRoom() && KH.mode === 'free' && !mouse.ld && hitKhalfan(mouse.x, mouse.y);
      if (overIt || dangling || roomHover) { if (BR.hoverIconT == null) BR.hoverIconT = t; } else BR.hoverIconT = null;
      if (BR.hoverIconT != null && t - BR.hoverIconT > (roomHover && !overIt && !dangling ? 1.2 : 0.35)) {
        BR.hoverIconT = null; BR.nudgeCool = t + 1.5;
        if (dangling) { KH.hang.dur = 0; KH.hang.next = 'climb'; }
        else if (KH.peek) { KH.peek.stage = 'duck'; KH.peek.next = t + 0.15; sfx('whoosh', 0.2); }
        else if (KH.mode === 'hang') { KH.hang.dur = 0; KH.hang.next = 'drop'; }
        else {
          KH.sit = null; KH.react = { t0: t, dur: 0.5, face: 'surprise' };
          later(0.2, () => {
            if (Q && Q.kind === 'icon') { if (!hopDown()) goTo(WD.floor, Q.cx + 30); }
            else if (Q && Q.kind === 'room') {                            // along the sill, away from the cursor (or the other way)
              let tx = clamp(KH.x + (mouse.x < KH.x ? 70 : -70), qlo(Q), qhi(Q));
              if (Math.abs(tx - KH.x) < 30) tx = clamp(KH.x + (mouse.x < KH.x ? -70 : 70), qlo(Q), qhi(Q));
              KH.walkTo = { x: tx, speed: 32, then: () => { if (inRoom()) sitDown(rnd(20, 40)); } };
            } else KH.walkTo = { x: clamp(KH.x + (mouse.x < KH.x ? 45 : -45), qlo(Q || WD.floor), qhi(Q || WD.floor)), speed: 32 };   // a step aside along his ledge
          });
        }
      }
    }
    // the desktop's files just came into view (everything minimised, or Win+D): he lights up and runs to his favourite
    const nOpen = WD.icons.filter((ic) => WD.plats.includes(ic)).length;
    if (nOpen && !BR.iconsOpen && KH.mode === 'free' && !KH.rage && !(KH.sit && KH.sit.sleep) && t > 3) {
      KH.react = { t0: t, dur: 0.8, face: 'yay', hop: true }; mark('excl', 0.7); sfx('pop', 0.3);
      later(0.9, () => visitIcon(T, Math.random() < 0.5 ? 'climb' : 'sit')); BR.iconCool = t + 30; BR.next = t + 8;
    }
    BR.iconsOpen = nOpen;
    BR.lastLd = mouse.ld;
    if (KH.mode !== 'free' || KH.rage || KH.leap || KH.jump || KH.gone || KH.reach || KH.nimbus) return;

    // asleep: any input wakes him; long away: he falls asleep where he is
    if (KH.sit && KH.sit.sleep) { if (idle < 1500) wake(t, false); return; }
    if (away && !KH.walkTo && !KH.peek) { sleep(); return; }
    if (KH.peek) return;

    // a click near him (not on him) startles him a little
    if (mouse.ld && !BR.lastClickDown && mouse.in && !inRoom() && Math.hypot(mouse.x - KH.x, mouse.y - (groundY() - 26)) < 70 && !hitKhalfan(mouse.x, mouse.y) && !KH.react) {
      KH.react = { t0: t, dur: 0.6, face: 'startle', hop: !KH.sit };
    }
    BR.lastClickDown = mouse.ld;

    // a new window opened: he looks at it
    if (WD.rects.length && BR.seenHwnds) {
      for (const r of WD.rects) if (!BR.seenHwnds.has(r.hwnd) && t > BR.newWinCool && !r.max) {
        KH.lookYaw = { yaw: clamp((r.x + r.w / 2 - KH.x) * 0.1, -22, 22), until: t + 1.4 };
        KH.react = { t0: t, dur: 1.2, face: 'curious' }; mark('qmark', 1.0);
        BR.newWinCool = t + 20;
        break;
      }
    }
    BR.seenHwnds = new Set(WD.rects.map((r) => r.hwnd));

    const Q = KH.plat || WD.floor;
    const mischief = S.mischief && !typing;

    // mischief 1: the cursor parked just over his head for a moment: he jumps up and rides it by his kumma. Only over the
    // bare desktop and when you have not clicked for a while: never over a window you are working in
    const overWindow = WD.rects.some((r) => mouse.x >= r.x && mouse.x <= r.x + r.w && mouse.y >= r.y && mouse.y <= r.y + r.h);
    if (mischief && t > BR.rideCool && mouse.in && !KH.sit && !overWindow && t - BR.lastClickT > 15) {
      const top = groundY() - 52;
      const dx = mouse.x - KH.x, dy = top - mouse.y;
      if (Math.abs(dx) < 14 && dy > 6 && dy < 34 && t - mouse.moveT > 1.0) { startRide(t); return; }
    }
    // mischief 2: the cursor zipping about near his ledge: he gives chase (and stops under it, arms up)
    if (mischief && mouse.in && !inRoom() && t > BR.chaseCool && recentMove > 90 && mouse.y > Q.y - 160 && mouse.y < Q.y + 25 && mouse.x > Q.x0 && mouse.x < Q.x1) {
      BR.chaseUntil = t + rnd(6, 11); BR.chaseCool = BR.chaseUntil + rnd(25, 70);
      KH.sit = null;
      if (Math.random() < 0.5) mark('excl', 0.6);
    }
    if (t < BR.chaseUntil && mouse.in) {
      const tx = clamp(mouse.x, qlo(Q), qhi(Q));
      if (Math.abs(tx - KH.x) > 8) KH.walkTo = { x: tx, speed: 44, near: 6 };
      else if (t - mouse.moveT > 0.3 && !KH.react && mouse.y < Q.y - 50) KH.react = { t0: t, dur: 0.9, face: 'yay', arms: true, hop: true };
      return;
    }

    // he follows you to the window you switch to (sometimes)
    if (BR.fgChanged && t - BR.fgChanged < 2 && t > BR.focusCool && WD.fg && !typing && !inRoom()) {   // (in a room he stays put)
      const targets = WD.plats.filter((P2) => P2.hwnd === WD.fg.hwnd && P2.x1 - P2.x0 > 60);
      BR.fgChanged = null;
      if (targets.length && targets[0] !== Q && Math.random() < (WD.fg.fav ? 0.7 : 0.35)) {
        const tgt = targets[0];
        if (goTo(tgt, rnd(tgt.x0 + 30, tgt.x1 - 30), 32)) { BR.focusCool = t + rnd(60, 150); BR.next = t + 8; return; }
      }
    }

    // typing: he settles down and keeps you company quietly (on his favourite window if he is there)
    if (typing) {
      if (!KH.sit && !KH.walkTo) sitDown(rnd(20, 50), Q.kind === 'fav' ? 'soft' : null);
      return;
    }
    if (KH.sit && t > KH.sit.until) { standUp(); BR.next = t + rnd(1, 3); return; }

    // he wants you: left alone a long while (you are busy, he has not been touched), he tries to get your attention
    if (t > BR.attnCool && t - BR.touched > 900 && idle < 5000) {
      BR.attnCool = t + rnd(700, 1200);
      KH.react = { t0: t, dur: 1.6, face: 'happy', wave: true };
      return;
    }

    if (t > BR.next && !KH.walkTo && !KH.sit) chooseAction(t);
  }

  // ---------------------------------------------------------------- events: hello, bye, call him, a render finished
  function onEvent(ev) {
    if (!ev || !D) return;
    const t = T;
    if (ev.type === 'hello') { KH.gone = false; dropIn(t); KH.sayOnLand = LINES.hello; }
    else if (ev.type === 'bye') {
      if (KH.mode !== 'free' || KH.nimbus) { KH.gone = true; if (NBX) NBX.reset(); KH.nimbus = false; setTimeout(() => desk && desk.gone(), 200); return; }
      KH.sit = null; KH.walkTo = null;
      KH.react = { t0: t, dur: 1.3, face: 'happy', wave: true };
      say(LINES.bye);
      setTimeout(() => { puff(KH.x, groundY(), 12, 1.6); puff(KH.x, groundY() - 30, 8, 1.2); KH.gone = true; sfx('pop', 0.4); setTimeout(() => desk && desk.gone(), 450); }, 1350);
    } else if (ev.type === 'call') {
      if (KH.nimbus) {                                                  // on his cloud: he flies over to your cursor
        const NB = NBX.state;
        if (NB && NB.phase === 'ride' && mouse.in) { NB.goal = { x: clamp(mouse.x + (mouse.x < WD.W / 2 ? 70 : -70), 100, WD.W - 100), y: clamp(mouse.y - 30, 110, WD.floor.y - NB_PARK - NB_BOTTOM - 4) }; NBA.next = T + 5; }
        return;
      }
      if (KH.mode === 'clip') endClip();
      if (KH.mode !== 'free') return;
      if (KH.sit && KH.sit.sleep) wake(t, true);
      const Q = nearestPlatUnder(mouse.x, mouse.y);
      if (!goTo(Q, mouse.x, 32, () => { KH.react = { t0: T, dur: 1.0, face: 'yay', arms: true, hop: true }; })) {
        dropIn(t, mouse.x);
      }
    } else if (ev.type === 'done' || ev.type === 'render-done') {
      if (KH.mode !== 'free' || KH.rage) return;
      if (KH.sit && KH.sit.sleep) return;                                // asleep: let him sleep
      if (t - (BR.doneT || -99) < 20) return;                            // several chats finishing at once: one cheer
      BR.doneT = t;
      KH.sit = null;
      KH.react = { t0: t, dur: 1.3, face: pick(['yay', 'triumph', 'happy']), arms: true, hop: true };
      const top = KM.ap(R.rootMatrix(R.full(KH.pose || stand(0, KH.x, groundY()))), 0, -50);
      floaty('spark', top[0], top[1], 4);
      sfx('tada', 0.35);
      BR.doneCount = (BR.doneCount || 0) + 1;
      if (BR.doneCount % 4 === 1) setTimeout(() => say(LINES.good), 450);
      BR.next = Math.max(BR.next, t + 3);
    } else if (ev.type === 'say' && ev.text) say(ev.text);
    else if (ev.type === 'nimbus') nimbusCall();
    else if (ev.type === 'powerup') {
      if (KH.rage) return;
      if (KH.nimbus) { KH.rageOnLand = true; if (NBX.state && NBX.state.phase === 'ride') NBX.leave(null); return; }
      if (KH.sit && KH.sit.sleep) wake(t, false);
      if (!playEmote()) KH.rageOnLand = true;
    }
  }
  // a move picked in the tray: here if it fits on his ledge, else down on the taskbar (the widest ledge) first
  function playFromMenu(key) {
    if (KH.rage || KH.gone) return;
    if (KH.mode === 'clip') endClip();
    if (KH.sit && KH.sit.sleep) wake(T, false);
    if (KH.mode !== 'free') { later(0.1, () => playFromMenu(key)); return; }
    KH.sit = null; KH.peek = null;
    if (playMove(key, { mirror: false }) || playMove(key)) return;
    if (KH.plat !== WD.floor && goTo(WD.floor, clamp(KH.x, 200, WD.W - 200), 32, () => playMove(key))) return;
    KH.react = { t0: T, dur: 0.9, face: 'curious' };                    // nowhere wide enough
  }
  function dropIn(t, x) {
    if (NBX) NBX.reset();
    KH.nimbus = false;
    const xx = x != null ? x : rnd(WD.W * 0.2, WD.W * 0.8);
    if (KH.mode === 'clip') endClip(false);
    startAir({ x: clamp(xx, 30, WD.W - 30), y: -10, vx: 0, vy: 60, self: true, fall: false, canCatch: false });
    KH.air.t0 = t;
    sfx('whoosh', 0.3);
  }
  function respawn() { dropIn(T); }

  // ---------------------------------------------------------------- his hands: files you hand him (not in this build)
  // What HE does when a file is handed to him: offer, reach, receive, hold, work, done, fail, shrug, nod. The menu
  // and the jobs that hand him files are not part of the public Khalfan, so nothing calls this block here.
  const HANDS = { offer: false, reach: false, hold: false, work: false, saved: null, timer: 0, reachT: -9, lastWork: null, nearT: -9, caught: false, hatU: 0 };
  function handsPose() { return KH.pose || stand(0, KH.x, groundY()); }
  // the kumma basket (KhalfanHat, not in this build): as a file comes near he takes his kumma off, turns it over and holds
  // it out as a basket that grows; it catches the file, stays out while the menu is open, and goes back on his head
  // before he gets to work. Mid-way picked up, powered up or off on his cloud: the kumma is simply back on.
  const HAT = () => window.KhalfanHat || null;
  function hatOn() { const H = HAT(); return !!(H && H.active()); }
  function hatBack() { if (!HANDS.hold) { HANDS.caught = false; hatWant(false); } }   // no menu after all: the kumma goes back on
  function hatWant(on, then) {
    const H = HAT();
    if (!H) { if (then) then(); return; }
    if (on) { if (handsFree() && KH.mode !== 'clip') { KH.sit = null; H.want(true); } }
    else if (H.active()) H.want(false, then);
    else if (then) then();
  }
  function handsFree() { return KH.mode === 'free' && !KH.rage && !KH.gone && !KH.reach && !KH.later && !KH.nimbus; }   // never mid-climb (KH.reach / KH.later); KH.rage = the power-up and its coffee; KH.nimbus = on his cloud
  function handsQuiet(on) {                                            // no mischief while a file is in play
    if (on && !HANDS.saved) {
      HANDS.saved = { chase: BR.chaseCool, ride: BR.rideCool, attn: BR.attnCool };
      BR.chaseCool = BR.rideCool = BR.attnCool = T + 1e6; BR.chaseUntil = 0;
      if (KH.mode === 'held' && KH.held && KH.held.ride) { throwHeld(true); KH.air.fall = false; }
    } else if (!on && HANDS.saved && !HANDS.offer && !HANDS.hold && !HANDS.work) {
      BR.chaseCool = Math.max(HANDS.saved.chase, T + 20); BR.rideCool = Math.max(HANDS.saved.ride, T + 60); BR.attnCool = HANDS.saved.attn;
      HANDS.saved = null; BR.next = Math.max(BR.next, T + rnd(2, 4));
    }
  }
  function handsTimer(on) {
    clearInterval(HANDS.timer); HANDS.timer = 0;
    if (!on) return;
    HANDS.timer = setInterval(handsTick, 120);
  }
  function handsTick() {                                               // five to eight times a second while a file is in play
    {
      if (!D) return;
      if (HANDS.offer && !HANDS.hold && handsFree() && mouse.in) {
        // a file is being carried: if it comes along his ledge he trots under it and reaches up for it
        const Q = KH.plat || WD.floor;
        const near = Math.abs(mouse.x - KH.x) < 300 && mouse.y > Q.y - 240 && mouse.y < Q.y + 20;
        if (near) {
          HANDS.nearT = T;
          hatWant(true);                                               // about to be handed something: the hat comes off
          if (!HANDS.dragAsked && window.handoff && window.handoff.dragInfo) { HANDS.dragAsked = true; window.handoff.dragInfo(); }   // what is it? (main looks)
          const tx = clamp(mouse.x, qlo(Q), qhi(Q));
          if (Math.abs(tx - KH.x) > 10 && !HANDS.reach) KH.walkTo = { x: tx, speed: 32, near: 8 };
          else if (!HAT() && T - HANDS.reachT > 1.1) { HANDS.reachT = T; KH.react = { t0: T, dur: 1.0, face: HANDS.reach ? 'yay' : 'curious', arms: true }; }
          KH.lookYaw = { yaw: clamp((mouse.x - KH.x) * 0.15, -20, 20), until: T + 0.4 };
        }
      }
      // the file went away again (still dragging): after a moment the kumma goes back on
      if (hatOn() && !HANDS.hold && !HANDS.caught && !HANDS.reach && T - HANDS.nearT > 1.2) hatWant(false);
      if (HANDS.work && handsFree() && KH.mode !== 'clip' && T - HANDS.reachT > 2.2) {
        HANDS.reachT = T;                                              // still working: a little sparkle of effort
        const top = KM.ap(R.rootMatrix(R.full(handsPose())), 0, -56);
        floaty('spark', top[0], top[1], 2);
        if (!KH.react) KH.react = { t0: T, dur: 1.4, face: 'thinking' };
      }
    }
  }
  // thinking it over with you: a fist under his chin, the other hand holding that elbow, the head tilted, now and then a
  // tap on the chin and a curious look; his eyes and head go up to the paper (gazeStep, KH.gazeRect)
  function thinkPose(p, t) {
    const u = t - HANDS.think.t0, a = ss(u / 0.45);
    const q = Object.assign({}, p);
    const tap = (Math.floor(t / 2.6) % 2 ? 1 : 0) * Math.max(0, Math.sin(t * 6.4));
    q.hrx = lerp(q.hrx, 8.2, a); q.hry = lerp(q.hry, -11.2 - 0.9 * tap, a);   // a fist at the corner of his chin
    q.hlx = lerp(q.hlx, 4.2, a); q.hly = lerp(q.hly, -4.4, a);          // the other hand under that elbow
    if (a > 0.4) { q.zr = 2; q.zhr = 2; q.hr = 'fist'; q.zl = 2; q.zhl = 2; q.hl = 'rest'; }
    q.hrot = (q.hrot || 0) - a * (8 + 1.6 * Math.sin(t * 0.9));        // the head tilted, away from the chin hand
    q.hdy = (q.hdy || 0) - 0.8 * a;                                     // chin up, to the paper
    q.lean = (q.lean || 0) - 2 * a;                                     // leaning back a little to look up
    if (!KH.react) q.expr = Math.floor(t / 3.1) % 3 === 2 ? 'curious' : 'thinking';
    if (u > 0.5 && Math.floor(u / 4.2) !== HANDS.think.dotK) {          // a little thought now and then
      HANDS.think.dotK = Math.floor(u / 4.2);
      const top = KM.ap(R.rootMatrix(R.full(q)), 9, -58);
      parts.push({ kind: 'qmark', t0: T, x: top[0], y: top[1], vx: 0, vy: 0, life: 0.9 });
    }
    return q;
  }
  const WORK_MOVES = { zip: 'squash-pop', unzip: 'squash-pop', pdf: 'reading', text: 'reading', image: 'wizard', video: 'wizard', audio: 'wizard', file: 'think-idea' };
  window.KhalfanHands = {
    // is (cx, cy), page pixels, on him? a little wider than his body, so a file is easy to hand over
    hit(cx, cy) {
      if (!KH.pose || KH.gone || !D) return false;
      const k = kDip();
      const [lx, ly] = KM.ap(KM.inv(R.rootMatrix(R.full(KH.pose))), cx * k, cy * k);
      const half = KH.pose.hatBowl ? Math.max(24, 21.15 * KH.pose.hatBowl + 4) : 24;   // his basket out: all of it catches
      return lx > -half && lx < half && ly > -62 && ly < 10;
    },
    // where the menu comes out of him: x of his middle, the top of his kumma, his feet (page pixels)
    anchor() {
      const M = R.rootMatrix(R.full(handsPose())), s = 1 / kDip();
      const mid = KM.ap(M, 0, -26), top = KM.ap(M, 0, -60), feet = KM.ap(M, 0, 4);
      return { x: mid[0] * s, top: top[1] * s, bottom: feet[1] * s };
    },
    offer(on) {                                                        // a file drag started (or ended) anywhere
      HANDS.offer = !!on;
      if (on) {
        HANDS.caught = false; HANDS.dragKind = null; HANDS.dragCount = 0; HANDS.dragAsked = false;
        if (KH.sit && KH.sit.sleep) wake(T, false);
        else if (handsFree() && !HANDS.hold) { KH.sit = null; if (Math.random() < 0.5) mark('qmark', 0.8); }
        handsQuiet(true); handsTimer(true);
      } else {
        HANDS.reach = false; if (!HANDS.work) handsTimer(false); if (!HANDS.hold && handsFree()) KH.walkTo = null; handsQuiet(false);
        const H = HAT(); if (H) H.reach(false);
        // let go somewhere else (not on him): the kumma goes back on (a moment's grace: the drop on him may land just after)
        setTimeout(() => { if (!HANDS.offer && !HANDS.caught && !HANDS.hold) hatWant(false); }, 350);
      }
    },
    // the file is over him: hands up, he wants it (kind, count: the drag's own guess; main's answer, dragInfo, wins)
    reach(on, kind, count) {
      if (kind && !HANDS.dragKind) HANDS.guessKind = kind;
      if (count) HANDS.guessCount = count;
      if (!!on === HANDS.reach) return;
      HANDS.reach = !!on;
      const H = HAT();
      if (H) {                                                         // the basket lifts and grows a little, he looks up at it, the file shows in its mouth
        if (on) { HANDS.nearT = T; hatWant(true); if (handsFree()) KH.walkTo = null; sfx('blip', 0.3); HANDS.reachT = T; }
        H.reach(on, HANDS.dragKind || HANDS.guessKind || 'file', HANDS.dragCount || HANDS.guessCount || 1);
        return;
      }
      if (on && handsFree()) { KH.walkTo = null; KH.react = { t0: T, dur: 1.2, face: 'yay', arms: true }; sfx('blip', 0.3); HANDS.reachT = T; }
    },
    receive(drop) {                                                    // dropped on him: he catches it (drop: page x, y and its kind)
      HANDS.reach = false;
      if (KH.mode === 'clip') endClip();
      if (KH.sit) KH.sit = null;
      const H = HAT();
      if (H && H.active() && handsFree()) {                            // into the kumma basket
        HANDS.caught = true; H.reach(false);
        KH.walkTo = null; KH.lookYaw = { yaw: 0, until: T + 1.6 };
        const k = kDip();
        const from = drop && isFinite(drop.x) && isFinite(drop.y) ? [drop.x * k, drop.y * k] : null;
        const ms = H.feed(T, from, drop && drop.kind);
        HANDS.feedEnd = T + (ms || 0) / 1000 + 0.12;                    // (the letter out of the hat: then the kumma goes back on)
        if (ms) {
          // it falls in (an icon of what it is), the hat gulps, and a letter shoots up out of it: the menu's paper takes
          // over where the letter ends (main passes it the delay)
          const F = H.FEED, rim = () => KH.pose && KH.pose.kfree;
          sfx('whoosh', 0.22);
          setTimeout(() => { sfx('pop', 0.5); const kf = rim(); if (kf) floaty('spark', kf[0], kf[1] - 2, 2); }, F.FALL * 1000);
          setTimeout(() => { sfx('whoosh', 0.4); const kf = rim(); if (kf) floaty('spark', kf[0], kf[1] - 4, 4); }, F.SHOOT0 * 1000);
          return Object.assign(this.anchor(), { delay: ms });
        }
        H.catchIt(T);                                                  // (the basket was not out in front yet: it dips with the catch)
        const kf = KH.pose && KH.pose.kfree;
        if (kf) floaty('spark', kf[0], kf[1] - 3, 3);
        sfx('pop', 0.5); sfx('whoosh', 0.3);
        return this.anchor();
      }
      // arms up and a hop as the folded letter leaves his kumma (the menu window plays the letter itself)
      if (handsFree()) { KH.walkTo = null; KH.lookYaw = { yaw: 0, until: T + 1.2 }; KH.react = { t0: T, dur: 1.0, face: 'yay', arms: true, hop: true }; }
      const top = KM.ap(R.rootMatrix(R.full(handsPose())), 0, -54);
      floaty('spark', top[0], top[1], 3);
      sfx('pop', 0.5); sfx('whoosh', 0.35);
      return this.anchor();
    },
    // The menu is open: he stands still and faces you. Once the letter is out of the hat, the kumma goes
    // back on his head, and he looks up at the paper with you,
    // a hand at his chin, his head tilted, his eyes on whatever you point at in it (thinkPose, the gaze's paper target).
    hold(on) {
      HANDS.hold = !!on;
      if (on) {
        if (handsFree()) KH.walkTo = null;
        KH.lookYaw = { yaw: 0, until: T + 1e6 }; handsQuiet(true); BR.next = T + 1e6;
        HANDS.thinkAt = hatOn() ? Math.max(T, HANDS.feedEnd || 0) : T;   // (his clock: see pose)
        HANDS.thinkAsked = false;
      } else {
        HANDS.think = null; HANDS.menuRect = null; KH.gazeRect = null;
        KH.lookYaw = null; BR.next = T + rnd(2, 4); handsQuiet(false); HANDS.caught = false; hatWant(false);   // the menu closed: the kumma goes back on
      }
    },
    // a card crumpled into a ball (not in this build): if he is free, he catches it and throws it off the
    // nearer edge of the screen. Returns which way, when he has it, when he lets go, and where his throwing hand is
    // (page pixels); null when he cannot (busy, asleep, his hat out): then it flies off on its own
    toss(pt) {
      if (!handsFree() || hatOn() || (KH.sit && KH.sit.sleep) || KH.mode !== 'free') return null;
      const dir = KH.x < WD.W / 2 ? -1 : 1;
      KH.walkTo = null; KH.sit = null;
      KH.react = { t0: T, dur: 1.25, face: 'surprise', toss: dir };
      KH.lookYaw = { yaw: dir * 14, until: T + 1.3 };
      setTimeout(() => sfx('pop', 0.25), 260);                         // the catch
      setTimeout(() => { sfx('whoosh', 0.6); }, 600);                  // the throw
      const side = dir > 0 ? 'r' : 'l';
      return { dir, catchAt: 0.26, throwAt: 0.6, hand: () => {
        const q = R.full(KH.pose || handsPose());
        const [hx, hy] = KM.ap(R.mm(R.rootMatrix(q), R.bodyMatrix(q)), q['h' + side + 'x'], q['h' + side + 'y']);
        return [hx / kDip(), hy / kDip() - 2];
      } };
    },
    // what is being dragged, from main (the selection in the Explorer window or on the desktop it came from)
    dragInfo(m) {
      if (!m || !m.kind) return;
      HANDS.dragKind = m.kind; HANDS.dragCount = m.count || 1;
      const H = HAT();
      if (H && HANDS.reach) H.reach(true, HANDS.dragKind, HANDS.dragCount);
    },
    // where the menu is (page pixels), from main each time it is placed: what he looks up at while he thinks
    menuAt(r) {
      if (!r || !isFinite(r.x)) { HANDS.menuRect = null; return; }
      const k = kDip();
      HANDS.menuRect = { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
    },
    work(action) {                                                     // he is on it (once his kumma is back on his head)
      HANDS.work = true; HANDS.lastWork = action;
      handsQuiet(true); handsTimer(true);
      hatWant(false, () => {
        if (!HANDS.work || HANDS.lastWork !== action) return;          // already finished (a fast job) or a newer one: the cheer covers it
        const kind = String(action || '').split('.')[0];
        const move = action === 'file.trash' ? null : WORK_MOVES[kind];
        if (action === 'file.trash') { if (handsFree()) { KH.react = { t0: T, dur: 0.9, face: 'huff', hop: true }; puff(KH.x + 12, groundY() - 30, 8, 1.2); sfx('whoosh', 0.4); } return; }
        if (!(move && CLIPS[move] && playMove(move, { mirror: false })) && handsFree()) KH.react = { t0: T, dur: 1.4, face: 'thinking' };
      });
    },
    // pet.js's tick, before drawing: the hat routine's pose on top of his own (a no-op unless the hat is off)
    pose(p, t, dt) {
      const H = HAT();
      if (HANDS.hold && !HANDS.think && !HANDS.thinkAsked && t >= (HANDS.thinkAt || 0)) {   // the letter is out: the kumma back on, then he thinks
        HANDS.thinkAsked = true; HANDS.caught = false;
        hatWant(false, () => { if (HANDS.hold) HANDS.think = { t0: T }; });
      }
      KH.gazeRect = HANDS.think && HANDS.hold ? HANDS.menuRect : null;
      if (HANDS.think && HANDS.hold && handsFree() && KH.mode !== 'clip' && !(H && H.active())) return thinkPose(p, t);
      if (!H || !H.active()) { HANDS.hatU = 0; return p; }
      if (!handsFree() || KH.mode === 'clip') { H.reset(); HANDS.hatU = 0; return p; }
      if (BR.next < t + 1) BR.next = t + 1;                            // no idle plans while he has it in his hands
      const q = H.pose(p, t, dt, {});
      const u = H.progress(), u0 = HANDS.hatU;                          // a sound at the turns of it
      if (u0 < 0.33 && u >= 0.33) sfx('pop', 0.22);                    // off it comes
      else if (u0 < 0.52 && u >= 0.52) sfx('whoosh', 0.25);            // turned over
      else if (u0 < 1 && u >= 1) sfx('blip', 0.2);                     // ready
      else if (u0 > 0.3 && u <= 0.3) sfx('pop', 0.22);                 // back on
      HANDS.hatU = u;
      return q;
    },
    // pet.js's tick, after his parts are placed: the upturned kumma takes the free kumma's place
    items(items, p) { const H = HAT(); if (H && p && p.hatBowl) H.items(items, p); },
    _tick: handsTick,                                                  // (the review steps time itself: it calls this)
    _hat: () => ({ u: HAT() ? +HAT().progress().toFixed(2) : null, caught: HANDS.caught, hold: HANDS.hold, work: HANDS.work, mode: KH.mode }),
    done() {                                                           // finished: a cheer, and زين
      HANDS.work = false; if (!HANDS.offer) handsTimer(false);
      hatBack();
      if (KH.mode === 'clip') endClip();
      if (handsFree()) {
        KH.react = { t0: T, dur: 1.3, face: pick(['yay', 'triumph', 'proud']), arms: true, hop: true };
        const top = KM.ap(R.rootMatrix(R.full(handsPose())), 0, -50);
        floaty('spark', top[0], top[1], 4);
        sfx('tada', 0.35);
        setTimeout(() => { if (!KH.rage) say(LINES.good); }, 450);
      }
      handsQuiet(false);
    },
    fail() {                                                           // it did not work: «!» and a startle
      HANDS.work = false; if (!HANDS.offer) handsTimer(false);
      hatBack();
      if (KH.mode === 'clip') endClip();
      mark('excl', 1.1);
      if (handsFree()) KH.react = { t0: T, dur: 1.2, face: 'startle' };
      sfx('boing', 0.3);
      handsQuiet(false);
    },
    shrug() { HANDS.work = false; hatBack(); if (handsFree()) KH.react = { t0: T, dur: 0.9, face: 'curious' }; handsQuiet(false); },
    nod() { HANDS.work = false; hatBack(); if (handsFree()) KH.react = { t0: T, dur: 0.7, face: 'happy', hop: true }; sfx('blip', 0.3); handsQuiet(false); },
    visible() { return !KH.gone && !PAUSED; },
  };

  // ---------------------------------------------------------------- the frame
  let lastFrameT = 0, frameSkip = 0, lastInteractive = false, PAUSED = false;
  const REVIEW_HOLD = {};
  const VIEW_W = 280, VIEW_H = 290, VIEW_UP = 160;                     // the patch round him (cells), most of it above his middle
  function tick(t, dt) {
    T = t;
    DPR = window.devicePixelRatio || 1;
    const wantPx = cellPx();
    if (wantPx !== CELLPX) resizeCells(wantPx);
    const w = REVIEW ? Math.max(1, Math.round(innerWidth * DPR)) : VIEW_W * CELLPX, h = REVIEW ? Math.round(959 * DPR) : VIEW_H * CELLPX;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w; cv.height = h;
      if (!REVIEW) Object.assign(cv.style, { inset: 'auto', left: '0', top: '0', width: w / DPR + 'px', height: h / DPR + 'px', willChange: 'transform' });
    }
    g.imageSmoothingEnabled = false;

    if (!REVIEW || RV.brain) brain(t, dt);
    if (KH.leap && t - KH.leap.t0 >= KH.leap.charge) launchLeap(t);
    if (KH.reach && KH.mode === 'free' && t - KH.reach.t0 >= 0.34) grabFromReach(t);
    if (KH.reach && KH.mode !== 'free') KH.reach = null;
    if (KH.later && KH.mode !== 'free' && KH.mode !== 'hang' && KH.mode !== 'air') KH.later = null;   // picked up: the plan is off
    if (KH.later && KH.mode === 'free' && !KH.walkTo && !KH.leap && !KH.reach && !KH.jump && t >= KH.later.at) { const f = KH.later.fn; KH.later = null; f(); }
    if (KH.jump && KH.jump.thenRide && t - KH.jump.t0 > KH.jump.dur * 0.5) beginRide(t);
    if (KH.sit && KH.mode !== 'free') KH.sit = null;
    if (KH.rageOnLand && KH.mode === 'free' && !KH.rage && !KH.nimbus) { KH.rageOnLand = false; blowUp(); }   // (after a hang or a climb)
    if (KH.rage) emoteStep(t, t < KH.hitUntil ? 0 : dt);
    nimbusStep(t, t < KH.hitUntil ? 0 : dt);
    peekStep(t, dt);

    let p, clip = null, ex = null;
    const sdt = t < KH.hitUntil ? 0 : dt;
    if (KH.mode === 'clip') {
      const c = KH.clip;
      KH.clipT += sdt;
      if (KH.clipT >= KH.clipUntil) { endClip(); p = freePose(t, dt); }
      else {
        const ct = c.loop ? R.pyMod(KH.clipT, c.dur) : KH.clipT;
        p = clipRoomPose(c, ct);
        clip = c; ex = clipExtras(c, ct);
        const prev = KH.clipPrev;
        for (const [st, kind, gain] of c.sfx) if ((prev < st && st <= ct) || (ct < prev && (st > prev || st <= ct))) sfx(kind, gain * 0.7);
        KH.clipPrev = ct;
      }
    } else if (KH.mode === 'held') p = heldPose(t, sdt);
    else if (KH.mode === 'air') p = airPose(t, sdt);
    else if (KH.mode === 'hang') p = hangPose(t, sdt);
    else if (KH.mode === 'wall') p = wallPose(t, sdt);
    else p = freePose(t, sdt);
    const RGs = KH.rage;
    if (NBX && NBX.whistle()) { /* calling the cloud: two rising notes */ }
    else if (RGs || (KH.mode !== 'held' && KH.mode !== 'air')) whistle(0, 500);
    roar(RGs && !RGs.out && RGs.frame >= 17 && RGs.frame <= 42 ? 0.5 : NBX && KH.nimbus ? NBX.wind() : 0);
    coolDown(sdt);
    if (KH.mode === 'held' && KH.held && KH.held.breakFree) {
      drag = null; cv.style.cursor = 'default';
      KH.held.vx = (Math.random() - 0.5) * 120; KH.held.vy = -80;
      KH.rageOnLand = true;
      throwHeld();
      sfx('boing', 0.6); shake(t, 0.9);
    }
    if (KH.blend) {
      const bw = ss((t - KH.blend.t0) / KH.blend.dur);
      if (bw >= 1) KH.blend = null; else p = mixPose(KH.blend.from, p, bw);
    }
    if (window.KhalfanHands && window.KhalfanHands.pose) p = window.KhalfanHands.pose(p, t, sdt) || p;   // (the kumma-basket routine, when one is loaded)
    KH.pose = p;
    // a landing he aimed for: whatever he meant to do there
    if (KH.mode === 'free' && KH.pendingThen) { const f = KH.pendingThen; KH.pendingThen = null; f(); }
    p = gazeStep(p, t, dt);                                              // his head on the cursor (drawn only; KH.pose stays plain)

    const q = R.full(p);
    const headM = R.mm(R.rootMatrix(q), R.headMatrix(q));
    const extra = springStep(headM, dt, q.kfree != null);

    // the screen: everything is drawn in cells, CELLPX device pixels each. Live, the canvas is a small window onto the
    // world that follows him (moved by the compositor), so a frame redraws a patch round him, not your whole screen.
    const MRq = R.rootMatrix(q);
    const centre = KM.ap(MRq, 0, -26);
    let vx0 = 0, vy0 = 0;
    if (!REVIEW) {
      vx0 = Math.round(centre[0] - VIEW_W / 2); vy0 = Math.round(centre[1] - VIEW_UP);
      if (vx0 !== KH.viewX || vy0 !== KH.viewY || CELLPX !== KH.viewPx) {
        KH.viewX = vx0; KH.viewY = vy0; KH.viewPx = CELLPX;
        cv.style.transform = `translate(${vx0 * CELLPX / DPR}px, ${vy0 * CELLPX / DPR}px)`;
      }
    }
    const sh = KH.shake ? KH.shake.amp * Math.exp(-(t - KH.shake.t0) * 12) : 0;
    if (KH.shake && sh < 0.02) KH.shake = null;
    const C = [CELLPX, 0, 0, CELLPX, -vx0 * CELLPX + (sh ? (Math.random() * 2 - 1) * sh * CELLPX : 0), -vy0 * CELLPX + (sh ? (Math.random() * 2 - 1) * sh * CELLPX : 0)];
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    if (REVIEW) drawReviewDesktop(C);
    if (KH.gone) { drawItems(particleItems(t), C); return; }

    const RGx = KH.rage;
    if (RGx) drawEmoteLight(C, t, false);                               // the power-up's light, round him only
    if (NBX && KH.nimbus) NBX.draw(C, 'back');                          // the cloud under him
    if (!(NBX && NBX.lifted())) drawShadow(p, C);
    const clipped = KH.sink > 0.5;
    if (clipped) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); g.rect(0, 0, cv.width, Math.round(groundY() * CELLPX + C[5])); g.clip(); }
    if (ex) { drawItems(ex.setB || [], C); drawItems(ex.partB || [], C); }
    if (KH.angerStage >= 2 && !RGx) {
      KH.steamAcc = (KH.steamAcc || 0) + 2.5 * sdt;
      while (KH.steamAcc >= 1) {
        KH.steamAcc -= 1;
        const sd = Math.random() < 0.5 ? -1 : 1;
        const [sx0, sy0] = KM.ap(headM, sd * 21, -33);
        parts.push({ kind: 'steam', t0: T, x: sx0, y: sy0, vx: sd * (40 + Math.random() * 45), vy: -(8 + Math.random() * 26), life: 0.4 + Math.random() * 0.3, size: (1.4 + Math.random() * 1.1) });
      }
    }
    const kItems = khalfanItems(p, extra, clip, ex);
    if (rhOn()) rhTrim(kItems);                                        // (on a window's edge: his hands beside his head, no arms)
    if (window.KhalfanHands && window.KhalfanHands.items) window.KhalfanHands.items(kItems, p);
    const spd = KH.mode === 'air' && KH.air ? Math.hypot(KH.air.vx, KH.air.vy) * VS * 1.4 : KH.mode === 'held' && KH.held ? (KH.held.energy || 0) : 0;
    if (spd > 230 && KH.ghosts.length === 4) {
      const a = clamp((spd - 230) / 320);
      for (const [k, al] of [[0, 0.1], [2, 0.2]]) { g.globalAlpha = al * a; drawItems(KH.ghosts[k], C); }
      g.globalAlpha = 1;
    }
    if (RGx) { drawEmoteFx(C, false); drawItems(emoteForm(kItems), C); drawEmoteFx(C, true); }   // the sheet's effects round him
    else drawItems(kItems, C);
    drawCupInHand(q, C, t);
    if (NBX && KH.nimbus) NBX.draw(C, 'front');                         // its front puffs over his feet
    KH.ghosts.push(kItems);
    if (KH.ghosts.length > 4) KH.ghosts.shift();
    if (ex) { drawItems(ex.partF || [], C); drawItems(ex.setF || [], C); }
    if (clipped) g.restore();
    drawItems(particleItems(t), C);
    if (rhOn()) drawItems(rearHangFx(kItems, t), C);
    if ((KH.mode === 'held' && KH.held && KH.held.dizzy) || (KH.mode === 'free' && t < KH.dizzyUntil)) {
      const hp = KM.ap(headM, 0, -28), its = [];
      for (let k = 0; k < 3; k++) { const a = t * 6 + k * 2.094; its.push({ spr: SMALL.star, M: KM.T(hp[0] + 13 * Math.cos(a), hp[1] + 3.5 * Math.sin(a)) }); }
      drawItems(its, C);
    }
    if (KH.angerStage >= 1 && !KH.rage) {
      const [vx0, vy0] = KM.ap(headM, 16, -25);
      const vs = 1 + 0.3 * Math.abs(Math.sin(t * 9));
      drawItems([{ spr: veinSpr(), M: KM.mul(KM.T(vx0, vy0), KM.S(vs, vs)) }], C);
    }
    const marks = KH.rage ? 0 : KH.angerStage >= 2 ? 2 : KH.angerStage >= 1 ? 1 : 0;
    if (marks) drawTemperMarks(q, t, marks, C);
    drawBubble(headM, C);
    if (RGx) { drawEmoteLight(C, t, true); drawCoffee(C, t); }
    fxFrame(t);                                                          // the bolt and the burning window, over the whole screen
    if (REVIEW) drawReviewCursor(C);

    // the mouse goes through the window everywhere except on him (and never while he rides the cursor)
    if (desk && !REVIEW) {
      const onCup = mouse.in && overCoffee(mouse.x, mouse.y);
      const over = onCup || (mouse.in && KH.nimbus && onCloud(mouse.x, mouse.y)) || (mouse.in && !(KH.mode === 'held' && KH.held && KH.held.ride) && hitKhalfan(mouse.x, mouse.y) && !userTargetAt(mouse.x, mouse.y));
      const want = !!drag || !!cupDrag || NBA.drag || over;
      // tell main, with his box on screen (it keeps the click-through safety net); refreshed while he has the mouse
      if (want !== lastInteractive || (want && t - (KH.boxSentT || 0) > 0.1)) {
        lastInteractive = want; KH.boxSentT = t;
        let box = null;
        if (want) {
          const k = 1 / kDip();
          const cs = [[-15, -52], [15, -52], [-15, 5], [15, 5]].map(([lx, ly]) => KM.ap(MRq, lx, ly));
          const B = brew();
          if (B && B.prompt) { const P0 = B.prompt; cs.push([P0.x - P0.w / 2 - 4, P0.y - P0.h / 2 - 6], [P0.x + P0.w / 2 + 4, P0.y + P0.h / 2 + 6]); }   // and his coffee bubble
          const NBs = KH.nimbus && NBX.state;
          if (NBs && NBs.spawned) { const k2 = NBs.frame - 1, cy2 = NBs.y + NBs.bobY + NBs.dip, hw = NB_DATA.bodyW[k2] * 0.5; cs.push([NBs.x - hw, cy2 + NB_DATA.deck[k2] - 2], [NBs.x + hw, cy2 + NB_DATA.bottom[k2] + 2]); }   // and his cloud
          const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
          box = { x: Math.min(...xs) * k, y: Math.min(...ys) * k, w: (Math.max(...xs) - Math.min(...xs)) * k, h: (Math.max(...ys) - Math.min(...ys)) * k };
        }
        desk.interactive(want, box, !!drag || !!cupDrag || NBA.drag);
      }
    }
    // lost somewhere off the screen: back he comes
    if (KH.mode === 'free' && (KH.x < -40 || KH.x > WD.W + 40)) respawn();
  }
  // still moments run at 30 fps (sitting, asleep, standing about), the rest at the screen's rate
  function calm() {
    return KH.mode === 'free' && KH.speed < 0.1 && !KH.jump && !KH.leap && !KH.reach && !KH.react && !KH.bubble && !KH.after && !KH.peek && !KH.rage && !KH.blend
      && parts.length === 0 && KH.sink < 0.01 && (KH.sitW === 0 || KH.sitW === 1) && T - KH.landT > 0.5 && !drag && KH.anger < 1 && !fxActive()
      && !(window.KhalfanHat && window.KhalfanHat.busy());              // (the kumma basket out: every frame, so it moves smoothly)
  }
  // frames: 60 a second when he moves (whatever the monitor's rate), 24 when he stands or sits about, 10 asleep
  function frame(now) {
    if (PAUSED) { lastFrameT = 0; return; }                             // hidden: no frames at all until he is shown again
    requestAnimationFrame(frame);
    if (manualClock) return;
    const t = now / 1000;
    const asleep = KH.sit && KH.sit.sleep && KH.mode === 'free' && !KH.react && !KH.bubble;
    const fps = asleep ? 10 : calm() ? (GZ.moving ? 40 : 24) : 60;     // his head turning after the cursor: 40
    if (lastFrameT && t - lastFrameT < 1 / fps - 0.002) return;
    const dt = clamp(t - (lastFrameT || t), 0, 1 / 12);
    lastFrameT = t;
    try { tick(t, dt); } catch (e) {
      // written to his log (the first few), and he starts over from a fresh drop rather than freezing
      KH.errors = (KH.errors || 0) + 1;
      if (desk && KH.errors <= 5) desk.log('frame error', e && e.stack || String(e));
      try { KH.mode = 'clip' === KH.mode ? 'free' : KH.mode; KH.clip = null; KH.blend = null; dropIn(t); } catch (e2) { /* next frame */ }
    }
    const fast = (!calm() && !asleep) || !!drag || KH.mode !== 'free';
    if (desk && fast !== KH.fastSent) { KH.fastSent = fast; desk.pace(fast); }
  }
  function resizeCells(px) {
    const old = CELLPX;
    CELLPX = px;
    if (!WD.raw) return;
    const f = old / px;
    KH.x *= f;
    applyWorld(WD.raw);
    parts = [];
    if (KH.mode === 'free' || KH.mode === 'clip') { if (KH.mode === 'clip') endClip(false); dropIn(T, KH.x); }
    else if (KH.mode === 'air' && KH.air) { KH.air.x *= f; KH.air.y *= f; KH.air.lowPrev = KH.air.y; }
    else if (KH.mode === 'hang') { KH.hang = null; dropIn(T, KH.x); }
    HANDS_UP = null;
  }

  // ---------------------------------------------------------------- the cursor and the world, from main.js
  function onTick(d) {
    const k = kDip();
    const x = d.mx * k, y = d.my * k;
    const inside = d.mx >= 0 && d.my >= 0 && d.mx < innerWidth && d.my < innerHeight;
    if (!drag) { mouse.x = x; mouse.y = y; }
    mouse.in = inside;
    const now = performance.now() / 1000;
    const mh = mouse.hist;
    const last = mh[mh.length - 1];
    if (!last || Math.hypot(x - last[1], y - last[2]) > 0.5) { mouse.moveT = T; }
    mh.push([now, x, y]);
    while (mh.length && now - mh[0][0] > 1.0) mh.shift();
    mouse.ld = d.ld; mouse.rd = d.rd;
    if (KH.mode === 'held' && KH.held && KH.held.ride) heldMove(x, y, now);
    const tdt = clamp(now - (mouse.tickT || now - 1 / 60), 1 / 240, 0.1);
    mouse.tickT = now;
    onTrackedRect(d.tr, tdt);
  }

  // ---------------------------------------------------------------- the tray icon: his face, drawn by the rig
  function trayIcon(n = 64) {
    const c2 = document.createElement('canvas');
    c2.width = c2.height = n;
    const g2 = c2.getContext('2d');
    g2.imageSmoothingEnabled = false;
    const p = stand(0, 0, 0);
    p.expr = 'happy';
    const items = R.parts(p, {});
    const s = Math.max(1, Math.floor(n / 62));                           // whole pixels per cell: crisp
    const base = [s, 0, 0, s, n / 2, n / 2 + 36 * s];                    // his head and kumma (cells -58 to -14) centred
    for (const it of items) {
      if (it.kind !== 'head' && it.kind !== 'kumma') continue;
      const m = R.mm(base, it.M);
      g2.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      g2.drawImage(sprCanvas(it.spr, baseLut()), -it.spr.ox, -it.spr.oy);
    }
    return c2.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const raw = window.KHALFAN_DATA;
    const [json, spr] = await Promise.all([gunzipB64(raw.json), gunzipB64(raw.spr)]);
    D = JSON.parse(new TextDecoder().decode(json));
    D.tables.EYES.rageeye = ['EE....', 'EWEE..', 'EWWWEE', 'EWWWWE', 'EWWWWE', '.EEEE.'];
    R.init(D.tables);
    BASE = D.tables.BASE;
    NUMKEYS = Object.keys(BASE);
    for (const [k, rows] of Object.entries(D.tables.SMALL)) SMALL[k] = R.sprite(rows);
    EXSPR = D.sprites.map(([w, h, ox, oy, off]) => ({ w, h, ox, oy, a: spr.subarray(off, off + w * h), id: 'x' + off }));
    // (public build: no library move is decoded; the moves and costumes come in later updates)
    NBX = makeNimbus();
    if (REVIEW) { document.body.classList.add('review'); await new Promise((r) => setTimeout(r, 500)); return runReview(REVIEW); }   // (its pictures decoded first)
    if (desk) {
      Object.assign(S, await desk.settings());
      CELLPX = cellPx();
      applyWorld(await desk.firstWorld());
      desk.onWorld(applyWorld);
      desk.onTick(onTick);
      desk.onEvent(onEvent);
      desk.onSettings((s) => { Object.assign(S, s); if (!S.sound) whistle(0, 500); });
      if (desk.onRage) desk.onRage((m) => {                              // the picture of the window his rage will strike
        if (!m || m.type !== 'shot' || !m.body) return;
        const load = (u) => new Promise((res) => { if (!u) { res(null); return; } const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = u; });
        Promise.all([load(m.body), load(m.top)]).then(([body, top]) => {
          if (!body) return;
          // put it together: the title bar's strip (cut from the screen) over the window's own picture, at its full size
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(m.w * DPR)); c.height = Math.max(1, Math.round(m.h * DPR));
          const cg = c.getContext('2d'), th = top ? Math.round(m.topH * DPR) : 0;
          if (top) cg.drawImage(top, 0, 0, c.width, th);
          cg.drawImage(body, 0, th, c.width, c.height - th);
          FX.shots.set(m.hwnd, { img: c, x: m.x, y: m.y, w: m.w, h: m.h });
        });
      });
      desk.onVisible((v) => {
        const was = PAUSED;
        PAUSED = !v;
        if (PAUSED) { whistle(0, 500); roar(0); if (AUD.ctx) AUD.ctx.suspend(); }
        else if (was) { if (AUD.ctx) AUD.ctx.resume(); requestAnimationFrame(frame); }
      });
      try { desk.trayIcon(trayIcon()); } catch (e) { /* no icon */ }
    }
    audioInit();
    if (desk) {
      window.addEventListener('error', (e) => desk.log('error', e.message, e.filename + ':' + e.lineno));
      window.addEventListener('unhandledrejection', (e) => desk.log('unhandled rejection', String(e.reason && e.reason.stack || e.reason)));
      desk.log('ready', JSON.stringify({ cellPx: CELLPX, dpr: DPR, W: Math.round(WD.W), H: Math.round(WD.H), floor: WD.floor.kind + '@' + Math.round(WD.floor.y), ledges: WD.plats.length - 1 }));
    }
    KH.plat = WD.floor;
    KH.x = WD.W * 0.7;
    dropIn(0.001, KH.x);
    KH.sayOnLand = LINES.hello;
    requestAnimationFrame(frame);
  }

  // ================================================================ review mode (npm run review -- <scenario>)
  // A pretend desktop (wallpaper, a chat window, a folder window, the taskbar), the clock stepped by hand, and
  // contact sheets of the frames: for checking every move without anyone's real screen.
  function drawReviewDesktop(C) {
    const k = 1 / kDip();
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (RV.wall && window.KhalfanReviewProps) window.KhalfanReviewProps.wallpaper(g, cv.width, cv.height);   // (the films)
    else {
      const gr = g.createLinearGradient(0, 0, cv.width, cv.height);
      gr.addColorStop(0, '#2b4c7e'); gr.addColorStop(1, '#88a7cf');
      g.fillStyle = gr; g.fillRect(0, 0, cv.width, cv.height);
    }
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    for (const r of RV.windows.slice().reverse()) {
      if (r.paint) { g.drawImage(r.paint, r.x, r.y, r.w, r.h); continue; }
      g.fillStyle = r.fav ? '#F4F0E6' : '#FBFBFB';
      g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = r.fav ? '#E9E3D4' : '#EDEFF3';
      g.fillRect(r.x, r.y, r.w, 15);
      g.fillStyle = '#3a3a3a';
      g.font = '600 7px "Segoe UI", sans-serif';
      g.textBaseline = 'middle'; g.direction = 'ltr'; g.textAlign = 'left';
      g.fillText(r.title, r.x + 8, r.y + 7.5);
      g.fillStyle = r.fav ? '#D97757' : '#9aa4b2';
      g.fillRect(r.x + 14, r.y + 30, r.w * 0.5, 4); g.fillRect(r.x + 14, r.y + 40, r.w * 0.35, 4);
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.5; g.strokeRect(r.x, r.y, r.w, r.h);
    }
    for (const ic of RV.icons || []) {                                   // the files: a folder picture and its name
      const k2 = kDip(), cx = (ic.x + ic.w / 2) * k2, side = ic.h * k2, y = ic.y * k2;
      if (/zip/i.test(ic.name)) { g.fillStyle = '#7d6bd8'; g.fillRect(cx - side * 0.36, y + side * 0.08, side * 0.72, side * 0.86); g.fillStyle = '#d9d2ff'; g.fillRect(cx - 1, y + side * 0.08, 2, side * 0.86); }
      else { g.fillStyle = '#e8b33f'; g.fillRect(cx - side * 0.46, y + side * 0.18, side * 0.92, side * 0.72); g.fillStyle = '#f6cf63'; g.fillRect(cx - side * 0.46, y + side * 0.3, side * 0.92, side * 0.6); }
      g.fillStyle = '#fff'; g.font = '600 6px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top'; g.direction = 'ltr';
      g.fillText(ic.name.length > 14 ? ic.name.slice(0, 13) + '…' : ic.name, cx, y + side + 1);
    }
    if (WD.taskbar) {
      const tb = WD.taskbar;
      g.fillStyle = 'rgba(28,32,40,0.92)'; g.fillRect(tb.x, tb.y, tb.w, tb.h);
      for (let i = 0; i < 7; i++) { g.fillStyle = i === 3 ? '#D97757' : '#5d6b80'; g.fillRect(WD.W / 2 - 60 + i * 18, tb.y + 6, 12, 12); }
    }
    void k;
  }
  // a stand-in arrow cursor for the review sheets (the real one is Windows' own, drawn over everything)
  function drawReviewCursor(C) {
    if (!mouse.in) return;
    g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
    g.beginPath();
    const x = mouse.x, y = mouse.y;
    g.moveTo(x, y); g.lineTo(x, y + 11); g.lineTo(x + 2.6, y + 8.4); g.lineTo(x + 4.6, y + 12.4); g.lineTo(x + 6, y + 11.7); g.lineTo(x + 4.1, y + 7.9); g.lineTo(x + 7.6, y + 7.9); g.closePath();
    g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 0.6; g.stroke();
  }
  const RV = { windows: [] };
  const RV_ICONS = ['Recycle Bin', 'Photos', 'Homework', 'Games', 'Music', 'Notes', 'Pictures.zip']
    .map((name, i) => ({ i, name, x: 0, y: 3 + i * 76, w: 77, h: 30, yb: 3 + i * 76 + 50 }));
  function reviewWorld(wins, icons = RV_ICONS) {
    RV.windows = wins; RV.icons = icons;
    const W = 1707, H = 959, floorY = 911;
    const ledges = [], occ = [];
    for (const r of wins) {
      let segs = [[Math.max(0, r.x), Math.min(W, r.x + r.w)]];
      for (const o of occ) if (o.y < r.y + 1 && o.y + o.h > r.y - 1) segs = segs.flatMap(([a, b]) => { const out = []; if (o.x + o.w <= a || o.x >= b) return [[a, b]]; if (o.x > a) out.push([a, o.x]); if (o.x + o.w < b) out.push([o.x + o.w, b]); return out; });
      for (const [x0, x1] of segs) if (x1 - x0 >= 70) ledges.push({ hwnd: r.hwnd, x0, x1, y: r.y, kind: r.fav ? 'fav' : 'window', title: r.title, full: true });
      occ.push(r);
    }
    const k = kDip();
    RV.windows = wins.map((r) => Object.assign({}, r, { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }));
    const ov = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const icons2 = icons.map((ic) => Object.assign({}, ic, { open: !wins.some((r) => ov(r, { x: ic.x, y: ic.y, w: ic.w, h: ic.yb - ic.y })) }));
    applyWorld({ W, H, floorY, taskbar: { x: 0, y: floorY, w: W, h: H - floorY }, ledges, rects: wins.map((r, z) => Object.assign({ max: false, z, normal: true, cls: /Explorer/.test(r.title) ? 'CabinetWClass' : 'Chrome_WidgetWin_1' }, r)), icons: icons2, fg: null, idle: 2000, hour: 15 });
  }
  function moveReviewWindow(hwnd, dx, dy) {
    const k = kDip();
    const r = RV.windows.find((w) => w.hwnd === hwnd);
    if (!r) return;
    r.x += dx * k; r.y += dy * k;
    const tr = { hwnd, x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k };
    onTrackedRect(tr, 1 / 60);
  }
  async function runReview(name) {
    manualClock = true;
    DPR = window.devicePixelRatio || 1;
    CELLPX = cellPx();
    cv.width = Math.round(innerWidth * DPR); cv.height = Math.round(959 * DPR);
    const WINS = [
      { hwnd: 11, title: 'Chat', fav: true, x: 960, y: 250, w: 660, h: 560 },
      { hwnd: 22, title: 'Homework — File Explorer', fav: false, x: 260, y: 470, w: 520, h: 410 },
    ];
    reviewWorld(WINS);
    const sheetFrames = [];
    let t = 0;
    const step = (sec, each) => { const n = Math.max(1, Math.round(sec * 60)); for (let i = 0; i < n; i++) { t += 1 / 60; if (each) each(t); tick(t, 1 / 60); } };
    const snap = (label, full) => {
      const c2 = document.createElement('canvas');
      const p = KH.pose;
      const cx = p ? KM.ap(R.rootMatrix(R.full(p)), 0, -26) : [KH.x, groundY() - 26];
      if (full === true || full === 'big') {
        const bw = full === 'big' ? 800 : 400;
        c2.width = bw; c2.height = bw * 0.75;
        const g2 = c2.getContext('2d');
        g2.fillStyle = '#20242c'; g2.fillRect(0, 0, c2.width, c2.height);
        g2.drawImage(cv, 0, 0, cv.width, cv.height, 0, bw * 0.1, bw, bw * 0.5625);
        sheetFrames.push({ c: c2, label });
        return;
      }
      const cw = full === 'wide' ? 160 : 100, ch = full === 'wide' ? 120 : 75;   // cells around him, drawn big
      const sx = (cx[0] - cw / 2) * CELLPX, sy = (cx[1] - ch / 2 - (full === 'wide' ? 24 : 4)) * CELLPX;
      c2.width = 400; c2.height = 300;
      const g2 = c2.getContext('2d');
      g2.imageSmoothingEnabled = false;
      g2.fillStyle = '#20242c'; g2.fillRect(0, 0, c2.width, c2.height);
      g2.drawImage(cv, sx, sy, cw * CELLPX, ch * CELLPX, 0, 0, c2.width, c2.height);
      sheetFrames.push({ c: c2, label });
    };
    const sheet = (nm, cols = 6) => {
      const W0 = Math.max(...sheetFrames.map((f) => f.c.width)), H0 = Math.max(...sheetFrames.map((f) => f.c.height)) + 18;
      const rows = Math.ceil(sheetFrames.length / cols);
      const s2 = document.createElement('canvas');
      s2.width = cols * W0; s2.height = rows * H0;
      const g2 = s2.getContext('2d');
      g2.fillStyle = '#111'; g2.fillRect(0, 0, s2.width, s2.height);
      sheetFrames.forEach((f, i) => {
        const x = (i % cols) * W0, y = Math.floor(i / cols) * H0;
        g2.drawImage(f.c, x, y);
        g2.fillStyle = '#ddd'; g2.font = '12px Consolas, monospace'; g2.fillText(f.label, x + 4, y + H0 - 5);
      });
      desk.reviewSheet(nm, s2.toDataURL('image/png'));
      sheetFrames.length = 0;
    };
    const lbl = () => `${t.toFixed(2)}s ${KH.mode}${KH.sit ? (KH.sit.sleep ? ' sleep' : ' sit') : ''}${KH.peek ? ' peek:' + KH.peek.stage : ''}${KH.hang ? ' hang' : ''}`;
    const fav = () => WD.plats.find((Q) => Q.kind === 'fav');
    const folder = () => WD.plats.find((Q) => Q.hwnd === 22);
    const settle = () => { KH.plat = WD.floor; KH.mode = 'free'; KH.x = 700; KH.air = null; KH.hang = null; KH.held = null; KH.sit = null; KH.sitW = 0; KH.peek = null; KH.sink = 0; KH.blend = null; KH.react = null; KH.after = null; KH.anger = 0; KH.angerStage = 0; KH.rage = null; KH.dizzyUntil = 0; KH.jump = null; KH.leap = null; parts = []; KH.bubble = null; };
    const scen = name === 'all' ? ['tour', 'fling', 'ride', 'window', 'peek', 'moves', 'temper'] : name.split(',');
    for (const sc of scen) {
      settle();
      mouse.in = true; mouse.x = 400; mouse.y = 200;
      try {
      if (sc === 'tour') {
        step(0.5); snap('stand ' + lbl());
        KH.walkTo = { x: 760, speed: 15 }; step(0.6); snap('walk ' + lbl()); step(0.6); snap('walk ' + lbl());
        KH.walkTo = { x: 640, speed: 32 }; step(0.5); snap('run ' + lbl());
        step(2); sitDown(20); step(0.15); snap('sitting ' + lbl()); step(0.6); snap(lbl()); step(1.0); snap(lbl());
        sleep(); step(2.5); snap('asleep ' + lbl());
        WD.idle = 100; step(0.1); wake(t, true); step(0.3); snap('wake ' + lbl()); step(1.2); snap(lbl());
        desk.log('goTo fav', goTo(fav(), 700)); step(0.2); snap('to fav ' + lbl());
        for (let i = 0; i < 16; i++) { step(0.25); snap(lbl()); if (KH.plat && KH.plat.kind === 'fav' && KH.mode === 'free' && T - KH.landT > 0.5) break; }
        step(2); snap('on fav ' + lbl(), true);
        sitDown(20); step(1.2); snap('sit on fav ' + lbl());
        KH.sit = null; step(0.6);
        const Q = fav(); KH.plat = Q; KH.x = qhi(Q) - 20; KH.walkTo = { x: qhi(Q), speed: 15, then: () => hangOff(Q, 1, T) };
        REVIEW_HOLD.hang = true;
        step(1.8); snap('hang off ' + lbl()); step(0.5); snap(lbl());
        desk.log('tour: before climb', lbl(), 'plat', KH.plat && KH.plat.kind, 'x', KH.x.toFixed(1));
        REVIEW_HOLD.hang = false; if (KH.hang) { KH.hang.next = 'climb'; KH.hang.dur = 0; } step(0.25); snap('climb ' + lbl()); step(0.3); snap(lbl()); step(0.6); snap(lbl());
        sheet('tour');
      } else if (sc === 'fling') {
        step(0.4);
        const p = KH.pose; const hp = KM.ap(R.rootMatrix(R.full(p)), 0, -40);
        mouse.x = hp[0]; mouse.y = hp[1]; grabAt(hp[0], hp[1], false);
        for (let i = 0; i < 16; i++) { step(1 / 30, () => { mouse.y -= 7; mouse.x += 2; heldMove(mouse.x, mouse.y, t); }); }
        snap('lift ' + lbl());
        for (let i = 0; i < 24; i++) step(1 / 30, () => { mouse.x += 3 * Math.sin(t * 9); heldMove(mouse.x, mouse.y, t); });
        snap('swing ' + lbl());
        for (let i = 0; i < 8; i++) step(1 / 60, () => { mouse.x += 14; mouse.y -= 7; heldMove(mouse.x, mouse.y, t); });
        snap('throw ' + lbl());
        throwHeld();
        for (let i = 0; i < 18; i++) { step(0.12); snap(lbl()); if (KH.mode === 'hang') { REVIEW_HOLD.hang = true; } }
        step(1.0); snap(lbl());
        REVIEW_HOLD.hang = false;
        for (let i = 0; i < 6; i++) { step(0.3); snap(lbl()); }
        snap('end ' + lbl(), true);
        sheet('fling');
      } else if (sc === 'ride') {
        step(0.3);
        mouse.x = KH.x + 2; mouse.y = groundY() - 70; mouse.moveT = t - 2;
        S.mischief = true; BR.rideCool = 0;
        startRide(t); step(0.08); snap('jump ' + lbl()); step(0.2); snap(lbl());
        const mx0 = mouse.x;
        for (let i = 0; i < 12; i++) { step(0.15, () => { mouse.x = mx0 + 60 * Math.sin(t * 1.6); mouse.y -= 0.4; if (KH.held) heldMove(mouse.x, mouse.y, t); }); snap('ride ' + lbl()); }
        throwHeld(true); for (let i = 0; i < 5; i++) { step(0.2); snap('let go ' + lbl()); }
        sheet('ride');
      } else if (sc === 'window') {
        KH.plat = folder(); KH.x = (folder().x0 + folder().x1) / 2; step(0.5); snap('on folder ' + lbl());
        for (let i = 0; i < 20; i++) { step(1 / 60, () => moveReviewWindow(22, 4, 0)); }
        snap('dragged slow ' + lbl());
        for (let i = 0; i < 12; i++) { step(1 / 60, () => moveReviewWindow(22, 24, -6)); }
        snap('dragged fast ' + lbl());
        for (let i = 0; i < 4; i++) { step(1 / 60, () => moveReviewWindow(22, 0, 0)); }
        snap('stopped dead ' + lbl());
        for (let i = 0; i < 12; i++) { step(0.12); snap(lbl()); }
        sheet('window');
      } else if (sc === 'jump') {
        KH.x = 640; step(0.3);
        desk.log('goTo', goTo(fav(), 640), JSON.stringify(KH.walkTo && { x: KH.walkTo.x }));
        for (let i = 0; i < 40; i++) {
          step(0.05);
          if (KH.mode === 'air' && KH.air) desk.log(t.toFixed(2), 'air y', KH.air.y.toFixed(1), 'vy', KH.air.vy.toFixed(0), 'yg', (KH.air.y - 46).toFixed(1), 'Qy', fav().y, 'catch', KH.air.canCatch, 'leap', KH.air.leap);
          else desk.log(t.toFixed(2), KH.mode, KH.leap ? 'leap ' + KH.leap.kind + ' ' + JSON.stringify(KH.leap.plan) : '');
          if (i % 3 === 0) snap(lbl());
        }
        sheet('jump');
        settle(); KH.plat = fav(); KH.x = fav().x1 - 30; step(0.2);
        REVIEW_HOLD.hang = true; hangOff(fav(), 1, T); step(0.6); snap('hang ' + lbl());
        REVIEW_HOLD.hang = false; KH.hang.dur = 0; KH.hang.next = 'climb';
        for (let i = 0; i < 14; i++) { step(0.05); snap(lbl()); }
        snap('full ' + lbl(), true);
        sheet('climb');
      } else if (sc === 'files') {
        // from the taskbar to his favourite file (his own zip), sit on it, read its name, hop down
        KH.x = 90; step(0.3); snap('start ' + lbl());
        desk.log('visit', visitIcon(t, 'sit'));
        for (let i = 0; i < 12; i++) { step(0.3); snap(lbl() + ' ' + (KH.plat && KH.plat.name || KH.plat.kind)); if (KH.sit && KH.sitW > 0.9) break; }
        step(0.8); snap('sitting on ' + (KH.plat.name || '') + ' ' + lbl(), false);
        snap('full ' + lbl(), true);
        KH.sit = null; step(0.5); readIcon(); step(0.6); snap('reading ' + lbl()); step(0.6); snap(lbl());
        hopDown(); for (let i = 0; i < 6; i++) { step(0.25); snap('hop down ' + lbl()); }
        sheet('files');
      } else if (sc === 'ladder') {
        const col = WD.cols.find((c) => c.icons.length > 3);
        KH.plat = col.icons[0]; KH.x = col.icons[0].cx; step(0.3); snap('bottom rung ' + lbl());
        desk.log('climb', climbColumn(col));
        for (let i = 0; i < 40; i++) { step(0.25); if (i % 2 === 0) snap(lbl() + ' ' + (KH.plat && (KH.plat.name || KH.plat.kind))); }
        snap('full ' + lbl(), true);
        sheet('ladder');
      } else if (sc === 'peekfile') {
        const ic = WD.icons.find((c) => /Homework$/.test(c.name));
        KH.plat = ic; KH.x = ic.cx; step(0.3); startPeek();
        for (let i = 0; i < 24; i++) { step(0.25); snap(lbl() + ' ' + (KH.plat.name || '')); }
        sheet('peekfile');
      } else if (sc === 'dangle') {
        KH.x = 500; step(0.3); dangle(T);
        for (let i = 0; i < 14; i++) { step(0.3); snap('taskbar ' + lbl()); if (i === 3) { const c3 = document.createElement('canvas'); c3.width = 600; c3.height = 200; const g3 = c3.getContext('2d'); g3.imageSmoothingEnabled = false; g3.drawImage(cv, (KH.hang ? KH.hang.hx : KH.x) * CELLPX - 300, cv.height - 200, 600, 200, 0, 0, 600, 200); desk.reviewSheet('dangle-raw', c3.toDataURL('image/png')); } if (i < 3) desk.log('dangle', JSON.stringify({ y: KH.pose.y, pvy: KH.pose.pvy, sink: KH.sink, floor: WD.floor.y, H: WD.H, gone: KH.gone, mode: KH.mode, items: khalfanItems(KH.pose, [0,0,0], null, null).length })); }
        settle(); KH.plat = fav(); KH.x = fav().x0 + 200; step(0.3); dangle(T);
        for (let i = 0; i < 8; i++) { step(0.35); snap('fav ' + lbl()); }
        sheet('dangle');
      } else if (sc === 'bar') {
        startAir({ x: 420, y: 230, vx: 40, vy: -420, self: false, canCatch: true });
        for (let i = 0; i < 26; i++) { step(0.2); snap(lbl()); }
        snap('full ' + lbl(), true);
        sheet('bar');
      } else if (sc === 'wall') {
        const wf0 = wallFor(WD.floor, null);
        desk.log('wall', wf0 ? JSON.stringify({ x: wf0.w.x, side: wf0.w.side, bx: wf0.bx, top: wf0.top.kind }) : 'none');
        if (wf0) {
          KH.x = wf0.bx - wf0.w.side * 40; step(0.3); startWall(wf0, null);
          for (let i = 0; i < 40; i++) { step(0.25); if (i % 2 === 0 || KH.mode === 'hang') snap(lbl() + ' y' + (KH.wallc ? Math.round(KH.wallc.y) : '')); if (KH.mode === 'free' && KH.plat === wf0.top && i > 4) { step(0.6); snap('on top ' + lbl()); break; } }
          snap('full ' + lbl(), true);
        }
        sheet('wall');
      } else if (sc === 'manners') {
        const ic = WD.icons.find((c) => /Homework$/.test(c.name));
        KH.plat = ic; KH.x = ic.cx; step(0.3); sitDown(30); step(1.0); snap('sitting ' + lbl());
        RV.brain = true; BR.next = 1e9; BR.iconsOpen = 99; BR.rideCool = 1e9; BR.chaseCool = 1e9;
        mouse.in = true; mouse.x = ic.cx + 2; mouse.y = ic.y + 6; mouse.moveT = t;
        for (let i = 0; i < 24; i++) { step(0.2); if (i % 2 === 0) snap('cursor on his file ' + lbl() + ' ' + (KH.plat && (KH.plat.name || KH.plat.kind))); }
        RV.brain = false;
        desk.log('manners: over a file =', userTargetAt(ic.cx, ic.y + 6), 'over taskbar =', userTargetAt(400, WD.floor.y + 4), 'over wallpaper =', userTargetAt(400, 200));
        sheet('manners');
      } else if (sc === 'resize') {
        // the tray's sizes while he is in every state: standing, sitting, on a window, hanging, in the air, held
        const states = [
          ['stand', () => {}],
          ['sit', () => sitDown(30)],
          ['fav', () => { KH.plat = fav(); KH.x = fav().x0 + 100; }],
          ['hang', () => { KH.plat = fav(); KH.x = fav().x1 - 20; hangOff(fav(), 1, T); REVIEW_HOLD.hang = true; }],
          ['air', () => dropIn(T, 500)],
          ['held', () => { const hp = KM.ap(R.rootMatrix(R.full(KH.pose)), 0, -40); mouse.x = hp[0]; mouse.y = hp[1]; grabAt(hp[0], hp[1], false); }],
        ];
        for (const [nm, setup] of states) {
          for (const sz of ['large', 'small', 'medium']) {
            settle(); S.size = 'medium'; step(0.2); setup(); step(0.2);
            S.size = sz; step(0.4); snap(`${nm} -> ${sz} ${lbl()} px${CELLPX}`);
            REVIEW_HOLD.hang = false;
          }
        }
        S.size = 'medium';
        sheet('resize');
      } else if (sc === 'done') {
        KH.plat = fav(); KH.x = fav().x0 + 160; step(0.4); snap('on fav ' + lbl());
        onEvent({ type: 'done' }); for (let i = 0; i < 7; i++) { step(0.2); snap('done ' + lbl()); }
        onEvent({ type: 'done' }); step(0.3); snap('2nd done in 20 s: ignored ' + lbl());
        sheet('done');
      } else if (sc === 'room') {
        // picked up off the taskbar and let go inside his favourite window: he falls to its bottom edge, goes to sit by the
        // corner; the window moved and resized carries him; a shake throws him out; dropped in the folder he hops out later
        const resizeWin = (hwnd, dw, dh) => { const k = kDip(); const r = RV.windows.find((w) => w.hwnd === hwnd); r.w += dw * k; r.h += dh * k; onTrackedRect({ hwnd, x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k }, 1 / 60); };
        const carry = (tx, ty, sec) => {
          const p0 = KH.pose; const hp = KM.ap(R.rootMatrix(R.full(p0)), 0, -40);
          mouse.x = hp[0]; mouse.y = hp[1]; grabAt(hp[0], hp[1], false);
          const n = Math.round(sec * 30), x0 = mouse.x, y0 = mouse.y;
          for (let i = 1; i <= n; i++) step(1 / 30, () => { const f = ss(i / n); mouse.x = lerp(x0, tx, f); mouse.y = lerp(y0, ty, f); heldMove(mouse.x, mouse.y, t); });
          step(0.3, () => heldMove(mouse.x, mouse.y, t));
        };
        KH.x = 560; step(0.4);
        carry(700, 230, 1.2); snap('carried into the chat window ' + lbl(), true);
        throwHeld();
        for (let i = 0; i < 6; i++) { step(0.15); snap('let go ' + lbl() + ' ' + KH.plat.kind); }
        RV.brain = true; BR.next = 0;
        for (let i = 0; i < 10; i++) { step(0.5); snap('settles ' + lbl() + ' ' + KH.plat.kind); if (KH.sit && KH.sitW > 0.95) break; }
        RV.brain = false;
        snap('by the edge ' + lbl(), true);
        for (let i = 0; i < 30; i++) step(1 / 60, () => moveReviewWindow(11, -3, 1));
        snap('window moved ' + lbl() + ' ' + KH.plat.kind, true);
        for (let i = 0; i < 30; i++) step(1 / 60, () => resizeWin(11, 0, -2));
        snap('window shorter ' + lbl());
        for (let i = 0; i < 30; i++) step(1 / 60, () => resizeWin(11, -4, 0));
        snap('window narrower ' + lbl());
        for (let i = 0; i < 10; i++) step(1 / 60, () => moveReviewWindow(11, 36, -10));
        for (let i = 0; i < 4; i++) step(1 / 60, () => moveReviewWindow(11, 0, 0));
        for (let i = 0; i < 6; i++) { step(0.15); snap('shaken out ' + lbl() + ' ' + KH.plat.kind); }
        settle(); KH.x = 400; step(0.4);
        carry(300, 330, 1.0); throwHeld();
        for (let i = 0; i < 4; i++) { step(0.25); snap('into the folder ' + lbl() + ' ' + KH.plat.kind); }
        step(1.0); hopOut(T);
        for (let i = 0; i < 8; i++) { step(0.2); snap('hops out ' + lbl() + ' ' + KH.plat.kind); }
        snap('full ' + lbl(), true);
        sheet('room');
      } else if (sc === 'nimbus') {
        // the Flying Nimbus: he calls it from the taskbar, it streaks in, he hops on; dragged through the air and let
        // go; then left alone he flies his little tour and lands on a ledge
        KH.x = 600; step(0.4);
        desk.log('nimbus: call', nimbusCall(), 'NBX', !!NBX);
        const ph = () => (NBX.state ? NBX.state.phase : 'none');
        for (let i = 0; i < 24; i++) { step(0.3); if (i % 2 === 0 || ph() === 'board') snap('call ' + ph() + ' ' + lbl(), 'wide'); if (ph() === 'ride') break; }
        step(0.6); snap('riding ' + ph(), 'wide');
        // you drag him up and to the left, and let go
        const p0 = KH.pose, hp = KM.ap(R.rootMatrix(R.full(p0)), 0, -30);
        const ev = (x, y) => ({ clientX: x / kDip(), clientY: y / kDip() });
        mouse.x = hp[0]; mouse.y = hp[1];
        NBX.down(hp[0], hp[1], ev(hp[0], hp[1])); NBA.drag = true;
        for (let i = 1; i <= 20; i++) step(1 / 30, () => { mouse.x -= 9; mouse.y -= 5; NBX.move(mouse.x, mouse.y, ev(mouse.x, mouse.y)); });
        snap('dragged ' + ph(), 'wide');
        NBA.drag = false; NBX.up();
        step(0.6); snap('let go, gliding ' + ph(), 'wide');
        snap('full ' + ph(), true);
        for (let i = 0; i < 90; i++) {
          step(0.5);
          if (i % 5 === 0 || ph() === 'land' || ph() === 'hopoff') snap('pilot ' + ph() + ' ' + Math.round(NBX.state ? NBX.state.x : KH.x) + ',' + Math.round(NBX.state ? NBX.state.y : 0) + ' ' + (KH.plat.kind || ''), 'wide');
          if (!NBX.active()) { step(0.6); snap('landed on ' + KH.plat.kind + ' ' + lbl(), 'wide'); break; }
        }
        snap('full end ' + lbl() + ' ' + KH.plat.kind, true);
        desk.log('nimbus end', ph(), KH.mode, KH.plat.kind, Math.round(KH.x), Math.round(groundY()));
        sheet('nimbus', 6);
      } else if (sc === 'allmoves') {
        // the game's moves the desktop never played before (set pieces, flights, feelings), on the taskbar
        for (const key of ['bench-sit', 'bar-hang', 'push-pull', 'detective', 'peek-sneak', 'dash-brake', 'hero-flight', 'cape-hero', 'ninja', 'sad-cry', 'angry-calm', 'scared']) {
          settle(); KH.x = 420; step(0.2);
          const ok = playMove(key, { mirror: false });
          const c = CLIPS[key];
          for (let i = 0; i < 40 && KH.mode !== 'clip'; i++) step(0.25);   // (he walks to where it fits first)
          step(c.dur * 0.25); snap(key + ' ' + (ok ? '' : 'NO ROOM ') + lbl(), 'wide'); step(c.dur * 0.3); snap(key + ' ' + lbl(), 'wide'); step(c.dur * 0.3); snap(key + ' ' + lbl(), 'wide');
        }
        sheet('allmoves', 6);
      } else if (sc === 'gaze') {
        // his head on the cursor: eight directions round him, on his face, far away; then sitting and hanging
        const DIRS = [['right', 44, -8], ['up-right', 40, -34], ['up', 0, -36], ['up-left', -40, -34], ['left', -44, -8], ['down-left', -40, 28], ['down', 0, 30], ['down-right', 40, 28], ['on his face', 2, -8], ['far right', 420, -30], ['far up-left', -380, -300]];
        const look = (nm, dx, dy, pre) => {
          const p0 = KH.pose; const c0 = KM.ap(R.rootMatrix(R.full(p0)), 0, -26);
          mouse.in = true; mouse.x = c0[0] + dx; mouse.y = c0[1] + dy;
          step(0.7, () => { mouse.moveT = t; }); snap(pre + nm + ' yaw' + Math.round(GZ.yaw) + ' up' + GZ.up.toFixed(2));
          { const gp = gazeStep(KH.pose, t, 0); const its = khalfanItems(gp, [0, 0, 0], null, null); const hk = its.find((it) => it.kind === 'kumma'); desk.log('gaze', pre + nm, JSON.stringify({ yaw: +KH.pose.yaw.toFixed(1), hyaw: gp.hyaw, hrot: +(gp.hrot || 0).toFixed(1), hdy: +gp.hdy.toFixed(2), eyes: gp.eyes, expr: gp.expr, look: gp.look, ktilt: hk && hk.tilt, kyaw: hk && hk.yaw, spring: KH.spring.st.map((v) => +v.toFixed(2)) })); }
        };
        KH.x = 700; step(0.4);
        for (const [nm, dx, dy] of DIRS) look(nm, dx, dy, '');
        settle(); KH.plat = fav(); KH.x = fav().x0 + 200; step(0.3); sitDown(60); step(1.0);
        for (const [nm, dx, dy] of DIRS.slice(0, 8)) look(nm, dx, dy, 'sit ');
        settle(); KH.plat = fav(); KH.x = fav().x1 - 20; REVIEW_HOLD.hang = true; hangOff(fav(), 1, T); step(1.0);
        for (const [nm, dx, dy] of [DIRS[0], DIRS[2], DIRS[4], DIRS[6]]) look(nm, dx, dy, 'hang ');
        REVIEW_HOLD.hang = false;
        sheet('gaze', 7);
      } else if (sc === 'icon') {
        desk.reviewSheet('icon', trayIcon(260));
      } else if (sc === 'sit') {
        KH.plat = fav(); KH.x = fav().x0 + 120; step(0.3); snap('stand ' + lbl());
        sitDown(30); for (let i = 0; i < 5; i++) { step(0.3); snap(lbl()); }
        sleep(); for (let i = 0; i < 3; i++) { step(0.8); snap(lbl()); }
        settle(); step(0.3); sitDown(30); step(1.0); snap('on taskbar ' + lbl()); step(0.5); snap(lbl());
        sheet('sit');
      } else if (sc === 'peek') {
        step(0.3); startPeek();
        for (let i = 0; i < 20; i++) { step(0.25); snap(lbl()); }
        sheet('peek');
      } else if (sc === 'moves') {
        for (const key of ['wave-bow', 'groove-loop', 'kumma-tip', 'reading', 'celebrate', 'lie-back']) {
          settle(); step(0.2); playMove(key, { mirror: false, dur: 4 }); step(1.2); snap(key + ' ' + lbl()); step(1.4); snap(key + ' ' + lbl());
        }
        sheet('moves');
      } else if (sc === 'temper') {
        // cross in two steps, then cooling off by himself (a huff, a sigh); then pushed past it: the angry power-up, and
        // the coffee carried from its bubble onto him
        step(0.3);
        addAnger(1.05); step(0.6); snap('stage1 ' + lbl());
        addAnger(1.0); step(0.6); snap('stage2 ' + lbl());
        for (let i = 0; i < 4; i++) { step(0.8); snap('cooling st' + KH.angerStage + ' ' + lbl()); }
        addAnger(1.05); addAnger(1.0); addAnger(1.3);
        const fr = () => (KH.rage ? ' f' + KH.rage.frame + (KH.rage.flash ? ' ' + KH.rage.flash : '') : '');
        for (let i = 0; i < 17; i++) { step(i < 12 ? 0.33 : 0.5); snap('power-up' + fr() + ' ' + lbl()); }
        snap('full' + fr(), true);
        const B = KH.rage;
        if (B && B.prompt) {
          const P0 = B.prompt; B.cup = { x: P0.x, y: P0.y, held: true };
          for (let i = 1; i <= 12; i++) step(1 / 30, () => { B.cup.x = lerp(P0.x, KH.x + 2, i / 12); B.cup.y = lerp(P0.y, groundY() - 34, i / 12); });
          snap('carrying the coffee ' + lbl());
          giveCoffee({ moved: true });
        } else desk.log('temper: no coffee bubble', !!B);
        for (let i = 0; i < 12; i++) { step(0.3); snap('coffee' + fr() + ' ' + lbl()); }
        sheet('temper', 7);
        // nobody brings coffee: after a while he gets over it by himself
        settle(); step(0.3); blowUp(); step(EM_TL.intro + 0.5); snap('waiting' + fr() + ' ' + lbl()); step(3.5); snap('the coffee bubble' + fr(), 'wide');
        step(EM_WAIT + 0.2); snap('gave up waiting' + fr() + ' ' + lbl()); step(0.6); snap(lbl()); step(1.0); snap(lbl());
        sheet('temper-wait');
      } else if (sc === 'refshot') {
        // clean pictures of him for an image AI: one art pixel to a cell, standing as usual (front, three-quarter, back),
        // on white and enlarged 8 times with no smoothing; also the 1:1 pixels on clear (review/ref-*.png)
        const poses = [['front', stand(0, 0, 0)], ['three-quarter', stand(40, 0, 0)], ['back', stand(180, 0, 0)]];
        const shots = [];
        for (const [nm, p] of poses) {
          p.x = 60; p.y = 90; p.expr = 'rest';
          const its = khalfanItems(p, [0, 0, 0], null, null);
          g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 200, 120); g.imageSmoothingEnabled = false;
          drawItems(its, [1, 0, 0, 1, 0, 0]);
          g.setTransform(1, 0, 0, 1, 0, 0);
          const d = g.getImageData(0, 0, 200, 120).data;
          let x0 = 200, y0 = 120, x1 = 0, y1 = 0;
          for (let j = 0; j < 120; j++) for (let i = 0; i < 200; i++) if (d[(j * 200 + i) * 4 + 3] > 0) { x0 = Math.min(x0, i); y0 = Math.min(y0, j); x1 = Math.max(x1, i); y1 = Math.max(y1, j); }
          const w = x1 - x0 + 1, h = y1 - y0 + 1, one = document.createElement('canvas');
          one.width = w; one.height = h; one.getContext('2d').drawImage(cv, x0, y0, w, h, 0, 0, w, h);
          desk.reviewSheet('ref-' + nm + '-1x', one.toDataURL('image/png'));
          shots.push([nm, one]);
          desk.log('refshot', nm, w + ' x ' + h + ' pixels');
        }
        const k = 8, pad = 6, W2 = shots.reduce((a2, [, c2]) => a2 + (c2.width + pad * 2) * k, 0), H2 = Math.max(...shots.map(([, c2]) => c2.height)) * k + pad * 2 * k;
        const big = document.createElement('canvas');
        big.width = W2; big.height = H2;
        const bg2 = big.getContext('2d');
        bg2.fillStyle = '#ffffff'; bg2.fillRect(0, 0, W2, H2); bg2.imageSmoothingEnabled = false;
        let ox = 0;
        for (const [nm, c2] of shots) {
          bg2.drawImage(c2, 0, 0, c2.width, c2.height, ox + pad * k, H2 - pad * k - c2.height * k, c2.width * k, c2.height * k);
          const solo = document.createElement('canvas');
          solo.width = (c2.width + pad * 2) * k; solo.height = (c2.height + pad * 2) * k;
          const sg = solo.getContext('2d'); sg.fillStyle = '#ffffff'; sg.fillRect(0, 0, solo.width, solo.height); sg.imageSmoothingEnabled = false;
          sg.drawImage(c2, 0, 0, c2.width, c2.height, pad * k, pad * k, c2.width * k, c2.height * k);
          desk.reviewSheet('ref-' + nm + '-8x', solo.toDataURL('image/png'));
          ox += (c2.width + pad * 2) * k;
        }
        desk.reviewSheet('ref-sheet-8x', big.toDataURL('image/png'));
      } else if (sc === 'ledgefilm') {
        // the rear hang filmed at 30 frames a second on the lifelike Explorer, close up and doubled (crisp pixels):
        // review/film/ledge/0000.jpg..
        if (!window.KhalfanReviewProps) await new Promise((res) => { const el = document.createElement('script'); el.src = 'review-props.js'; el.onload = res; el.onerror = res; document.head.appendChild(el); });
        const kd = kDip(), EXP = { hwnd: 22, title: 'Homework — File Explorer', fav: false, x: 140, y: 330, w: 760, h: 500 };
        settle(); if (window.KhalfanHat) window.KhalfanHat.reset();
        reviewWorld([Object.assign({}, EXP)], []);
        RV.wall = true; RV.windows[0].paint = window.KhalfanReviewProps.explorer(EXP.w, EXP.h, DPR);
        KH.x = 700 * kd; step(0.4);
        const Q = WD.plats.find((P0) => P0.hwnd === 22), hx = 660 * kd;
        const crop = { x: 660 - 320, y: 330 - 160, w: 640, h: 360 };
        const fc = document.createElement('canvas');
        fc.width = Math.round(crop.w * DPR * 2); fc.height = Math.round(crop.h * DPR * 2);
        const fg = fc.getContext('2d'); fg.imageSmoothingEnabled = false;
        let i = 0;
        const frame = () => { fg.drawImage(cv, crop.x * DPR, crop.y * DPR, crop.w * DPR, crop.h * DPR, 0, 0, fc.width, fc.height); desk.reviewFrame('ledge', i++, fc.toDataURL('image/jpeg', 0.92)); };
        AUD.rec = [];                                                   // (its sounds, for its sound track)
        const tS = t;
        startHang(Q, { x: hx, rot: -8, vx: -20, self: false }, t);
        KH.hang.dur = 2; KH.hang.next = 'climb';                       // (a hang as long as they come: it is fitted to the tries)
        KH.blend = null;                                                // (on the edge from the first frame: no setting up to cut)
        const motion = [];                                              // (for checking the motion: his head and shoes, each frame)
        const track = () => {
          const q = R.full(KH.pose), MR = R.rootMatrix(q), r1 = (v) => Math.round(v * 100) / 100;
          const hd = KM.ap(MR, 0, -30), fl = KM.ap(MR, q.flx, q.fly), fr = KM.ap(MR, q.frx, q.fry);
          motion.push([r1(hd[0]), r1(hd[1]), r1(fl[0]), r1(fl[1]), r1(fr[0]), r1(fr[1]), r1(q.rot), KH.mode !== 'hang' ? 0 : KH.hang.climbT != null ? 2 : t - KH.hang.t0 < 0.4 ? 3 : 1]);   // (1: the struggle)
        };
        while (KH.mode === 'hang' && i < 400) { step(1 / 30); frame(); track(); }
        for (let k = 0; k < 30; k++) { step(1 / 30); frame(); track(); }
        desk.log('ledgefilm: frames', i);
        desk.log('MOTION ' + JSON.stringify(motion));
        const ev = AUD.rec; AUD.rec = null;
        desk.log('SOUNDS ' + JSON.stringify(ev.map((e) => [Math.round((e[0] - tS - 1 / 30) * 1000) / 1000, ...e.slice(1)])));
        await filmSound('ledge', ev, tS + 1 / 30, i / 30 + 0.5);
        RV.wall = false; reviewWorld(WINS);
      } else if (sc === 'ledge') {
        // the rear hang on a window's edge (Ahmed's 16-pose sheet): the struggle, then the climb and the turn to us
        reviewWorld(WINS); settle(); step(0.3);
        const Q = WD.plats.find((P0) => P0.hwnd === 22);
        startHang(Q, { x: Q.x0 + 70, rot: 0, vx: 0, self: false }, t);
        KH.hang.dur = 3.25; KH.hang.next = 'climb';
        for (let i = 0; i < 16; i++) { step(0.1); snap('hang ' + (t - KH.hang.t0).toFixed(1) + 's', 'wide'); }
        step(1.6);
        for (let i = 0; i < 40 && KH.mode === 'hang'; i++) {
          step(0.1);
          const Hg = KH.hang;
          snap(Hg && Hg.climbT != null ? 'climb ' + (t - Hg.climbT).toFixed(2) + 's' : 'hang', 'wide');
        }
        step(0.3); snap('stood, ' + KH.mode, 'wide');
        sheet('ledge', 7);
      } else if (sc === 'bubbles') {
        // his speech bubbles in pixels (playroom/js/bubble.js): one popping in, the angry one throbbing, the side tails,
        // and the coffee bubble over him in the power-up
        const keep = S.rageBurns; S.rageBurns = false;
        settle(); step(0.4);
        say(LINES.hello);
        for (const d2 of [0.03, 0.06, 0.06, 0.4]) { step(d2); snap('say +' + Math.round((t - KH.bubble.t0) * 1000) + 'ms', 'wide'); }
        step(2);
        say(LINES.angry2, 2); step(0.3); snap('angry', 'wide'); step(0.06); snap('angry, throbbing', 'wide');
        step(2.5);
        const KB = window.KhalfanBubble, gy = groundY();
        g.setTransform(CELLPX, 0, 0, CELLPX, 0, 0);
        KB.box(g, Math.round(KH.x) + 30, Math.round(gy) - 40, 22, 15, 1, { side: 'left', at: 8 });
        KB.box(g, Math.round(KH.x) - 54, Math.round(gy) - 40, 22, 15, 1, { side: 'right', at: 8 }, KB.ANGRY);
        snap('side tails (drawn by hand)', 'wide');
        blowUp(); step(EM_TL.intro + 4); snap('the coffee bubble', 'wide');
        S.rageBurns = keep;
        sheet('bubbles', 4);
      } else if (sc.startsWith('burnfilm')) {
        // his window burn in each of its looks, filmed one after another on a lifelike Explorer window (review-props.js;
        // never a picture of a real window), 30 frames a second: review/film/<look>/0000.jpg..
        // burnfilm:fire+dust films only those.
        if (!window.KhalfanReviewProps) await new Promise((res) => { const el = document.createElement('script'); el.src = 'review-props.js'; el.onload = res; el.onerror = res; document.head.appendChild(el); });
        const KB = window.KhalfanBurn, looks = sc.includes(':') ? sc.split(':')[1].split('+') : KB.STYLES;
        const kd = kDip(), EXP = { hwnd: 22, title: 'Homework — File Explorer', fav: false, x: 140, y: 330, w: 760, h: 500 };
        const paint = window.KhalfanReviewProps.explorer(EXP.w, EXP.h, DPR), crop = { x: 40, y: 239, w: 1280, h: 720 };
        const fc = document.createElement('canvas');
        fc.width = Math.round(crop.w * DPR); fc.height = Math.round(crop.h * DPR);
        const fg = fc.getContext('2d');
        const frame = (look, n, i) => {
          fg.drawImage(cv, crop.x * DPR, crop.y * DPR, fc.width, fc.height, 0, 0, fc.width, fc.height);
          const lab = `${n + 1}   ${KB.LABELS[look] || look}`, z = DPR;
          fg.font = `600 ${Math.round(20 * z)}px "Segoe UI", sans-serif`; fg.textBaseline = 'middle'; fg.textAlign = 'left';
          const tw = fg.measureText(lab).width;
          fg.fillStyle = 'rgba(12,14,20,.62)'; fg.beginPath(); fg.roundRect(18 * z, 16 * z, tw + 32 * z, 38 * z, 19 * z); fg.fill();
          fg.fillStyle = '#ffffff'; fg.fillText(lab, 34 * z, 35.5 * z);
          desk.reviewFrame(look, i, fc.toDataURL('image/jpeg', 0.93));
        };
        desk.log('burnfilm: dpr', DPR, 'cell', CELLPX, 'looks', looks.join(','));
        for (const [n, look] of looks.entries()) {
          settle(); if (window.KhalfanHat) window.KhalfanHat.reset();
          reviewWorld([Object.assign({}, EXP)], []);
          RV.wall = true; RV.windows[0].paint = paint;
          KH.x = 1130 * kd; step(0.6);
          RV.burned = (h) => { RV.windows = RV.windows.filter((w) => w.hwnd !== h); WD.rects = WD.rects.filter((r) => r.hwnd !== h); };
          S.rageBurnStyle = look;
          blowUp();
          FX.shots.set(22, { img: paint, x: EXP.x, y: EXP.y, w: EXP.w, h: EXP.h });
          step(STRIKE_AT - 0.75);
          let i = 0, after = -1, drawn = '-';
          for (; i < 300; i++) {
            step(1 / 30);
            frame(look, n, i);
            const St = KH.rage && KH.rage.strike;
            if (FX.burn) drawn = FX.burn.style;
            if (St && St.hit && !FX.burn && after < 0) after = i;
            if (after >= 0 && i - after > 12) break;
          }
          desk.log('burnfilm:', look, 'frames', i + 1, 'drawn as', drawn, 'gl', KB.lastError || 'ok');
          RV.burned = null; RV.wall = false; FX.burn = null; FX.shots.clear();
        }
        delete S.rageBurnStyle; reviewWorld(WINS);
      } else if (sc === 'grudge') {
        // the window he burned comes back from the taskbar while he still rages: he strikes it again, and again
        reviewWorld(WINS); settle(); if (window.KhalfanHat) window.KhalfanHat.reset(); KH.x = 640; step(0.4);   // (the desktop as it was)
        const kd = kDip(), fw0 = RV.windows.find((w) => w.hwnd === 22), keep = Object.assign({}, fw0), rect0 = WD.rects.find((r) => r.hwnd === 22);
        const pic = document.createElement('canvas');
        pic.width = Math.round(fw0.w / kd * DPR); pic.height = Math.round(fw0.h / kd * DPR);
        pic.getContext('2d').drawImage(cv, fw0.x / kd * DPR, fw0.y / kd * DPR, pic.width, pic.height, 0, 0, pic.width, pic.height);
        const give = () => FX.shots.set(22, { img: pic, x: keep.x / kd, y: keep.y / kd, w: keep.w / kd, h: keep.h / kd });
        RV.burned = (h) => { RV.windows = RV.windows.filter((w) => w.hwnd !== h); WD.rects = WD.rects.filter((r) => r.hwnd !== h); };
        const lb2 = () => { const E = KH.rage, St = E && E.strike; return St ? `${St.again ? 'again ' : ''}strike +${Math.round((t - St.t0) * 1000)}ms${St.hit ? ' hit' : ''}` : E ? 'f' + E.frame : 'calm'; };
        blowUp(); give();
        step(STRIKE_AT + 0.6); snap('first strike ' + lb2(), 'big');
        step(2.2); snap('burnt, minimized ' + lb2(), 'big');
        for (let round = 1; round <= 2; round++) {
          RV.windows.push(Object.assign({}, keep)); WD.rects.push(Object.assign({}, rect0)); step(0.3);   // you open it again
          snap(`you open it again (${round})`, 'big');
          step(0.4); give();                                              // (live: main takes a fresh picture)
          for (const d2 of [0.25, 0.35, 0.5, 0.8]) { step(d2); snap(lb2() + ' burn ' + (FX.burn ? Math.round((t - FX.burn.t0) * 100) / 100 : '-'), 'big'); }
          step(1.0);
        }
        desk.log('grudge: windows struck', KH.rage && KH.rage.grudge ? [...KH.rage.grudge].join(',') : '-');
        RV.burned = null;
        sheet('grudge', 4);
      } else if (sc === 'everywin') {
        // while he rages every window is his: the folder first, then another window that was open already, then one
        // you open while he is still angry
        const kd = kDip();
        const photos = { hwnd: 44, title: 'Photos', fav: false, x: 120, y: 110, w: 520, h: 300 };
        const notes = { hwnd: 33, title: 'Notes', fav: false, x: 1000, y: 520, w: 600, h: 360 };
        reviewWorld([...WINS, photos]); settle(); if (window.KhalfanHat) window.KhalfanHat.reset(); KH.x = 640; step(0.4);
        const give = (h) => {                                             // (live: main takes the window's picture)
          const w = RV.windows.find((x) => x.hwnd === h); if (!w) return;
          const pic = document.createElement('canvas');
          pic.width = Math.round(w.w / kd * DPR); pic.height = Math.round(w.h / kd * DPR);
          pic.getContext('2d').drawImage(cv, w.x / kd * DPR, w.y / kd * DPR, pic.width, pic.height, 0, 0, pic.width, pic.height);
          FX.shots.set(h, { img: pic, x: w.x / kd, y: w.y / kd, w: w.w / kd, h: w.h / kd });
        };
        const struck = [];
        RV.burned = (h) => { struck.push(h); RV.windows = RV.windows.filter((w) => w.hwnd !== h); WD.rects = WD.rects.filter((r) => r.hwnd !== h); };
        const lb2 = () => { const E = KH.rage, St = E && E.strike; return St ? `${St.again ? 'next ' : ''}strike #${St.tg.hwnd} +${Math.round((t - St.t0) * 1000)}ms${St.hit ? ' hit' : ''}` : E ? 'f' + E.frame : 'calm'; };
        const watch = (sec) => { for (let k = 0; k < Math.round(sec / 0.1); k++) { step(0.1); const St = KH.rage && KH.rage.strike; if (St && !St.hit && !FX.shots.has(St.tg.hwnd)) give(St.tg.hwnd); } };
        blowUp(); give(22);
        watch(STRIKE_AT + 0.6); snap('first strike ' + lb2(), 'big');
        watch(2.4); snap('then the other open window ' + lb2(), 'big');
        watch(2.4); snap('both gone ' + lb2(), 'big');
        reviewWorld([...WINS.filter((w) => !struck.includes(w.hwnd)), notes]); step(0.3);   // (the desktop as main reports it, with the new window)
        snap('you open a new window', 'big');
        watch(1.2); snap('he turns on it ' + lb2(), 'big');
        watch(2.4); snap('the new one burned ' + lb2(), 'big');
        desk.log('everywin: windows struck in order', struck.join(',') || '-', '| still raging', !!KH.rage);
        RV.burned = null;
        sheet('everywin', 3);
      } else if (sc === 'touch') {
        // charged, he would go for the folder; you click the Photos window instead of giving him his coffee: that one
        // burns first
        const kd = kDip();
        const photos = { hwnd: 44, title: 'Photos', fav: false, x: 120, y: 110, w: 520, h: 300 };
        reviewWorld([...WINS, photos]); settle(); if (window.KhalfanHat) window.KhalfanHat.reset(); KH.x = 640; step(0.4);
        const give = (h) => {
          const w = RV.windows.find((x) => x.hwnd === h); if (!w) return;
          const pic = document.createElement('canvas');
          pic.width = Math.round(w.w / kd * DPR); pic.height = Math.round(w.h / kd * DPR);
          pic.getContext('2d').drawImage(cv, w.x / kd * DPR, w.y / kd * DPR, pic.width, pic.height, 0, 0, pic.width, pic.height);
          FX.shots.set(h, { img: pic, x: w.x / kd, y: w.y / kd, w: w.w / kd, h: w.h / kd });
        };
        const struck = [];
        RV.burned = (h) => { struck.push(h); RV.windows = RV.windows.filter((w) => w.hwnd !== h); WD.rects = WD.rects.filter((r) => r.hwnd !== h); };
        const lb2 = () => { const E = KH.rage, St = E && E.strike; return St ? `strike #${St.tg.hwnd} +${Math.round((t - St.t0) * 1000)}ms${St.hit ? ' hit' : ''}` : E ? 'f' + E.frame : 'calm'; };
        const watch = (sec) => { for (let k = 0; k < Math.round(sec / 0.1); k++) { step(0.1); const St = KH.rage && KH.rage.strike; if (St && !St.hit && !FX.shots.has(St.tg.hwnd)) give(St.tg.hwnd); } };
        blowUp(); give(22);
        watch(2.0); snap('charged, about to go for the folder ' + lb2(), 'big');
        applyWorld(Object.assign({}, WD.raw, { fg: { hwnd: 44 } })); give(44);   // you click the Photos window
        snap('you click Photos', 'big');
        watch(STRIKE_AT - 2.0 + 0.6); snap('he burns what you touched ' + lb2(), 'big');
        watch(1.0); snap(lb2() + ' burn ' + (FX.burn ? Math.round((t - FX.burn.t0) * 100) / 100 : '-'), 'big');
        watch(1.6); snap('then the folder ' + lb2(), 'big');
        watch(1.6); snap(lb2(), 'big');
        desk.log('touch: windows struck in order', struck.join(',') || '-');
        RV.burned = null;
        sheet('touch', 3);
      } else if (sc === 'burn') {
        // his ultra rage strikes the folder window: a bolt from his hand, the window burns from the hit and crumbles away
        // (the picture here is the pretend desktop's own window, which then is not drawn; live, main takes the real
        // window's picture and minimizes it)
        reviewWorld(WINS); settle(); if (window.KhalfanHat) window.KhalfanHat.reset(); KH.x = 640; step(0.4);   // (the desktop as it was)
        const kd = kDip(), fw = RV.windows.find((w) => w.hwnd === 22);
        const pic = document.createElement('canvas');
        pic.width = Math.round(fw.w / kd * DPR); pic.height = Math.round(fw.h / kd * DPR);
        pic.getContext('2d').drawImage(cv, fw.x / kd * DPR, fw.y / kd * DPR, pic.width, pic.height, 0, 0, pic.width, pic.height);
        RV.burned = (h) => { RV.windows = RV.windows.filter((w) => w.hwnd !== h); WD.rects = WD.rects.filter((r) => r.hwnd !== h); };
        blowUp();
        FX.shots.set(22, { img: pic, x: fw.x / kd, y: fw.y / kd, w: fw.w / kd, h: fw.h / kd });
        const lb2 = () => { const E = KH.rage, St = E && E.strike; return St ? `strike +${Math.round((t - St.t0) * 1000)}ms${St.hit ? ' hit' : ''}` : E ? 'f' + E.frame : 'calm'; };
        step(STRIKE_AT - 0.05); snap('white form, about to strike', 'big');
        for (const dt2 of [0.15, 0.12, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.35, 0.45, 0.6]) { step(dt2); snap(lb2() + ' burn ' + (FX.burn ? Math.round((t - FX.burn.t0) * 100) / 100 : '-'), 'big'); }
        desk.log('burn: target', KH.rage && KH.rage.target && KH.rage.target.hwnd, 'look', FX.burn ? FX.burn.style : '-', window.KhalfanBurn.lastError || '');
        RV.burned = null;
        sheet('burn', 4);
      } else if (sc === 'hover') {
        // a folder (three of them) carried over his basket: it hovers in the hat's mouth; let go, it falls in from there
        const KHH = window.KhalfanHands;
        const ticking = (sec, each) => step(sec, (tt) => { if (each) each(tt); if (Math.round(tt * 60) % 7 === 0) KHH._tick(); });
        step(0.4);
        KHH.offer(true);
        const gy = groundY(), kd = kDip();
        mouse.x = KH.x + 20; mouse.y = gy - 110;
        ticking(2.4); snap('basket out', 'wide');
        KHH.dragInfo({ kind: 'folder', count: 3 });
        KHH.reach(true, null, 3);
        for (let i = 0; i < 4; i++) { ticking(0.25); snap('folders over the hat', 'wide'); }
        KHH.reach(false); ticking(0.4); snap('carried away again', 'wide');
        KHH.reach(true, 'image', 1); KHH.dragInfo({ kind: 'image', count: 1 }); ticking(0.6); snap('a photo over the hat', 'wide');
        const an = KHH.receive({ x: mouse.x / kd, y: mouse.y / kd, kind: 'image' });
        for (let i = 0; i < 8; i++) { ticking(0.1); snap('let go ' + Math.round((i + 1) * 100) + 'ms', 'wide'); }
        KHH.offer(false);
        desk.log('hover: menu delay', an && an.delay);
        sheet('hover', 7);
      } else if (sc === 'toss') {
        // the job card crumpled: he catches the ball and throws it off the nearer edge of the screen (the ball is drawn
        // here as a stand-in: the real one is a page element of the hand-off, with the same flight)
        const KHH = window.KhalfanHands;
        const kd = kDip();
        for (const xAt of [0.7, 0.25]) {
          settle(); if (window.KhalfanHat) window.KhalfanHat.reset(); KH.x = WD.W * xAt; step(0.5);
          const card = [KH.x / kd + 150, (groundY() - 70) / kd];         // the job card beside his head (page pixels)
          const plan = KHH.toss({ x: card[0], y: card[1] });
          let bx = card[0], by = card[1], vx = 0, vy = 0, flying = !plan, u = 0;
          const R0 = 20, dir = plan ? plan.dir : 1;
          const ball = () => {
            const C2 = [CELLPX, 0, 0, CELLPX, -(KH.viewX || 0) * CELLPX, -(KH.viewY || 0) * CELLPX];
            g.setTransform(C2[0], 0, 0, C2[3], C2[4], C2[5]);
            g.fillStyle = '#efe4c8'; g.strokeStyle = '#7a6a50'; g.lineWidth = 0.6;
            const sc = flying ? 7 / R0 : 1 + (7 / R0 - 1) * Math.min(1, u / plan.catchAt);
            g.beginPath(); g.arc(bx * kd, by * kd, R0 * sc * kd, 0, Math.PI * 2); g.fill(); g.stroke();
          };
          for (let i = 0; i < 18; i++) {
            step(1 / 15, () => {
              u += 1 / 60;
              if (!flying) {
                const h = plan.hand();
                if (u < plan.catchAt) { const f = u / plan.catchAt, e = 1 - (1 - f) * (1 - f); bx = card[0] + (h[0] - card[0]) * e; by = card[1] + (h[1] - card[1]) * e - 36 * Math.sin(Math.PI * f); }
                else { bx = h[0]; by = h[1]; }
                if (u >= plan.throwAt) { flying = true; vx = dir * 1550; vy = -1000; }
              } else { vy += 2500 / 60; bx += vx / 60; by += vy / 60; }
            });
            ball();
            snap(`${xAt > 0.5 ? 'right side' : 'left side'} ${Math.round(u * 1000)}ms ${flying ? 'thrown' : u < (plan ? plan.catchAt : 0) ? 'catching' : 'in his hand'}`, 'wide');
          }
          desk.log('toss: plan', !!plan, 'dir', dir, 'ball at', Math.round(bx), Math.round(by));
        }
        sheet('toss', 6);
      } else if (sc === 'think') {
        // the menu open over him: the letter out of the hat, the kumma back on, then he looks up at the
        // paper and thinks it over with you; his eyes follow the cursor across the paper
        const KHH = window.KhalfanHands;
        const ticking = (sec, each) => step(sec, (tt) => { if (each) each(tt); if (Math.round(tt * 60) % 7 === 0) KHH._tick(); });
        const flush = () => new Promise((r) => setTimeout(r, 5));
        const hs = () => { const h = KHH._hat(); return `u${h.u}${h.hold ? ' menu' : ''} ${lbl()}`; };
        step(0.4);
        KHH.offer(true);
        const gy = groundY(), kd = kDip();
        mouse.x = KH.x + 20; mouse.y = gy - 110;
        ticking(2.4); KHH.reach(true); ticking(0.4); snap('basket out ' + hs(), 'wide');
        const an = KHH.receive({ x: mouse.x / kd, y: mouse.y / kd, kind: 'folder' });
        KHH.offer(false); KHH.hold(true);
        const mw = 256, mh = 210;                                        // the menu over his kumma, in page pixels
        KHH.menuAt({ x: KH.x / kd - mw / 2, y: (gy - 66) / kd - mh - 8, w: mw, h: mh });
        mouse.x = KH.x + 300; mouse.y = gy - 300;                         // the cursor off the paper: he looks at the paper itself
        for (let i = 0; i < 10; i++) { ticking(0.2); await flush(); snap((i < 4 ? 'letter out ' : 'hat back on ') + hs(), 'wide'); }
        ticking(0.8); await flush(); snap('thinking ' + hs(), 'wide');
        const R0 = { x: KH.x - mw * kd / 2, y: gy - 66 - (mh + 8) * kd };
        for (const [nm, fx, fy] of [['you point at Make', 0.25, 0.85], ['at the file', 0.3, 0.3], ['at the right', 0.9, 0.5]]) {
          mouse.x = R0.x + mw * kd * fx; mouse.y = R0.y + mh * kd * fy; mouse.moveT = t;
          ticking(0.7, () => { mouse.moveT = t; }); await flush(); snap(nm + ' ' + hs(), 'wide');
        }
        ticking(2.6); await flush(); snap('still thinking ' + hs(), 'wide');
        KHH.hold(false); ticking(0.5); snap('menu closed ' + hs(), 'wide');
        desk.log('think: menu delay', an && an.delay);
        sheet('think', 6);
      } else if (sc === 'hat') {
        // a file carried toward him: the kumma comes off and becomes a basket that grows;
        // over him it lifts, dropped in it dips; held while the menu is open, back on his head before the work move.
        // Then a file that comes near and goes away again, and one picked up mid-way.
        const KHH = window.KhalfanHands;
        const hs = () => { const h = KHH._hat(); return `u${h.u}${h.caught ? ' caught' : ''}${h.hold ? ' menu' : ''}${h.work ? ' work' : ''} ${lbl()}`; };
        const ticking = (sec, each) => step(sec, (tt) => { if (each) each(tt); if (Math.round(tt * 60) % 7 === 0) KHH._tick(); });
        step(0.4); snap('standing ' + hs());
        KHH.offer(true);
        const gy = groundY();
        mouse.x = KH.x - 260; mouse.y = gy - 200;
        for (let i = 0; i < 9; i++) { ticking(0.25, () => { mouse.x += (KH.x + 30 - mouse.x) * 0.05; mouse.y += (gy - 110 - mouse.y) * 0.05; }); snap('carried near ' + hs()); }
        mouse.x = KH.x - 8; mouse.y = gy - 66; KHH.reach(true);
        ticking(0.3); snap('over him ' + hs()); ticking(0.4); snap(hs());
        const kd = kDip();
        const an = KHH.receive({ x: mouse.x / kd, y: mouse.y / kd, kind: 'image' });
        desk.log('hat: the menu opens after', an && an.delay, 'ms');
        for (let i = 0; i < 12; i++) { ticking(0.08); snap((i ? 'in the hat ' : 'dropped in ') + Math.round((i + 1) * 80) + 'ms ' + hs()); }
        KHH.offer(false); KHH.hold(true); ticking(0.8); snap('menu open ' + hs()); ticking(1.7); snap(hs());
        KHH.hold(false); KHH.work('zip.make');
        const flush = () => new Promise((r) => setTimeout(r, 5));        // (the basket hands its "back on" over on the next task)
        for (let i = 0; i < 5; i++) { ticking(0.22); await flush(); snap('back on, then work ' + hs()); }
        ticking(0.6); snap(hs());
        KHH.done(); ticking(0.8); snap('done ' + hs());
        sheet('hat');
        // came near, went away: after a moment it goes back on; then picked up mid-way: straight back on
        settle(); mouse.in = true; step(0.3);
        KHH.offer(true); mouse.x = KH.x + 40; mouse.y = groundY() - 100;
        ticking(0.9); snap('near ' + hs());
        mouse.x = KH.x + 700; mouse.y = groundY() - 400;
        for (let i = 0; i < 6; i++) { ticking(0.4); snap('went away ' + hs()); }
        mouse.x = KH.x + 40; mouse.y = groundY() - 100; ticking(1.0); snap('near again ' + hs());
        const hp = KM.ap(R.rootMatrix(R.full(KH.pose)), 0, -30);
        mouse.x = hp[0]; mouse.y = hp[1]; grabAt(hp[0], hp[1], false); step(0.2); snap('picked up ' + hs());
        throwHeld(true); for (let i = 0; i < 3; i++) { step(0.4); snap('let go ' + hs()); }
        KHH.offer(false);
        sheet('hat-away');
      }
      } catch (e) {
        desk.log('scenario', sc, 'failed at', t.toFixed(2), e && e.stack || String(e));
        if (sheetFrames.length) sheet(sc + '-FAILED');
      }
    }
    desk.reviewDone();
  }

  boot().catch((e) => { if (desk) { desk.log('boot failed', e && e.stack || String(e)); if (REVIEW) desk.reviewDone(); } console.error(e); });
})();
