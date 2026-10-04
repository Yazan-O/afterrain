import { describe, expect, it } from 'vitest';
import {
  activeInterval,
  buildTimeline,
  dailyAt,
  hoursBetween,
  mergeIntervals,
  overflowsSpillingInWindow,
  spillingAt,
  type ReplayTimeline,
} from '../../src/engine/replay';
import { avonAssumptions, buildTransport, gaugeMedianFlow, pulsesAt, weirIndex } from '../../src/engine/transport';
import { formatClock, parseUtc } from '../../src/engine/timefmt';
import { disk } from './disk';

const FRESHFORD = 'FRESHFORD STORM TANK';
const t = parseUtc;

const load = async (key: '2024-09-23' | '2023-07-10'): Promise<ReplayTimeline> => buildTimeline(await disk.replay(key));

describe('mergeIntervals', () => {
  it('joins records that touch or overlap and keeps a one-minute gap as two spills', () => {
    const m = 60_000;
    expect(
      mergeIntervals([
        { startMs: 10 * m, stopMs: 11 * m },
        { startMs: 0, stopMs: 5 * m },
        { startMs: 5 * m, stopMs: 6 * m },
        { startMs: 7 * m, stopMs: 9 * m },
        { startMs: 8 * m, stopMs: 10 * m },
      ]),
    ).toEqual([
      { startMs: 0, stopMs: 6 * m },
      { startMs: 7 * m, stopMs: 11 * m },
    ]);
  });

  it('rejects a record that ends before it starts', () => {
    expect(() => mergeIntervals([{ startMs: 5, stopMs: 1 }])).toThrow(/ends before it starts/);
  });
});

describe('replay 2024-09-23 timeline', () => {
  it('orders events in time, and each overflow alternates on, off, on, off', async () => {
    const tl = await load('2024-09-23');
    for (let i = 1; i < tl.events.length; i++) expect(tl.events[i]!.tMs).toBeGreaterThanOrEqual(tl.events[i - 1]!.tMs);
    for (const o of tl.overflows) {
      const own = tl.events.filter((e) => e.overflow === o.key);
      expect(own.map((e) => e.kind)).toEqual(own.map((_, i) => (i % 2 === 0 ? 'on' : 'off')));
      expect(own.length).toBe(2 * o.intervals.length);
    }
  });

  it('puts an overflow switching off before one switching on at the same instant', async () => {
    const tl = await load('2024-09-23');
    const byTime = new Map<number, string[]>();
    for (const e of tl.events) byTime.set(e.tMs, [...(byTime.get(e.tMs) ?? []), e.kind]);
    for (const kinds of byTime.values()) expect(kinds).toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === 'off' ? -1 : 1)));
  });

  it('has 24 overflows spilling in the window, matching numbers.json', async () => {
    const [tl, numbers] = [await load('2024-09-23'), await disk.numbers()];
    expect(overflowsSpillingInWindow(tl)).toHaveLength(24);
    expect(numbers['replay.2024-09-23.overflows_spilling']!.value).toBe(24);
  });

  it('has the Freshford storm tank spilling from 09:28 UTC on 23 Sep to 15:39 UTC on 24 Sep, 30.18 h', async () => {
    const tl = await load('2024-09-23');
    const fr = tl.overflows.find((o) => o.key === FRESHFORD)!;
    const iv = activeInterval(fr, t('2024-09-24T00:00:00Z'))!;
    expect(iv).toEqual({ startMs: t('2024-09-23T09:28:00Z'), stopMs: t('2024-09-24T15:39:00Z') });
    expect(hoursBetween(iv.startMs, iv.stopMs)).toBeCloseTo(30.18, 2);
    expect(activeInterval(fr, t('2024-09-23T09:27:59Z'))).toBeNull();
    expect(spillingAt(tl, t('2024-09-23T09:28:00Z'))).toContain(FRESHFORD);
    expect(spillingAt(tl, t('2024-09-24T15:39:00Z'))).not.toContain(FRESHFORD);
    expect(fr.distanceToWeirM).toBe(4555);
  });

  it('holds the 31,000 sample at 08:10 UTC on 24 Sep (09:10 in Bath), inside the Freshford spill, with the weir index raised', async () => {
    const [tl, numbers, w, p] = [await load('2024-09-23'), await disk.numbers(), await disk.model('warleigh'), await disk.model('portable')];
    const s = tl.samples.find((x) => x.ecoliPer100ml === 31000)!;
    expect(s.tMs).toBe(t('2024-09-24T08:10:00Z'));
    expect(formatClock(s.tMs, 'Europe/London')).toBe('09:10');
    expect(numbers['replay.2024-09-23.max_ecoli']!.value).toBe(31000);
    expect(s.tMs).toBeGreaterThanOrEqual(tl.windowStartMs);
    expect(s.tMs).toBeLessThan(tl.windowEndMs);

    const fr = tl.overflows.find((o) => o.key === FRESHFORD)!;
    const iv = activeInterval(fr, s.tMs)!;
    expect(iv.startMs).toBe(t('2024-09-23T09:28:00Z'));

    const tr = buildTransport(tl, avonAssumptions(gaugeMedianFlow(w, p)));
    const before = tl.samples.filter((x) => x.tMs < t('2024-09-21T00:00:00Z'));
    expect(before).toHaveLength(3);
    for (const b of before) expect(weirIndex(tr, b.tMs)).toBe(0);
    const index = weirIndex(tr, s.tMs);
    expect(index).toBeGreaterThan(5);
    const freshfordAtWeir = pulsesAt(tr, s.tMs).find((x) => x.overflow === FRESHFORD && x.weirSurvival !== null);
    expect(freshfordAtWeir?.spilling).toBe(true);
  });

  it('reads daily flow and rain on the Environment Agency 09:00-09:00 UTC day', async () => {
    const tl = await load('2024-09-23');
    expect(dailyAt(tl.flow, t('2024-09-24T08:59:00Z'))!.date).toBe('2024-09-23');
    expect(dailyAt(tl.flow, t('2024-09-24T09:00:00Z'))!.value).toBe(81.325);
    expect(dailyAt(tl.rain, t('2024-09-23T12:00:00Z'))!.value).toBe(30.4);
    expect(dailyAt(tl.flow, t('2024-09-19T08:59:00Z'))).toBeNull();
  });
});

describe('replay 2023-07-10 timeline', () => {
  it('has 11 overflows spilling in the window, matching numbers.json', async () => {
    const [tl, numbers] = [await load('2023-07-10'), await disk.numbers()];
    expect(overflowsSpillingInWindow(tl)).toHaveLength(11);
    expect(numbers['replay.2023-07-10.overflows_spilling']!.value).toBe(11);
  });

  it('has the 3,100 sample on the morning after the spills with pulses at the weir', async () => {
    const [tl, w, p] = [await load('2023-07-10'), await disk.model('warleigh'), await disk.model('portable')];
    const s = tl.samples[0]!;
    expect([s.ecoliPer100ml, s.tMs]).toEqual([3100, t('2023-07-11T08:00:00Z')]);
    const tr = buildTransport(tl, avonAssumptions(gaugeMedianFlow(w, p)));
    expect(weirIndex(tr, s.tMs)).toBeGreaterThan(1);
    expect(weirIndex(tr, t('2023-07-09T12:00:00Z'))).toBe(0);
  });
});
