// Where a label goes on the forecast curve: the selected value at the nearest clear place
// beside its point (within NEAR px, else farther with a short connector), and each curve's name ("Before",
// "With test") just outside its own curve, on the side away from the other one. Pure geometry in CSS px, so the
// placement is tested without a browser.

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A readout within this many CSS px of its point needs no connector. */
export const NEAR = 40;

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ left: x, top: y, right: x + w, bottom: y + h });

/** The distance from a point to the nearest point of a box (0 inside it). */
export const rectDist = (px: number, py: number, r: Rect): number => Math.hypot(Math.max(r.left - px, 0, px - r.right), Math.max(r.top - py, 0, py - r.bottom));

export const overlaps = (a: Rect, b: Rect, pad = 0): boolean => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

/** A box crosses a polyline (x, y pairs with x increasing), sampled every 2 px across the box, with a margin. */
export function crossesLine(r: Rect, xy: ArrayLike<number>, pad = 3): boolean {
  const n = xy.length / 2;
  for (let k = 0; k < n - 1; k++) {
    const ax = xy[2 * k]!,
      bx = xy[2 * k + 2]!;
    if (bx < r.left - pad || ax > r.right + pad) continue;
    const ay = xy[2 * k + 1]!,
      by = xy[2 * k + 3]!;
    for (let x = Math.max(ax, r.left - pad); x <= Math.min(bx, r.right + pad); x += 2) {
      const y = ay + ((by - ay) * (x - ax)) / Math.max(1e-6, bx - ax);
      if (y >= r.top - pad && y <= r.bottom + pad) return true;
    }
  }
  return false;
}

/** A polyline's highest and lowest y over [x0, x1] (screen y grows downward); null where it does not reach. */
export function yRange(xy: ArrayLike<number>, x0: number, x1: number): { min: number; max: number } | null {
  let min = Infinity,
    max = -Infinity;
  const n = xy.length / 2;
  for (let k = 0; k < n - 1; k++) {
    const ax = xy[2 * k]!,
      bx = xy[2 * k + 2]!;
    if (bx < x0 || ax > x1) continue;
    const ay = xy[2 * k + 1]!,
      by = xy[2 * k + 3]!;
    for (const x of [Math.max(ax, x0), Math.min(bx, x1)]) {
      const y = ay + ((by - ay) * (x - ax)) / Math.max(1e-6, bx - ax);
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
  }
  return min <= max ? { min, max } : null;
}

export interface Placed {
  readonly x: number;
  readonly y: number;
  /** From the point to the label's nearest edge. */
  readonly dist: number;
  /** Farther than NEAR: drawn with a connector from the point. */
  readonly lead: boolean;
}

/**
 * A w x h label for the point (px, py): of every place around the point (eight directions, each slid along its
 * side) the nearest one that `clear` accepts, searched out to `far` px. Beyond NEAR it is marked for a connector.
 */
export function placeNear(px: number, py: number, w: number, h: number, clear: (r: Rect) => boolean, far = 160): Placed | null {
  const cands: Placed[] = [];
  const add = (x: number, y: number): void => {
    const d = rectDist(px, py, rect(x, y, w, h));
    cands.push({ x, y, dist: d, lead: d > NEAR });
  };
  for (let d = 6; d <= far; d += 3) {
    // above and below, slid from the point's right to its left; beside, slid from above to below
    for (let s = 0; s <= 1.0001; s += 0.25) {
      add(px - s * w, py - d - h);
      add(px - s * w, py + d);
      add(px + d, py - s * h);
      add(px - d - w, py - s * h);
    }
    // the corners
    const c = d / Math.SQRT2;
    add(px + c, py - c - h);
    add(px - c - w, py - c - h);
    add(px + c, py + c);
    add(px - c - w, py + c);
  }
  cands.sort((a, b) => a.dist - b.dist);
  return cands.find((p) => clear(rect(p.x, p.y, w, h))) ?? null;
}

/**
 * Where a curve's name goes: just outside the curve (above it where it runs above the other curve, below it where
 * it runs below), scanning from the right end of the curve leftward to the middle, the first place `clear` accepts.
 */
export function placeOnCurve(xy: ArrayLike<number>, other: ArrayLike<number> | null, w: number, h: number, x0: number, x1: number, clear: (r: Rect) => boolean, gap = 4): { x: number; y: number } | null {
  for (let x = x1 - w; x >= x0 + (x1 - x0) * 0.25; x -= 8) {
    const me = yRange(xy, x, x + w);
    if (!me) continue;
    const them = other ? yRange(other, x, x + w) : null;
    // this curve is the upper one here (smaller screen y): its name goes above it, else below
    const above = !them || (me.min + me.max) / 2 <= (them.min + them.max) / 2;
    const y = above ? me.min - h - gap : me.max + gap;
    if (clear(rect(x, y, w, h))) return { x, y };
  }
  return null;
}
