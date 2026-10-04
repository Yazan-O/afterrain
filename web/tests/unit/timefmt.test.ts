import { describe, expect, it } from 'vitest';
import {
  PLACE_ZONES,
  formatClock,
  formatDayMonth,
  formatDayTime,
  formatLocalIso,
  formatWeekdayClock,
  localParts,
  parseNaiveUtc,
  parseUtc as t,
  utcOffsetMinutes,
} from '../../src/engine/timefmt';
import { REPLAY_KEYS } from '../../src/data/schemas';
import { disk } from './disk';

// EU summer time starts and ends at 01:00 UTC on the last Sunday of March and October (Directive 2000/84/EC).
const SPRING_2024 = t('2024-03-31T01:00:00Z');
const AUTUMN_2024 = t('2024-10-27T01:00:00Z');
const AUTUMN_2026 = t('2026-10-25T01:00:00Z');
const SEC = 1000;

const WESTERN = ['Europe/London', 'Europe/Lisbon'] as const; // GMT/BST and WET/WEST: UTC+0, +1 in summer
const CENTRAL = ['Europe/Paris', 'Europe/Brussels', 'Europe/Oslo', 'Europe/Rome'] as const; // CET/CEST: UTC+1, +2

describe('place zones', () => {
  it('maps each place to its IANA zone', () => {
    expect(PLACE_ZONES).toEqual({
      CO: 'Europe/Lisbon',
      TO: 'Europe/Paris',
      GH: 'Europe/Brussels',
      OS: 'Europe/Oslo',
      BE: 'Europe/Rome',
      AVON: 'Europe/London',
    });
  });
});

describe.each(WESTERN)('%s daylight saving', (zone) => {
  it('springs forward from 00:59 to 02:00 at 01:00 UTC', () => {
    expect(formatClock(SPRING_2024 - SEC, zone)).toBe('00:59');
    expect(formatClock(SPRING_2024, zone)).toBe('02:00');
    expect([utcOffsetMinutes(SPRING_2024 - SEC, zone), utcOffsetMinutes(SPRING_2024, zone)]).toEqual([0, 60]);
  });
  it('falls back from 01:59 to 01:00 at 01:00 UTC, so 01:30 happens twice', () => {
    expect(formatClock(AUTUMN_2024 - SEC, zone)).toBe('01:59');
    expect(formatClock(AUTUMN_2024, zone)).toBe('01:00');
    expect(formatClock(AUTUMN_2024 - 30 * 60 * SEC, zone)).toBe(formatClock(AUTUMN_2024 + 30 * 60 * SEC, zone));
    expect([utcOffsetMinutes(AUTUMN_2024 - SEC, zone), utcOffsetMinutes(AUTUMN_2024, zone)]).toEqual([60, 0]);
  });
  it('changes on 25 October 2026, inside the hackathon season', () => {
    expect([utcOffsetMinutes(AUTUMN_2026 - SEC, zone), utcOffsetMinutes(AUTUMN_2026, zone)]).toEqual([60, 0]);
  });
});

describe.each(CENTRAL)('%s daylight saving', (zone) => {
  it('springs forward from 01:59 to 03:00 at 01:00 UTC', () => {
    expect(formatClock(SPRING_2024 - SEC, zone)).toBe('01:59');
    expect(formatClock(SPRING_2024, zone)).toBe('03:00');
    expect([utcOffsetMinutes(SPRING_2024 - SEC, zone), utcOffsetMinutes(SPRING_2024, zone)]).toEqual([60, 120]);
  });
  it('falls back from 02:59 to 02:00 at 01:00 UTC', () => {
    expect(formatClock(AUTUMN_2024 - SEC, zone)).toBe('02:59');
    expect(formatClock(AUTUMN_2024, zone)).toBe('02:00');
    expect([utcOffsetMinutes(AUTUMN_2024 - SEC, zone), utcOffsetMinutes(AUTUMN_2024, zone)]).toEqual([120, 60]);
  });
  it('changes on 25 October 2026, inside the hackathon season', () => {
    expect([utcOffsetMinutes(AUTUMN_2026 - SEC, zone), utcOffsetMinutes(AUTUMN_2026, zone)]).toEqual([120, 60]);
  });
});

describe('display strings', () => {
  const s = t('2024-09-24T08:10:00Z');
  it('shows the 31,000 sample at 09:10 on Tuesday 24 September in Bath', () => {
    expect(formatClock(s, PLACE_ZONES.AVON)).toBe('09:10');
    expect(formatDayMonth(s, PLACE_ZONES.AVON)).toBe('24 Sep');
    expect(formatDayTime(s, PLACE_ZONES.AVON)).toBe('Tue 24 Sep 09:10');
    expect(formatWeekdayClock(s, PLACE_ZONES.AVON)).toBe('Tuesday 09:10');
  });
  it('shows the same instant in each city clock', () => {
    expect([PLACE_ZONES.CO, PLACE_ZONES.TO, PLACE_ZONES.GH, PLACE_ZONES.OS, PLACE_ZONES.BE].map((z) => formatClock(s, z))).toEqual([
      '09:10',
      '10:10',
      '10:10',
      '10:10',
      '10:10',
    ]);
  });
  it('crosses midnight into the next local day', () => {
    const late = t('2026-09-30T22:30:00Z');
    expect(localParts(late, PLACE_ZONES.CO)).toMatchObject({ day: 30, hour: 23, weekday: 3 });
    expect(localParts(late, PLACE_ZONES.TO)).toMatchObject({ month: 10, day: 1, hour: 0, weekday: 4 });
  });
});

describe('agreement with the pipeline on real data', () => {
  it.each(REPLAY_KEYS)('replay %s: every time_local equals time_utc shown in Europe/London', async (key) => {
    const r = await disk.replay(key);
    for (const s of r.samples) expect(formatLocalIso(t(s.time_utc), PLACE_ZONES.AVON)).toBe(s.time_local);
  });

  it('warleigh_backtest.json: all 322 samples, across five years of clock changes', async () => {
    const b = await disk.backtest();
    expect(b.samples).toHaveLength(322);
    for (const s of b.samples) expect(formatLocalIso(t(s.time_utc), PLACE_ZONES.AVON)).toBe(s.time_local);
  });

  it('reads the forecast hours as UTC, as the file declares', async () => {
    const f = await disk.forecast('CO');
    expect(f.timezone).toBe('UTC');
    const first = parseNaiveUtc(f.hourly_times_utc[0]!);
    expect(first).toBe(t(`${f.hourly_times_utc[0]!}:00Z`));
    expect(parseNaiveUtc(f.hourly_times_utc[1]!) - first).toBe(3_600_000);
  });
});

describe('parsing', () => {
  it('refuses a time that does not say it is UTC', () => {
    expect(() => t('2024-09-24T09:10:00')).toThrow(/not a UTC instant/);
    expect(() => t('2024-09-24T09:10:00+01:00')).toThrow(/not a UTC instant/);
    expect(t('2024-09-24T08:10:00+00:00')).toBe(t('2024-09-24T08:10:00Z'));
  });
});
