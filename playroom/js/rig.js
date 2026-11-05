/* Khalfan pixel rig v2, ported line for line from the original Python pixel rig.
 *
 * The tables (palette, eyes, mouths, faces, hands...) are not copied here: they come from the Python rig through
 * data/khalfan-data.js, after the extended moves have added their faces and colours. Every sprite and every placed
 * part was checked against the Python rig.
 *
 * Python's round() rounds halves to even, int() truncates and % floors: pyRound / Math.trunc / pyMod keep that.
 * Matrices are canvas affines [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
 */
(function (root) {
  'use strict';
  let T = null, KEYS = null, IDX = null, K = null;

  // ---------------------------------------------------------------- python arithmetic
  function pyRound(x) {
    const f = Math.floor(x);
    if (x - f === 0.5) return (f % 2 === 0) ? f : f + 1;
    return Math.round(x);
  }
  function pyMod(a, b) {
    let r = a % b;
    if (r !== 0 && ((r < 0) !== (b < 0))) r += b;
    return r;
  }
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrap = (a) => pyMod(a + 180.0, 360.0) - 180.0;
  const ss = (x) => { x = clamp(x, 0.0, 1.0); return x * x * (3 - 2 * x); };

  // ---------------------------------------------------------------- sprites
  let SPR_ID = 0;
  class Spr {
    constructor(w, h, ox = 0, oy = 0) {
      this.w = w; this.h = h; this.ox = ox; this.oy = oy;
      this.a = new Uint8Array(w * h);
      this.id = ++SPR_ID;
    }
    set(x, y, ch) {
      const i = Math.floor(x + this.ox), j = Math.floor(y + this.oy);
      if (i >= 0 && i < this.w && j >= 0 && j < this.h && ch !== '.') this.a[j * this.w + i] = IDX[ch];
    }
    get(x, y) {
      const i = Math.floor(x + this.ox), j = Math.floor(y + this.oy);
      if (i >= 0 && i < this.w && j >= 0 && j < this.h) return KEYS[this.a[j * this.w + i]];
      return '.';
    }
    stamp(rows, x0, y0, flip = false) {
      for (let y = 0; y < rows.length; y++) {
        let row = rows[y];
        if (flip) row = row.split('').reverse().join('');
        for (let x = 0; x < row.length; x++) if (row[x] !== '.') this.set(x0 + x, y0 + y, row[x]);
      }
    }
    ring(ch = 'O', mask = null) {
      const w = this.w, h = this.h, a = this.a;
      const filled = mask || a.map((v) => (v > 0 ? 1 : 0));
      const v = IDX[ch];
      const r = new Uint8Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (filled[k]) continue;
        if ((j > 0 && filled[k - w]) || (j < h - 1 && filled[k + w]) || (i > 0 && filled[k - 1]) || (i < w - 1 && filled[k + 1])) r[k] = 1;
      }
      for (let k = 0; k < w * h; k++) if (r[k]) a[k] = v;
    }
    edge(ch = 'O') {
      const w = this.w, h = this.h, a = this.a;
      const f = a.map((v) => (v > 0 ? 1 : 0));
      const v = IDX[ch];
      const at = (i, j) => (i >= 0 && i < w && j >= 0 && j < h ? f[j * w + i] : 0);
      const e = [];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if (!f[j * w + i]) continue;
        if (!(at(i, j - 1) && at(i, j + 1) && at(i - 1, j) && at(i + 1, j))) e.push(j * w + i);
      }
      for (const k of e) a[k] = v;
    }
  }

  function fromRows(rows, ox = 0, oy = 0, flip = false) {
    const s = new Spr(Math.max(...rows.map((r) => r.length)), rows.length, ox, oy);
    s.stamp(rows, -ox, -oy, flip);
    return s;
  }
  function sprite(rows, ox, oy) {
    const w = rows[0].length, h = rows.length;
    return fromRows(rows, ox == null ? w / 2 : ox, oy == null ? h / 2 : oy);
  }

  function memo(fn) {
    const m = new Map();
    return function (...args) {
      const key = JSON.stringify(args);
      let v = m.get(key);
      if (v === undefined) { v = fn(...args); m.set(key, v); }
      return v;
    };
  }

  // ---------------------------------------------------------------- kumma
  function clean(mask, w, h) {
    for (let it = 0; it < 2; it++) {
      const out = new Uint8Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!mask[k]) continue;
        const n = (j > 0 ? mask[k - w] : 0) + (j < h - 1 ? mask[k + w] : 0) + (i > 0 ? mask[k - 1] : 0) + (i < w - 1 ? mask[k + 1] : 0);
        out[k] = n >= 2 ? 1 : 0;
      }
      mask = out;
    }
    return mask;
  }

  function kummaS(u, Rf) {
    return Rf * Math.asin(clamp(K.KFLAT * u, -1, 1)) / K.KFLAT;
  }

  // the worn kumma's apparent tilt (the Python rig's kumma_tilt): front + right turns as approved, turning left it tips back
  function kummaTilt(yaw) {
    yaw = wrap(yaw);
    if (yaw >= 0) return K.KTILT * Math.cos(rad(yaw));
    const d = -yaw;
    if (d <= K.KL_TURN) return K.KTILT + (-K.KL_BACK - K.KTILT) * ss(d / K.KL_TURN);
    if (d <= 90) return -K.KL_BACK;
    return -K.KL_BACK + (K.KL_BACK - K.KTILT) * ss((d - 90) / 90);
  }

  // style: optional pattern variant (null = the approved kumma)
  const kumma = memo(function (yaw, tilt) {
    yaw = wrap(yaw);
    const sc = K.KSCALE, ya = rad(yaw);
    const KR = K.KW / 2;
    const Rf = KR * sc;
    const R = Rf * Math.sqrt(Math.cos(ya) ** 2 + (K.KDEPTH * Math.sin(ya)) ** 2);
    const Hk = K.KH * sc, kc = K.KC * sc, off = yaw / 360.0 * kc;
    const th = rad(tilt), cs = Math.cos(th), sn = Math.sin(th);
    const pad = 3;
    const half = Math.ceil(R * cs + Hk * Math.abs(sn)) + pad;
    const top = Math.ceil(Hk * cs + R * Math.abs(sn)) + pad;
    const bot = Math.ceil(R * Math.abs(sn)) + pad;
    const s = new Spr(2 * half, top + bot, half, top);
    const W = s.w, H = s.h;
    const scr = (xl, yl) => [Math.floor(cs * xl + sn * yl + half), Math.floor(-sn * xl + cs * yl + top)];
    let inside = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = i - half + 0.5, y = j - top + 0.5;
      const xl = x * cs - y * sn, yl = x * sn + y * cs;
      if (-R <= xl && xl <= R && -Hk <= yl && yl <= 0) { inside[j * W + i] = 1; s.a[j * W + i] = IDX.K; }
    }
    inside = clean(inside, W, H);
    for (let k = 0; k < W * H; k++) if (!inside[k]) s.a[k] = 0;
    const put = (i, j) => { if (i >= 0 && i < W && j >= 0 && j < H && inside[j * W + i]) s.a[j * W + i] = IDX.R; };
    const localX = (x, ylOf) => { let xl = x / cs; for (let k = 0; k < 6; k++) xl = (x - sn * ylOf(xl)) / cs; return xl; };
    const tn = sn / cs;
    for (let i = 0; i < W; i++) {
      for (const c of [-8.0, -1.6]) {
        const ys = [];
        for (const x of [i - half + 0.02, i - half + 0.98]) {
          const xl = (x - sn * c) / cs;
          if (-R < xl && xl < R) ys.push(-tn * x + c / cs);
        }
        if (ys.length) {
          const j0 = Math.floor(Math.min(...ys) + top), j1 = Math.floor(Math.max(...ys) + top);
          for (let j = j0; j <= j1; j++) put(i, j);
        }
      }
    }
    const P = kc / 8;
    const zig = (xl) => {
      const ph = pyMod((kummaS(xl / R, R) + off) / P, 1.0);
      const ztop = -Hk + 2.8;
      return ztop + Math.abs(ph * 2 - 1) * (-10.6 - ztop);
    };
    for (let i = 0; i < W; i++) {
      const ys = [];
      for (const x of [i - half + 0.02, i - half + 0.5, i - half + 0.98]) {
        const xl = localX(x, zig);
        if (-R < xl && xl < R) ys.push(-sn * xl + cs * zig(xl));
      }
      if (!ys.length) continue;
      const j0 = Math.floor(Math.min(...ys) + top), j1 = Math.floor(Math.max(...ys) + top);
      for (let j = j0; j < j1 + 2; j++) put(i, j);
    }
    const D = kc / 14;
    const smax = kummaS(1.0, R);
    for (let k = 0; k < 14; k++) {
      const sk = pyMod((k * D - off + D / 2) + kc / 2, kc) - kc / 2;
      if (Math.abs(sk) > smax - 1.2) continue;
      const xl = R * Math.sin(K.KFLAT * sk / R) / K.KFLAT;
      const [i, j] = scr(xl, -4.8);
      const rows = Math.abs(sk) < smax - 4 ? ['.R.', 'RRR', '.R.'] : ['R', 'R'];
      for (let yy = 0; yy < rows.length; yy++) for (let xx = 0; xx < rows[yy].length; xx++) {
        if (rows[yy][xx] !== '.') put(i - Math.floor(rows[yy].length / 2) + xx, j - Math.floor(rows.length / 2) + yy);
      }
    }
    s.edge('O');
    return s;
  });

  // ---------------------------------------------------------------- head
  const hairEdge = (y) => (y < -6 ? 86.0 : 86.0 + (y + 6) * 3.0);
  const proj = (theta, yaw, r) => { const a = rad(theta + yaw); return [r * Math.sin(a), Math.cos(a)]; };
  // turning left, the temple bulge tucks into the right side's small clumps, mirrored (the Python rig's _clumps)
  function clumpsFor(yaw) {
    if (yaw >= 0) return T.CLUMPS;
    const d = -yaw;
    const w = d <= 120 ? ss(d / 45.0) : 1.0 - ss((d - 120) / 60.0);
    if (w <= 0) return T.CLUMPS;
    const nf = T.NFRONT;
    return T.CLUMPS.map((q, n) => (n < nf ? q.map((a, k) => a + (T.TUCK[n][k] - a) * w) : q));
  }
  const shorten = (rows, n) => {
    if (rows[0].length <= n) return rows;
    const k = Math.floor(n / 2);
    return rows.map((r) => r.slice(0, k) + r.slice(r.length - (n - k)));
  };
  // closed happy crescents for a turned head (playroom extra): open eyes seen from the side looked
  // odd, so a calm or happy face shows ^ ^ once he turns; one crescent for each width the rig draws an eye at
  const CRESCENT = {
    6: ['......', '..EE..', '.E..E.', 'E....E', '......', '......'],
    5: ['.....', '.EEE.', 'E...E', '.....', '.....', '.....'],
    3: ['...', '.E.', 'E.E', '...', '...', '...'],
  };
  const SIDE_SMILE = new Set(['rest', 'grin', 'soften', 'cheeky', 'wink', 'neutral']);
  const crescentFor = (rows) => CRESCENT[rows[0].length >= 6 ? 6 : rows[0].length >= 4 ? 5 : 3];
  const narrow = (rows, n) => { const i = Math.max(0, Math.floor((rows[0].length - n) / 2)); return rows.map((r) => r.slice(i, i + n)); };

  // face features for a left turn (the Python rig's _left_features): the far eye narrows but stays whole, the near-side
  // features sit a little further round, the mouth goes between the eyes, a mouth corner under the nose in profile
  function leftFeatures(f, yaw, hw, R, eL, eR, bw, bshape, m, cheeks, look, eyePos) {
    const d = -yaw;
    const off = K.NEAR_OFF * ss(d / 40.0) * (1.0 - ss((d - 50) / 40.0));
    if (cheeks) {
      for (const th of [-36.0, 36.0 + off]) {
        const [x, c] = proj(th, yaw, R);
        if (c > 0.3) f.stamp(['PPP', 'PPP'], pyRound(x - 1.5), -4);
      }
      for (const th of [-47.0, 47.0 + off]) {
        const [x2, c2] = proj(th, yaw, R);
        if (c2 > 0.35) f.stamp(['EE'], pyRound(x2 - 1), -3);
      }
    }
    const span = {};
    for (const [side, e, th] of [[-1, eL, -29.0], [1, eR, 29.0 + off]]) {
      let [x, c] = proj(th, yaw, R);
      if (c < 0.2) continue;
      const cres = e === 'crescent';
      let rows = T.EYES[cres ? 'open' : e];
      const rnd = cres || e === 'open' || e === 'wide';
      if (c < 0.62) {
        if (c < 0.4) rows = rnd ? T.EYES.far : narrow(rows, 3);
        else rows = rnd ? T.EYES.side : narrow(rows, 5);
      }
      if (cres) rows = crescentFor(rows);
      const w = rows[0].length;
      const lim = hw - (d >= 60 ? 2 : 1) - w / 2;
      x = Math.max(-lim, Math.min(lim, x));
      const x0 = pyRound(x - w / 2) + look;
      f.stamp(rows, x0, -9, side > 0);
      span[side] = [x0, x0 + w];
      eyePos.push([x, c, side]);
    }
    if (bw) {
      for (const side of (bw === 'r' ? [1] : [-1, 1])) {
        let [x, c] = proj(side * 33 + (side > 0 ? off : 0.0), yaw, R);
        if (c < 0.3) continue;
        x = Math.max(-(hw - 3), Math.min(hw - 3, x));
        f.stamp(T.BROWS[bshape], pyRound(x - 2), bshape === 'up' ? -11.5 : -11, side < 0);
      }
    }
    let [rows, mx, my] = T.MOUTHS[m];
    if (span[-1] && span[1]) {
      const gap0 = span[-1][1] + 1, gap1 = span[1][0] - 1;
      const n = Math.max(2, Math.min(rows[0].length, gap1 - gap0));
      rows = shorten(rows, n);
      f.stamp(rows, Math.floor((gap0 + gap1 - n) / 2), pyRound(-4.5 + my));
      return;
    }
    let [x, c] = proj(1, yaw, R);
    if (c < -0.1) return;
    if (c < 0.25) rows = T.MOUTH_SIDE;
    else if (c < 0.55) rows = rows.map((r) => r.slice(Math.floor(r.length / 2)));
    const w = rows[0].length;
    const lim = hw - 1 - w / 2;
    x = Math.max(-lim, Math.min(lim, x + (c > 0.55 ? mx : 0)));
    f.stamp(rows, pyRound(x - w / 2), pyRound(-4.5 + my) + (c < 0.25 ? 1 : 0));
  }
  // retro shades: a bold browline frame, sunset-gradient lenses
  // (deep indigo at the top through violet and plum to a coral band), a diagonal shine; the lens colours are added
  // to the palette by the game (^ ~ * =)
  // oversized: 15 x 10 lenses that meet at the bridge
  const GLASSES = [
    'OOOOOOOOOOOOOOO',
    'O^^^^^^^^^WW^^O',
    'O^^^^^^^^WW^^^O',
    'O^^^^^^^WW^^^^O',
    'O~~~~~~WW~~~~~O',
    'O~~~~~~~~~~~W~O',
    'O~~~~~~~~~~~~~O',
    'O*************O',
    '.O===*****===O.',
    '..OOOOOOOOOOO..',
  ];

  // hairstyles (playroom extra): the game registers styles in HAIR (js/hair.js); a style may replace
  // the hairline test (edge), the curls (clumps), the forelock, the spiral texture, and paint its own pixels (paint,
  // before his ears are drawn).
  // hair null = his own curls, drawn exactly as the Python rig draws them.
  const HAIR = {};
  // glasses: false | 'shades' (an outfit extra, not in the Python rig)
  function headRaw(yaw, expr, mouth, eyes, look, brow, blush, glasses, sideSmile, hair, capped) {
    const hs = hair ? HAIR[hair] || null : null;
    yaw = wrap(pyRound(yaw));
    const a = rad(yaw);
    const hw = K.HW - 5.0 * Math.abs(Math.sin(a));
    const R = hw;
    const W = 64, Hh = hs ? 42 : 30, OX = 32, OY = hs ? 31 : 25;   // a style may stand taller and hang below the chin
    const s = new Spr(W, Hh, OX, OY);
    const A = s.a, N = W * Hh;
    const H = IDX.H, Ocol = IDX.O;
    const sk = new Uint8Array(N);
    const dn = Math.abs(yaw), fs = yaw < 0 ? -1 : 1;  // his nose on the front edge, on both sides
    const nose = (0 < dn && dn < 150) ? K.NOSE_LEN * ss((dn - 40) / 25.0) * (1.0 - ss((dn - 105) / 40.0)) : 0.0;
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
      const x = i - OX + 0.5, y = j - OY + 0.5;
      if (K.HTOP <= y && y <= 0 && Math.abs(x) <= hw) {
        let cut = (y > -1 && Math.abs(x) > hw - 2) || (y > -2 && Math.abs(x) > hw - 1);
        if (cut && x * fs > 0 && nose > 0.5) cut = y > -1 && Math.abs(x) > hw - 1;   // a chin under it
        if (!cut) sk[j * W + i] = 1;
      } else if (nose > 0 && x * fs > hw) {
        const share = T.NOSE_ROWS[Math.floor(y)];
        if (share !== undefined && x * fs <= hw + nose * share) sk[j * W + i] = 1;
      }
    }
    const hairm = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      if (!sk[k]) continue;
      const i = k % W, j = (k - i) / W;
      const x = i - OX + 0.5, y = j - OY + 0.5;
      const phi = deg(Math.asin(clamp(x / R, -1, 1)));
      const th = wrap(phi - yaw);
      if (hs && hs.edge ? hs.edge(x, y, th, yaw, hw) : (Math.abs(th) > hairEdge(y) || y < -15.0)) { A[k] = H; hairm[k] = 1; }
      else A[k] = IDX[(y > -1.0 || x > hw - 1.0) ? 's' : 'S'];
    }
    if (!hs || hs.spirals !== false) for (const ky of [-13.5, -8.5, -3.5]) {
      for (let k = 0; k < 14; k++) {
        const th = k * 360 / 14 + (ky === -8.5 ? 180 / 14 : 0);
        const [x, c] = proj(th, yaw, R * 0.92);
        if (c < 0.25) continue;
        const i0 = Math.floor(x - 2) + OX, j0 = Math.floor(ky - 2) + OY;
        const r0 = Math.max(0, j0 - 1), r1 = Math.min(Hh, j0 + 5), c0 = Math.max(0, i0 - 1), c1 = Math.min(W, i0 + 5);
        if (r1 - r0 !== 6 || c1 - c0 !== 6) continue;
        let all = true;
        for (let jj = r0; jj < r1 && all; jj++) for (let ii = c0; ii < c1; ii++) if (!hairm[jj * W + ii]) { all = false; break; }
        if (all) s.stamp(T.SPIRAL, i0 - OX, j0 - OY);
      }
    }
    s.ring('O', sk);
    const skinOk = new Uint8Array(N);
    for (let k = 0; k < N; k++) skinOk[k] = (A[k] === IDX.S || A[k] === IDX.s) ? 1 : 0;

    let [[eL, eR], bw, bshape, m, cheeks] = T.EXPR[expr];
    if (eyes) [eL, eR] = Array.isArray(eyes) ? eyes : [eyes, eyes];
    if (sideSmile && !eyes && Math.abs(yaw) >= 30 && SIDE_SMILE.has(expr)) {   // turned: calm open eyes close to ^ ^
      if (eL === 'open') eL = 'crescent';
      if (eR === 'open') eR = 'crescent';
    }
    m = mouth || m;
    bshape = brow || bshape;
    const f = new Spr(W, Hh, OX, OY);
    const eyePos = [];
    if (yaw < 0) leftFeatures(f, yaw, hw, R, eL, eR, bw, bshape, m, cheeks && blush, look, eyePos);
    else {
    if (cheeks && blush) {
      for (const side of [-1, 1]) {
        const [x, c] = proj(side * 36, yaw, R);
        if (c > 0.3) f.stamp(['PPP', 'PPP'], pyRound(x - 1.5), -4);
        const [x2, c2] = proj(side * 47, yaw, R);
        if (c2 > 0.35) f.stamp(['EE'], pyRound(x2 - 1), -3);
      }
    }
    for (const [side, e] of [[-1, eL], [1, eR]]) {
      const [x, c] = proj(side * 29, yaw, R);
      if (c < 0.2) continue;
      const cres = e === 'crescent';
      let rows = T.EYES[cres ? 'open' : e];
      if (c < 0.62 && (cres || e === 'open' || e === 'wide')) rows = T.EYES.side;
      if (cres) rows = crescentFor(rows);
      let ex = x;
      if (yaw >= 60) ex = Math.min(hw - 2 - rows[0].length / 2, x);   // profile: the eye sits back from the nose
      f.stamp(rows, pyRound(ex - rows[0].length / 2) + look, -9, side > 0);
      eyePos.push([ex, c, side]);
    }
    if (bw) {
      for (const side of (bw === 'r' ? [1] : [-1, 1])) {
        const [x, c] = proj(side * 33, yaw, R);
        if (c < 0.3) continue;
        f.stamp(T.BROWS[bshape], pyRound(x - 2), bshape === 'up' ? -11.5 : -11, side < 0);
      }
    }
    {
      let [rows, mx, my] = T.MOUTHS[m];
      const [x, c] = proj(1, yaw, R);
      if (c > 0.15) {
        if (c < 0.55) rows = rows.map((r) => (yaw > 0 ? r.slice(0, Math.max(2, Math.floor(r.length / 2))) : r.slice(Math.floor(r.length / 2))));
        f.stamp(rows, pyRound(x - rows[0].length / 2 + mx * (c > 0.55 ? 1 : 0)), pyRound(-4.5 + my));
      } else if (c > -0.1 && yaw > 0) {             // profile: the mouth corner under the nose, as on his left
        rows = T.MOUTH_SIDE.map((r) => r.split('').reverse().join(''));
        const mxr = Math.min(hw - 1 - rows[0].length / 2, x);
        f.stamp(rows, pyRound(mxr - rows[0].length / 2), pyRound(-4.5 + my) + 1);
      }
    }
    }
    for (let k = 0; k < N; k++) if (f.a[k] > 0 && skinOk[k]) A[k] = f.a[k];

    // curls in front of the face, back to front, each with its own outline
    const hm = new Uint8Array(N);
    const spirals = [];
    const clumps = (hs && hs.clumps ? hs.clumps(yaw, T, capped) : clumpsFor(yaw)).map((q, idx) => [q, proj(q[0], yaw, 1)[1], idx]);
    clumps.sort((p, q) => (p[1] - q[1]) || (p[2] - q[2]));
    for (const [[th, cy, roff, r]] of clumps) {
      const [x, c] = proj(th, yaw, R + roff);
      if (c < -0.12) continue;
      const cx = x;
      const one = new Uint8Array(N);
      for (let j = Math.trunc(cy - r - 2) + OY; j < Math.trunc(cy + r + 2) + OY; j++) {
        for (let i = Math.trunc(cx - r - 2) + OX; i < Math.trunc(cx + r + 2) + OX; i++) {
          if (i >= 0 && i < W && j >= 0 && j < Hh) {
            const px = i - OX + 0.5, py = j - OY + 0.5;
            if (Math.hypot(px - cx, py - cy) <= r) one[j * W + i] = 1;
          }
        }
      }
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (one[k]) continue;
        if ((j > 0 && one[k - W]) || (j < Hh - 1 && one[k + W]) || (i > 0 && one[k - 1]) || (i < W - 1 && one[k + 1])) A[k] = Ocol;
      }
      for (let k = 0; k < N; k++) if (one[k]) { A[k] = H; hm[k] = 1; }
      if (r >= 2.2 && c > 0.1 && (!hs || hs.spirals !== false)) spirals.push([cx, cy, r]);
    }
    const [fx, fc] = proj(7, yaw, R);
    const FL = hs && 'forelock' in hs ? hs.forelock : T.FORELOCK;
    if (FL && fc > (yaw < 0 ? 0.8 : 0.45)) {            // turning left the forelock hides sooner
      const fl = new Uint8Array(N);
      FL.forEach((row, yy) => {
        for (let xx = 0; xx < row.length; xx++) {
          if (row[xx] === '.') continue;
          const i = pyRound(fx - 4) + xx + OX, j = -12 + yy + OY;
          fl[j * W + i] = 1;
          A[j * W + i] = IDX[row[xx]];
        }
      });
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (fl[k] || hm[k]) continue;
        if ((j > 0 && fl[k - W]) || (j < Hh - 1 && fl[k + W]) || (i > 0 && fl[k - 1]) || (i < W - 1 && fl[k + 1])) A[k] = Ocol;
      }
    }
    for (const [cx, cy, r] of spirals) {
      const rows = r >= 3.2 ? T.SPIRAL_L : T.SPIRAL;
      const n = rows.length;
      for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < rows[yy].length; xx++) {
        const ch = rows[yy][xx];
        const i = pyRound(cx - n / 2) + xx + OX, j = pyRound(cy - n / 2) + yy + OY;
        if (ch !== '.' && i >= 0 && i < W && j >= 0 && j < Hh && A[j * W + i] === H) A[j * W + i] = IDX[ch];
      }
    }
    if (hs && hs.paint) hs.paint({ s, A, W, Hh, OX, OY, N, yaw, hw, R, sk, capped: !!capped, proj, IDX, ss });   // a style's own hair, under his ears
    for (const side of [-1, 1]) {
      const th = side * 90;
      const [x, c] = proj(th, yaw, R);
      if (c < -0.4) continue;
      const sx = Math.sin(rad(th + yaw));
      let ex, rows;
      if (Math.abs(sx) > 0.72) {
        ex = (hw + 1.6) * (sx > 0 ? 1 : -1);
        rows = sx < 0 ? T.EAR : T.EAR.map((r) => r.split('').reverse().join(''));
      } else {
        ex = x;
        rows = ['.OOO.', 'OSSSO', 'OSssO', 'OSsSO', 'OSSSO', '.OOO.'];
      }
      s.stamp(rows, pyRound(ex - rows[0].length / 2), -8);
    }
    if (glasses) {
      // shades over each eye that shows (the shine falls the same way on both), a two-row bridge when both show,
      // and the arms running back towards the ears (playroom extra)
      const lens = [];
      for (const [x, c, side] of eyePos) {
        let rows = GLASSES;
        if (c < 0.62) rows = rows.map((r) => r.slice(1, 12));
        const x0 = pyRound(x - rows[0].length / 2);
        s.stamp(rows, x0, -12, false);
        lens.push([x0, x0 + rows[0].length, side]);
      }
      if (lens.length === 2) {
        const [a, b] = lens[0][2] < lens[1][2] ? lens : [lens[1], lens[0]];
        for (let x = a[1]; x < b[0]; x++) { s.set(x, -11, 'O'); s.set(x, -10, 'O'); }
      }
      for (const [l0, l1, side] of lens) {                      // the arm: from the lens's outer edge to the face's edge
        if (side < 0) for (let x = Math.floor(-hw + 1); x < l0; x++) s.set(x, -11, 'O');
        else for (let x = l1; x < Math.ceil(hw - 1); x++) s.set(x, -11, 'O');
      }
    }
    return s;
  }
  const headMemo = memo(headRaw);
  function head(yaw = 0, expr = 'rest', mouth = null, eyes = null, look = 0, brow = null, blush = 1, glasses = false, sideSmile = false, hair = null, capped = true) {
    if (!hair || !HAIR[hair]) return headMemo(wrap(pyRound(yaw)), expr, mouth, eyes, look, brow, blush, glasses, sideSmile);
    return headMemo(wrap(pyRound(yaw)), expr, mouth, eyes, look, brow, blush, glasses, sideSmile, hair, !!capped);
  }

  // ---------------------------------------------------------------- body
  const bodyHalf = (y) => 2.4 + (y - K.BODY_TOP) * 0.63;
  // sweep (playroom extra): running sideways the robe is no longer a triangle; the leading side
  // (sweep > 0: to the right) goes almost straight down, the trailing side flares out and its hem lifts behind him
  const bodyMemo = memo(function (yaw, hem, sweep = 0) {
    const a = rad(yaw);
    const W = sweep ? 40 : 30, OXB = W / 2;
    const s = new Spr(W, 16, OXB, 12);
    const fill = new Uint8Array(W * 16);
    const sw = Math.abs(sweep), lead = sweep >= 0 ? 1 : -1;
    for (let j = 0; j < 16; j++) for (let i = 0; i < W; i++) {
      const x = i - OXB + 0.5, y = j - 12 + 0.5;
      if (K.BODY_TOP <= y && y <= K.BODY_BOT) {
        const hw = bodyHalf(y) + Math.max(0, hem) * Math.max(0, (y - K.BODY_TOP - 5) / 6);
        let inside = Math.abs(x) <= hw;
        if (sw) {
          const t = (y - K.BODY_TOP) / (K.BODY_BOT - K.BODY_TOP);
          if (x * lead >= 0) inside = x * lead <= hw + (bodyHalf(K.BODY_TOP) + 0.7 * t - hw) * sw;   // almost straight down
          else {
            const back = -x * lead;
            const lift = sw * 1.8 * clamp((back - 3) / 8, 0, 1);
            inside = back <= hw + sw * 3.6 * Math.pow(t, 1.3) && y <= K.BODY_BOT - lift;
          }
        }
        if (inside) { fill[j * W + i] = 1; s.a[j * W + i] = IDX.D; }
      }
    }
    for (const x of [-2, -1, 0, 1]) { s.set(x, -10, 's'); fill[(-10 + 12) * W + x + OXB] = 1; }
    s.ring('O', fill);
    const front = Math.cos(a);
    if (front > 0.15) {
      const fx = 0.8 * Math.sin(a);
      const cx = pyRound(fx * 3);
      s.stamp(['O..O', '.OO.'], cx - 2, -9);
      if (front > 0.35) {
        const fxx = pyRound(fx * 4.5);
        for (let y = -7; y < -3; y++) { s.set(fxx - 1, y, 'O'); s.set(fxx, y, 'O'); }
        s.stamp(['OOO', 'ODO', 'OOO'], fxx - 1.5, -3);
        s.set(fxx - 1, -7, 'D');
      }
    }
    return s;
  });
  const body = (yaw = 0, hem = 0, sweep = 0) => bodyMemo(wrap(pyRound(yaw)), hem, Math.round(clamp(sweep, -1, 1) * 8) / 8);

  // ---------------------------------------------------------------- limbs
  const tubeMemo = memo(function (L, width, colour, shade) {
    const W = width + 2;
    const s = new Spr(W + 2, L + 3, (W + 2) / 2, 1);
    for (let y = 0; y < L; y++) for (let x = 0; x < width; x++) {
      s.set(x - width / 2, y, (x === width - 1 && width > 1) ? shade : colour);
    }
    s.ring('O');
    return s;
  });
  const tube = (length, width = 2, colour = 'D', shade = 'd') => tubeMemo(Math.max(1, Math.trunc(pyRound(length))), width, colour, shade);
  const hand = memo(function (shape = 'rest', flip = false) {
    const rows = T.HANDS[shape];
    return fromRows(rows, rows[0].length / 2, rows.length / 2, flip);
  });
  const foot = memo(function (sideView = false, flip = false) {
    const rows = sideView ? T.FOOT_SIDE : T.FOOT_FRONT;
    return fromRows(rows, rows[0].length / 2, rows.length - 1, flip);
  });

  // ---------------------------------------------------------------- pose -> placed parts (as in the Python rig)
  const M = {
    T: (x, y) => [1, 0, 0, 1, x, y],
    R: (d) => { const a = rad(d), c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; },
    S: (sx, sy) => [sx, 0, 0, sy, 0, 0],
    mul(A, B) {
      return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
        A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
    },
    ap: (A, x, y) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]],
    inv(A) {
      const det = A[0] * A[3] - A[1] * A[2];
      const a = A[3] / det, b = -A[1] / det, c = -A[2] / det, d = A[0] / det;
      return [a, b, c, d, -(a * A[4] + c * A[5]), -(b * A[4] + d * A[5])];
    },
  };
  const mm = (...ms) => ms.reduce((acc, x) => M.mul(acc, x));

  const SWITCHES = { expr: 'rest', mouth: null, eyes: null, brow: null, hl: 'rest', hr: 'rest', kfree: null, props: [] };
  const HIP = [0.0, -4.0];

  function full(p) { return Object.assign({}, T.BASE, SWITCHES, p); }
  const rootMatrix = (p) => mm(M.T(p.x, p.y), M.T(p.pvx, p.pvy), M.R(p.rot), M.T(-p.pvx, -p.pvy), M.S(p.sx, p.sy));
  const bodyMatrix = (p) => mm(M.T(HIP[0], HIP[1]), M.R(p.lean), M.T(0, p.bdy));
  const headMatrix = (p) => mm(bodyMatrix(p), M.T(0, -10), M.R(p.hrot), M.T(p.hdx, p.hdy));
  const talkMouth = (t) => T.MOUTH_CYCLE[Math.trunc(t * 9) % T.MOUTH_CYCLE.length];

  /* opts: { extra:[dx,dy,dr] kumma follow-through, glasses, blush } -> [{spr, M, kind, side}] in draw order */
  function parts(p, opts = {}) {
    p = full(p);
    const extra = opts.extra || [0, 0, 0];
    const MR = rootMatrix(p), MB = bodyMatrix(p), MH = headMatrix(p);
    const yaw = p.yaw, a = rad(yaw);
    const outBack = [], outMid = [], outFront = [];
    for (const [side, key] of [[-1, 'l'], [1, 'r']]) {
      const th = side * 90 + yaw;
      const sxp = 3.0 * Math.sin(rad(th));
      const depth = Math.cos(rad(th));
      const [shx, shy] = M.ap(MB, sxp, -7.0);
      const [hx, hy] = M.ap(MB, p['h' + key + 'x'], p['h' + key + 'y']);
      const dx = hx - shx, dy = hy - shy;
      const L = Math.hypot(dx, dy);
      const ang = L > 1e-6 ? deg(Math.atan2(-dx, dy)) : 0.0;
      const items = [];
      if (L > 1.4) items.push({ spr: tube(L - 1.2), M: mm(MR, M.T(shx, shy), M.R(ang)), kind: 'arm', side: key });
      const shape = p['h' + key];
      const handItem = { spr: hand(shape, side > 0), M: mm(MR, M.T(hx, hy), M.R(p['h' + key + 'a'] + p.lean)), kind: 'hand', side: key, shape };
      let z = p['z' + key];
      const bx = p['h' + key + 'x'], by = p['h' + key + 'y'];
      if (z < 0.5 && Math.abs(Math.cos(a)) > 0.5 && (by < -9.0 || Math.abs(bx) > 13.0)) z = 1.0;
      const zh = p['zh' + key];
      if (zh >= 1.5 && z < 1.5) outFront.push(handItem); else items.push(handItem);
      if (z >= 1.5) outFront.push(...items);
      else if (z >= 0.5) outMid.push(...items);
      else outBack.push([depth, items]);
    }
    outBack.sort((u, v) => u[0] - v[0]);
    const back = [].concat(...outBack.map((u) => u[1]));

    const sideView = Math.abs(Math.sin(a)) > 0.55;
    const facingLeft = Math.sin(a) < 0;
    const legs = [];
    for (const [side, key] of [[-1, 'l'], [1, 'r']]) {
      const th = side * 90 + yaw;
      const hipx = 2.4 * Math.sin(rad(th));
      const depth = Math.cos(rad(th));
      const [hx, hy] = M.ap(MB, hipx, 0.0);
      const fx = p['f' + key + 'x'], fy = p['f' + key + 'y'];
      const dx = fx - hx, dy = fy - 2.5 - hy;
      const L = Math.hypot(dx, dy);
      const items = [];
      if (L > 1.6) items.push({ spr: tube(L, 2), M: mm(MR, M.T(hx, hy), M.R(deg(Math.atan2(-dx, dy)))), kind: 'leg', side: key });
      items.push({ spr: foot(sideView, facingLeft), M: mm(MR, M.T(fx, fy), M.R(p['f' + key + 'a'])), kind: 'foot', side: key });
      legs.push([depth, items]);
    }
    legs.sort((u, v) => u[0] - v[0]);
    const legItems = [].concat(...legs.map((u) => u[1]));

    const bodyItem = { spr: body(yaw, pyRound(p.hem * 2) / 2, p.sweep || 0), M: mm(MR, MB), kind: 'body' };
    let eyes = p.eyes, mouth = p.mouth;
    if (p.blink > 0.5) eyes = 'closed';
    else if (p.blink > 0.2) eyes = 'half';
    if (p.talk > 0) mouth = talkMouth(p.talk);
    const headItem = {
      spr: head(yaw, p.expr, mouth, eyes, Math.trunc(pyRound(p.look)), p.brow, opts.blush == null ? 1 : opts.blush, opts.glasses || false, opts.sideSmile || false,
        opts.hair || null, opts.capped == null ? p.kfree == null : opts.capped),
      M: mm(MR, MH), kind: 'head', yaw,
    };
    const items = back.concat(legItems, [bodyItem], outMid, [headItem]);
    if (p.kfree == null) {
      const tilt = kummaTilt(yaw);
      const MK = mm(MR, MH, M.T(p.kdx + extra[0], -13.0 + p.kdy + extra[1]), M.R(p.krot + extra[2]));
      items.push({ spr: kumma(pyRound(yaw), pyRound(tilt)), M: MK, kind: 'kumma', yaw, tilt });
    } else {
      const kf = p.kfree;
      const tilt = kf.length > 4 ? kf[4] : kummaTilt(kf[3]);
      items.push({ spr: kumma(pyRound(kf[3]), pyRound(tilt)), M: mm(M.T(kf[0], kf[1]), M.R(kf[2])), kind: 'kumma', free: true, yaw: kf[3], tilt });
    }
    items.push(...outFront);
    for (const pr of (p.props || [])) {
      const [name, hold, home] = pr;
      const spr = propSpr(name);
      if (hold) {
        const [hx, hy] = M.ap(mm(MR, MB), p['h' + hold + 'x'], p['h' + hold + 'y']);
        items.push({ spr, M: M.T(hx, hy - 2.0), kind: 'prop' });
      } else items.unshift({ spr, M: M.T(home[0], home[1]), kind: 'prop' });
    }
    return items;
  }

  const propSpr = memo(function (name) {
    const rows = { finjan: T.FINJAN }[name];
    return sprite(rows, rows[0].length / 2, rows.length);
  });

  function init(tables) {
    T = tables;
    KEYS = tables.KEYS;
    IDX = {};
    KEYS.forEach((k, i) => { IDX[k] = i; });
    K = tables.K;
  }
  // a new palette key (outfit colours), appended like xlib.add_colours does
  function addColour(key, rgb) {
    if (IDX[key] !== undefined) { T.PAL[key] = rgb; return IDX[key]; }
    KEYS.push(key);
    IDX[key] = KEYS.length - 1;
    T.PAL[key] = rgb;
    return IDX[key];
  }

  const api = {
    init, addColour, HAIR, Spr, fromRows, sprite, kumma, head, body, tube, hand, foot, parts, full, M, mm,
    rootMatrix, bodyMatrix, headMatrix, pyRound, pyMod, wrap, rad, deg, clamp, memo,
    get IDX() { return IDX; }, get KEYS() { return KEYS; }, get T() { return T; }, get K() { return K; },
  };
  root.KRig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
