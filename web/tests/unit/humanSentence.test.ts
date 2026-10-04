// The person's sentence (src/model/humanSentence.ts): exact wording on small synthetic rows, and on every real
// nowcast row of every city (the served forecast) the episode it names is the one the row holds: every hour before
// it at or under the "higher" threshold, every hour in it over, the hour it ends back at or under.
import { describe, expect, it } from 'vitest';
import { CITY_IDS } from '../../src/data/schemas';
import { localParts } from '../../src/engine/timefmt';
import { humanSentence, type HumanInput } from '../../src/model/humanSentence';
import { disk } from './disk';

const H = 3.6e6;
const T0 = Date.parse('2026-10-04T07:00:00Z'); // Sunday 08:00 in Lisbon (UTC+1)
const row = (p: number[], rain: number[] = p.map(() => 0)): HumanInput => ({
  place: 'Eiras',
  zone: 'Europe/Lisbon',
  nowMs: T0,
  hoursMs: p.map((_, i) => T0 + i * H),
  p,
  rainMm: rain,
  thresholds: { higher: 0.3, high: 0.5 },
  unmeasuredAfterRain: false,
});

describe('the sentence for a person', () => {
  it('a calm forecast: usual chance today, no action time', () => {
    expect(humanSentence(row([0.1, 0.2, 0.25])).text).toBe('Eiras, Sunday. Usual chance today.');
  });
  it('raised now, after rain: the day, the word, and the first hour back under the threshold', () => {
    const s = humanSentence(row([0.4, 0.45, 0.2, 0.1], [3, 3, 3, 3]));
    expect(s.text).toBe('Eiras, Sunday: higher chance after rain. Keep dogs out until Sunday 10:00.');
    expect(s.lead.find((q) => q.ms !== undefined)!.ms).toBe(T0 + 2 * H);
  });
  it('raised later, over the high threshold, without rain: from when, and the highest word it reaches', () => {
    expect(humanSentence(row([0.1, 0.35, 0.6, 0.4, 0.29])).text).toBe('Eiras, from Sunday 09:00: high chance even without rain. Keep dogs out until Sunday 12:00.');
  });
  it('never back under within the forecast: until the forecast ends, with its date', () => {
    expect(humanSentence(row([0.4, 0.4], [2, 2])).text).toBe('Eiras, Sunday: higher chance after rain. Keep dogs out until the forecast ends 4 Oct.');
  });
  it('a place nobody sampled after rain says so; "safe" never appears', () => {
    const s = humanSentence({ ...row([0.4, 0.1], [2, 2]), unmeasuredAfterRain: true });
    expect(s.fog).toBe('Nobody has measured here after rain.');
    expect(s.text.endsWith(' Nobody has measured here after rain.')).toBe(true);
    expect(s.text).not.toMatch(/\bsafe\b/i);
  });
  it('the clock past the first hours: the episode is searched from the clock on', () => {
    const s = humanSentence({ ...row([0.6, 0.1, 0.1, 0.4, 0.1], [2, 2, 2, 2, 2]), nowMs: T0 + 1.5 * H });
    expect(s.from).toBe(3);
    expect(s.until).toBe(4);
  });

  for (const id of CITY_IDS)
    it(`${id}: on every real nowcast row the named episode is the row's own, at three clocks`, async () => {
      const now = await disk.nowcast(id);
      const hoursMs = now.hours_utc.map((t) => Date.parse(t));
      const th = { higher: now.thresholds!.higher, high: now.thresholds!.high };
      for (const site of now.sites)
        for (const h0 of [1, 24, 72]) {
          const s = humanSentence({ place: site.name, zone: now.timezone, nowMs: hoursMs[h0]!, hoursMs, p: site.p50, rainMm: site.r48_p50_mm, thresholds: th, unmeasuredAfterRain: site.oah_sampled_after_rain !== true });
          expect(s.text).not.toMatch(/\bsafe\b/i);
          expect(s.fog === null).toBe(site.oah_sampled_after_rain === true);
          if (s.from === null) {
            expect(s.risk).toBe('usual');
            for (let h = h0; h < hoursMs.length; h++) expect(site.p50[h]!).toBeLessThanOrEqual(th.higher);
            continue;
          }
          for (let h = h0; h < s.from; h++) expect(site.p50[h]!).toBeLessThanOrEqual(th.higher);
          const end = s.until ?? hoursMs.length;
          for (let h = s.from; h < end; h++) expect(site.p50[h]!).toBeGreaterThan(th.higher);
          if (s.until !== null) {
            expect(site.p50[s.until]!).toBeLessThanOrEqual(th.higher);
            const p = localParts(hoursMs[s.until]!, now.timezone);
            expect(s.text).toContain(`${String(p.hour).padStart(2, '0')}:00.`);
          } else expect(s.text).toContain('until the forecast ends');
          const peak = Math.max(...Array.from({ length: end - s.from }, (_, i) => site.p50[s.from! + i]!));
          expect(s.risk).toBe(peak > th.high ? 'high' : 'higher');
          expect(s.text).toContain(site.r48_p50_mm[s.from]! >= 1 ? 'after rain' : 'even without rain');
        }
    });
});
