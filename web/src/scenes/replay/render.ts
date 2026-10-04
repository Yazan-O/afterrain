// Drawing helpers for the replay's 2D overlay: water as moving light along a polyline, the brown plumes, the
// lamps. Every function is a pure function of its inputs (positions, story time, palette), so a pinned
// clock draws the same pixels every time.
export type RGB = readonly [number, number, number];

export interface Palette {
  readonly night: boolean;
  readonly comp: GlobalCompositeOperation;
  readonly bg: RGB;
  readonly usual: RGB;
  readonly higher: RGB;
  readonly high: RGB;
  readonly plume: RGB;
  readonly river: RGB;
  readonly lampOff: RGB;
  readonly core: RGB;
  readonly terrainLow: RGB;
  readonly terrainHigh: RGB;
  readonly terrainGamma: number;
}

export const PALETTES: Record<'night' | 'day', Palette> = {
  night: {
    night: true,
    comp: 'lighter',
    bg: [4, 9, 10],
    usual: [214, 236, 247],
    higher: [255, 176, 58],
    high: [255, 88, 30],
    plume: [206, 124, 56],
    river: [180, 208, 222],
    lampOff: [96, 116, 112],
    core: [255, 255, 255],
    terrainLow: [3, 8, 8],
    terrainHigh: [48, 80, 70],
    terrainGamma: 1.55,
  },
  day: {
    night: false,
    comp: 'source-over',
    bg: [243, 241, 234],
    usual: [31, 94, 140],
    higher: [168, 109, 0],
    high: [207, 63, 20],
    plume: [150, 84, 28],
    river: [31, 94, 140],
    lampOff: [150, 156, 150],
    core: [27, 35, 37],
    terrainLow: [196, 190, 176],
    terrainHigh: [250, 249, 244],
    terrainGamma: 0.9,
  },
};

export const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as unknown as RGB;
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const hash = (i: number): number => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** The weir lamp's colour for an index share 0..1: white, then amber, then deep orange. */
export function weirColour(p: Palette, share: number): RGB {
  const s = clamp(share, 0, 1);
  return s < 0.5 ? mixRGB(p.usual, p.higher, s / 0.5) : mixRGB(p.higher, p.high, (s - 0.5) / 0.5);
}

const sprites = new Map<string, HTMLCanvasElement>();
/** A soft round glow sprite in one colour (cached). */
export function glowSprite(c: RGB): HTMLCanvasElement {
  const k = c.join(',');
  let s = sprites.get(k);
  if (!s) {
    const S = 128;
    s = document.createElement('canvas');
    s.width = s.height = S;
    const g = s.getContext('2d')!;
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, `rgba(${k},0.95)`);
    gr.addColorStop(0.12, `rgba(${k},0.55)`);
    gr.addColorStop(0.4, `rgba(${k},0.12)`);
    gr.addColorStop(1, `rgba(${k},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    sprites.set(k, s);
  }
  return s;
}

/** A polyline in screen space with its along-line metres. */
export interface Track {
  /** x0, y0, x1, y1, ... in CSS pixels (NaN for points behind the camera). */
  P: Float64Array;
  readonly cum: Float64Array;
  readonly L: number;
}

/** Screen position `m` metres along the track; returns the index of the nearer vertex. */
export function posAlong(t: Track, m: number, out: number[]): number {
  const c = t.cum;
  let lo = 0;
  let hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid]! <= m) lo = mid;
    else hi = mid;
  }
  const f = c[hi]! > c[lo]! ? clamp((m - c[lo]!) / (c[hi]! - c[lo]!), 0, 1) : 0;
  const P = t.P;
  out[0] = P[2 * lo]! + (P[2 * hi]! - P[2 * lo]!) * f;
  out[1] = P[2 * lo + 1]! + (P[2 * hi + 1]! - P[2 * lo + 1]!) * f;
  return f < 0.5 ? lo : hi;
}

export interface FlowStyle {
  /** metres between particles */
  readonly gap: number;
  /** metres per story second */
  readonly speed: number;
  /** trail length, metres */
  readonly trail: number;
  readonly width: number;
  readonly alpha: number;
  readonly colour: RGB;
  readonly glow: boolean;
}

const A = [0, 0];
const B = [0, 0];
const C = [0, 0];

/** Water moving along tracks as short bright trails (flowing light). */
export function drawFlow(
  ctx: CanvasRenderingContext2D,
  tracks: readonly Track[],
  styleOf: (i: number) => FlowStyle,
  anim: number,
  alphaMul: number,
  dpr: number,
  pal: Palette,
  seed = 0,
  colourAt?: (track: number, vertex: number) => RGB | null,
): void {
  if (alphaMul <= 0.01) return;
  const buckets = new Map<string, { st: FlowStyle; col: RGB; a: number; seg: number[] }>();
  for (let w = 0; w < tracks.length; w++) {
    const t = tracks[w]!;
    const st = styleOf(w);
    if (t.L < st.trail * 1.5) continue;
    const n = Math.max(1, Math.floor(t.L / st.gap));
    for (let k = 0; k < n; k++) {
      const h = hash(seed + w * 131 + k * 17);
      let p = ((k + h * 0.7) * st.gap + anim * st.speed * (0.85 + 0.3 * h)) % t.L;
      if (p < 0) p += t.L;
      let a = st.alpha * (0.55 + 0.45 * hash(seed + k * 3 + w)) * Math.min(1, p / (st.trail * 1.5 + 1), (t.L - p) / (st.trail + 1)) * alphaMul;
      if (a < 0.03) continue;
      const vi = posAlong(t, p, A);
      posAlong(t, Math.max(0, p - st.trail * 0.5), B);
      posAlong(t, Math.max(0, p - st.trail), C);
      if (!Number.isFinite(A[0]! + A[1]! + C[0]! + C[1]!)) continue;
      if (Math.abs(A[0]! - C[0]!) + Math.abs(A[1]! - C[1]!) > 120) continue;
      const col = (colourAt && colourAt(w, vi)) || st.colour;
      if (col !== st.colour) a = Math.min(1, a * 1.25);
      const q = Math.round(a * 8) / 8;
      const key = `${col.join(',')}|${q}|${st.width}|${st.glow ? 1 : 0}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { st, col, a: q, seg: [] }));
      b.seg.push(A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!);
    }
  }
  ctx.globalCompositeOperation = pal.comp;
  ctx.lineCap = 'round';
  const D = dpr;
  for (const b of buckets.values()) {
    const sg = b.seg;
    const col = b.col;
    if (pal.night && b.st.glow) {
      ctx.strokeStyle = rgba(col, b.a * 0.16);
      ctx.lineWidth = (b.st.width + 3.5) * D;
      ctx.beginPath();
      for (let i = 0; i < sg.length; i += 6) {
        ctx.moveTo(sg[i]! * D, sg[i + 1]! * D);
        ctx.lineTo(sg[i + 2]! * D, sg[i + 3]! * D);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(col, b.a * (pal.night ? 0.35 : 0.5));
    ctx.lineWidth = b.st.width * D;
    ctx.beginPath();
    for (let i = 0; i < sg.length; i += 6) {
      ctx.moveTo(sg[i + 2]! * D, sg[i + 3]! * D);
      ctx.lineTo(sg[i + 4]! * D, sg[i + 5]! * D);
    }
    ctx.stroke();
    ctx.strokeStyle = rgba(col, b.a * (pal.night ? 0.85 : 1));
    ctx.beginPath();
    for (let i = 0; i < sg.length; i += 6) {
      ctx.moveTo(sg[i]! * D, sg[i + 1]! * D);
      ctx.lineTo(sg[i + 2]! * D, sg[i + 3]! * D);
    }
    ctx.stroke();
    if (pal.night) {
      ctx.fillStyle = `rgba(255,255,255,${(b.a * 0.5).toFixed(3)})`;
      const hs = 1.8 * D;
      for (let i = 0; i < sg.length; i += 6) ctx.fillRect(sg[i]! * D - hs / 2, sg[i + 1]! * D - hs / 2, hs, hs);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** A still line along tracks (glow + core), for the river's bed of light. */
export function strokeTracks(ctx: CanvasRenderingContext2D, tracks: readonly Track[], passes: readonly (readonly [number, number])[], colour: RGB, alphaMul: number, dpr: number, pal: Palette): void {
  if (alphaMul <= 0.01) return;
  ctx.globalCompositeOperation = pal.comp;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [w, a] of passes) {
    ctx.strokeStyle = rgba(colour, a * alphaMul);
    ctx.lineWidth = w * dpr;
    ctx.beginPath();
    for (const t of tracks) {
      const P = t.P;
      let pen = false;
      for (let i = 0; i < P.length; i += 2) {
        const x = P[i]!;
        const y = P[i + 1]!;
        if (!Number.isFinite(x + y)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(x * dpr, y * dpr);
        else ctx.moveTo(x * dpr, y * dpr);
        pen = true;
      }
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Plume level 0..1 from the summed surviving plumes at a point (one plume is about 0.26, fourteen are 1). */
export const plumeLevel = (sum: number): number => (sum <= 0.02 ? 0 : clamp(Math.log1p(sum) / Math.log1p(14), 0.08, 1));

/** Brown light for a thin plume, amber where several meet, deep orange where most of the storm arrives. */
export function plumeColour(p: Palette, level: number): RGB {
  const stops: [number, RGB][] = p.night
    ? [
        [0, [132, 84, 46]],
        [0.35, [196, 120, 56]],
        [0.7, p.higher],
        [1, p.high],
      ]
    : [
        [0, [170, 120, 70]],
        [0.35, p.plume],
        [0.7, p.higher],
        [1, p.high],
      ];
  const x = clamp(level, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    const [b, cb] = stops[i]!;
    const [a, ca] = stops[i - 1]!;
    if (x <= b) return mixRGB(ca, cb, (x - a) / (b - a));
  }
  return stops[stops.length - 1]![1];
}

/**
 * The plume field on the river: every segment coloured by the plumes covering it (sum of surviving
 * fractions at its two ends). Drawn once per segment, so overlapping plumes read as a colour, not as white.
 */
export function drawField(ctx: CanvasRenderingContext2D, tracks: readonly { nodes: Int32Array; t: Track }[], sumAt: Float32Array, alphaMul: number, dpr: number, pal: Palette): void {
  if (alphaMul <= 0.01) return;
  const levels = 10;
  // runs of equal level become one polyline each (x, y pairs, NaN-separated), so a stroke has few caps and joins
  const runs: number[][] = Array.from({ length: levels + 1 }, () => []);
  for (const l of tracks) {
    const P = l.t.P;
    let cur = 0;
    for (let k = 1; k < l.nodes.length; k++) {
      const v = 0.5 * (sumAt[l.nodes[k - 1]!]! + sumAt[l.nodes[k]!]!);
      const lv = Math.round(plumeLevel(v) * levels);
      const x0 = P[2 * k - 2]!;
      const y0 = P[2 * k - 1]!;
      const x1 = P[2 * k]!;
      const y1 = P[2 * k + 1]!;
      if (lv <= 0 || !Number.isFinite(x0 + y0 + x1 + y1)) {
        cur = 0;
        continue;
      }
      const r = runs[lv]!;
      if (lv !== cur) r.push(NaN, x0, y0);
      r.push(x1, y1);
      cur = lv;
    }
  }
  const D = dpr;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = pal.comp;
  const passes: [number, number][] = pal.night
    ? [
        [11, 0.07],
        [3.6, 0.3],
        [1.4, 0.95],
      ]
    : [
        [5, 0.22],
        [2.2, 0.9],
      ];
  for (const [w, a] of passes) {
    for (let lv = 1; lv <= levels; lv++) {
      const r = runs[lv]!;
      if (!r.length) continue;
      const f = lv / levels;
      ctx.strokeStyle = rgba(plumeColour(pal, f), a * (0.55 + 0.45 * f) * alphaMul);
      ctx.lineWidth = w * (0.8 + 0.35 * f) * D;
      ctx.beginPath();
      for (let i = 0; i < r.length; ) {
        if (Number.isNaN(r[i]!)) {
          ctx.moveTo(r[i + 1]! * D, r[i + 2]! * D);
          i += 3;
        } else {
          ctx.lineTo(r[i]! * D, r[i + 1]! * D);
          i += 2;
        }
      }
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** A lamp: a dark ring, a core, and (at night) a glow. */
export function drawLamp(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, core: RGB, glow: RGB | null, glowSize: number, alpha: number, dpr: number, pal: Palette): void {
  if (!Number.isFinite(x + y) || alpha <= 0.01) return;
  const D = dpr;
  if (glow && glowSize > 0) {
    ctx.globalCompositeOperation = pal.night ? 'lighter' : 'source-over';
    ctx.globalAlpha = alpha * (pal.night ? 1 : 0.35);
    const g = glowSize * D;
    ctx.drawImage(glowSprite(glow), x * D - g / 2, y * D - g / 2, g, g);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pal.night ? 'rgb(6,16,14)' : 'rgb(243,241,234)';
  ctx.beginPath();
  ctx.arc(x * D, y * D, (r + 1.3) * D, 0, 7);
  ctx.fill();
  ctx.fillStyle = rgba(core, 1);
  ctx.beginPath();
  ctx.arc(x * D, y * D, r * D, 0, 7);
  ctx.fill();
  ctx.globalAlpha = 1;
}
