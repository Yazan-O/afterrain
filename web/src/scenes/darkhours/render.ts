// The canvas: rain curtain (the axis drawn as rain itself), ground lines, drops and fog. Light comes only
// from the data: a drop is a light, the ground ripples where drops touch it, the fog thins where samples land.
import { type DropSet, type Geometry, type Placement, CITY_ROWS, DRY_MM, WET_MM, geometry, mmAtFrac, place, xOf } from './layout';
import {
  CITY_GO,
  FALL_DUR,
  FOG_FULL,
  GLIDE,
  GLIDE_SPREAD,
  HANDOFF,
  NUM_LINES,
  REGROUP,
  clamp01,
  easeInOut,
  hash01,
  oahFall,
  openFall,
  ramp,
  smooth,
  window01,
} from './timeline';

type RGB = readonly [number, number, number];
export interface Palette {
  readonly bg: string;
  readonly ink: RGB;
  readonly flag: RGB;
  readonly flagCore: RGB;
  /** The hot centre of an orange drop (night: near white, so it reads as a light; day: the flag ink). */
  readonly flagHot: RGB;
  readonly fog: RGB;
  readonly fogA: number;
  readonly lineA: number;
  readonly rainA: number;
  readonly additive: boolean;
}

// Palette roles: ordinary stream light, single-sample flag and uncertainty fog.
export const PALETTES: Record<'night' | 'day', Palette> = {
  night: {
    bg: '#04090a',
    ink: [214, 236, 247],
    flag: [255, 96, 28],
    flagCore: [255, 128, 48],
    flagHot: [255, 222, 178],
    fog: [150, 161, 157],
    fogA: 0.6,
    lineA: 0.16,
    rainA: 1,
    additive: true,
  },
  day: {
    bg: '#f3f1ea',
    ink: [31, 94, 140],
    flag: [214, 66, 18],
    flagCore: [214, 66, 18],
    flagHot: [214, 66, 18],
    fog: [176, 184, 182],
    fogA: 0.85,
    lineA: 0.3,
    rainA: 1.6,
    additive: false,
  },
};

const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function glowSprite(c: RGB): HTMLCanvasElement {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, rgba(c, 0.95));
  gr.addColorStop(0.14, rgba(c, 0.5));
  gr.addColorStop(0.42, rgba(c, 0.1));
  gr.addColorStop(1, rgba(c, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return cv;
}

/** A soft round brush that erases fog around a measured sample. */
function lifterSprite(): HTMLCanvasElement {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(0.5, 'rgba(0,0,0,0.55)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return cv;
}

/** Tileable value noise for the uncertainty fog. */
function noiseTile(c: RGB): HTMLCanvasElement {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  const oct: [number, number][] = [
    [4, 0.5],
    [8, 0.27],
    [16, 0.15],
    [32, 0.08],
  ];
  const grids = oct.map(([n], o) => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) a[i] = hash01(i * 1.713 + o * 57.3);
    return a;
  });
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let v = 0;
      oct.forEach(([n, amp], o) => {
        const fx = (x / S) * n;
        const fy = (y / S) * n;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = smooth(fx - ix);
        const ty = smooth(fy - iy);
        const G = grids[o]!;
        const x1 = (ix + 1) % n;
        const y1 = (iy + 1) % n;
        v += amp * ((G[iy * n + ix]! * (1 - tx) + G[iy * n + x1]! * tx) * (1 - ty) + (G[y1 * n + ix]! * (1 - tx) + G[y1 * n + x1]! * tx) * ty);
      });
      const i = (y * S + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = Math.round(clamp01((v - 0.28) * 2.1) * 255);
    }
  g.putImageData(img, 0, 0);
  return cv;
}

/** Where the fog starts and where it is full, as fractions of the rain axis (about 4 mm and 18 mm). */
const FOG_A = 0.5;
const FOG_B = 0.76;

export interface Frame {
  /** Screen position and visibility of every drop in the last frame, for hit tests. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pa: Float32Array;
}

export class Painter {
  readonly set: DropSet;
  g!: Geometry;
  p!: Placement;
  private pal: Palette;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private readonly startOah: Float64Array;
  private readonly startOpen: Float64Array;
  private glowInk!: HTMLCanvasElement;
  private glowFlag!: HTMLCanvasElement;
  private noise!: HTMLCanvasElement;
  private readonly lifter = lifterSprite();
  private readonly fogCv = document.createElement('canvas');
  private readonly maskCv = document.createElement('canvas');
  readonly frame: Frame;
  /** The first orange (over 900) drop and the scene time it lands: its colour's word appears beside it. */
  readonly firstFlag: number;
  readonly firstFlagLand: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    set: DropSet,
    theme: 'night' | 'day',
  ) {
    this.set = set;
    this.ctx = canvas.getContext('2d')!;
    this.pal = PALETTES[theme];
    this.startOah = oahFall(set.oah.length);
    this.startOpen = openFall(set.open.length);
    const n = set.all.length;
    this.frame = { px: new Float32Array(n), py: new Float32Array(n), pa: new Float32Array(n) };
    this.maskCv.width = 96;
    this.maskCv.height = 32;
    const first = set.open.find((d) => d.flag);
    this.firstFlag = first ? first.i : -1;
    this.firstFlagLand = first ? this.landAt(first.i) : Infinity;
    this.makeSprites();
  }

  setTheme(theme: 'night' | 'day'): void {
    this.pal = PALETTES[theme];
    this.makeSprites();
  }

  private makeSprites(): void {
    this.glowInk = glowSprite(this.pal.ink);
    this.glowFlag = glowSprite(this.pal.flag);
    this.noise = noiseTile(this.pal.fog);
  }

  resize(W: number, H: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.g = geometry(W, H);
    this.p = place(this.g, this.set);
    this.fogCv.width = Math.ceil(W * 0.5);
    this.fogCv.height = Math.ceil(H * 0.5);
  }

  /** Scene time at which drop i reaches its place. */
  landAt(i: number): number {
    const k = this.set.oah.length;
    return i < k ? this.startOah[i]! + FALL_DUR : this.startOpen[i - k]! + FALL_DUR;
  }

  draw(T: number): void {
    const { ctx, g, pal } = this;
    const { W, H } = g;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    const cityW = easeInOut(ramp(T, CITY_GO, CITY_GO + GLIDE + GLIDE_SPREAD));
    const backW = easeInOut(ramp(T, REGROUP, REGROUP + GLIDE + GLIDE_SPREAD));
    const out = 1 - smooth(ramp(T, HANDOFF, HANDOFF + 0.9));
    const axisIn = smooth(ramp(T, 0.1, 1.5));
    const wRows = cityW * (1 - backW);
    // The city rows fold back into the one ground for the storm beat.
    const rowsY = g.rows.map((y) => y * (1 - backW) + g.gy1 * backW);
    const groundY = g.gy1 * (1 - wRows) + g.rows[2]! * wRows;

    this.drawRain(T, groundY, axisIn * out * (1 - 0.55 * wRows));
    // The ground's edge mark: 1 mm on the 3-day axis, 5 mm on the Garonne's 2-day axis.
    this.drawGround(g.gy1, axisIn * (1 - wRows) * out, 1, [
      [DRY_MM, 1 - backW],
      [WET_MM, backW],
    ]);
    rowsY.forEach((y) => this.drawGround(y, wRows * out, 0.7, [[DRY_MM, 1]]));
    this.drawDrops(T, backW, out);
    this.drawFog(T, wRows);
  }

  /** Rain streaks: none over the dry end, denser toward the storm end, in proportion to the millimetres at x. */
  private drawRain(T: number, groundY: number, a: number): void {
    if (a <= 0.01) return;
    const { ctx, g, pal } = this;
    const top = g.H * 0.08;
    const span = groundY - top;
    const cols = Math.round((g.x1 - g.x0) / (g.phone ? 6 : 8));
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (let c = 0; c < cols; c++) {
      const f = (c + 0.5) / cols;
      const mm = mmAtFrac(f);
      if (mm < 0.35) continue;
      const k = Math.min(6, Math.floor(0.9 * mm ** 0.5));
      const dens = clamp01(mm / 45);
      for (let s = 0; s < k; s++) {
        const h1 = hash01(c * 37 + s * 101);
        const h2 = hash01(c * 53 + s * 17 + 7);
        const x = g.x0 + (c + h1) * ((g.x1 - g.x0) / cols);
        const u = (h2 + T * (0.42 + 0.3 * h1)) % 1;
        const y = top + u * span;
        const len = 7 + 16 * h2 * (0.4 + dens);
        const fade = Math.sin(Math.PI * u);
        ctx.strokeStyle = rgba(pal.ink, a * pal.rainA * fade * (0.05 + 0.13 * dens));
        ctx.beginPath();
        ctx.moveTo(x, y - len);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
  }

  private drawGround(y: number, a: number, weight: number, marks: readonly (readonly [number, number])[]): void {
    if (a <= 0.01) return;
    const { ctx, g, pal } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = rgba(pal.ink, pal.lineA * a * weight);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.x0 - (g.phone ? 0 : 12), y + 0.5);
    ctx.lineTo(g.x1, y + 0.5);
    ctx.stroke();
    // The axis' edge (1 mm in three days, or 5 mm in two): a short mark through the ground.
    for (const [mm, w] of marks) {
      if (w <= 0.01) continue;
      const xd = Math.round(xOf(g, mm)) + 0.5;
      ctx.strokeStyle = rgba(pal.ink, 0.42 * a * weight * w);
      ctx.beginPath();
      ctx.moveTo(xd, y - 5);
      ctx.lineTo(xd, y + 5);
      ctx.stroke();
    }
  }

  private drawDrops(T: number, backW: number, out: number): void {
    const { ctx, g, p, pal, set, frame } = this;
    const add = pal.additive;
    const nO = set.oah.length;
    // Each line of numbers lights the drops it counts and lets the rest step back:
    //   "After three dry days: none of 36 over 900."   the 36 dry-day drops;
    //   "After 5 mm of rain in two days: 6 of 30."      the 30 right of the 5 mm mark, 6 of them orange;
    //   "Less rain: 4 of 88."                           the 88 left of it, 4 of them orange.
    const focusDry = window01(T, NUM_LINES[0]![0], NUM_LINES[0]![1] - 0.2, 0.8);
    const focusWet = window01(T, NUM_LINES[1]![0], NUM_LINES[1]![1] - 0.2, 0.8);
    const focusLess = window01(T, NUM_LINES[2]![0], NUM_LINES[2]![1] - 0.2, 0.8);
    const oahOut = 1 - smooth(ramp(T, REGROUP, REGROUP + 1.3));
    const ripples: { x: number; e: number; flag: boolean }[] = [];
    const y0 = -24;

    for (const d of set.all) {
      const i = d.i;
      const isOah = i < nO;
      const start = isOah ? this.startOah[i]! : this.startOpen[i - nO]!;
      frame.pa[i] = 0;
      if (T < start) continue;
      const land = start + FALL_DUR;
      let x: number;
      let y: number;
      if (isOah) {
        const st = hash01(i + 11) * GLIDE_SPREAD;
        const cw = easeInOut(ramp(T, CITY_GO + st, CITY_GO + st + GLIDE));
        x = p.heapX[i]! * (1 - cw) + p.cityX[i]! * cw;
        const rowY = p.cityY[i]! + (g.gy1 - g.rows[p.cityRow[i]!]!) * backW;
        y = p.heapY[i]! * (1 - cw) + rowY * cw;
      } else {
        x = p.heapX[i]!;
        y = p.heapY[i]!;
      }
      const falling = T < land;
      if (falling) {
        const u = (T - start) / FALL_DUR;
        y = y0 + (y - y0) * u * u;
      }

      let a = out;
      let bright = 1;
      if (isOah) a *= oahOut;
      else {
        const on = d.left ? focusLess : focusWet;
        const off = d.left ? focusWet : focusLess;
        if (d.dry) bright += 0.8 * focusDry;
        else a *= 1 - (d.flag ? 0.35 : 0.6) * focusDry;
        a *= 1 - (d.flag ? 0.35 : 0.62) * off;
        bright += (d.flag ? 0.55 : 0.3) * on;
      }
      if (a <= 0.01) continue;

      const r = g.r * (!isOah && d.dry ? 1 + 0.2 * focusDry : 1);
      const fl = falling ? 0 : 1 - ramp(T, land, land + (d.flag ? 1.6 : 0.9));
      frame.px[i] = x;
      frame.py[i] = y;
      frame.pa[i] = falling ? 0 : a;
      if (T >= land && T < land + 0.9) ripples.push({ x, e: ramp(T, land, land + 0.9), flag: d.flag });

      ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
      if (falling) {
        const u = (T - start) / FALL_DUR;
        const len = Math.min(26, 6 + 30 * u);
        ctx.strokeStyle = rgba(pal.ink, 0.55 * a);
        ctx.lineWidth = r * 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y - len);
        ctx.lineTo(x, y);
        ctx.stroke();
        continue;
      }
      const sprite = d.flag ? this.glowFlag : this.glowInk;
      const gs = r * (d.flag ? 15 : 7) * (1 + (d.flag ? 1.6 : 1.2) * fl * fl) * (0.85 + 0.25 * bright);
      ctx.globalAlpha = clamp01(a * ((add ? (d.flag ? 1 : 0.34) : d.flag ? 0.42 : 0.14) + 0.6 * fl) * bright);
      ctx.drawImage(sprite, x - gs / 2, y - gs / 2, gs, gs);
      if (d.flag && add) {
        // a second, tighter bloom so an orange drop reads as a lamp, not a dot
        const gt = r * 5.5 * (1 + fl);
        ctx.globalAlpha = clamp01(a * 0.85 * bright);
        ctx.drawImage(sprite, x - gt / 2, y - gt / 2, gt, gt);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = d.flag
        ? rgba(pal.flagCore, clamp01(a * bright))
        : add
          ? `rgba(255,255,255,${clamp01(a * 0.92 * bright)})`
          : rgba(pal.ink, clamp01(a * bright));
      ctx.beginPath();
      ctx.arc(x, y, r * (d.flag ? 0.95 : 0.64) * (1 + 0.5 * fl), 0, Math.PI * 2);
      ctx.fill();
      if (d.flag && add) {
        ctx.fillStyle = rgba(pal.flagHot, clamp01(a * 0.95 * Math.min(1, bright)));
        ctx.beginPath();
        ctx.arc(x, y, r * 0.42 * (1 + 0.5 * fl), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // A ripple on the ground where each drop lands.
    ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
    ctx.lineWidth = 1;
    for (const rp of ripples) {
      const w = 3 + (rp.flag ? 34 : 20) * Math.sqrt(rp.e);
      ctx.strokeStyle = rgba(rp.flag ? pal.flag : pal.ink, (rp.flag ? 0.7 : 0.42) * (1 - rp.e) * out);
      ctx.beginPath();
      ctx.ellipse(rp.x, g.gy1, w, w * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Fog over the storm end of the axis. It thins in a soft spot around every Garonne sample that has
   * landed (a measurement is what clears fog). At the hand-off the view pushes into the storm side and its
   * fog spreads over the whole screen, then holds there, drifting, while the city loads underneath: the
   * shell cross-fades from this fog to the map (whose fog is the same unmeasured water), never through black.
   */
  private drawFog(T: number, wRows: number): void {
    const { ctx, g, pal, set, p } = this;
    const { W, H } = g;
    const hand = smooth(ramp(T, HANDOFF + 0.1, FOG_FULL));
    const unlift = 1 - smooth(ramp(T, HANDOFF, HANDOFF + 0.7));
    const level = smooth(ramp(T, 0.2, 2.2)) * (1 - 0.3 * wRows);
    if (level <= 0.01) return;

    // Mask: which part of the screen the fog covers.
    const bottom = (g.gy1 + 0.1 * H) * (1 - wRows) + (g.rows[4]! + 0.06 * H) * wRows;
    const m = this.maskCv.getContext('2d')!;
    const MW = this.maskCv.width;
    const MH = this.maskCv.height;
    const img = m.createImageData(MW, MH);
    const fa = FOG_A;
    const fb = FOG_B;
    const axW = g.x1 - g.x0;
    for (let cx = 0; cx < MW; cx++) {
      const f = (((cx + 0.5) / MW) * W - g.x0) / axW;
      for (let cy = 0; cy < MH; cy++) {
        const sy = ((cy + 0.5) / MH) * H;
        // A ragged, slowly breathing edge instead of a straight one.
        const wave = 0.05 * Math.sin(sy / H * 7.1 + T * 0.23) + 0.035 * Math.sin(sy / H * 17.3 - T * 0.31 + 1.7);
        const base = smooth(ramp(f + wave, fa, fb));
        const vTop = smooth(ramp(sy, H * 0.1, H * 0.3));
        const vBot = 1 - smooth(ramp(sy, bottom - 0.06 * H, bottom + 0.1 * H));
        const m0 = base * vTop * vBot;
        img.data[(cy * MW + cx) * 4 + 3] = Math.round(255 * (m0 + (1 - m0) * hand));
      }
    }
    m.putImageData(img, 0, 0);

    const fc = this.fogCv;
    const f = fc.getContext('2d')!;
    const fw = fc.width;
    const fh = fc.height;
    const S = fw / W;
    f.globalCompositeOperation = 'source-over';
    f.globalAlpha = 1;
    f.clearRect(0, 0, fw, fh);
    const pat = f.createPattern(this.noise, 'repeat')!;
    f.save();
    f.translate((T * 9) % 512, (T * 2.2) % 512);
    f.scale(1.8, 1.05);
    f.fillStyle = pat;
    f.fillRect(-700, -700, fw + 1400, fh + 1400);
    f.restore();
    f.save();
    f.translate((-T * 5 + 97) % 512, (T * 1.3 + 41) % 512);
    f.scale(2.6, 1.4);
    f.globalAlpha = 0.5;
    f.fillStyle = pat;
    f.fillRect(-700, -700, fw + 1400, fh + 1400);
    f.restore();
    f.globalCompositeOperation = 'destination-in';
    f.imageSmoothingEnabled = true;
    f.drawImage(this.maskCv, 0, 0, fw, fh);

    // Lift around every landed sample. On the storm side (5 mm or more in the two days before) a measured sample
    // opens a window in the fog above where it sits, growing as it settles: those storm hours were measured, so
    // the fog over them thins, and the more samples land there, the more of the storm side shows.
    if (unlift > 0) {
      f.globalCompositeOperation = 'destination-out';
      const R = (g.phone ? 34 : 56) * S;
      const nO = set.oah.length;
      for (const d of set.open) {
        const land = this.startOpen[d.i - nO]! + FALL_DUR;
        if (T < land) continue;
        const x = p.heapX[d.i]! * S;
        const y = p.heapY[d.i]! * S;
        if (d.left) {
          f.globalAlpha = 0.34 * smooth(ramp(T, land, land + 1.4)) * unlift;
          f.drawImage(this.lifter, x - R, y - R, 2 * R, 2 * R);
          continue;
        }
        const e = smooth(ramp(T, land, land + 1.8));
        const rx = R * (0.8 + 0.9 * e);
        const ry = rx * 2.2;
        f.globalAlpha = 0.6 * e * unlift;
        f.drawImage(this.lifter, x - rx, y - ry * 1.35, 2 * rx, 2 * ry);
      }
      f.globalAlpha = 1;
    }
    f.globalCompositeOperation = 'source-over';

    // Hand-off: the view pushes into the storm side's fog, which fills the screen before the city appears.
    const cx = xOf(g, 30);
    const cy = g.gy1 - 0.12 * H;
    const zoom = 1 + 1.4 * hand * hand;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha = clamp01(pal.fogA * level * (1 - 0.3 * hand));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fc, 0, 0, W, H);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Rows of the city beat, for placing their labels. */
  cityRows(): readonly { id: string; name: string; y: number }[] {
    return CITY_ROWS.map((c, k) => ({ id: c.id, name: c.name, y: this.g.rows[k]! }));
  }
}
