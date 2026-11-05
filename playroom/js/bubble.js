/* Khalfan's speech bubbles, in pixels, the same everywhere he talks:
 * a 1-cell outline with stepped corners, a shaded bottom row and a pixel tail, on his own
 * grid; the words in them stay Alexandria. One drawing for his original game and the
 * desktop companion (app/pet.js, which loads this file by reference).
 *   KhalfanBubble.box(g, x0, y0, w, h, u, tail, look)  one bubble: its top-left (x0, y0) in the caller's units, w x h
 *     cells of u units each; tail = { side: 'down' | 'left' | 'right', at } with `at` its column (down) or row (left,
 *     right) in cells from the bubble's left or top edge, kept 3 cells from the corners; look = PLAIN or ANGRY
 *   KhalfanBubble.mark(g, x, y, u, t)  the angry one's mark, four brackets throbbing a cell apart, round cell (x, y)
 *   KhalfanBubble.grow(age)  its pop-in by steps (half size, a size over, its size), so it never scales off the grid
 */
'use strict';
(() => {
  const PLAIN = { ink: '#2E1C12', fill: '#FFFBF2', shade: '#EADFCB', text: '#2E1C12' };
  const ANGRY = { ink: '#C43C32', fill: '#FFF6EC', shade: '#F5D8C6', text: '#C43C32' };
  function box(g, x0, y0, w, h, u, tail, look = PLAIN) {
    const c = look, W = w - 1, H = h - 1;
    const px = (col, i, j, ww = 1, hh = 1) => { g.fillStyle = col; g.fillRect(x0 + i * u, y0 + j * u, ww * u, hh * u); };
    px(c.fill, 1, 2, w - 2, h - 4); px(c.fill, 2, 1, w - 4, h - 2);
    px(c.shade, 2, H - 1, w - 4);
    px(c.ink, 2, 0, w - 4); px(c.ink, 2, H, w - 4); px(c.ink, 0, 2, 1, h - 4); px(c.ink, W, 2, 1, h - 4);
    px(c.ink, 1, 1); px(c.ink, W - 1, 1); px(c.ink, 1, H - 1); px(c.ink, W - 1, H - 1);
    if (!tail) return;
    if (tail.side === 'down') {                                          // three rows under it, narrowing to the tip
      const a = Math.min(Math.max(tail.at, 3), w - 4);
      px(c.shade, a - 1, H, 3);
      px(c.ink, a - 2, H + 1); px(c.shade, a - 1, H + 1, 3); px(c.ink, a + 2, H + 1);
      px(c.ink, a - 1, H + 2); px(c.shade, a, H + 2); px(c.ink, a + 1, H + 2);
      px(c.ink, a, H + 3);
    } else {                                                             // three columns out of its side
      const a = Math.min(Math.max(tail.at, 3), h - 4), d = tail.side === 'left' ? -1 : 1, e = d < 0 ? 0 : W;
      px(c.fill, e, a - 1, 1, 3);
      px(c.ink, e + d, a - 2); px(c.fill, e + d, a - 1, 1, 3); px(c.ink, e + d, a + 2);
      px(c.ink, e + 2 * d, a - 1); px(c.fill, e + 2 * d, a); px(c.ink, e + 2 * d, a + 1);
      px(c.ink, e + 3 * d, a);
    }
  }
  function mark(g, x, y, u, t, col = '#E5322D') {
    const o = Math.floor(t * 9) % 2;
    g.fillStyle = col;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = sx * (1 + o), cy = sy * (1 + o);
      for (const [i, j] of [[cx, cy], [cx + sx, cy], [cx, cy + sy]]) g.fillRect(x + i * u, y + j * u, u, u);
    }
  }
  const grow = (age) => (age < 0.07 ? 0.5 : age < 0.14 ? 1.08 : 1);
  window.KhalfanBubble = { PLAIN, ANGRY, box, mark, grow };
})();
