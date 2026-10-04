// The example test reading's comparison: its layout and its fog stipple (each function self-contained). The mapped stream lies in the upper part of the screen (on a 390x844 phone inside
// the top 40%); under it, the tested place's two probability strokes ("Before", "With test") lie adjacent on one
// fixed 0 to 100% length scale, the upstream reference's pair under them, then the test's controls.

/**
 * The comparison's script, in seconds from navigation: the mapped stream alone, then the "Before" strokes grow
 * from the scale's origin to their chance (morphAt, for morph seconds), the test's controls show (kitAt), the
 * reading is taken (testAt), the "With test" strokes show at the "Before" length (show) and change to the new
 * chance while the mapped reach updates (wipe). The page's first paint plays the same seconds until the live scene
 * takes over in place.
 */
export const CMP = { morphAt: 2.0, morph: 1.5, kitAt: 4.0, testAt: 4.6, show: 0.3, wipe: 1.2 } as const;

/** The comparison's places on a W x H screen, in CSS pixels. */
export function compareLayout(W: number, H: number) {
  const phone = W < 700;
  const xL = phone ? 30 : Math.round(Math.min(160, Math.max(96, W * 0.085)));
  // the strokes' scale: 0% at x0 (after the rows' names), 100% at x1; one length per chance on every screen size
  const x0 = xL + (phone ? 88 : 128);
  const x1 = phone ? W - 34 : Math.min(W - xL, x0 + 640);
  const yBefore = Math.round(H * (phone ? 0.452 : 0.5));
  const yAfter = yBefore + (phone ? 36 : 50);
  const yRef = yAfter + (phone ? 70 : 78);
  return {
    phone,
    xL,
    xR: W - xL,
    /** The mapped stream's middle, and the half-height it may take. */
    mapY: Math.round(H * (phone ? 0.205 : 0.25)),
    band: Math.round(H * (phone ? 0.085 : 0.11)),
    x0,
    x1,
    yBefore,
    yAfter,
    /** The upstream reference's two strokes (thin), one under the other. */
    yRef,
    yRef2: yRef + (phone ? 16 : 20),
    barW: phone ? 8 : 10,
    refW: phone ? 3 : 4,
    /** The test's controls, under the strokes. */
    yKit: Math.round(H * (phone ? 0.655 : 0.72)),
    /** The definition of the chance and of the flag. */
    yUnit: Math.round(H * (phone ? 0.775 : 0.825)),
    vl: phone ? 18 : xL,
    vt: phone ? 64 : Math.round(H * 0.075),
    vs: phone ? 22 : Math.round(Math.min(40, Math.max(27, W * 0.026))),
    /** The fog's stipple around a stroke (from fogIn to fogIn + fogR either side), and around the mapped stream. */
    fogR: phone ? 8 : 9,
    fogIn: phone ? 6 : 8,
    mapFogR: phone ? 8 : 11,
  };
}

/** Metres per CSS pixel that fit a stream of extent (ex, ey) metres (turned to run across) into the map band. */
export function compareScale(ex: number, ey: number, xL: number, xR: number, band: number): number {
  return Math.max(ex / ((xR - xL) * 0.92), ey / (band * 2));
}

/**
 * The fog's stipple around a polyline (xs, ys in CSS pixels, fog per vertex): dots at fixed places along the line
 * (every `step` pixels of its length, a few across it, offset from `inner` to `inner + R` on either side), each with
 * its own fixed threshold. A dot shows where the fog's coverage at its place passes its threshold, so less fog
 * removes dots and never moves one: two ribbons with the same geometry compare without shimmer. Returns x, y pairs.
 */
export function stippleAlong(xs: ArrayLike<number>, ys: ArrayLike<number>, fog: ArrayLike<number>, R: number, inner: number, step: number, seed: number): number[] {
  const h = (v: number): number => {
    const s = Math.sin(v * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const cov = (f: number): number => {
    const c = Math.min(1, Math.max(0, (f - 0.45) / 0.55));
    return Math.pow(c, 1.4);
  };
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    const dy = ys[i + 1]! - ys[i]!;
    const L = Math.hypot(dx, dy);
    if (!(L > 1e-6)) continue;
    const ux = dx / L;
    const uy = dy / L;
    for (let k = Math.ceil(acc / step); k * step < acc + L; k++) {
      const t = (k * step - acc) / L;
      const c = cov(fog[i]! + (fog[i + 1]! - fog[i]!) * t);
      for (let j = 0; j < 3; j++) {
        if (h(k * 3.17 + j * 17.31) >= c) continue;
        const o = h(k * 5.71 + j * 29.13 + 3.3) * 2 - 1;
        const off = (o < 0 ? -1 : 1) * (inner + Math.abs(o) * R);
        const along = (h(k * 7.37 + j * 41.93 + 5.1) - 0.5) * step;
        out.push(xs[i]! + dx * t - uy * off + ux * along, ys[i]! + dy * t + ux * off + uy * along);
      }
    }
    acc += L;
  }
  return out;
}
