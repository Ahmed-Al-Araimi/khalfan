/* Khalfan's ultra rage burns a window away: four looks to pick from.
 *   fire     real fire: a glowing ember line eats in from the hit, the window chars and scorches ahead of it, flames
 *            lick up along the edge, embers and grey ash float up on the heat (drawn on the graphics card)
 *   shatter  glass: his bolt cracks the window like a pane from the hit, a held beat, then it bursts into shards that
 *            tumble away
 *   dust     the window comes apart into its own coloured dust behind a blue edge of his lightning, and the wind blows
 *            the dust away (graphics card: every two pixels of the window are one grain)
 *   pixel    8-bit fire in Khalfan's own pixels: the window turns to blocks, they burn through a fire palette, chunky
 *            pixel flames roar up (Doom's fire on a grid of two of his cells)
 * window.KhalfanBurn.start(style, shot, impact, now, env) -> a burn; .draw(ctx, burn, now) -> false once it is over.
 * shot = { img: a canvas at env.dpr, x, y, w, h } in page pixels; impact = [x, y] in page pixels; ctx draws in page
 * pixels. env = { dpr, cell (page pixels per rig cell), dir (+1: the window is to his right), floor (page y), audio }.
 * The window's picture lives only in memory, for the length of the burn.
 */
'use strict';
(() => {
  const STYLES = ['fire', 'shatter', 'dust', 'pixel'];
  const LABELS = { fire: 'Real fire', shatter: 'Glass shatter', dust: 'Dust', pixel: 'Pixel fire' };
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, f) => a + (b - a) * f;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ss = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const API = { STYLES, LABELS, start, draw, lastError: null };

  // ---------------------------------------------------------------- noise: one random lattice, read here and by the shaders
  const LAT = new Uint8Array(256 * 256 * 4);
  for (let k = 0; k < LAT.length; k++) LAT[k] = Math.floor(Math.random() * 256);
  function vn(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
    const a = LAT[(y0 * 256 + x0) * 4], b = LAT[(y0 * 256 + x1) * 4], c = LAT[(y1 * 256 + x0) * 4], d = LAT[(y1 * 256 + x1) * 4];
    return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) / 255;
  }
  function fbm(x, y, oct = 5) {
    let s = 0, a = 0.5, n = 0;
    for (let o = 0; o < oct; o++) { s += a * vn(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; a *= 0.5; }
    return s / n;
  }
  // when each spot of the window goes: its distance from the hit (`up` < 1: it climbs faster than it falls) plus
  // noise for a ragged front, scaled 0 (the hit) .. 1 (the last spot). span: page pixels from the first to the last.
  function field(shot, impact, step, o) {
    const fw = Math.ceil(shot.w / step) + 1, fh = Math.ceil(shot.h / step) + 1, v = new Float32Array(fw * fh);
    const ix = impact[0] - shot.x, iy = impact[1] - shot.y, ox = rnd(0, 200), oy = rnd(0, 200);
    let lo = 1e9, hi = -1e9;
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
      const dx = i * step - ix, dy = j * step - iy;
      const val = Math.hypot(dx, dy * (dy < 0 ? o.up : o.down)) + o.noise * (fbm(ox + i * step / o.scale, oy + j * step / o.scale) - 0.5);
      v[j * fw + i] = val;
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    }
    const span = Math.max(1, hi - lo);
    for (let k = 0; k < v.length; k++) v[k] = (v[k] - lo) / span;
    return { fw, fh, step, v, span };
  }
  const fieldAt = (F, shot, x, y) => {
    const i = clamp(Math.round((x - shot.x) / F.step), 0, F.fw - 1), j = clamp(Math.round((y - shot.y) / F.step), 0, F.fh - 1);
    return F.v[j * F.fw + i];
  };

  // ---------------------------------------------------------------- the graphics card (one small WebGL2 context, shared)
  const G = { cv: null, gl: undefined, progs: {}, noise: null, vao: null };
  function glc() {
    if (G.gl !== undefined) return G.gl;
    G.cv = mk(4, 4);
    let gl = null;
    try { gl = G.cv.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true, depth: false, stencil: false }); } catch (e) { gl = null; }
    G.gl = gl || null;
    if (gl) {
      G.vao = gl.createVertexArray();
      G.noise = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, G.noise);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, LAT);
      texParams(gl, gl.REPEAT);
    } else API.lastError = 'no WebGL2';
    return G.gl;
  }
  function texParams(gl, wrap) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  }
  function texImage(gl, src) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    texParams(gl, gl.CLAMP_TO_EDGE);
    return t;
  }
  function texField(gl, F) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, F.fw, F.fh, 0, gl.RED, gl.FLOAT, F.v);
    texParams(gl, gl.CLAMP_TO_EDGE);
    return t;
  }
  function prog(gl, key, vs, fs) {
    if (G.progs[key] !== undefined) return G.progs[key];
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { API.lastError = key + ': ' + gl.getShaderInfoLog(s); console.warn('burn shader', API.lastError); return null; }
      return s;
    };
    const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
    let p = null;
    if (v && f) {
      p = gl.createProgram();
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { API.lastError = key + ' link: ' + gl.getProgramInfoLog(p); console.warn('burn shader', API.lastError); p = null; }
    }
    if (p) {
      p.u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); p.u[a.name] = gl.getUniformLocation(p, a.name); }
    }
    G.progs[key] = p;
    return p;
  }
  function setU(gl, p, name, ...v) {
    const l = p.u[name];
    if (l == null) return;
    if (typeof v[0] === 'object') { const a = v[0]; if (a.int) gl.uniform1i(l, a.int); else if (a.length === 4) gl.uniform4fv(l, a); else gl.uniform2fv(l, a); }
    else gl.uniform1f(l, v[0]);
  }
  function bindTex(gl, p, name, unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    if (p.u[name] != null) gl.uniform1i(p.u[name], unit);
  }
  // size the shared canvas for one burn: two layers stacked, the window itself on top, its light below
  function glFrame(B) {
    const gl = glc(), W = B.cw, H = B.ch;
    if (G.cv.width !== W || G.cv.height !== H * 2) { G.cv.width = W; G.cv.height = H * 2; }
    gl.bindVertexArray(G.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, W, H * 2);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return gl;
  }
  // put the two layers on the page: the window over the desktop, then its light added, softly bloomed
  function glPresent(ctx, B, bloom, mode) {
    const r = B.reg, W = B.cw, H = B.ch;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(G.cv, 0, 0, W, H, r.x, r.y, r.w, r.h);
    if (mode === 'over') ctx.drawImage(G.cv, 0, H, W, H, r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = 'lighter';
    if (bloom) { ctx.filter = `blur(${bloom}px)`; ctx.globalAlpha = mode === 'over' ? 0.5 : 0.85; ctx.drawImage(G.cv, 0, H, W, H, r.x, r.y, r.w, r.h); ctx.filter = 'none'; ctx.globalAlpha = 1; }
    if (mode !== 'over') ctx.drawImage(G.cv, 0, H, W, H, r.x, r.y, r.w, r.h);
    ctx.restore();
  }
  function glFree(B) {
    const gl = G.gl;
    if (!gl || !B.tex) return;
    for (const t of B.tex) gl.deleteTexture(t);
    B.tex = null;
  }

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uNoise, uImg, uField;
uniform vec4 uPic, uReg;
uniform vec2 uFN;
uniform float uStep, uTh, uT, uDpr, uLayer;
float nz(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(uNoise, (i + f + .5) / 256.).r; }
float nz2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(uNoise, (i + f + .5) / 256.).g; }
float fbm(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 4; k++) { s += a * nz(p); p = p * 2.03 + vec2(17.1, 9.7); a *= .5; } return s / .9375; }
float hashI(ivec2 q){ uvec2 u = uvec2(q); uint h = (u.x * 1597334677u) ^ (u.y * 3812015801u); h ^= h >> 16; h *= 2246822519u; h ^= h >> 13; return float(h & 16777215u) / 16777216.; }
bool inPic(vec2 p){ return p.x >= uPic.x && p.y >= uPic.y && p.x <= uPic.x + uPic.z && p.y <= uPic.y + uPic.w; }
float F(vec2 p){ vec2 q = (p - uPic.xy) / uStep; return texture(uField, (q + .5) / uFN).r; }
`;
  const QUAD_VS = COMMON + `
out vec2 vP;
void main(){
  vec2 uv = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vP = uReg.xy + uv * uReg.zw;
  gl_Position = vec4(uv.x * 2. - 1., 1. - uv.y * 2., 0., 1.);
}`;

  // ---------------------------------------------------------------- 1. real fire
  const FIRE_FS = COMMON + `
in vec2 vP;
out vec4 o;
uniform float uRag, uHot;
float B(vec2 p){ return F(p) + (nz(p * .32) - .5) * uRag + (nz2(p * 1.1) - .5) * uRag * .35; }
float slope(vec2 p){ float e = uStep; return length(vec2(F(p + vec2(e, 0.)) - F(p - vec2(e, 0.)), F(p + vec2(0., e)) - F(p - vec2(0., e)))) / (2. * e); }
vec3 flameCol(float I){
  vec3 c = mix(vec3(.62, .06, .01), vec3(1., .34, .03), smoothstep(0., .35, I));
  c = mix(c, vec3(1., .66, .16), smoothstep(.35, .72, I));
  return mix(c, vec3(1., .94, .74), smoothstep(.78, 1., I));
}
vec4 over(vec4 acc, vec3 c, float a){ a = clamp(a, 0., 1.); return vec4(c * a, a) + acc * (1. - a); }
void main(){
  vec2 p = vP;
  bool pic = inPic(p);
  float b = pic ? B(p) : 9.;
  float dp = (b - uTh) / max(pic ? slope(p) : 1., 1e-5);   // page pixels ahead of the fire line (below 0: burnt away)
  float ahead = max(dp, 0.);
  float chw = 14. * (.55 + .9 * nz2(p * .06 + 7.));
  float ch = 1. - smoothstep(0., chw, ahead);
  if (uLayer < .5) {
    if (!pic) { o = vec4(0.); return; }
    vec2 sh = (vec2(nz(p * .08 + vec2(0., uT * 5.)), nz2(p * .08 + vec2(40., uT * 5.))) - .5) * 1.6 * exp(-ahead / 18.);
    vec3 c = texture(uImg, clamp((p + sh - uPic.xy) / uPic.zw, 0., 1.)).rgb;
    float sc = 1. - smoothstep(0., 38. * (.6 + .8 * nz(p * .025 + 3.)), ahead);
    c = mix(c, c * vec3(.84, .63, .38), sc * .85);                                            // toasted brown ahead of it
    float cw = smoothstep(0., 1., ch);
    c = mix(c, mix(vec3(.32, .17, .07), vec3(.035, .022, .014), cw), cw);                     // charred black at the line
    float a = clamp(dp * uDpr + .5, 0., 1.);
    o = vec4(c * a, a);
    return;
  }
  // the fire itself, laid back to front: its light on the window, the glow in the char, the burning edge, the flames
  vec4 acc = vec4(0.);
  float fl = .72 + .56 * nz(vec2(p.x * .06 + p.y * .03, uT * 8.));
  if (pic && dp > -2.) {
    float vein = 1. - smoothstep(0., .045, abs(fbm(p * .11 + 5.) - .5));
    float sp = smoothstep(.66, .86, nz(p * .5 + 11.));
    acc = over(acc, vec3(1., .42, .07), (vein * .95 + sp * .7) * ch * ch * (.5 + .6 * nz2(vec2(p.x * .4, uT * 12.))));
    acc = over(acc, vec3(1., .36, .04), exp(-max(dp, 0.) / 2.2) * step(-1.2, dp) * .85 * fl);
    acc = over(acc, vec3(1., .9, .6), exp(-abs(dp - .6) / .7) * fl);
  }
  // the flames: look down from here for the burning line, along a swaying path, and rise from it
  float hh = -1., prev = 0.;
  bool hp = false;
  float j0 = hashI(ivec2(floor(p * uDpr))) * 3.;
  for (int k = 0; k < 30; k++) {
    float h = float(k) * 3. + j0;
    vec2 q = p + vec2((nz(vec2(p.y * .05 - uT * 3., p.x * .02)) - .5) * h * .9, h);
    if (!inPic(q)) { hp = false; continue; }
    float dq = F(q) - uTh;
    if (hp && (dq > 0.) != (prev > 0.)) { hh = h - 3. + 3. * abs(prev) / (abs(prev) + abs(dq)); break; }
    prev = dq; hp = true;
  }
  if (hh >= 0.) {
    float n1 = fbm(vec2(p.x * .05, p.y * .035 + uT * 2.6));
    float Ht = (24. + 46. * nz(vec2(p.x * .022, uT * .9))) * uHot;
    float I = clamp(1. - hh / max(Ht, 1.) + (n1 - .5) * .9, 0., 1.) * smoothstep(0., .15, 1. - hh / max(Ht * 1.6, 1.));
    acc = over(acc, flameCol(I), smoothstep(0., .42, I) * .94 * uHot);
  }
  o = acc;
}`;
  const FIRE_D = 2.4;
  function startFire(B) {
    const gl = glc();
    const p = gl && prog(gl, 'fire', QUAD_VS, FIRE_FS);
    if (!p) return false;
    const { shot } = B;
    B.F = field(shot, B.impact, 2, { up: 0.62, down: 1.25, noise: 280, scale: 165 });
    B.reg = { x: shot.x - 40, y: shot.y - 120, w: shot.w + 80, h: shot.h + 150 };
    B.cw = Math.round(B.reg.w * B.dpr); B.ch = Math.round(B.reg.h * B.dpr);
    B.tex = [texImage(gl, shot.img), texField(gl, B.F)];
    B.prog = p;
    // what it throws off, picked now and let go as the line reaches each spot
    const sp = [], F = B.F;
    for (let j = 0; j < F.fh; j += 2) for (let i = 0; i < F.fw; i += 2) {
      const r = Math.random(), x = shot.x + i * F.step, y = shot.y + j * F.step, v = F.v[j * F.fw + i];
      if (r < 0.009) sp.push({ v, x, y, kind: 'ember' });
      else if (r < 0.015) sp.push({ v, x, y, kind: 'ash' });
      else if (r < 0.020) sp.push({ v, x, y, kind: 'smoke' });
    }
    B.spawns = sp.sort((a, b) => a.v - b.v); B.si = 0;
    B.parts = [];
    for (let k = 0; k < 34; k++) { const a = rnd(0, 6.283), s = rnd(60, 220); B.parts.push({ kind: 'ember', t0: B.t0, x: B.impact[0], y: B.impact[1], vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: rnd(0.35, 0.8), size: rnd(1.2, 2.4), w: rnd(4, 9), ph: rnd(0, 6), amp: rnd(1, 4) }); }
    B.end = FIRE_D + 1.8;
    return true;
  }
  const fireTh = (u) => 1.05 * (0.8 * u + 0.2 * (1 - Math.pow(1 - clamp(u), 4))) - 0.01;
  function drawFire(ctx, B, now) {
    const tt = now - B.t0, u = tt / FIRE_D, th = fireTh(u);
    if (th < 1.06) {
      const gl = glFrame(B), p = B.prog, F = B.F, s = B.shot;
      gl.useProgram(p);
      bindTex(gl, p, 'uNoise', 0, G.noise); bindTex(gl, p, 'uImg', 1, B.tex[0]); bindTex(gl, p, 'uField', 2, B.tex[1]);
      setU(gl, p, 'uPic', [s.x, s.y, s.w, s.h]); setU(gl, p, 'uReg', [B.reg.x, B.reg.y, B.reg.w, B.reg.h]);
      setU(gl, p, 'uFN', [F.fw, F.fh]); setU(gl, p, 'uStep', F.step); setU(gl, p, 'uTh', th); setU(gl, p, 'uT', tt); setU(gl, p, 'uDpr', B.dpr);
      setU(gl, p, 'uRag', 10 / F.span);
      setU(gl, p, 'uHot', ss(tt / 0.25) * (1 - ss((th - 0.96) / 0.09)));
      gl.disable(gl.BLEND);
      gl.viewport(0, B.ch, B.cw, B.ch); setU(gl, p, 'uLayer', 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.viewport(0, 0, B.cw, B.ch); setU(gl, p, 'uLayer', 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else glFree(B);
    // let go what the line has reached
    while (B.si < B.spawns.length && B.spawns[B.si].v <= th) {
      const q = B.spawns[B.si++];
      if (q.kind === 'ember') B.parts.push({ kind: 'ember', t0: now, x: q.x, y: q.y, vx: rnd(-25, 25), vy: rnd(-95, -40), life: rnd(0.5, 1.1), size: rnd(0.9, 1.9), w: rnd(3, 8), ph: rnd(0, 6), amp: rnd(2, 7) });
      else if (q.kind === 'ash') B.parts.push({ kind: 'ash', t0: now, x: q.x, y: q.y, vx: rnd(-30, 30), vy: rnd(-70, -20), life: rnd(1.4, 2.3), size: rnd(2.6, 6), rot: rnd(0, 6), vr: rnd(-3, 3), fl: rnd(2, 6), ph: rnd(0, 6), path: blob() });
      else B.parts.push({ kind: 'smoke', t0: now, x: q.x + rnd(-10, 10), y: q.y - rnd(20, 50), vx: rnd(-10, 10), vy: rnd(-48, -26), life: rnd(1.2, 1.9), size: rnd(12, 22), ph: rnd(0, 6) });
    }
    B.parts = B.parts.filter((q) => now - q.t0 < q.life);
    fireParts(ctx, B, now, 'smoke');
    if (th < 1.06) glPresent(ctx, B, 6, 'over');
    fireParts(ctx, B, now, 'ash');
    fireParts(ctx, B, now, 'ember');
    return tt < B.end || B.parts.length > 0;
  }
  function blob() {
    const p = new Path2D(), n = 5 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) { const a = k / n * 6.283 + rnd(-0.3, 0.3), r = rnd(0.55, 1); k ? p.lineTo(Math.cos(a) * r, Math.sin(a) * r) : p.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
    p.closePath();
    return p;
  }
  const SPR = {};
  function sprite(key, n, stops) {
    if (SPR[key]) return SPR[key];
    const c = mk(n, n), g = c.getContext('2d'), r = n / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, n, n);
    return (SPR[key] = c);
  }
  function fireParts(ctx, B, now, kind) {
    const hot = sprite('hot', 32, [[0, 'rgba(255,228,150,1)'], [0.16, 'rgba(255,170,60,.95)'], [0.45, 'rgba(255,100,20,.3)'], [1, 'rgba(255,70,10,0)']]);
    const cool = sprite('cool', 32, [[0, 'rgba(255,170,80,1)'], [0.2, 'rgba(240,80,20,.8)'], [0.5, 'rgba(200,40,10,.25)'], [1, 'rgba(160,20,0,0)']]);
    const smoke = sprite('smoke', 64, [[0, 'rgba(46,40,38,.9)'], [0.5, 'rgba(52,46,43,.45)'], [1, 'rgba(60,54,50,0)']]);
    ctx.save();
    for (const q of B.parts) {
      if (q.kind !== kind) continue;
      const a = now - q.t0, f = a / q.life;
      if (a < 0 || f >= 1) continue;
      if (kind === 'ember') {
        const x = q.x + q.vx * a + Math.sin(a * q.w + q.ph) * q.amp, y = q.y + q.vy * a * (1 - 0.35 * f), s = q.size * (1 - 0.5 * f);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.pow(1 - f, 0.7) * (0.75 + 0.25 * Math.sin(a * 30 + q.ph));
        ctx.drawImage(f < 0.45 ? hot : cool, x - s * 3, y - s * 3, s * 6, s * 6);
      } else if (kind === 'ash') {
        const x = q.x + q.vx * (1 - Math.exp(-1.5 * a)) / 1.5 + Math.sin(a * 1.7 + q.ph) * 8 * a;
        const y = q.y + q.vy * (1 - Math.exp(-2.2 * a)) / 2.2 + 13 * a * a;
        const c = Math.min(1, f * 2.2);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.92 * (1 - f * f);
        ctx.save();
        ctx.translate(x, y); ctx.rotate(q.rot + q.vr * a); ctx.scale(q.size, q.size * (0.3 + 0.7 * Math.abs(Math.cos(a * q.fl + q.ph))));
        ctx.fillStyle = `rgb(${Math.round(lerp(40, 112, c))},${Math.round(lerp(31, 105, c))},${Math.round(lerp(25, 98, c))})`;
        ctx.fill(q.path);
        if (f < 0.3) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - f / 0.3; ctx.strokeStyle = '#ff8a2a'; ctx.lineWidth = 0.35; ctx.stroke(q.path); }
        ctx.restore();
      } else {
        const x = q.x + q.vx * a + Math.sin(a * 1.3 + q.ph) * 10 * a, y = q.y + q.vy * a, r = q.size * (1 + 2.4 * f);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.24 * ss(f * 5) * (1 - f);
        ctx.drawImage(smoke, x - r, y - r, r * 2, r * 2);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 2. glass shatter
  const CRACK_T = 0.2, BREAK_T = 0.42;
  function startShatter(B) {
    const { shot, impact } = B, [ix, iy] = impact, dpr = B.dpr;
    const far = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => Math.hypot(shot.x + a * shot.w - ix, shot.y + b * shot.h - iy)));
    const M = 15, a0 = rnd(0, 6.283), ang = [];
    for (let j = 0; j < M; j++) ang.push(a0 + (j + rnd(-0.3, 0.3)) * 6.2832 / M);
    const rings = [rnd(8, 12)];
    while (rings[rings.length - 1] < far * 1.02) rings.push(rings[rings.length - 1] * rnd(1.4, 1.62));
    rings[rings.length - 1] = Math.max(rings[rings.length - 1], far * 1.25);
    const K = rings.length;
    const V = ang.map((a) => rings.map((r, k) => {
      const rr = r * (k === K - 1 ? rnd(1, 1.12) : k ? rnd(0.86, 1.14) : rnd(0.8, 1.2)), aa = a + rnd(-0.05, 0.05);
      return [ix + Math.cos(aa) * rr, iy + Math.sin(aa) * rr];
    }));
    const dist = (p) => Math.hypot(p[0] - ix, p[1] - iy);
    const cracks = [], polys = [];
    const crack = (a, b, w = 1) => { const ra = dist(a), rb = dist(b); cracks.push(ra <= rb ? { a, b, ra, rb, w } : { a: b, b: a, ra: rb, rb: ra, w }); };
    const mid = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
    const piece = (q) => {
      if (q.length === 4 && Math.random() < 0.45) {                       // some split corner to corner: glass breaks in triangles
        if (Math.random() < 0.5) { polys.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]); crack(q[0], q[2], 0.8); }
        else { polys.push([q[0], q[1], q[3]], [q[1], q[2], q[3]]); crack(q[1], q[3], 0.8); }
      } else polys.push(q);
    };
    polys.push(V.map((col) => col[0]));                                  // the crushed middle
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M;
      crack([ix, iy], V[j][0], 1.2);
      for (let k = 0; k < K - 1; k++) {
        const a = V[j][k], b = V[j2][k], c = V[j2][k + 1], d = V[j][k + 1];
        crack(a, d, 1.2 - 0.3 * k / K);                                    // the rays
        crack(a, b, 0.9);                                                  // the rings
        if (Math.hypot(c[0] - d[0], c[1] - d[1]) > 130) {                   // big outer pieces split across the middle
          const m1 = mid(a, b, rnd(0.4, 0.6)), m2 = mid(d, c, rnd(0.4, 0.6));
          crack(m1, m2, 0.8);
          piece([a, m1, m2, d]); piece([m1, b, c, m2]);
        } else piece([a, b, c, d]);
        if (k < K - 2 && Math.random() < 0.5) {                            // little branches off the rays
          const ra = Math.atan2(a[1] - iy, a[0] - ix) + (Math.random() < 0.5 ? -1 : 1) * rnd(0.4, 0.9), L = Math.min(60, rings[k] * rnd(0.15, 0.35));
          crack(a, [a[0] + Math.cos(ra) * L, a[1] + Math.sin(ra) * L], 0.6);
        }
      }
    }
    // each piece: its own little picture, cut from the window, with a glassy sheen and a bright rim
    const sdx = shot.img.width / shot.w, sdy = shot.img.height / shot.h, shards = [];
    for (const q of polys) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
      for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x / q.length; cy += y / q.length; }
      const bx = Math.max(x0, shot.x), by = Math.max(y0, shot.y), bx2 = Math.min(x1, shot.x + shot.w), by2 = Math.min(y1, shot.y + shot.h);
      if (bx2 - bx < 1 || by2 - by < 1) continue;
      const bw = bx2 - bx, bh = by2 - by, c = mk(Math.ceil(bw * dpr), Math.ceil(bh * dpr)), g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, -bx * dpr, -by * dpr);
      const path = new Path2D(); q.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath();
      g.save(); g.beginPath(); g.rect(bx, by, bw, bh); g.clip(); g.clip(path);
      g.drawImage(shot.img, (bx - shot.x) * sdx, (by - shot.y) * sdy, bw * sdx, bh * sdy, bx, by, bw, bh);
      const sa = rnd(0, 6.283), gr = g.createLinearGradient(cx - Math.cos(sa) * bw, cy - Math.sin(sa) * bh, cx + Math.cos(sa) * bw, cy + Math.sin(sa) * bh);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(230,240,255,.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fill(path);
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2; g.stroke(path);
      g.strokeStyle = 'rgba(20,30,45,.35)'; g.lineWidth = 0.7; g.stroke(path);
      g.restore();
      const local = new Path2D(); q.forEach(([x, y], i) => (i ? local.lineTo(x - cx, y - cy) : local.moveTo(x - cx, y - cy))); local.closePath();
      const rc = Math.hypot(cx - ix, cy - iy), rn = clamp(rc / far), dx = (cx - ix) / (rc || 1), dy = (cy - iy) / (rc || 1), spd = 40 + 160 * Math.pow(1 - rn, 2);
      shards.push({ c, bx, by, bw, bh, cx, cy, path, local, rel: BREAK_T + 0.3 * rn + rnd(0, 0.04),
        vx: dx * spd + rnd(-20, 20) + B.env.dir * 25, vy: dy * spd * 0.4 - rnd(0, 50), spin: rnd(-3, 3) * (1.5 - rn), tum: rnd(3, 8), ax: rnd(0, 3.14), ph: rnd(0, 6.283), life: rnd(0.9, 1.4), out: false });
    }
    B.far = far; B.cracks = cracks; B.shards = shards.sort((a, b) => a.rel - b.rel); B.r1 = rings[1] || 20;
    B.stat = mk(shot.img.width, shot.img.height); B.sg = B.stat.getContext('2d');
    B.specks = [];
    B.end = BREAK_T + 0.36 + 1.5;
    return true;
  }
  function drawShatter(ctx, B, now) {
    const tt = now - B.t0, s = B.shot, dpr = B.dpr, floor = B.env.floor || 1e9;
    const R = B.far * 1.1 * (1 - Math.pow(1 - clamp(tt / CRACK_T), 2));
    // what still stands: the window, its cracks, minus the pieces already gone
    if (tt < BREAK_T + 0.6) {
      const g = B.sg;
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'copy'; g.drawImage(s.img, 0, 0); g.globalCompositeOperation = 'source-over';
      const kx = s.img.width / s.w, ky = s.img.height / s.h;
      g.setTransform(kx, 0, 0, ky, -s.x * kx, -s.y * ky);
      const crush = clamp(tt / 0.08) * (tt < BREAK_T ? 1 : 0);
      if (crush > 0) { const gr = g.createRadialGradient(B.impact[0], B.impact[1], 0, B.impact[0], B.impact[1], B.r1 * 1.4); gr.addColorStop(0, `rgba(255,255,255,${0.6 * crush})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(B.impact[0] - B.r1 * 1.5, B.impact[1] - B.r1 * 1.5, B.r1 * 3, B.r1 * 3); }
      const lit = Math.max(0, 1 - tt / 0.6);
      g.lineCap = 'round';
      for (const pass of [0, 1, 2]) {
        if (pass === 2 && lit <= 0) continue;
        g.globalCompositeOperation = pass === 2 ? 'lighter' : 'source-over';
        g.strokeStyle = pass === 0 ? 'rgba(15,25,40,.45)' : pass === 1 ? 'rgba(255,255,255,.95)' : `rgba(120,175,255,${(0.55 * lit).toFixed(3)})`;
        g.beginPath();
        for (const c of B.cracks) {
          if (R <= c.ra) continue;
          const f = c.rb > c.ra ? clamp((R - c.ra) / (c.rb - c.ra)) : 1;
          g.moveTo(c.a[0] + (pass === 0 ? 0.5 : 0), c.a[1] + (pass === 0 ? 0.5 : 0));
          g.lineTo(lerp(c.a[0], c.b[0], f) + (pass === 0 ? 0.5 : 0), lerp(c.a[1], c.b[1], f) + (pass === 0 ? 0.5 : 0));
        }
        g.lineWidth = pass === 0 ? 1.7 : pass === 1 ? 0.8 : 3.2;
        g.stroke();
      }
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
      for (const sh of B.shards) if (tt >= sh.rel) { g.fill(sh.path); g.stroke(sh.path); }
      g.globalCompositeOperation = 'source-over';
      ctx.drawImage(B.stat, s.x, s.y, s.w, s.h);
    }
    // the pieces in flight: thrown out from the hit, falling, tumbling (turned edge-on they flash white)
    ctx.save();
    for (const sh of B.shards) {
      const a = tt - sh.rel;
      if (a < 0) break;
      if (!sh.out) {
        sh.out = true;
        for (let k = 0; k < 2; k++) B.specks.push({ t0: now, x: sh.cx + rnd(-sh.bw, sh.bw) * 0.3, y: sh.cy + rnd(-sh.bh, sh.bh) * 0.3, vx: sh.vx * rnd(0.6, 1.4) + rnd(-60, 60), vy: sh.vy * rnd(0.6, 1.2) - rnd(0, 80), life: rnd(0.5, 0.9), ph: rnd(0, 6) });
      }
      if (a > sh.life) continue;
      const x = sh.cx + sh.vx * a, y = sh.cy + sh.vy * a + 1000 * a * a;
      const fade = clamp((sh.life - a) / 0.3) * clamp(1 - (y - floor) / 40);
      if (fade <= 0) continue;
      const phi = sh.ph + sh.tum * a, cs = Math.cos(phi), sc = 1 + 0.05 * ss(a / 0.15);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(sh.ax); ctx.scale(Math.abs(cs) < 0.04 ? 0.04 * Math.sign(cs || 1) : cs, 1); ctx.rotate(-sh.ax + sh.spin * a); ctx.scale(sc, sc);
      ctx.globalAlpha = fade;
      ctx.drawImage(sh.c, sh.bx - sh.cx, sh.by - sh.cy, sh.bw, sh.bh);
      const glint = Math.pow(Math.max(0, 1 - Math.abs(cs) * 2.2), 2) * 0.85;
      if (glint > 0.02) { ctx.fillStyle = `rgba(235,245,255,${glint.toFixed(3)})`; ctx.fill(sh.local); }
      if (cs < 0) { ctx.fillStyle = 'rgba(30,50,80,.22)'; ctx.fill(sh.local); }
      ctx.restore();
    }
    // glass dust, glinting
    ctx.globalCompositeOperation = 'lighter';
    B.specks = B.specks.filter((q) => now - q.t0 < q.life);
    for (const q of B.specks) {
      const a = now - q.t0, f = a / q.life, x = q.x + q.vx * a, y = q.y + q.vy * a + 700 * a * a;
      ctx.globalAlpha = (1 - f) * (0.55 + 0.45 * Math.sin(a * 40 + q.ph));
      ctx.fillStyle = q.ph > 3 ? '#ffffff' : '#bcd6ff';
      ctx.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
    }
    ctx.restore();
    return tt < B.end;
  }

  // ---------------------------------------------------------------- 3. dust
  const DUST_D = 0.9;                                                    // the window goes in under a second (it was 1.7)
  const DUST_QFS = COMMON + `
in vec2 vP;
out vec4 o;
uniform float uBand, uBlk;
void main(){
  vec2 p = vP;
  if (!inPic(p)) { o = vec4(0.); return; }
  ivec2 bi = ivec2(floor((p - uPic.xy) * uDpr / uBlk));
  vec2 bc = (vec2(bi) + .5) * uBlk / uDpr + uPic.xy;
  float d = F(bc) - uBand * hashI(bi) - uTh;            // above 0: this grain is still in the window
  if (d <= 0.) { o = vec4(0.); return; }
  float near = 1. - smoothstep(0., uBand * 1.7, d);
  vec3 c = texture(uImg, (p - uPic.xy) / uPic.zw).rgb;
  if (uLayer < .5) { o = vec4(mix(c, c * .78 + vec3(.05, .09, .16), near * .55), 1.); return; }
  vec3 e = vec3(.42, .64, 1.) * pow(near, 3.) * .85;
  o = vec4(e, max(e.r, max(e.g, e.b)));
}`;
  const DUST_VS = COMMON + `
uniform int uBX;
uniform float uBand, uBlk, uDur;
uniform vec2 uWind;
out vec4 vC;
out float vGlow;
void main(){
  ivec2 bi = ivec2(gl_VertexID % uBX, gl_VertexID / uBX);
  vec2 bc = (vec2(bi) + .5) * uBlk / uDpr + uPic.xy;
  float h = hashI(bi), h2 = hashI(bi + ivec2(7919, 1049)), h3 = hashI(bi + ivec2(3137, 271));
  float age = (uTh - (F(bc) - uBand * h)) * uDur;       // seconds since this grain came away
  float life = .9 + .9 * h2;
  if (age <= 0. || age >= life || bc.x > uPic.x + uPic.z || bc.y > uPic.y + uPic.w) { gl_Position = vec4(2., 2., 0., 1.); gl_PointSize = 0.; vC = vec4(0.); vGlow = 0.; return; }
  vec3 col = texture(uImg, (bc - uPic.xy) / uPic.zw).rgb;
  float heavy = step(h3, .05);
  vec2 d = uWind * ((25. + 45. * h2) * age + 60. * age * age) * (1. - heavy * .7);
  vec2 tq = bc * .011 + vec2(age * .35, -age * .25);
  d += (vec2(nz(tq * 3.), nz2(tq * 3. + 19.)) - .5) * 2. * (50. * age * age + 16. * age);
  d.y += heavy * 260. * age * age - 20. * age * (1. - heavy);
  vec2 uv = (bc + d - uReg.xy) / uReg.zw;
  gl_Position = vec4(uv.x * 2. - 1., 1. - uv.y * 2., 0., 1.);
  float f = age / life, s = uBlk * (1. + heavy * .8) * (1. - .6 * f) * mix(1., 3.5, uLayer);
  gl_PointSize = max(s, 1.);
  float a = (1. - smoothstep(.35, 1., f)) * min(s, 1.);
  col = mix(col, vec3(dot(col, vec3(.3, .59, .11))) * .8 + .08, smoothstep(.2, .9, f) * .6);
  vC = vec4(col * a, a);
  vGlow = (1. - smoothstep(0., .28, age)) * step(h3, .22);
}`;
  const DUST_PFS = `#version 300 es
precision highp float;
in vec4 vC;
in float vGlow;
out vec4 o;
uniform float uLayer;
void main(){
  if (uLayer < .5) { o = vC; return; }
  float g = vGlow * (1. - smoothstep(0., 1., length(gl_PointCoord - .5) * 2.)) * .7;
  o = vec4(vec3(.55, .76, 1.) * g, g);
}`;
  function startDust(B) {
    const gl = glc();
    const pq = gl && prog(gl, 'dustq', QUAD_VS, DUST_QFS), pp = gl && prog(gl, 'dustp', DUST_VS, DUST_PFS);
    if (!pq || !pp) return false;
    const { shot } = B, wx = B.env.dir || 1;
    B.F = field(shot, B.impact, 2, { up: 1, down: 1, noise: 340, scale: 150 });
    B.reg = { x: shot.x - (wx > 0 ? 60 : 380), y: shot.y - 300, w: shot.w + 440, h: shot.h + 460 };
    B.cw = Math.round(B.reg.w * B.dpr); B.ch = Math.round(B.reg.h * B.dpr);
    B.tex = [texImage(gl, shot.img), texField(gl, B.F)];
    B.pq = pq; B.pp = pp; B.blk = 2;
    B.bx = Math.ceil(shot.w * B.dpr / B.blk); B.by = Math.ceil(shot.h * B.dpr / B.blk);
    const wl = Math.hypot(1, 0.45); B.wind = [wx / wl, -0.45 / wl];
    B.end = DUST_D + 1.5;
    return true;
  }
  function drawDust(ctx, B, now) {
    const tt = now - B.t0, th = 1.04 * tt / DUST_D - 0.02;
    if (tt >= B.end) { glFree(B); return false; }
    const gl = glFrame(B), F = B.F, s = B.shot;
    const uni = (p) => {
      gl.useProgram(p);
      bindTex(gl, p, 'uNoise', 0, G.noise); bindTex(gl, p, 'uImg', 1, B.tex[0]); bindTex(gl, p, 'uField', 2, B.tex[1]);
      setU(gl, p, 'uPic', [s.x, s.y, s.w, s.h]); setU(gl, p, 'uReg', [B.reg.x, B.reg.y, B.reg.w, B.reg.h]);
      setU(gl, p, 'uFN', [F.fw, F.fh]); setU(gl, p, 'uStep', F.step); setU(gl, p, 'uTh', th); setU(gl, p, 'uT', tt); setU(gl, p, 'uDpr', B.dpr);
      setU(gl, p, 'uBand', 14 / F.span); setU(gl, p, 'uBlk', B.blk);
    };
    gl.enable(gl.BLEND);
    for (const layer of [0, 1]) {
      if (layer === 0) { gl.viewport(0, B.ch, B.cw, B.ch); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
      else { gl.viewport(0, 0, B.cw, B.ch); gl.blendFunc(gl.ONE, gl.ONE); }
      uni(B.pq); setU(gl, B.pq, 'uLayer', layer); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      uni(B.pp); setU(gl, B.pp, 'uLayer', layer); setU(gl, B.pp, 'uDur', DUST_D / 1.04); setU(gl, B.pp, 'uWind', B.wind);
      if (B.pp.u.uBX != null) gl.uniform1i(B.pp.u.uBX, B.bx);
      gl.drawArrays(gl.POINTS, 0, B.bx * B.by);
    }
    gl.disable(gl.BLEND);
    glPresent(ctx, B, 3, 'add');
    return true;
  }

  // ---------------------------------------------------------------- 4. pixel fire
  // a fire palette in 37 steps (Doom's fire's count), dark red to white, keyed by hand for the 8-bit look
  const PAL = (() => {
    const keys = [[0, [30, 6, 6]], [6, [100, 14, 12]], [12, [175, 30, 14]], [18, [228, 70, 18]], [24, [252, 128, 26]], [29, [255, 190, 52]], [33, [255, 232, 120]], [36, [255, 252, 225]]];
    const out = [];
    for (let h = 0; h <= 36; h++) {
      let k = 0; while (k < keys.length - 2 && keys[k + 1][0] < h) k++;
      const [h0, c0] = keys[k], [h1, c1] = keys[k + 1], f = clamp((h - h0) / (h1 - h0));
      out.push(c0.map((v, i) => Math.round(lerp(v, c1[i], f))));
    }
    return out;
  })();
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const PIX_D = 2.1, LEAD = 0.26, BURN_T = 0.24, CHAR_T = 0.16, SIM = 1 / 30;
  function startPixel(B) {
    const { shot, impact } = B, cs = Math.max(2, (B.env.cell || 2.5) * 2);          // two of his pixels
    const x0 = Math.floor(shot.x / cs) * cs, y0w = Math.floor(shot.y / cs) * cs, head = Math.ceil(170 / cs);
    const nx = Math.ceil((shot.x + shot.w - x0) / cs), nyw = Math.ceil((shot.y + shot.h - y0w) / cs), ny = nyw + head;
    const cat = new Float32Array(nx * nyw).fill(NaN), ox = rnd(0, 200), oy = rnd(0, 200);   // (NaN: not the window)
    let lo = 1e9, hi = -1e9;
    for (let j = 0; j < nyw; j++) for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * cs, cy = y0w + (j + 0.5) * cs;
      if (cx < shot.x || cx > shot.x + shot.w || cy < shot.y || cy > shot.y + shot.h) continue;
      const dx = cx - impact[0], dy = cy - impact[1], v = Math.hypot(dx, dy * (dy < 0 ? 0.7 : 1.2)) + 230 * (fbm(ox + cx / 120, oy + cy / 120) - 0.5);
      cat[j * nx + i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    for (let k = 0; k < cat.length; k++) if (!Number.isNaN(cat[k])) cat[k] = (cat[k] - lo) / Math.max(1, hi - lo) * PIX_D;
    // the window in blocks: one colour a block, in fewer shades
    const sm = mk(nx, nyw), sg = sm.getContext('2d');
    sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
    sg.drawImage(shot.img, 0, 0, shot.img.width, shot.img.height, (shot.x - x0) / cs, (shot.y - y0w) / cs, shot.w / cs, shot.h / cs);
    const mos = sg.getImageData(0, 0, nx, nyw).data;
    for (let k = 0; k < mos.length; k++) if (k % 4 !== 3) mos[k] = Math.round(mos[k] / 255 * 5) / 5 * 255;
    Object.assign(B, { cs, x0, y0w, y0: y0w - head * cs, head, nx, nyw, ny, cat, mos, heat: new Uint8Array(nx * ny), grid: mk(nx, ny), mask: mk(nx, nyw), wc: mk(shot.img.width, shot.img.height),
      img: new ImageData(nx, ny), mimg: new ImageData(nx, nyw), simT: 0, sparks: [], last: PIX_D + BURN_T + CHAR_T + 0.1 });
    const ic = [Math.floor((impact[0] - x0) / (cs / 2)), Math.floor((impact[1] - B.y0) / (cs / 2))];
    for (let k = 0; k < 28; k++) { const a = k / 28 * 6.283, s = rnd(3, 7); B.sparks.push({ x: ic[0], y: ic[1], vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5, life: rnd(8, 16), age: 0, kind: 'spark' }); }
    B.end = B.last + 1.3;
    return true;
  }
  function pixelSim(B) {
    const { nx, ny, nyw, head, heat, cat } = B, t = B.simT;
    // Doom's fire: every cell hands its heat to the one above, a little cooler, a step to one side
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const src = j * nx + i, h = heat[src];
      if (!h) { heat[src - nx] = 0; continue; }
      const dst = clamp(i + ((Math.random() * 3) | 0) - 1, 0, nx - 1) + (j - 1) * nx;
      heat[dst] = Math.max(0, h - 1 - (Math.random() < 0.6 ? 1 : 0) - (Math.random() < 0.3 ? 1 : 0));
    }
    heat.fill(0, (ny - 1) * nx);                                         // (nothing feeds the bottom row from below)
    // the burning edge feeds it (a block burning beside one still whole); now and then it throws a spark or smoke
    const cold = (i, j) => { if (i < 0 || j < 0 || i >= nx || j >= nyw) return false; const c = cat[j * nx + i]; return c >= 0 && t < c; };
    for (let j = 0; j < nyw; j++) for (let i = 0; i < nx; i++) {
      const c = cat[j * nx + i];
      if (!(c >= 0)) continue;
      const a = t - c;
      if (a >= 0 && a < BURN_T && (cold(i - 1, j) || cold(i + 1, j) || cold(i, j - 1) || cold(i, j + 1))) {
        const k = (j + head) * nx + i;
        heat[k] = 34;
        if (Math.random() < 0.012 && B.sparks.length < 300) B.sparks.push({ x: i * 2 + 1, y: (j + head) * 2, vx: rnd(-0.6, 0.6), vy: rnd(-2.8, -1.3), life: rnd(10, 24), age: 0, kind: 'spark' });
        if (Math.random() < 0.01 && B.sparks.length < 300) B.sparks.push({ x: i, y: j + head - 10, vx: rnd(-0.3, 0.3), vy: rnd(-0.9, -0.5), life: rnd(18, 30), age: 0, kind: 'smoke' });
      }
    }
    for (const q of B.sparks) { q.age++; q.x += q.vx; q.y += q.vy; if (q.kind === 'spark') { q.vy += 0.06; q.vx += rnd(-0.25, 0.25); } else q.vx += rnd(-0.12, 0.12); }
    B.sparks = B.sparks.filter((q) => q.age < q.life);
  }
  function drawPixel(ctx, B, now) {
    const tt = now - B.t0, s = B.shot;
    let stepped = false;
    while (B.simT <= tt) { pixelSim(B); B.simT += SIM; stepped = true; }
    const { nx, ny, nyw, head, cat, mos, heat } = B, t = B.simT - SIM;
    if (stepped) {
      const d = B.img.data, m = B.mimg.data;
      d.fill(0); m.fill(0);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i, o = k * 4, jw = j - head, bay = BAYER[(j & 3) * 4 + (i & 3)];
        let r = 0, g = 0, b = 0, a = 0;
        if (jw >= 0) {
          const c = cat[jw * nx + i], mo = (jw * nx + i) * 4;
          if (c >= 0) {                                                  // (NaN: outside the window)
            const age = t - c;
            if (age < -LEAD || (age < 0 && bay >= (1 + age / LEAD) * 2.2)) m[mo + 3] = 255;                   // still the window itself
            else if (age < 0) {                                                                                // turned to blocks
              r = mos[mo]; g = mos[mo + 1]; b = mos[mo + 2]; a = 255;
            } else if (age < BURN_T) {                                                                         // burning: white hot, cooling to orange
              const p = PAL[clamp(Math.round(32 - 26 * age / BURN_T + (bay - 0.5) * 5), 0, 36)];
              r = p[0]; g = p[1]; b = p[2]; a = 255;
            } else if (age < BURN_T + CHAR_T && bay > (age - BURN_T) / CHAR_T) { r = 38; g = 16; b = 10; a = 255; }   // the char, falling apart
            else if (age < BURN_T + 0.8 && ((i * 7 + jw * 13) % 29) === 0) {                                    // a block still glowing
              const p = PAL[10 + Math.round(10 * Math.abs(Math.sin(tt * 9 + i)))]; r = p[0]; g = p[1]; b = p[2]; a = 255;
            }
          }
        }
        const h = heat[k];
        if (h >= 8) {
          const p = PAL[h], fa = h >= 12 ? 1 : (h - 7) / 5;
          r = lerp(r, p[0], fa); g = lerp(g, p[1], fa); b = lerp(b, p[2], fa); a = Math.max(a, fa * 255);
        }
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
      }
      B.grid.getContext('2d').putImageData(B.img, 0, 0);
      B.mask.getContext('2d').putImageData(B.mimg, 0, 0);
      const wg = B.wc.getContext('2d');
      wg.globalCompositeOperation = 'copy'; wg.drawImage(s.img, 0, 0);
      wg.globalCompositeOperation = 'destination-in'; wg.imageSmoothingEnabled = false;
      const kx = s.img.width / s.w, ky = s.img.height / s.h;
      wg.drawImage(B.mask, (B.x0 - s.x) * kx, (B.y0w - s.y) * ky, nx * B.cs * kx, nyw * B.cs * ky);
      wg.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    if (t < B.last) ctx.drawImage(B.wc, s.x, s.y, s.w, s.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(B.grid, B.x0, B.y0, nx * B.cs, ny * B.cs);
    // sparks (one of his pixels) and smoke (two blocks), on the grid
    const c1 = B.cs / 2;
    for (const q of B.sparks) {
      const f = q.age / q.life;
      if (q.kind === 'spark') {
        const p = PAL[clamp(Math.round(36 - f * 24), 0, 36)];
        ctx.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`;
        ctx.fillRect(B.x0 + Math.round(q.x) * c1, B.y0 + Math.round(q.y) * c1, c1, c1);
      } else {
        ctx.fillStyle = `rgba(70,64,62,${[0.55, 0.42, 0.28, 0.14][Math.min(3, Math.floor(f * 4))]})`;
        ctx.fillRect(B.x0 + Math.round(q.x) * B.cs, B.y0 + Math.round(q.y) * B.cs, B.cs * 2, B.cs * 2);
      }
    }
    ctx.restore();
    return tt < B.end;
  }

  // ---------------------------------------------------------------- sounds (made here, nothing to load)
  let NOISE = null;
  function noise(ac) {
    if (NOISE && NOISE.sampleRate === ac.sampleRate) return NOISE;
    NOISE = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = NOISE.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return NOISE;
  }
  function burst(ac, out, t, dur, type, freq, q, gain, attack = 0.005) {
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noise(ac); src.loop = true;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
    return f;
  }
  function tone(ac, out, t, type, freq, dur, gain) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  function sound(style, A) {
    if (!A || !A.ctx || A.on === false) return;
    try {
      const ac = A.ctx, out = A.master, t = ac.currentTime + 0.01;
      if (style === 'fire') {
        burst(ac, out, t, 0.7, 'lowpass', 700, 0.7, 1.1, 0.02);                                   // the whoomp as it catches
        burst(ac, out, t + 0.05, 2.4, 'bandpass', 320, 0.6, 0.35, 0.3);                           // the roar
        for (let k = 0; k < 30; k++) burst(ac, out, t + rnd(0.05, 2.4), rnd(0.01, 0.03), 'bandpass', rnd(1500, 4200), 2, rnd(0.25, 0.7), 0.001);   // crackles
      } else if (style === 'shatter') {
        burst(ac, out, t, 0.08, 'highpass', 2200, 0.7, 0.9, 0.001); tone(ac, out, t, 'sine', 120, 0.12, 0.5);   // the crack
        burst(ac, out, t + BREAK_T, 0.45, 'highpass', 3000, 0.7, 0.9, 0.002);                                     // it breaks
        for (let k = 0; k < 20; k++) tone(ac, out, t + BREAK_T + rnd(0, 1.2) * rnd(0.3, 1), 'sine', rnd(2600, 7200), rnd(0.08, 0.3), rnd(0.06, 0.18));   // pieces landing
      } else if (style === 'dust') {
        const f = burst(ac, out, t, 2.1, 'bandpass', 500, 1.2, 0.55, 0.35);                       // the wind takes it
        f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(2800, t + 1.6);
        for (let k = 0; k < 8; k++) tone(ac, out, t + rnd(0, 1.2), 'sine', rnd(3000, 6000), rnd(0.2, 0.5), 0.04);
      } else if (style === 'pixel') {
        const o = tone(ac, out, t, 'square', 880, 0.62, 0.16);                                     // 8-bit: a falling note
        for (let k = 0; k < 12; k++) o.frequency.setValueAtTime(880 * Math.pow(0.82, k), t + k * 0.05);
        const crunch = ac.createBuffer(1, Math.round(ac.sampleRate * 1.6), ac.sampleRate), d = crunch.getChannelData(0);
        let v = 0;
        for (let i = 0; i < d.length; i++) { if (i % 24 === 0) v = Math.random() * 2 - 1; d[i] = v; }
        const src = ac.createBufferSource(), g = ac.createGain();
        src.buffer = crunch;
        for (let k = 0; k <= 16; k++) g.gain.setValueAtTime(0.42 * (1 - k / 16), t + k * 0.1);
        src.connect(g); g.connect(out); src.start(t);
      }
    } catch (e) { /* a sound is never worth stopping him */ }
  }

  // ---------------------------------------------------------------- one burn
  const STARTS = { fire: startFire, shatter: startShatter, dust: startDust, pixel: startPixel };
  const DRAWS = { fire: drawFire, shatter: drawShatter, dust: drawDust, pixel: drawPixel };
  function start(style, shot, impact, now, env = {}) {
    if (!STARTS[style]) style = 'dust';                              // (his pick)
    const B = { style, shot, impact: impact.slice(), t0: now, env, dpr: env.dpr || 1 };
    let ok = false;
    try { ok = STARTS[style](B); } catch (e) { API.lastError = style + ': ' + (e && e.message); console.warn('burn', e); }
    if (!ok && (style === 'fire' || style === 'dust')) { B.style = 'shatter'; ok = startShatter(B); }   // (no graphics card: glass)
    if (!ok) return null;
    sound(B.style, env.audio);
    return B;
  }
  function draw(ctx, B, now) {
    if (!B) return false;
    let more = false;
    try { more = DRAWS[B.style](ctx, B, now); } catch (e) { API.lastError = B.style + ' draw: ' + (e && e.message); console.warn('burn', e); more = false; }
    if (!more) glFree(B);
    return more;
  }
  window.KhalfanBurn = API;
})();
