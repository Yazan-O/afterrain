// The storm replay scene's pure parts: the river network, the departure and arrival schedule with its Bath
// time labels, and the tempo that paces the story.
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/engine/replay';
import { parseUtc as t } from '../../src/engine/timefmt';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNetwork, buildNetworkSliced, pointAlong, distM } from '../../src/scenes/replay/network';
import { decodeDem, decodeDemSliced } from '../../src/scenes/replay/terrain';
import { buildSchedule, clockLabel, HERO_OVERFLOW, type Schedule } from '../../src/scenes/replay/schedule';
import { disk } from './disk';

const sched = async (key: '2024-09-23' | '2023-07-10'): Promise<Schedule> => {
  const pack = await disk.replay(key);
  return buildSchedule(key, pack, buildTimeline(pack));
};

describe('river network', () => {
  it('routes every overflow to the weir within 0.5% of the pipeline distance', async () => {
    for (const key of ['2024-09-23', '2023-07-10'] as const) {
      const pack = await disk.replay(key);
      const net = buildNetwork(pack);
      expect(net.paths.size).toBe(pack.overflows.length);
      for (const o of pack.overflows) {
        const p = net.paths.get(o.overflow)!;
        expect(Math.abs(p.lengthM - o.distance_to_weir_m!) / o.distance_to_weir_m!).toBeLessThan(0.005);
        expect(Math.abs(p.snapM - o.snap_to_river_m!) / Math.max(o.snap_to_river_m!, 1)).toBeLessThan(0.1);
        expect(p.nodes[p.nodes.length - 1]).toBe(net.weirNode);
      }
    }
  });

  it('ends every path at the weir and walks downstream monotonically', async () => {
    const pack = await disk.replay('2024-09-23');
    const net = buildNetwork(pack);
    const weir = { lon: pack.site.lon, lat: pack.site.lat };
    const fresh = net.paths.get(HERO_OVERFLOW)!;
    expect(distM(pointAlong(net, fresh, fresh.lengthM), weir)).toBeLessThan(50);
    for (let k = 1; k < fresh.nodes.length; k++) expect(net.nodes[fresh.nodes[k]!]!.toWeirM).toBeLessThan(net.nodes[fresh.nodes[k - 1]!]!.toWeirM);
    expect(fresh.lengthM / 1000).toBeCloseTo(4.55, 1);
  });
});

describe('departures', () => {
  it('has one first departure for each of the 24 overflows of the 2024 storm and 11 of the 2023 one', async () => {
    const s24 = await sched('2024-09-23');
    expect(s24.departures.filter((d) => d.first)).toHaveLength(24);
    expect(new Set(s24.departures.filter((d) => d.first).map((d) => d.overflow)).size).toBe(24);
    const s23 = await sched('2023-07-10');
    expect(s23.departures.filter((d) => d.first)).toHaveLength(11);
  });

  it('labels the Freshford storm tank 10:28 on 23 Sep to 16:39 on 24 Sep, Bath time, 30 hours', async () => {
    const s = await sched('2024-09-23');
    const h = s.heroDeparture!;
    expect(h.overflow).toBe(HERO_OVERFLOW);
    expect(h.label).toBe('10:28');
    expect(clockLabel(h.startMs)).toBe('Mon 23 Sep 10:28');
    expect(clockLabel(h.stopMs)).toBe('Tue 24 Sep 16:39');
    expect(Math.round((h.stopMs - h.startMs) / 3_600_000)).toBe(30);
    expect(h.startMs).toBe(t('2024-09-23T09:28:00Z'));
  });

  it('converts every logged start from UTC to Bath summer time', async () => {
    const s = await sched('2024-09-23');
    for (const d of s.departures) {
      const utc = new Date(d.startMs);
      const bst = (utc.getUTCHours() + 1) % 24;
      expect(d.label).toBe(`${String(bst).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}`);
    }
    const first = s.departures.find((d) => d.overflow === HERO_OVERFLOW && d.first)!;
    expect(first.label).toBe('10:16');
    expect(first.hero).toBe(false);
  });

  it('clicks on every logged switch inside the window, in time order', async () => {
    const s = await sched('2024-09-23');
    expect(s.clicks.length).toBeGreaterThan(48);
    for (let i = 1; i < s.clicks.length; i++) expect(s.clicks[i]!.tMs).toBeGreaterThanOrEqual(s.clicks[i - 1]!.tMs);
    expect(s.clicks.every((c) => c.tMs >= s.windowStartMs && c.tMs < s.windowEndMs)).toBe(true);
  });
});

describe('sample arrivals', () => {
  it('lands the 31,000 at 09:10 on 24 Sep and the 20 Sep pair at 15:00 and 16:00, Bath time', async () => {
    const s = await sched('2024-09-23');
    expect(s.samples).toHaveLength(15);
    const hero = s.heroSample!;
    expect(hero.value).toBe(31000);
    expect(hero.label).toBe('09:10');
    expect(clockLabel(hero.tMs)).toBe('Tue 24 Sep 09:10');
    expect(hero.src).toBe('replay_2024-09-23.json#/samples/3/ecoli_per_100ml');
    const sep20 = s.samples.filter((x) => clockLabel(x.tMs).startsWith('Fri 20 Sep'));
    expect(sep20.map((x) => [x.label, x.value])).toEqual([
      ['15:00', 1100],
      ['16:00', 200],
    ]);
    expect(s.samples.filter((x) => x.hero)).toHaveLength(1);
  });

  it('points every value at its row in the file', async () => {
    const pack = await disk.replay('2024-09-23');
    const s = await sched('2024-09-23');
    for (const x of s.samples) {
      const i = Number(/\/samples\/(\d+)\//.exec(x.src)![1]);
      expect(pack.samples[i]!.ecoli_per_100ml).toBe(x.value);
      expect(Date.parse(pack.samples[i]!.time_utc)).toBe(x.tMs);
    }
  });

  it('shows the 2023 storm with its one sample, 3,100 at 09:00 on 11 Jul', async () => {
    const s = await sched('2023-07-10');
    expect(s.samples.map((x) => [clockLabel(x.tMs), x.value])).toEqual([['Tue 11 Jul 09:00', 3100]]);
  });
});

describe('tempo', () => {
  it('runs the 2024 storm in 40 to 55 story seconds and is monotonic and invertible', async () => {
    const { tempo } = await sched('2024-09-23');
    expect(tempo.duration).toBeGreaterThan(40);
    expect(tempo.duration).toBeLessThan(55);
    let prev = -1;
    for (let tm = tempo.startMs; tm <= tempo.endMs; tm += 600_000) {
      const s = tempo.sigmaAt(tm);
      expect(s).toBeGreaterThan(prev);
      prev = s;
      expect(Math.abs(tempo.timeAt(s) - tm)).toBeLessThan(1000);
    }
  });

  it('gives the beat of silence before the 31,000 and the hold after it at least two seconds each', async () => {
    const s = await sched('2024-09-23');
    const h = s.heroSample!.tMs;
    const at = s.tempo.sigmaAt;
    expect(at(h) - at(h - 40 * 60_000)).toBeGreaterThan(2);
    expect(at(h + 55 * 60_000) - at(h)).toBeGreaterThan(3);
    // the calm days pass quickly: the first two days take under 8 seconds
    expect(at(s.windowStartMs + 48 * 3_600_000)).toBeLessThan(8);
  });

  it('gives the Freshford departure time to read', async () => {
    const s = await sched('2024-09-23');
    const d = s.heroDeparture!.startMs;
    expect(s.tempo.sigmaAt(d + 30 * 60_000) - s.tempo.sigmaAt(d - 30 * 60_000)).toBeGreaterThan(1.5);
  });

  it('keeps the 2023 storm short', async () => {
    const { tempo } = await sched('2023-07-10');
    expect(tempo.duration).toBeGreaterThan(15);
    expect(tempo.duration).toBeLessThan(45);
  });
});

describe('routes', () => {
  it('reads the storm and the fold from the hash, and writes them back the same way', async () => {
    const { parseReplayRoute, replayHash, DEFAULT_KEY } = await import('../../src/scenes/replay/route');
    const { parseHash } = await import('../../src/app/router');
    const cases = [
      ['#/replay', '2024-09-23', false],
      ['#/replay/timetable', '2024-09-23', true],
      ['#/replay/2023-07-10', '2023-07-10', false],
      ['#/replay/2023-07-10/timetable', '2023-07-10', true],
    ] as const;
    expect(DEFAULT_KEY).toBe('2024-09-23');
    for (const [hash, key, timetable] of cases) {
      const route = parseHash(hash, ['replay']);
      expect(route.kind).toBe('scene');
      const r = parseReplayRoute(route.params);
      expect(r).toEqual({ key, timetable });
      expect(replayHash(r)).toBe(hash);
    }
    // an explicit default date reads as the default storm
    expect(parseReplayRoute(['2024-09-23', 'timetable'])).toEqual({ key: '2024-09-23', timetable: true });
  });
});

describe('a cheap mount (round 3: the replay mounts under the dark hours on a phone)', () => {
  it("reuses the schedule story mode has already built from its own copy of the same storm's file", async () => {
    const pack = await disk.replay('2024-09-23');
    const a = buildSchedule('2024-09-23', pack, buildTimeline(pack));
    // story mode and the scene each load the file: a second copy of the same storm gets the same schedule
    const copy = structuredClone(pack);
    const b = buildSchedule('2024-09-23', copy, buildTimeline(copy));
    expect(b).toBe(a);
    // a file that differs is built afresh
    const other = structuredClone(pack);
    other.samples = other.samples.slice(1);
    const c = buildSchedule('2024-09-23', other, buildTimeline(other));
    expect(c).not.toBe(a);
    expect(c.samples.length).toBe(a.samples.length - (Date.parse(pack.samples[0]!.time_utc) >= a.windowStartMs ? 1 : 0));
    // and the other storm has its own
    const p23 = await disk.replay('2023-07-10');
    expect(buildSchedule('2023-07-10', p23, buildTimeline(p23))).not.toBe(a);
  });

  it('builds the network in slices to the same graph, and names each river line by its vertices', async () => {
    const pack = await disk.replay('2024-09-23');
    const a = buildNetwork(pack);
    let pauses = 0;
    const b = await buildNetworkSliced(pack, async () => void pauses++);
    expect(pauses).toBeGreaterThanOrEqual(2);
    expect(b.nodes).toEqual(a.nodes);
    expect([...b.paths.values()].map((p) => p.lengthM)).toEqual([...a.paths.values()].map((p) => p.lengthM));
    expect(a.lines).toHaveLength(pack.river.length);
    pack.river.forEach((line, k) =>
      line.coordinates.forEach((c, i) => {
        const n = a.nodes[a.lines[k]![i]!]!;
        expect([n.lon, n.lat]).toEqual([c[0], c[1]]);
      }),
    );
  });

  it('decodes the terrain in slices to exactly the same heights', async () => {
    const bin = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/scenes/replay/assets/terrain.bin'));
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    const a = decodeDem(buf);
    let pauses = 0;
    const b = await decodeDemSliced(buf, async () => void pauses++);
    expect(pauses).toBeGreaterThanOrEqual(2);
    expect(b.nx).toBe(a.nx);
    expect(Buffer.from(b.h.buffer).equals(Buffer.from(a.h.buffer))).toBe(true);
  });
});
