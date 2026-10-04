import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/engine/replay';
import {
  avonAssumptions,
  buildTransport,
  dieOffPerHour,
  distanceAt,
  gaugeMedianFlow,
  pulsesAt,
  timeAtDistance,
  velocityAt,
  velocityMps,
  type TransportReplay,
} from '../../src/engine/transport';
import { parseUtc as t } from '../../src/engine/timefmt';
import { disk, readOut } from './disk';
import { decode } from '../../src/data/decode';
import { replayFile } from '../../src/data/schemas';

const FRESHFORD = 'FRESHFORD STORM TANK';
const MIN = 60_000;

const medianFlow = async (): Promise<number> => gaugeMedianFlow(await disk.model('warleigh'), await disk.model('portable'));
const sep2024 = async (): Promise<TransportReplay> => buildTransport(buildTimeline(await disk.replay('2024-09-23')), avonAssumptions(await medianFlow()));

describe('assumptions', () => {
  it('recovers the gauge median flow two independent ways from the model files', async () => {
    const [w, p] = [await disk.model('warleigh'), await disk.model('portable')];
    const viaFills = w.features.find((f) => f.input === 'flow_prev_day')!.fill_if_missing / p.features.find((f) => f.input === 'flow_ratio')!.fill_if_missing;
    const q = gaugeMedianFlow(w, p);
    expect(Math.abs(q - viaFills) / q).toBeLessThan(1e-12);
    expect(q).toBeCloseTo(6.803, 3);
  });

  it('sets v = 0.5 m/s at the median flow and scales it by (Q / median)^0.34', async () => {
    const a = avonAssumptions(await medianFlow());
    expect(velocityMps(a, a.referenceFlowM3s)).toBeCloseTo(0.5, 12);
    expect(velocityMps(a, 2 * a.referenceFlowM3s)).toBeCloseTo(0.5 * 2 ** 0.34, 12);
    expect(() => velocityMps(a, 0)).toThrow(/positive/);
  });

  it('uses the Mancini dark freshwater rate, 0.8 per day at 20 C, times 1.07^(T - 20)', async () => {
    const a = avonAssumptions(await medianFlow());
    expect(dieOffPerHour(a)).toBeCloseTo(0.8 / 24, 15);
    expect(dieOffPerHour({ ...a, waterTempC: 25 })).toBeCloseTo((0.8 * 1.07 ** 5) / 24, 15);
  });
});

describe('distance clock', () => {
  it('integrates the day-by-day velocity, and timeAtDistance inverts it', async () => {
    const tr = await sep2024();
    const day = tr.clock.knots.find((k) => k.tMs === t('2024-09-23T09:00:00Z'))!;
    expect(distanceAt(tr.clock, t('2024-09-24T09:00:00Z')) - distanceAt(tr.clock, day.tMs)).toBeCloseTo(day.mps * 86_400, 6);
    for (const iso of ['2024-09-19T09:00:00Z', '2024-09-22T17:43:00Z', '2024-09-27T22:59:00Z']) {
      expect(timeAtDistance(tr.clock, distanceAt(tr.clock, t(iso)))).toBeCloseTo(t(iso), 3);
    }
  });

  it('starts where both the window and the flow record exist, and refuses times outside', async () => {
    const tr = await sep2024();
    expect(tr.startMs).toBe(t('2024-09-19T09:00:00Z'));
    expect(tr.endMs).toBe(t('2024-09-27T23:00:00Z'));
    expect(() => pulsesAt(tr, t('2024-09-19T08:59:00Z'))).toThrow(RangeError);
    expect(() => pulsesAt(tr, t('2024-09-28T00:00:00Z'))).toThrow(RangeError);
  });

  it('stops with the date when a day of flow is missing', async () => {
    const raw = structuredClone(readOut('replay_2024-09-23.json')) as { flow_daily: { m3_per_s: number | null; quality: string }[] };
    raw.flow_daily[4]!.m3_per_s = null;
    raw.flow_daily[4]!.quality = 'missing';
    const tl = buildTimeline(decode('replay', replayFile, raw));
    const a = avonAssumptions(await medianFlow());
    expect(() => buildTransport(tl, a)).toThrow(/no flow on 2024-09-23 \(missing\)/);
  });

  it('keeps an overflow without a routed distance on the timeline but gives it no pulse', async () => {
    const raw = structuredClone(readOut('replay_2023-07-10.json')) as { overflows: { overflow: string; distance_to_weir_m: number | null }[] };
    raw.overflows[0]!.distance_to_weir_m = null;
    const tl = buildTimeline(decode('replay', replayFile, raw));
    const tr = buildTransport(tl, avonAssumptions(await medianFlow()));
    expect(tr.unrouted).toEqual([raw.overflows[0]!.overflow]);
    expect(tr.tracks).toHaveLength(10);
  });
});

describe('the Freshford pulse on 23-24 September 2024', () => {
  it('moves its head at the day velocity and fades by die-off', async () => {
    const tr = await sep2024();
    const start = t('2024-09-23T09:28:00Z');
    const now = start + 30 * MIN;
    const v = velocityAt(tr, now);
    const p = pulsesAt(tr, now).find((x) => x.overflow === FRESHFORD)!;
    expect(p.spilling).toBe(true);
    expect(p.headKmFromOverflow).toBeCloseTo((v * 1800) / 1000, 9);
    expect(p.headKmToWeir).toBeCloseTo(4.555 - (v * 1800) / 1000, 9);
    expect(p.tailKmFromOverflow).toBe(0);
    expect(p.headSurvival).toBeCloseTo(Math.exp(-tr.dieOffPerHour * 0.5), 12);
    expect(p.tailSurvival).toBe(1);
    expect(p.weirSurvival).toBeNull();
  });

  it('reaches the weir exactly 4,555 m of travel after the spill starts', async () => {
    const tr = await sep2024();
    const start = t('2024-09-23T09:28:00Z');
    const arrive = start + (4555 / velocityAt(tr, start)) * 1000;
    const at = (ms: number) => pulsesAt(tr, ms).find((x) => x.overflow === FRESHFORD && x.spillStartMs === start)!;
    expect(at(arrive - 1000).weirSurvival).toBeNull();
    expect(at(arrive + 1000).weirSurvival).toBeCloseTo(Math.exp((-tr.dieOffPerHour * (arrive + 1000 - start)) / 3_600_000), 3);
    expect(at(arrive + 1000).headKmToWeir).toBe(0);
  });

  it('leaves the river once its tail has passed the weir', async () => {
    const tr = await sep2024();
    const stop = t('2024-09-24T15:39:00Z');
    const gone = stop + (4555 / velocityAt(tr, stop)) * 1000;
    const fromThisSpill = (ms: number) => pulsesAt(tr, ms).filter((x) => x.overflow === FRESHFORD && x.spillStartMs === t('2024-09-23T09:28:00Z'));
    expect(fromThisSpill(gone - 1000)).toHaveLength(1);
    expect(fromThisSpill(gone - 1000)[0]!.spilling).toBe(false);
    expect(fromThisSpill(gone + 1000)).toHaveLength(0);
  });

  it('keeps every position on the overflow-to-weir path', async () => {
    const tr = await sep2024();
    for (let ms = tr.startMs; ms <= tr.endMs; ms += 37 * MIN) {
      for (const p of pulsesAt(tr, ms)) {
        expect(p.tailKmFromOverflow).toBeGreaterThanOrEqual(0);
        expect(p.tailKmFromOverflow).toBeLessThanOrEqual(p.headKmFromOverflow + 1e-9);
        expect(p.headKmFromOverflow).toBeLessThanOrEqual(p.riverKm + 1e-9);
        expect(p.headKmFromOverflow + p.headKmToWeir).toBeCloseTo(p.riverKm, 9);
        expect(p.headSurvival).toBeLessThanOrEqual(p.tailSurvival + 1e-12);
      }
    }
  });
});
