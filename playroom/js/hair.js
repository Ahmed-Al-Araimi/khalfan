/* Khalfan's hairstyles: Ahmed's hair drawings, ten of them. They replace ten earlier code-drawn styles.
 *
 * Each drawing is a front view of his bare head. A small tool read it onto the rig's own head grid
 * (data/khalfan-hairs.js: his face fitted to the rig's face, so the hair sits where he drew it, in the rig's cells
 * and palette). Here it is wrapped round his head the way the rig wraps his face, so it turns with him:
 *   on his head      a cell is mapped back to the drawing through the head's own turn (the fringe stays with his eyes);
 *                    behind his hairline (the rig's own, as for his curls) it is the back of his hair
 *   above his head   the hair keeps the outline he drew at every turn (seen from behind, mirrored), narrowing as his
 *                    head does in profile; its curls are read round it like a drum, so they move as he turns
 *   beside his head  the hair standing out at his sides turns as a drum of the drawing's width: towards us it is what
 *                    he drew there, behind it is the back of his hair
 *   the back         the drawing's own texture, mirrored through his sides; where his face was, the curls above
 *                    repeat downwards
 *   capped           under a worn kumma or massar the hair stops where his own curls stop at that turn, so the
 *                    kumma fits as always
 * Registered in the rig's HAIR table (rig.head(..., hair, capped)), it follows every move, turn and expression.
 * null / 'classic' is his own approved curls, untouched.
 */
(function (root) {
  'use strict';
  const R = root.KRig || (typeof require === 'function' ? require('./rig.js') : null);
  const DATA = root.KHALFAN_HAIRS || (typeof require === 'function' ? require('../data/khalfan-hairs.js') : {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
  const wrap = (d) => ((d + 180) % 360 + 360) % 360 - 180;
  const HW = 18, HTOP = -17;                                    // his head's half-width and top, as the rig has them
  const hairEdge = (y) => (y < -6 ? 86.0 : 86.0 + (y + 6) * 3.0);   // the rig's hairline round the back of his head
  // under a kumma or massar the hair stops where his own curls stop at that turn (their outline one row above it),
  // so the kumma fits exactly as it does on him
  const capTops = {};
  function capTop(yaw) {
    if (capTops[yaw] === undefined) {
      const s = R.head(yaw);
      let top = 0;
      search: for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) if (s.a[j * s.w + i]) { top = j - s.oy; break search; }
      capTops[yaw] = top + 1;
    }
    return capTops[yaw];
  }

  // in the artist's order
  const NAMES = [
    ['fuller', 'Fuller curls', 'مجعّد كثيف'],
    ['wavy', 'Wavy side sweep', 'تموّج جانبي'],
    ['crop', 'Textured crop', 'قصّة قصيرة'],
    ['taper', 'Curly low taper', 'مجعّد بجوانب خفيفة'],
    ['curtains', 'Fluffy curtains', 'غرّة مفروقة'],
    ['quiff', 'Soft quiff', 'شعر مرفوع'],
    ['spikes', 'Messy spikes', 'شعر منكوش'],
    ['coils', 'Rounded coils', 'حلقات مستديرة'],
    ['mullet', 'Mini mullet', 'قصّة طويلة من الخلف'],
    ['sidepart', 'Clean side part', 'فرق جانبي مرتّب'],
  ];
  const EXTRA = { mullet: { nape: 4 } };                        // the mullet's tail hangs over his collar at the back

  // one drawing, ready to sample: at(u, y) is its cell (u, y in rig cells, the face's middle at u = 0, the chin at y = 0)
  function prepare(d) {
    const y0 = d.y0, x0 = d.x0, y1 = y0 + d.rows.length - 1;
    // his drawn forehead reaches a little above the rig's head top: there the hair comes down to meet the head (a cell
    // above his head with hair over it and on both sides of it becomes hair, the curls' texture carried down)
    const rows = d.rows.map((r) => r.split(''));
    for (let j = 1; j < rows.length && y0 + j < HTOP; j++) {
      const r = rows[j];
      let a = -1, b = -1;
      for (let i = 0; i < r.length; i++) if (r[i] !== '.') { if (a < 0) a = i; b = i; }
      for (let i = a + 1; i < b; i++) {
        if (r[i] !== '.') continue;
        let up = -1;
        for (let jj = j - 1; jj >= 0; jj--) if (rows[jj][i] !== '.') { up = jj; break; }
        if (up >= 0) r[i] = rows[Math.max(0, j - 6)][i] !== '.' ? rows[Math.max(0, j - 6)][i] : 'H';
      }
    }
    const at = (u, y) => {
      const j = y - y0, i = Math.floor(u) - x0;
      if (j < 0 || j >= rows.length || i < 0 || i >= rows[j].length) return '.';
      return rows[j][i];
    };
    const lo = {}, hi = {}, ext = {};                           // each row's hair: left and right end, half-width
    for (let y = y0; y <= y1; y++) {
      const r = rows[y - y0];
      let a = -1, b = -1;
      for (let i = 0; i < r.length; i++) if (r[i] !== '.') { if (a < 0) a = i; b = i; }
      if (a < 0) continue;
      lo[y] = a + x0; hi[y] = b + x0;
      ext[y] = Math.max(-lo[y], hi[y] + 1, y >= HTOP ? HW : 0);
    }
    // the curls' repeat for the back: the hair's own rows above his forehead
    const period = Math.max(4, Math.min(8, HTOP - y0));
    return { at, lo, hi, ext, y0, y1, period };
  }

  function makeStyle(key, en, ar) {
    const P = prepare(DATA[key]), X = EXTRA[key] || {};
    // the back of his hair at drawing column u, row y: the drawing's own cell where it has hair, else the curls above
    function backAt(u, y) {
      let ch = P.at(u, y);
      for (let n = 1; ch === '.' && n < 6; n++) ch = P.at(u, y - n * P.period);
      return ch === '.' ? 'H' : ch;
    }
    // turned, the drawing's side columns face us and would stretch into streaks; there the hair's texture is read
    // evenly round the head instead (which hair shows is still the drawing's, so the hairline stays with his face)
    function unsmear(ch, th, Rd, Re, y) {
      if (ch === '.') return ch;
      const t = rad(th), stretch = (Rd * Math.abs(Math.cos(t))) / Math.max(1e-6, Re * Math.abs(Math.cos(t + rad(yawNow))));
      if (stretch >= 0.5) return ch;
      const c2 = P.at(Rd * t * 2 / Math.PI, y);
      return c2 === '.' ? 'H' : c2;
    }
    let yawNow = 0;
    function paint(c) {
      const { A, W, Hh, OX, OY, yaw, hw, sk, IDX, capped } = c;
      yawNow = yaw;
      const N = W * Hh, m = new Uint8Array(N), put = new Uint8Array(N);
      const k = hw / HW;                                        // turned, his head reads narrower; so does the hair
      const topY = capped ? Math.max(P.y0, capTop(yaw)) : P.y0;
      for (let j = 0; j < Hh; j++) {
        const y = j - OY;
        if (y < topY) continue;
        for (let i = 0; i < W; i++) {
          const q = j * W + i, x = i - OX + 0.5;
          let ch = '.';
          if (sk[q]) {                                          // on his head: through the head's own turn
            const th = wrap(deg(Math.asin(clamp(x / hw, -1, 1))) - yaw), u = HW * Math.sin(rad(th));
            ch = Math.abs(th) > hairEdge(y) ? backAt(u, y) : unsmear(P.at(u, y), th, HW, hw, y);
          } else if (y < 0 && P.ext[y]) {                       // round his head: the drum of the drawing's width
            const Rd = P.ext[y], Re = Rd * k;
            if (Math.abs(x) > Re) continue;
            const th = wrap(deg(Math.asin(clamp(x / Re, -1, 1))) - yaw), u = Rd * Math.sin(rad(th));
            if (y < HTOP) {                                     // above his head: the drawing's own outline at every turn
              const sil = P.at((Math.abs(yaw) <= 90 ? x : -x) / k, y);   // (mirrored from behind), its texture round the drum
              if (sil !== '.') {
                const t = Math.abs(th) <= 90 ? unsmear(P.at(u, y), th, Rd, Re, y) : P.at(u, y);
                ch = t !== '.' ? t : sil;
              }
            } else if (Math.abs(th) <= 90) ch = unsmear(P.at(u, y), th, Rd, Re, y);   // beside his face: what he drew there
            else if (u >= P.lo[y] - 0.5 && u <= P.hi[y] + 1.5) ch = backAt(u, y);   // beside the back: the full back of his hair
          } else if (y >= 0 && y < (X.nape || 0)) {             // the mullet's tail, seen from behind and the side
            const half = (11 - y * 1.5) * Math.max(0.35, Math.abs(Math.cos(rad(yaw))));
            const th = wrap(deg(Math.asin(clamp(x / hw, -1, 1))) - yaw);
            if (Math.abs(x) <= half && Math.abs(th) > 110) ch = backAt(x, -12 + y);
          }
          if (ch !== '.') { m[q] = 1; put[q] = IDX[ch]; }
        }
      }
      for (let q = 0; q < N; q++) if (m[q]) A[q] = put[q];
      // the hair's outline, on the empty cells and the skin round it (as his curls have)
      const o = [];
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const q = j * W + i, v = A[q];
        if (m[q] || !(v === 0 || v === IDX.S || v === IDX.s)) continue;
        if ((j > 0 && m[q - W]) || (j < Hh - 1 && m[q + W]) || (i > 0 && m[q - 1]) || (i < W - 1 && m[q + 1])) o.push(q);
      }
      for (const q of o) A[q] = IDX.O;
    }
    return {
      en, ar,
      edge: () => false,                                        // the rig paints his whole head as skin; paint() adds the hair
      clumps: () => [], forelock: null, spirals: false,
      paint,
    };
  }

  const STYLES = {};
  for (const [key, en, ar] of NAMES) if (DATA[key]) STYLES[key] = makeStyle(key, en, ar);
  const ORDER = ['classic'].concat(NAMES.map((n) => n[0]).filter((k) => STYLES[k]));
  const LIST = [{ key: 'classic', en: 'His own curls', ar: 'شعره المجعّد' }].concat(ORDER.slice(1).map((k) => ({ key: k, en: STYLES[k].en, ar: STYLES[k].ar })));

  let ready = false;
  function init() {                                             // after R.init
    if (ready) return;
    for (const k of Object.keys(R.HAIR)) delete R.HAIR[k];
    for (const k of ORDER.slice(1)) R.HAIR[k] = STYLES[k];
    ready = true;
  }
  // nothing hangs behind his body with these styles (the mullet's tail is drawn on his head sprite)
  const back = () => null;
  const api = { init, back, LIST, ORDER, STYLES, valid: (k) => k === 'classic' || !!STYLES[k] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KHair = api;
})(typeof window !== 'undefined' ? window : globalThis);
