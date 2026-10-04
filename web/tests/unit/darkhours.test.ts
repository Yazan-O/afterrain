// W2 The dark hours: every drop's position comes from its data row (OneAquaHealth on the rain of the three days
// before, the Garonne on the rain of the two days before), and every count the scene shows equals numbers.json
// and the rows on screen.
import { describe, expect, it } from 'vitest';
import type { DarkHoursFile, NumbersFile } from '../../src/data/schemas';
import { KEYS, numberOf } from '../../src/scenes/darkhours/copy';
import { CITY_ROWS, DRY_MM, FLAG_ECOLI, RAIN_MAX, WET_MM, buildDrops, edgeMm, geometry, place, rainFrac, xOf, type DropSet } from '../../src/scenes/darkhours/layout';
import {
  BEATS,
  BEAT_START,
  FALL_DUR,
  FOG_FULL,
  GARONNE_AT,
  HANDOFF,
  LINE_IN,
  NAVIGATE_AT,
  NUM_LINES,
  OPEN_AT,
  REGROUP,
  RETURN_BEAT,
  SETTLED,
  STILLS,
  beatAt,
  oahFall,
  openFall,
  startOf,
  stillFor,
} from '../../src/scenes/darkhours/timeline';
import { disk } from './disk';

const file: DarkHoursFile = await disk.darkHours();
const numbers: NumbersFile = await disk.numbers();
const set: DropSet = buildDrops(file);
const VIEWPORTS = [
  [1440, 900],
  [390, 844],
] as const;

/** The dark_hours.json row a drop's src pointer names. */
const rowOf = (src: string): Record<string, unknown> => {
  const m = /^dark_hours\.json#\/(\w+)\/(\d+)$/.exec(src);
  if (!m) throw new Error(`bad src ${src}`);
  const arr = (file as unknown as Record<string, Record<string, unknown>[]>)[m[1]!]!;
  return arr[Number(m[2])]!;
};

describe('drops are the rows of dark_hours.json', () => {
  it('draws every OneAquaHealth and Garonne row once, and no Bath row (Bath has its own scene)', () => {
    expect(set.missingRain).toBe(0);
    expect(set.oah).toHaveLength(file.oneaquahealth.length);
    expect(set.open).toHaveLength(file.toulouse_garonne.length);
    expect(set.all.every((d) => !d.src.includes('bath_warleigh'))).toBe(true);
    expect(new Set(set.all.map((d) => d.src)).size).toBe(set.all.length);
    set.all.forEach((d, k) => expect(d.i).toBe(k));
  });

  it("carries each row's own rain, dry flag, date, E. coli count and flag", () => {
    for (const d of set.all) {
      const r = rowOf(d.src);
      expect(d.rain).toBe(r['rain_3d_mm']);
      expect(d.dry).toBe(r['dry']);
      // the rain on the drop's own axis: three days for OneAquaHealth, two days for the Garonne
      expect(d.axisMm).toBe(r[d.series === 'garonne' ? 'rain_2d_mm' : 'rain_3d_mm']);
      expect(d.left).toBe(d.series === 'garonne' ? (r['rain_2d_mm'] as number) < WET_MM : r['dry']);
      expect(d.date).toBe(r['date']);
      expect(d.siteName).toBe(r['site_name']);
      if (d.series === 'oah') {
        expect(d.ecoli).toBeNull();
        expect(d.flag).toBe(false);
      } else {
        expect(d.ecoli).toBe(r['ecoli_per_100ml']);
        expect(d.flag).toBe(r['over_900']);
        expect(d.flag).toBe((d.ecoli ?? 0) > FLAG_ECOLI);
      }
    }
  });

  it('falls in date order', () => {
    for (const list of [set.oah, set.open]) for (let k = 1; k < list.length; k++) expect(list[k - 1]!.when <= list[k]!.when).toBe(true);
  });

  it("agrees with the file's definition of dry and with the threshold keys on screen", () => {
    expect(file.definition).toMatch(/less than 1 mm of rain summed over the 3 days before/);
    expect(numberOf(numbers, KEYS.dryMm)).toBe(DRY_MM);
    expect(numberOf(numbers, KEYS.flag)).toBe(FLAG_ECOLI);
    expect(numberOf(numbers, KEYS.wetMm)).toBe(WET_MM);
    expect(file.rain_sources['toulouse']).toMatch(/rain_2d_mm = the 2 days before the sample day, wet when >= 5 mm/);
    for (const d of set.all) expect(d.dry).toBe(d.rain < DRY_MM);
    for (const d of set.all) expect(d.rain).toBeLessThanOrEqual(RAIN_MAX);
    for (const d of set.all) expect(d.axisMm).toBeLessThanOrEqual(RAIN_MAX);
  });
});

describe.each(VIEWPORTS)('positions at %i x %i', (W, H) => {
  const g = geometry(W, H);
  const p = place(g, set);
  const wetEdge = xOf(g, WET_MM);

  it('x is the rain before the sample, on the axis scale, and nothing else: three days for OneAquaHealth', () => {
    for (const d of set.oah) {
      const want = g.x0 + rainFrac(rowOf(d.src)['rain_3d_mm'] as number) * (g.x1 - g.x0);
      expect(p.x[d.i]).toBeCloseTo(want, 3);
    }
  });

  it("every Garonne drop's x is its row's rain_2d_mm (the two days before), where the 5 mm mark stands", () => {
    expect(set.open.length).toBe(file.toulouse_garonne.length);
    for (const d of set.open) {
      const mm = rowOf(d.src)['rain_2d_mm'] as number;
      expect(typeof mm).toBe('number');
      expect(p.x[d.i]).toBeCloseTo(g.x0 + rainFrac(mm) * (g.x1 - g.x0), 3);
      // settled on the heap: within its slide of that x, and on the side of the 5 mm mark its rain puts it
      expect(Math.abs(p.heapX[d.i]! - p.x[d.i]!)).toBeLessThanOrEqual(g.slide + 1e-3);
      if (mm >= WET_MM) expect(p.heapX[d.i]!).toBeGreaterThan(wetEdge);
      else expect(p.heapX[d.i]!).toBeLessThan(wetEdge);
    }
  });

  it('every heap: each drop within its slide of its data x, on its own side of the dry edge, above its ground, none overlapping', () => {
    const heaps: { ids: number[]; xs: Float32Array; ys: Float32Array; ground: (i: number) => number }[] = [
      { ids: set.oah.map((d) => d.i), xs: p.heapX, ys: p.heapY, ground: () => g.gy1 },
      { ids: set.open.map((d) => d.i), xs: p.heapX, ys: p.heapY, ground: () => g.gy1 },
      ...CITY_ROWS.map((_, row) => ({
        ids: set.oah.filter((d) => p.cityRow[d.i] === row).map((d) => d.i),
        xs: p.cityX,
        ys: p.cityY,
        ground: () => g.rows[row]!,
      })),
    ];
    for (const { ids, xs, ys, ground } of heaps) {
      for (const i of ids) {
        const d = set.all[i]!;
        const e = xOf(g, edgeMm(d.series));
        expect(Math.abs(xs[i]! - p.x[i]!)).toBeLessThanOrEqual(g.slide + 1e-3);
        if (d.left) expect(xs[i]!).toBeLessThan(e);
        else expect(xs[i]!).toBeGreaterThan(e);
        expect(ys[i]!).toBeLessThanOrEqual(ground(i) - g.r + 1e-3);
      }
      for (let a = 0; a < ids.length; a++)
        for (let b = a + 1; b < ids.length; b++) {
          const i = ids[a]!;
          const j = ids[b]!;
          expect(Math.hypot(xs[i]! - xs[j]!, ys[i]! - ys[j]!)).toBeGreaterThanOrEqual(2 * g.r - 1e-3);
        }
    }
  });

  it('the 5 mm mark splits the Garonne as the lines say (toulouse.wet_2d_5mm and toulouse.otherwise)', () => {
    const right = set.open.filter((d) => p.heapX[d.i]! > wetEdge);
    const left = set.open.filter((d) => p.heapX[d.i]! < wetEdge);
    expect([right.filter((d) => d.flag).length, right.length]).toEqual([numberOf(numbers, KEYS.wetExceed), numberOf(numbers, KEYS.wetN)]);
    expect([left.filter((d) => d.flag).length, left.length]).toEqual([numberOf(numbers, KEYS.elseExceed), numberOf(numbers, KEYS.elseN)]);
    // and the dry-day drops (under 1 mm in three days) all sit left of it, as many orange as the line says
    const dry = set.open.filter((d) => d.dry);
    for (const d of dry) expect(p.heapX[d.i]!).toBeLessThan(wetEdge);
    expect(dry.filter((d) => d.flag)).toHaveLength(numberOf(numbers, KEYS.dryExceed));
  });

  it("puts each OneAquaHealth drop on its own city's row", () => {
    for (const d of set.oah) expect(CITY_ROWS[p.cityRow[d.i]!]!.id).toBe(d.city);
  });

  it('is the same every time (no randomness)', () => {
    const q = place(geometry(W, H), buildDrops(file));
    expect([...q.heapX]).toEqual([...p.heapX]);
    expect([...q.heapY]).toEqual([...p.heapY]);
    expect([...q.cityY]).toEqual([...p.cityY]);
  });
});

describe('every count the scene shows equals numbers.json and the drops on screen', () => {
  const oahDry = set.oah.filter((d) => d.dry).length;
  it('the dry-day count and the sample count (darkhours.oneaquahealth.*)', () => {
    expect(numberOf(numbers, KEYS.n)).toBe(set.oah.length);
    expect(numberOf(numbers, KEYS.dry)).toBe(oahDry);
    expect(file.summary.oneaquahealth.dry).toBe(oahDry);
  });

  it('the samples after rain, and after 5 mm or more (numbers.json keeps the split)', () => {
    const wet = set.oah.filter((d) => !d.dry);
    expect(numberOf(numbers, 'darkhours.oah.wet_after_rain')).toBe(wet.length);
    expect(numberOf(numbers, 'darkhours.oah.wet_after_5mm')).toBe(set.oah.filter((d) => d.rain >= WET_MM).length);
  });

  it('per city: the dry-day count of each city row (oah.<city>.dry and .samples)', () => {
    const shown: Record<string, [number, number]> = {};
    for (const c of CITY_ROWS) {
      const drops = set.oah.filter((d) => d.city === c.id);
      const dry = drops.filter((d) => d.dry).length;
      expect(numberOf(numbers, KEYS.city[c.id]!.dry)).toBe(dry);
      expect(numberOf(numbers, KEYS.city[c.id]!.n)).toBe(drops.length);
      expect(file.summary.oneaquahealth_by_city[c.id]).toMatchObject({ n: drops.length, dry });
      shown[c.name] = [dry, drops.length];
    }
    expect(Object.keys(shown)).toEqual(CITY_ROWS.map((c) => c.name));
  });

  it('the Garonne: the dry-day line counts the drops left of the dry edge; the 5 mm split partitions the rest (toulouse.*)', () => {
    const garonne = set.open;
    expect(garonne).toHaveLength(numberOf(numbers, 'toulouse.samples'));
    const dry = garonne.filter((d) => d.dry);
    expect(numberOf(numbers, KEYS.dryN)).toBe(dry.length);
    expect(numberOf(numbers, KEYS.dryExceed)).toBe(dry.filter((d) => d.flag).length);
    // The two-day split, recounted from the rows' own rain_2d_mm: it partitions the 118.
    const wet = garonne.filter((d) => d.axisMm >= WET_MM);
    const less = garonne.filter((d) => d.axisMm < WET_MM);
    expect([wet.filter((d) => d.flag).length, wet.length]).toEqual([numberOf(numbers, KEYS.wetExceed), numberOf(numbers, KEYS.wetN)]);
    expect([less.filter((d) => d.flag).length, less.length]).toEqual([numberOf(numbers, KEYS.elseExceed), numberOf(numbers, KEYS.elseN)]);
    expect(wet.length + less.length).toBe(garonne.length);
  });
});

describe('the script', () => {
  it('lands every OneAquaHealth drop before the sentence, and every Garonne drop before the numbers', () => {
    const a = oahFall(set.oah.length);
    const b = openFall(set.open.length);
    for (let k = 1; k < a.length; k++) expect(a[k]!).toBeGreaterThan(a[k - 1]!);
    expect(a[a.length - 1]! + FALL_DUR).toBeLessThan(LINE_IN);
    expect(b[b.length - 1]! + FALL_DUR).toBeLessThan(NUM_LINES[0]![0]);
  });

  it('shows one line of numbers at a time', () => {
    for (let k = 1; k < NUM_LINES.length; k++) expect(NUM_LINES[k]![0]).toBeGreaterThanOrEqual(NUM_LINES[k - 1]![1]);
  });

  it('a deep link starts at its beat (the fall from the top, never the line after it)', () => {
    for (const b of BEATS) expect(beatAt(startOf(b))).toBe(b);
    expect(startOf('fall')).toBe(0);
    // the fall settles before the line begins: every drop has landed and the line is not up yet
    expect(SETTLED.fall).toBeGreaterThan(oahFall(set.oah.length)[set.oah.length - 1]! + FALL_DUR);
    expect(SETTLED.fall).toBeLessThan(LINE_IN);
    expect(RETURN_BEAT).toBe('storm');
  });

  it('hands off once its words have gone and the fog is spreading, and the fog fills the screen after that', () => {
    const lastOut = NUM_LINES[NUM_LINES.length - 1]![1] + 0.5;
    expect(NAVIGATE_AT).toBeGreaterThanOrEqual(lastOut);
    expect(NAVIGATE_AT).toBeGreaterThan(HANDOFF);
    expect(FOG_FULL).toBeGreaterThan(NAVIGATE_AT);
    expect(SETTLED.end).toBeLessThan(NAVIGATE_AT);
  });

  it('settles each beat inside that beat, and reduced motion shows one still per stretch', () => {
    for (const b of BEATS) expect(beatAt(SETTLED[b])).toBe(b);
    for (const b of BEATS) expect(SETTLED[b]).toBeGreaterThanOrEqual(BEAT_START[b]);
    for (const s of STILLS) expect(stillFor(s.from)).toBe(s.at);
    for (const s of STILLS) expect(s.at).toBeGreaterThanOrEqual(s.from);
  });
});

describe('the hook and the Garonne beat', () => {
  it('the fall is legible and quick: three drops one by one, then the shower, all landed before the line at about 4 s', () => {
    const a = oahFall(set.oah.length);
    expect(a[1]! - a[0]!).toBeGreaterThanOrEqual(0.3);
    expect(a[2]! - a[1]!).toBeGreaterThanOrEqual(0.3);
    expect(a[a.length - 1]! + FALL_DUR).toBeLessThan(LINE_IN);
    // story mode shows a 3.8 s tagline before the dark hours: the line lands before 8 s into the story
    expect(LINE_IN).toBeLessThanOrEqual(4.2);
  });

  it("story mode's Garonne beat is the scene's storm beat: the cities fold back, then its drops, then its numbers", () => {
    expect(GARONNE_AT).toBe(BEAT_START.storm);
    expect(GARONNE_AT).toBe(REGROUP);
    expect(OPEN_AT).toBeGreaterThan(REGROUP);
    const b = openFall(set.open.length);
    expect(b[0]).toBe(OPEN_AT);
    expect(b[b.length - 1]! + FALL_DUR).toBeLessThan(NUM_LINES[0]![0]);
    expect(NUM_LINES[NUM_LINES.length - 1]![1]).toBeLessThanOrEqual(HANDOFF);
  });

  it('the storm side is where its drops are: of the Garonne samples after 5 mm or more in two days, every one sits right of the 5 mm mark', () => {
    for (const [W, H] of VIEWPORTS) {
      const g = geometry(W, H);
      const p = place(g, set);
      const wet = set.open.filter((d) => !d.left);
      expect(wet.length).toBe(numberOf(numbers, KEYS.wetN));
      for (const d of wet) expect(p.heapX[d.i]!).toBeGreaterThan(xOf(g, WET_MM));
    }
  });
});
