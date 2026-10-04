// Where every drop sits. Pure functions of the data rows and the viewport, so the unit tests can prove that
// each drop's x is its row's rain and nothing else.
//
// x: the rain before the sampling day on a log scale ln(1 + mm / RAIN_C), so "dry" (under 1 mm) and "storm"
//    (tens of mm) both get room. Each series sits on the axis its claim is made on:
//      OneAquaHealth  rain summed over the 3 days before (rain_3d_mm), split at the 1 mm dry edge;
//      the Garonne    rain summed over the 2 days before (rain_2d_mm), split at 5 mm (thresholds.wet_mm_2d),
//                     the axis of "After 5 mm of rain in two days: 6 of 30. Less rain: 4 of 88."
// y: a heap. Drops are placed in date order, each as low as it fits without touching another, sliding
//    sideways at most a few pixels (never across its axis' edge), the way drops or sand pile up. Height
//    carries no data; it only keeps every drop visible. A Garonne sample over 900 E. coli per 100 ml is orange.
import type { DarkHoursFile } from '../../data/schemas';

export const RAIN_C = 0.25;
export const RAIN_MAX = 70;
/** dark_hours.json's own definition: dry = under 1 mm summed over the 3 days before the sampling day. */
export const DRY_MM = 1;
/** The Garonne's split: 5 mm or more in the 2 days before the sample day is wet (thresholds.wet_mm_2d). */
export const WET_MM = 5;

export const rainFrac = (mm: number): number => Math.log1p(Math.max(0, mm) / RAIN_C) / Math.log1p(RAIN_MAX / RAIN_C);
export const mmAtFrac = (f: number): number => RAIN_C * Math.expm1(f * Math.log1p(RAIN_MAX / RAIN_C));

export type Series = 'oah' | 'garonne';

export interface Drop {
  /** Index in the scene's drop list (OneAquaHealth first, then the Garonne and the Avon in date order). */
  readonly i: number;
  readonly series: Series;
  /** Index of the row in its dark_hours.json array, for the src pointer and the tests. */
  readonly row: number;
  readonly city: string;
  readonly siteName: string;
  readonly date: string;
  /** Sort key: the sample's date, or its local date-time where the file has one. */
  readonly when: string;
  /** Rain in the 3 days before (rain_3d_mm), the file's dry test. */
  readonly rain: number;
  readonly dry: boolean;
  /** Rain on this drop's own axis: rain_3d_mm for OneAquaHealth, rain_2d_mm for the Garonne. */
  readonly axisMm: number;
  /** Left of its axis' edge: dry for OneAquaHealth, under 5 mm in two days for the Garonne. */
  readonly left: boolean;
  /** Over 900 E. coli per 100 ml in this one sample (Garonne only; OneAquaHealth rows have no count). */
  readonly flag: boolean;
  /** E. coli per 100 ml (Garonne); null for OneAquaHealth rows, which carry risk scores instead. */
  readonly ecoli: number | null;
  /** `dark_hours.json#/<array>/<row>`: the row this drop is drawn from. */
  readonly src: string;
}

const ARRAY: Record<Series, 'oneaquahealth' | 'toulouse_garonne'> = {
  oah: 'oneaquahealth',
  garonne: 'toulouse_garonne',
};

export interface DropSet {
  /** OneAquaHealth's samples in date order. */
  readonly oah: Drop[];
  /** The Garonne at Toulouse (Hub'Eau station BF000002), in date order. The Avon at Bath has its own scene. */
  readonly open: Drop[];
  readonly all: Drop[];
  /** Rows left out because their rain is missing (dark_hours.json reports 0 today). */
  readonly missingRain: number;
}

export function buildDrops(file: DarkHoursFile): DropSet {
  let missingRain = 0;
  const rows = (series: Series): Omit<Drop, 'i'>[] => {
    const out: Omit<Drop, 'i'>[] = [];
    file[ARRAY[series]].forEach((r, row) => {
      const r2 = 'rain_2d_mm' in r ? r.rain_2d_mm : null;
      if (r.rain_3d_mm === null || r.dry === null || (series === 'garonne' && r2 === null)) {
        missingRain++;
        return;
      }
      const axisMm = series === 'garonne' ? r2! : r.rain_3d_mm;
      out.push({
        series,
        row,
        city: r.city,
        siteName: r.site_name,
        date: r.date,
        when: r.date,
        rain: r.rain_3d_mm,
        dry: r.dry,
        axisMm,
        left: series === 'garonne' ? axisMm < WET_MM : r.dry,
        flag: 'over_900' in r ? r.over_900 : false,
        ecoli: 'ecoli_per_100ml' in r ? r.ecoli_per_100ml : null,
        src: `dark_hours.json#/${ARRAY[series]}/${row}`,
      });
    });
    return out;
  };
  const byWhen = (a: Omit<Drop, 'i'>, b: Omit<Drop, 'i'>): number => (a.when < b.when ? -1 : a.when > b.when ? 1 : a.row - b.row);
  const oahRows = rows('oah').sort(byWhen);
  const openRows = rows('garonne').sort(byWhen);
  const oah = oahRows.map((d, i) => ({ ...d, i }));
  const open = openRows.map((d, k) => ({ ...d, i: oah.length + k }));
  return { oah, open, all: [...oah, ...open], missingRain };
}

/** The five OneAquaHealth cities, in the order the scene lists them. */
export const CITY_ROWS = [
  { id: 'GH', name: 'Ghent' },
  { id: 'OS', name: 'Oslo' },
  { id: 'TO', name: 'Toulouse' },
  { id: 'CO', name: 'Coimbra' },
  { id: 'BE', name: 'Benevento' },
] as const;

export interface Geometry {
  readonly W: number;
  readonly H: number;
  readonly phone: boolean;
  /** The rain axis runs from x0 (no rain) to x1 (RAIN_MAX). */
  readonly x0: number;
  readonly x1: number;
  /** Drop radius. */
  readonly r: number;
  /** How far a drop may slide sideways while it settles on a heap. */
  readonly slide: number;
  /** Ground line of the fall, the line and the storm beats. */
  readonly gy1: number;
  /** Ground lines of the five city rows. */
  readonly rows: readonly number[];
  /** Left edge and top of the sentence. */
  readonly textX: number;
  readonly textY: number;
}

export function geometry(W: number, H: number): Geometry {
  const phone = W < 700;
  const side = phone ? 16 : Math.max(96, Math.round(W * 0.075));
  const rows: number[] = [];
  const rTop = phone ? 0.23 : 0.21;
  const rBot = 0.9;
  for (let k = 0; k < CITY_ROWS.length; k++) rows.push(Math.round(H * (rTop + ((rBot - rTop) * k) / (CITY_ROWS.length - 1))));
  return {
    W,
    H,
    phone,
    x0: side,
    x1: W - side,
    r: phone ? 2.9 : 4.2,
    slide: phone ? 22 : 44,
    gy1: Math.round(H * (phone ? 0.64 : 0.7)),
    rows,
    textX: side,
    textY: phone ? 76 : 88,
  };
}

export const xOf = (g: Geometry, mm: number): number => g.x0 + rainFrac(mm) * (g.x1 - g.x0);
/** The edge each series heaps against: the 1 mm dry edge (3-day axis) or 5 mm (the Garonne's 2-day axis). */
export const edgeMm = (series: Series): number => (series === 'garonne' ? WET_MM : DRY_MM);

/** Where the words "storm side" sit on the rain axis: under the fog at the wet end (about 25 mm). */
export const STORM_SIDE_MM = 25;

/** The single-sample flag: over 900 E. coli per 100 ml. */
export const FLAG_ECOLI = 900;

/** Gap between drops in a heap, as a multiple of the diameter. */
const AIR = 1.16;
/** Height cost of one pixel of sideways slide: slopes of about 50 degrees, like a pile of sand. */
const SLIDE_COST = 1.3;

export interface Settled {
  /** Settled x of each drop (within `slide` of its data x, on the same side of the dry edge). */
  readonly x: number[];
  /** Height of each drop's centre above its ground line. */
  readonly h: number[];
}

/**
 * A heap: drops placed in the given order, each at the lowest spot it fits without touching an earlier one,
 * sliding at most `slide` pixels from its data x, never left of `minX` and never across `edge` (drops marked
 * `left` stay left of it, the others right of it).
 */
export function settle(xs: readonly number[], left: readonly boolean[], r: number, slide: number, edge: number, minX: number): Settled {
  const d = 2 * r * AIR;
  const d2 = d * d - 1e-6;
  const buckets = new Map<number, { x: number; h: number }[]>();
  const key = (x: number): number => Math.floor(x / d);
  const heightAt = (x: number): number => {
    const near: { x: number; h: number }[] = [];
    for (let k = key(x) - 1; k <= key(x) + 1; k++) for (const p of buckets.get(k) ?? []) if (Math.abs(p.x - x) < d) near.push(p);
    const cands = [r, ...near.map((p) => p.h + Math.sqrt(Math.max(0, d * d - (p.x - x) ** 2)))].sort((a, b) => a - b);
    for (const c of cands) if (near.every((p) => (p.x - x) ** 2 + (p.h - c) ** 2 >= d2)) return c;
    return cands[cands.length - 1]!;
  };
  const out: Settled = { x: [], h: [] };
  const step = r * 0.5;
  xs.forEach((x, i) => {
    const lo = Math.max(minX, x - slide, left[i] ? -Infinity : edge + r);
    const hi = Math.min(x + slide, left[i] ? edge - r : Infinity);
    let bx = Math.min(Math.max(x, lo), hi);
    let bh = heightAt(bx);
    let best = bh + SLIDE_COST * Math.abs(bx - x);
    for (let k = 1; k * step <= slide; k++) {
      for (const sx of [x + k * step, x - k * step]) {
        if (sx < lo || sx > hi) continue;
        const hh = heightAt(sx);
        const cost = hh + SLIDE_COST * Math.abs(sx - x);
        if (cost < best - 1e-9) {
          best = cost;
          bx = sx;
          bh = hh;
        }
      }
    }
    const p = { x: bx, h: bh };
    const b = buckets.get(key(bx));
    if (b) b.push(p);
    else buckets.set(key(bx), [p]);
    out.x.push(bx);
    out.h.push(bh);
  });
  return out;
}

/** Screen position of every drop in each beat; index = Drop.i. */
export interface Placement {
  /** x from the data alone: the rain before the sample on the drop's own axis (Drop.axisMm). */
  readonly x: Float32Array;
  /** The heap on the first ground (OneAquaHealth in the fall and line beats, the Garonne in the storm beat). */
  readonly heapX: Float32Array;
  readonly heapY: Float32Array;
  /** OneAquaHealth on its city's row. */
  readonly cityX: Float32Array;
  readonly cityY: Float32Array;
  /** Row index (0..4) of each OneAquaHealth drop; -1 for the others. */
  readonly cityRow: Int8Array;
}

export function place(g: Geometry, set: DropSet): Placement {
  const n = set.all.length;
  const f32 = (): Float32Array => new Float32Array(n);
  const P = { x: f32(), heapX: f32(), heapY: f32(), cityX: f32(), cityY: f32(), cityRow: new Int8Array(n).fill(-1) };
  for (const d of set.all) P.x[d.i] = xOf(g, d.axisMm);
  const minX = g.x0 - (g.phone ? g.r : 2 * g.r);
  const heap = (drops: readonly Drop[], ground: number, setX: Float32Array, setY: Float32Array): void => {
    if (drops.length === 0) return;
    const s = settle(
      drops.map((d) => P.x[d.i]!),
      drops.map((d) => d.left),
      g.r,
      g.slide,
      xOf(g, edgeMm(drops[0]!.series)),
      minX,
    );
    drops.forEach((d, k) => {
      setX[d.i] = s.x[k]!;
      setY[d.i] = ground - s.h[k]!;
    });
  };
  heap(set.oah, g.gy1, P.heapX, P.heapY);
  heap(set.open, g.gy1, P.heapX, P.heapY);
  for (const d of set.open) {
    P.cityX[d.i] = P.heapX[d.i]!;
    P.cityY[d.i] = P.heapY[d.i]!;
  }
  CITY_ROWS.forEach((c, row) => {
    const drops = set.oah.filter((d) => d.city === c.id);
    heap(drops, g.rows[row]!, P.cityX, P.cityY);
    for (const d of drops) P.cityRow[d.i] = row;
  });
  return P;
}
