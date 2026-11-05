/*
 * The Flying Nimbus: Khalfan's golden cloud.
 *
 * The cloud is Ahmed's 60-frame sheet, every cloud as he made it,
 * brought down to the game's grid (data/khalfan-nimbus.js); the game's own Khalfan rides it.
 * The sheet's rows: idle billow 1-6, prepare 7-12, accelerate 13-18, full flight 19-24, swoop up 25-30, crest and down
 * 31-36, brake 37-42, stop 43-48, settle 49-54, idle loop 55-60.
 *
 * Its tile (Jumps and heroics) calls it. He whistles with a hand up, then looks and points; a glint at the edge, and
 * the cloud streaks in, brakes, settles beside him; he crouches, hops on and it dips under him. Then you fly him: the
 * arrows (up and down climb and dive, Shift goes faster), a tap anywhere to fly there, or drag him through the air and
 * let go to fling him. Its tile again (or any move) brings him down; he hops off, waves, and the cloud streaks away.
 *
 * The page calls window.KhalfanNimbus(host) once and hooks what it returns into its frame, his pose, the pointer and
 * the tiles. Everything here works in room cells; the stage (host.RM) is read at run time, as it changes.
 */
(() => {
  const NIMBUS = window.KHALFAN_NIMBUS;
  if (!NIMBUS) return;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ss = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
  const bump = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin(Math.PI * (t - a) / (b - a)));
  const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };

  // which drawings play when: loops repeat, the rest play once and hand over to `next`
  const ANIM = {
    // standing, calm: one drawing, held, its top level (IDLE_DECK); no swapping, no bob
    idle: { f: [1], d: 1, loop: true },
    go: { f: range(9, 18), d: 0.045, next: 'fly' },
    fly: { f: range(19, 24), loop: true },
    up: { f: [26, 27, 28, 29, 30, 29, 28, 27], loop: true },
    down: { f: [33, 34, 35, 36, 35, 34], loop: true },
    brake: { f: range(37, 48), d: 0.055, next: 'settle' },
    settle: { f: range(49, 54), d: 0.085, next: 'idle' },
  };
  const SINK = 1.5;              // his feet sink this far into the fluff (the cloud's front rows cover them)
  const PARK = 3;                // the parked cloud's underside, above the floor
  // the cloud's measures come from the cut of the sheet, so a re-cut at another size carries them along;
  // K scales the distances that were set by eye at the first cut's size (its body's bottom 21.5 cells under the anchor)
  const med = (a) => { const q = a.slice().sort((u, v) => u - v); return q[q.length >> 1]; };
  const BOTTOM = med(NIMBUS.bottom);   // the anchor -> the underside of the body, in cells
  const DECK = med(NIMBUS.deck);       // the anchor -> the top under his feet
  const IDLE_DECK = NIMBUS.deck[0];    // standing: the held drawing's top, where his feet stay
  const K = BOTTOM / 21.5;
  const HALF = 34 * K;                 // half the cloud's body, for keeping it in the room
  const CALL = 1.25;             // seconds of whistling and looking before it comes
  const CROUCH = 0.16, HOP = 0.5;
  const UP_X = 29;               // a raised hand goes out past his curls (the arm stays behind his head)

  window.KhalfanNimbus = function (H) {
    const { KH, S, g } = H;
    const img = new Image();
    img.onload = () => { icon = null; H.redraw(); };
    img.src = NIMBUS.src;
    let icon = null, NB = null, told = false;

    const sz = () => S.size;
    const floor = () => H.floorY(KH.z);
    const parkY = () => floor() - (PARK + BOTTOM) * sz();
    const xMin = () => 8 + HALF * sz(), xMax = () => H.RM.W - 8 - HALF * sz();
    const yMin = () => 4 + 56 * sz() - (DECK + SINK) * sz();   // his kumma stays in the room
    const clampGoal = (x, y) => ({ x: clamp(x, xMin(), xMax()), y: clamp(y, yMin(), parkY()) });

    function call() {
      if (NB) return;
      if (KH.mode === 'clip') H.endClip();
      if (KH.mode !== 'free' || KH.rage || KH.emote || KH.jump) return;
      H.audioInit();
      const W = H.RM.W;
      let side = W - KH.x >= KH.x ? 1 : -1;                         // it parks on his roomier side
      let px = clamp(KH.x + side * 54 * K * sz(), xMin(), xMax());
      if (Math.abs(px - KH.x) < 44 * K * sz()) { side = -side; px = clamp(KH.x + side * 54 * K * sz(), xMin(), xMax()); }
      NB = {
        phase: 'call', t0: H.T, side, park: { x: px, y: parkY() }, x: 0, y: 0, vx: 0, vy: 0, dir: -side, flip: -side,
        anim: 'fly', acc: 0, frame: 19, deckS: NIMBUS.deck[18], dip: 0, dipV: 0, bobY: 0, on: false, lift: false,
        spawned: false, glint: false, stopT: null, goal: null, drag: null, then: null, pivotY: floor(), wasFast: false,
      };
      KH.walkTo = null; KH.speed = 0; KH.userYaw = null; KH.yawTarget = 0; KH.faceUsAt = 0; KH.react = null; KH.after = null;
      H.refreshUI();
    }
    function leave(then) {
      if (!NB) return;
      if (NB.phase === 'ride') { NB.phase = 'land'; NB.t0 = H.T; NB.goal = null; NB.drag = null; }
      if (then !== undefined) NB.then = then;
      H.refreshUI();
    }
    function toggle() {
      H.audioInit();
      if (!NB) call(); else if (NB.phase === 'ride') leave(null);
    }
    function setAnim(a, i0 = 0) { NB.anim = a; NB.acc = i0; }
    function steer(dt, tvx, tvy, k) {
      const e = 1 - Math.exp(-dt * k);
      NB.vx += (tvx - NB.vx) * e; NB.vy += (tvy - NB.vy) * e;
    }
    function seek(dt, gx, gy, vmax, gain, k) {                    // k null: straight in, easing to a stop (no overshoot)
      const ex = gx - NB.x, ey = gy - NB.y, d = Math.hypot(ex, ey);
      const want = Math.min(vmax, d * gain);
      const tvx = d > 0.01 ? ex / d * want : 0, tvy = d > 0.01 ? ey / d * want : 0;
      if (k == null) { NB.vx = tvx; NB.vy = tvy; } else steer(dt, tvx, tvy, k);
      return d;
    }

    // ---- the cloud's drawings follow how it moves
    function animate(dt) {
      const sp = Math.hypot(NB.vx, NB.vy), a = NB.anim;
      if (NB.phase === 'ride') { if (NB.vx > 14) NB.dir = 1; else if (NB.vx < -14) NB.dir = -1; }   // it only turns when you fly it
      const turning = Math.sign(NB.flip) !== NB.dir && Math.abs(NB.flip) > 0.9;
      if (turning && sp > 40) H.sfx('whoosh', 0.35);
      NB.flip += clamp(NB.dir - NB.flip, -dt * 13, dt * 13);       // a quick paper turn (drawn never thinner than 45%)
      const flying = a === 'fly' || a === 'up' || a === 'down';
      if ((a === 'idle' || a === 'settle') && sp > 20) { setAnim('go'); if (NB.phase === 'ride') H.sfx('whoosh', 0.45); }
      else if (a === 'brake' && sp > 34) setAnim('go', 4);
      else if ((flying || a === 'go') && sp < 12) setAnim('brake');
      else if (flying) {                                          // banking: up and down with a little give either way
        const up = NB.vy < -0.45 * Math.abs(NB.vx), down = NB.vy > 0.45 * Math.abs(NB.vx);
        const want = a === 'up' ? (NB.vy < -14 && up ? 'up' : 'fly') : a === 'down' ? (NB.vy > 14 && down ? 'down' : 'fly')
          : NB.vy < -30 && up ? 'up' : NB.vy > 30 && down ? 'down' : 'fly';
        if (want !== a) setAnim(want);
      }
      const A = ANIM[NB.anim];
      NB.acc += dt / (A.d || lerp(0.075, 0.05, clamp(sp / 140)));
      let i = Math.floor(NB.acc);
      if (!A.loop && i >= A.f.length) { setAnim(A.next); i = 0; }
      const B = ANIM[NB.anim];
      NB.frame = B.loop ? B.f[i % B.f.length] : B.f[Math.min(i, B.f.length - 1)];
      // standing it calms: its drawings line up on one deck, his feet stay put, and it floats on a slow, small bob
      NB.calm = lerp(NB.calm || 0, NB.anim === 'idle' ? 1 : 0, 1 - Math.exp(-dt * 5));
      const deckTo = lerp(NIMBUS.deck[NB.frame - 1], IDLE_DECK, NB.calm);
      NB.deckS = lerp(NB.deckS, deckTo, 1 - Math.exp(-dt * lerp(12, 5, NB.calm)));
      NB.dipV += (-90 * NB.dip - 9 * NB.dipV) * dt;               // it gives under him and springs back
      NB.dip += NB.dipV * dt;
      NB.bobPh = (NB.bobPh || 0) + dt * 2.1;
      NB.bobY = 0.9 * (1 - NB.calm) * Math.sin(NB.bobPh) * sz() * (1 - clamp(sp / 80));   // a hover bob while it drifts; none standing
      if (NB.anim === 'idle' && sp < 2.5 && !NB.drag) { NB.vx = 0; NB.vy = 0; }        // glided to a stop: stopped
      NB.feetX = NB.x + NB.flip * NIMBUS.riderX * sz();
      NB.feetY = NB.y + NB.bobY + NB.dip + (NB.deckS + SINK) * sz();
    }

    function step(t, dt) {
      if (!NB) return;
      const u = t - NB.t0, RM = H.RM;
      KH.speed = 0; KH.walkTo = null;
      if (NB.phase === 'call') {
        if (u >= 0.95 && !NB.glint) {                              // something glints at the edge of the room
          NB.glint = true;
          H.floaty('spark', NB.side > 0 ? RM.W - 14 : 14, NB.park.y - 30 * sz(), 3);
          H.sfx('shimmer', 0.4);
        }
        if (u >= CALL) {                                           // here it comes
          NB.spawned = true;
          NB.x = NB.side > 0 ? RM.W + 110 : -110; NB.y = NB.park.y - 26 * K * sz();
          NB.vx = -NB.side * 280; NB.vy = 30;
          NB.dir = NB.flip = -NB.side;
          setAnim('fly');
          NB.phase = 'arrive'; NB.t0 = t;
          H.sfx('whoosh', 0.85); H.sfx('sparkle', 0.35);
        }
      } else if (NB.phase === 'arrive') {
        const d = seek(dt, NB.park.x, NB.park.y, 290, 3.4, null);
        NB.x += NB.vx * dt; NB.y += NB.vy * dt;
        if (!NB.stopT && d < 1.5 && Math.hypot(NB.vx, NB.vy) < 8) { NB.stopT = t; NB.vx = NB.vy = 0; H.sfx('boing', 0.35); }
        if (NB.stopT && t - NB.stopT > 0.55) {                     // his turn: crouch, then hop on
          NB.phase = 'board'; NB.t0 = t; NB.x0 = KH.x; NB.y0 = floor();
          KH.yawTarget = NB.side * 30; KH.faceUsAt = t + 9;
        }
      } else if (NB.phase === 'board') {
        if (u >= CROUCH && !NB.lift) { NB.lift = true; H.sfx('jump', 0.6); }
      } else if (NB.phase === 'ride') {
        let [dx, dy] = H.inputDir();
        const fast = H.keys.has('shift') || S.run, V = fast ? 150 : 85;
        if (dx || dy) {
          NB.goal = null;
          const n = Math.hypot(dx, dy); dx /= n; dy /= n;
          steer(dt, dx * V, dy * V * 0.72, 3.2);
        } else if (NB.goal) {
          const dr = NB.goal.drag;
          const d = seek(dt, NB.goal.x, NB.goal.y, dr ? 420 : V, dr ? 10 : 2.6, dr ? 14 : 4);
          if (!dr && d < 1) NB.goal = null;
        } else steer(dt, 0, 0, 1.8);                               // let go: it glides to a stop
        NB.x += NB.vx * dt; NB.y += NB.vy * dt;
        if (NB.x < xMin()) { NB.x = xMin(); NB.vx = Math.max(0, NB.vx); }
        if (NB.x > xMax()) { NB.x = xMax(); NB.vx = Math.min(0, NB.vx); }
        if (NB.y < yMin()) { NB.y = yMin(); NB.vy = Math.max(0, NB.vy); }
        if (NB.y > parkY()) { NB.y = parkY(); NB.vy = Math.min(0, NB.vy); }
      } else if (NB.phase === 'land') {                            // down to a low hover over the floor
        const gx = clamp(NB.x, RM.WALK.x0 + 6, RM.WALK.x1 - 6);
        const d = seek(dt, gx, parkY(), 110, 3, null);
        NB.x += NB.vx * dt; NB.y += NB.vy * dt;
        if ((d < 1.5 && Math.hypot(NB.vx, NB.vy) < 8) || u > 2.6) {
          const toward = NB.feetX < RM.W / 2 ? 1 : -1;            // he hops off towards the middle of the room
          NB.phase = 'hopoff'; NB.t0 = t; NB.vx = NB.vy = 0;
          NB.x0 = NB.feetX; NB.y0 = NB.feetY; NB.tx = clamp(NB.feetX + toward * 30 * sz(), RM.WALK.x0, RM.WALK.x1);
          KH.yawTarget = toward * 30; KH.faceUsAt = t + 9;
        }
      } else if (NB.phase === 'hopoff') {
        if (u >= 0.12 && NB.on) { NB.on = false; NB.dipV += 40; H.sfx('jump', 0.55); }
      } else if (NB.phase === 'leave') {                           // it streaks away while he waves
        if (u > 0.35) { NB.vx += NB.dir * 380 * dt; NB.vy -= 40 * dt; NB.vx = clamp(NB.vx, -320, 320); }
        NB.x += NB.vx * dt; NB.y += NB.vy * dt;
        if ((NB.x < -170 || NB.x > RM.W + 170) && u > 1.7) {
          const then = NB.then;
          NB = null;
          KH.faceUsAt = 0; KH.yawTarget = 0;
          H.refreshUI();
          if (then) H.playClip(then);
          return;
        }
      }
      if (NB.spawned) animate(dt);
      // where his feet go (the size and the room's floor scale round this point); a phase may have just changed
      const v = t - NB.t0;
      if (NB.phase === 'board' && v >= CROUCH) {
        const f = clamp((v - CROUCH) / HOP);
        KH.x = lerp(NB.x0, NB.feetX, ss(f));
        NB.pivotY = lerp(NB.y0, NB.feetY, ss(f)) - 16 * sz() * Math.sin(Math.PI * f);
        if (f >= 1) {                                             // on: the cloud gives under him
          NB.phase = 'ride'; NB.t0 = t; NB.on = true; NB.dipV += 70;
          KH.landT = t; KH.landHard = 0.35; KH.faceUsAt = 0;
          H.sfx('boing', 0.5); H.sfx('land', 0.3);
          if (!told) { told = true; H.plate(['Tap or drag to fly', 'المس أو اسحب ليطير']); }
        }
      } else if (NB.phase === 'hopoff' && v >= 0.12) {
        const f = clamp((v - 0.12) / HOP);
        KH.x = lerp(NB.x0, NB.tx, ss(f));
        NB.pivotY = lerp(NB.y0, floor(), f * f) - 12 * sz() * Math.sin(Math.PI * f);
        if (f >= 1) {
          NB.phase = 'leave'; NB.t0 = t; NB.lift = false; NB.pivotY = floor();
          KH.landT = t; KH.landHard = 0.5; KH.yawTarget = 0; KH.faceUsAt = 0;
          H.sfx('land', 0.7); H.puff(KH.x, floor(), 6);
          NB.dir = NB.x >= KH.x ? 1 : -1; setAnim('go'); NB.vx = NB.dir * 20;
          H.sfx('whoosh', 0.7);
        }
      } else if (NB.on) {
        KH.x = NB.feetX; NB.pivotY = NB.feetY;
        if (NB.phase === 'ride' || NB.phase === 'land') {          // he turns three-quarters into the way he flies
          const fl = clamp((Math.abs(NB.vx) - 10) / 40);
          if (fl > 0.05) { KH.yawTarget = NB.dir * 32 * fl; KH.faceUsAt = t + 0.6; }
        }
      } else NB.pivotY = floor();
    }

    // ---- his pose, on top of what freePose made (its hops, squashes and faces carry over)
    function setHand(p, k, x, y, shape, z, w = 1) {
      p['h' + k + 'x'] = lerp(p['h' + k + 'x'], x, w); p['h' + k + 'y'] = lerp(p['h' + k + 'y'], y, w);
      if (w > 0.4) { p['h' + k] = shape; p['z' + k] = z; }
    }
    function point(p, s, w = 1) {                                  // the game's own pointing pose, to side s
      const k = s > 0 ? 'r' : 'l';
      setHand(p, k, s * 17, -7, 'point', 1, w);
      p['h' + k + 'a'] = lerp(p['h' + k + 'a'], s * 90, w);
    }
    function pose(p, t) {
      if (!NB) return;
      const u = t - NB.t0, lift = p.y - floor(), s = NB.side;
      const free = !KH.react && !KH.after && KH.angerStage < 1 && t >= KH.dizzyUntil && S.face === 'rest';
      if (NB.phase === 'call') {
        if (u < 0.9) {                                             // a whistle, a hand up and waving
          if (free) { p.expr = 'whistle'; p.mouth = 'whistle'; }
          setHand(p, s > 0 ? 'r' : 'l', s * UP_X, -20, 'open', 1);
          p[s > 0 ? 'hra' : 'hla'] = 16 * Math.sin(t * 15);
        } else {                                                   // where is it? he looks and points
          if (free) p.expr = 'curious';
          p.look = s; p.hrot += s * 6;
          point(p, s);
        }
      } else if (NB.phase === 'arrive') {
        p.look = Math.sign(NB.x - KH.x) || s;
        if (NB.stopT) {                                            // it's here: hands up
          if (free) p.expr = 'yay';
          const b = bump(t - NB.stopT, 0, 0.32);
          p.y -= 2.5 * b; p.fly -= b; p.fry -= b;
          setHand(p, 'l', -UP_X, -19, 'open', 1); setHand(p, 'r', UP_X, -19, 'open', 1);
        } else {
          if (free) p.expr = 'wonder';
          point(p, s);
        }
      } else if (NB.phase === 'board' || NB.phase === 'hopoff') {
        const c0 = NB.phase === 'board' ? CROUCH : 0.12;
        if (u < c0) {                                              // the crouch before the hop
          const c = 2.4 * ss(u / c0);
          p.y = NB.pivotY + lift + c; p.fly -= c; p.fry -= c;
          setHand(p, 'l', -11, -1, 'fist', 0); setHand(p, 'r', 11, -1, 'fist', 0);
          if (free) p.expr = 'determined';
        } else {
          const f = clamp((u - c0) / HOP), a = Math.sin(Math.PI * f);
          p.y = NB.pivotY + lift;
          p.fly -= 3 * a; p.fry -= 3 * a; p.hem = Math.max(p.hem, a);
          setHand(p, 'l', -15, -14, 'open', 1); setHand(p, 'r', 15, -14, 'open', 1);
          if (free) p.expr = 'yay';
        }
      } else if (NB.phase === 'ride' || NB.phase === 'land') {
        p.y = NB.pivotY + lift;
        const sp = Math.hypot(NB.vx, NB.vy), fl = clamp((sp - 8) / 70), d = NB.dir;
        p.lean += 10 * clamp(NB.vx / 120, -1, 1);
        if (fl > 0.01) {                                           // flying: one hand shows the way, the other out back
          point(p, d, fl);
          setHand(p, d > 0 ? 'l' : 'r', -d * UP_X, -18, 'open', 0, fl);
          p[d > 0 ? 'hla' : 'hra'] = -d * 10 * fl;
          p.hem = Math.max(p.hem, 0.35 + 0.75 * fl);
          p.sweep = d * 0.8 * fl * (1 + 0.15 * Math.sin(t * 18));
        }
        if (free) p.expr = fl > 0.55 ? 'yay' : fl > 0.12 ? 'grin' : 'happy';
      } else if (NB.phase === 'leave') {                           // bye bye
        const w = 1 - ss((u - 1.6) / 0.3);
        if (w > 0) {
          const k = NB.dir > 0 ? 'r' : 'l';
          setHand(p, k, NB.dir * UP_X, -20, 'open', 1, w);
          p['h' + k + 'a'] = 18 * Math.sin(t * 2 * Math.PI * 2.4) * w;
          p.look = NB.dir;
          if (free) p.expr = 'happy';
        }
      }
    }

    // ---- drawing: its shadow and the cloud behind him; its front rows over his feet
    function draw(C, layer) {
      if (!NB || !NB.spawned || !img.complete || !img.naturalWidth) return;
      if (layer === 'front' && !NB.on) return;
      const m = NIMBUS, k = NB.frame - 1, c = k % m.cols, r = Math.floor(k / m.cols), z = sz();
      const y = NB.y + NB.bobY + NB.dip + (NB.calm || 0) * (IDLE_DECK - m.deck[k]) * z;   // standing: its top held level
      if (layer === 'back') {
        const fy = floor(), h = Math.max(0, fy - (y + m.bottom[k] * z)), kk = clamp(1 - h / 110);
        if (kk > 0.03) {
          g.setTransform(C[0], 0, 0, C[3], C[4], C[5]);
          g.fillStyle = `rgba(52,24,12,${(0.22 * kk).toFixed(3)})`;
          g.beginPath();
          g.ellipse(NB.x, fy, m.bodyW[k] * 0.42 * z * (0.6 + 0.4 * kk), 2.2 * z * (0.6 + 0.4 * kk), 0, 0, Math.PI * 2);
          g.fill();
        }
      }
      const fl = (NB.flip < 0 ? -1 : 1) * Math.max(0.45, Math.abs(NB.flip));   // a sliver of cloud is no cloud to stand on
      g.setTransform(C[0] * fl * z, 0, 0, C[3] * z, C[0] * NB.x + C[4], C[3] * y + C[5]);
      g.imageSmoothingEnabled = false;
      const cut = layer === 'front' ? clamp(Math.round(m.anchor[1] + m.deck[k] + 0.5), 0, m.th - 1) : 0;
      g.drawImage(img, c * m.tw, r * m.th + cut, m.tw, m.th - cut, -m.anchor[0], -m.anchor[1] + cut, m.tw, m.th - cut);
    }

    // ---- the pointer while he rides: drag him (or the cloud) through the air, tap to fly somewhere, tap him to poke
    function onCloud(x, y) {
      if (!NB || !NB.spawned) return false;
      const k = NB.frame - 1, z = sz(), cy = NB.y + NB.bobY + NB.dip;
      return Math.abs(x - NB.x) < NIMBUS.bodyW[k] * 0.5 * z && y > cy + NIMBUS.deck[k] * z - 2 && y < cy + NIMBUS.bottom[k] * z + 2;
    }
    function down(x, y, e) {
      if (!NB) return false;
      const on = H.hitKhalfan(x, y) || onCloud(x, y);
      if (NB.phase !== 'ride') return on;                          // not now: he is on his way
      if (on) { NB.drag = { sx: e.clientX, sy: e.clientY, off: [NB.x - x, NB.y - y], moved: false }; return true; }
      NB.goal = clampGoal(x, y);
      return true;
    }
    function move(x, y, e) {
      if (!NB || !NB.drag) return false;
      const D = NB.drag;
      if (!D.moved && Math.hypot(e.clientX - D.sx, e.clientY - D.sy) > 6) D.moved = true;
      if (D.moved) NB.goal = Object.assign(clampGoal(x + D.off[0], y + D.off[1]), { drag: true });
      return true;
    }
    function up() {
      if (!NB || !NB.drag) return false;
      const D = NB.drag;
      NB.drag = null;
      if (!D.moved) H.poke(); else NB.goal = null;                 // let go mid-swoop: it glides on
      return true;
    }

    // ---- the tile: a flying drawing of the cloud (a coloured pixel picture among the engraved icons)
    function tileIcon() {
      if (!icon && img.complete && img.naturalWidth) {
        const m = NIMBUS, k = 20, c = k % m.cols, r = Math.floor(k / m.cols), n = 176;
        const cv = document.createElement('canvas');
        cv.width = cv.height = n;
        const q = cv.getContext('2d');
        q.imageSmoothingEnabled = false;
        const s = Math.floor((n - 12) / m.tw * 10) / 10;
        q.drawImage(img, c * m.tw, r * m.th, m.tw, m.th, (n - m.tw * s) / 2, (n - m.th * s) / 2 + 8, m.tw * s, m.th * s);
        icon = cv.toDataURL('image/png');
      }
      return icon ? `<img src="${icon}" alt="" draggable="false">` : '';
    }

    return {
      active: () => !!NB,
      lifted: () => !!(NB && NB.lift),
      feetY: () => (NB ? NB.pivotY : floor()),
      canJump: () => !NB || (NB.phase === 'ride' && !NB.drag),
      jumpLanded() { if (!NB || !NB.lift) return false; NB.dipV += 45; H.sfx('boing', 0.3); return true; },
      whistle() {                                                  // the call: two rising notes
        if (!NB || NB.phase !== 'call') return false;
        const u = H.T - NB.t0;
        const a = u >= 0.12 && u < 0.4, b = u >= 0.5 && u < 0.88;
        H.whistle(a || b ? 1 : 0, a ? 1500 + 500 * clamp((u - 0.12) / 0.28) : b ? 1550 + 900 * clamp((u - 0.5) / 0.38) : 1500, 0.09);
        return true;
      },
      wind: () => (NB && NB.spawned ? 0.2 * clamp((Math.hypot(NB.vx, NB.vy) - 30) / 170) : 0),
      step, pose, draw, down, move, up, call, leave, toggle,
      tile: () => ({ key: 'nimbus', en: 'Flying Nimbus', ar: 'السحابة الطائرة', icon: tileIcon, on: () => !!NB, click: toggle }),
      reset() { NB = null; },
      get state() { return NB; },
    };
  };
})();
