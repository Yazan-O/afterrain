// The quest's ask (src/model/quest.ts) and the names on screen (src/model/names.ts): the sentence follows the
// tagline (the site, the storm window, after the rain), says a tie as a tie, dates a stale forecast, and every
// quest the pipeline wrote reads as a full sentence within the strip's word budget.
import { describe, expect, it } from 'vitest';
import { CITY_IDS } from '../../src/data/schemas';
import { siteDisplayName, streamDisplayName } from '../../src/model/names';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { questText, resultTiming, windowText, windowTextAfterDate, type QuestAsk, type QuestFields } from '../../src/model/quest';
import { DATA_OUT } from './disk';
import { disk, readOut } from './disk';

const ask = (over: Omit<Partial<QuestAsk>, 'fields'> & { fields?: Partial<QuestFields> } = {}): QuestAsk => ({
  site: 'Vale das Flores',
  rank: 0,
  firstCode: 'C1',
  zone: 'Europe/Lisbon',
  dated: false,
  forecastMs: Date.parse('2026-09-26T01:30:53Z'),
  ...over,
  fields: { when_local: 'Wednesday afternoon', after_rain: true, tied_with: [], window_rain_mm_p50: 1.4, ...over.fields },
});

describe('the quest sentence', () => {
  it('names the site and the storm window, after the rain, and what one sample does', () => {
    expect(questText(ask())).toBe('Sample Vale das Flores on Wednesday afternoon, after the rain. Its sample brings the largest expected fog reduction.');
    // the whole sampling day is said as the day
    expect(questText(ask({ fields: { when_local: 'Wednesday daytime' } }))).toBe('Sample Vale das Flores on Wednesday, after the rain. Its sample brings the largest expected fog reduction.');
    expect(questText(ask({ fields: { when_local: 'Friday morning to afternoon', after_rain: false } }))).toBe('Sample Vale das Flores on Friday morning to afternoon. Its sample brings the largest expected fog reduction.');
  });

  it('says a tie as a tie, and a quest tied with the first shares its claim', () => {
    expect(questText(ask({ fields: { tied_with: ['C4', 'C19'] } }))).toBe('Sample Vale das Flores on Wednesday afternoon, after the rain. One of the samples with the largest expected fog reduction.');
    expect(questText(ask({ rank: 1, firstCode: 'C17', fields: { tied_with: ['C17', 'C19'] } }))).toMatch(/One of the samples with the largest expected fog reduction\.$/);
    expect(questText(ask({ rank: 2, firstCode: 'C17', fields: { tied_with: [] } }))).toMatch(/\. A sample here is expected to reduce the fog\.$/);
  });

  it('dates a forecast that no longer reaches the clock', () => {
    expect(questText(ask({ dated: true }))).toBe('Forecast of 26 Sep: Sample Vale das Flores on Wednesday afternoon, after the rain. Its sample brings the largest expected fog reduction.');
  });

  it('refuses a window that is not a weekday and part of day (no silent fallback)', () => {
    expect(() => questText(ask({ fields: { when_local: '2026-09-30T13:00+0100' } }))).toThrow(/weekday and part of day/);
  });

  it("every city's quest asks on the strip in its own words, never a code, within the strip's word budget", async () => {
    for (const id of CITY_IDS) {
      const now = await disk.nowcast(id);
      const pack = readOut(`../../web/public/data/streams/${id}.json`) as { streams: { name: string; stations: { code: string; name: string }[] }[] };
      for (const q of now.quests) {
        const st = pack.streams.find((s) => s.stations.some((x) => x.code === q.code));
        const stream = st ? streamDisplayName(st.name, st.stations.map((x) => x.name)) : undefined;
        const site = siteDisplayName(q.name, stream);
        for (const dated of [false, true]) {
          // the line (src/city/scene.ts tapQuest), the sampling window and the control under it
          const line = `${dated ? 'Forecast of 2 Oct: ' : ''}Sample ${site}${q.after_rain ? ' after rain' : ''}`;
          const text = `${line} ${windowText(Date.parse(q.window_start_utc), Date.parse(q.window_end_utc), now.timezone)} Try a test reading`;
          expect(text).not.toMatch(/\([A-Z][a-z]?\d+\)/); // no raw codes such as "(Zw3)"
          expect(text).not.toMatch(/safe/i);
          // with the way back's arrow and the selected hour's day and time (three words), within the strip's 25
          expect(text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length + 3, text).toBeLessThanOrEqual(25);
        }
      }
    }
  }, 60_000); // reads every city's nowcast and pack from disk: slow on a busy machine
});

describe('names on screen', () => {
  it('drops a code in brackets and names a place-and-number site by its place on its stream', () => {
    expect(siteDisplayName('Zwalm3 (Zw3)', 'Zwalmbeek')).toBe('Zwalmbeek in Zwalm');
    expect(siteDisplayName('Gent4 (G4)', 'Lieve')).toBe('Lieve in Gent');
    expect(siteDisplayName('Serretelle 4', 'Torrente Serretelle')).toBe('Torrente Serretelle');
    expect(siteDisplayName('Conraria', 'Rio Ceira')).toBe('Conraria');
    expect(siteDisplayName('Fossé Mère (ou Ruisseau Le Négogousses)', 'Le Négogousses')).toBe('Fossé Mère (ou Ruisseau Le Négogousses)');
    expect(siteDisplayName('Makrellbekken – ring3', 'Makrellbekken')).toBe('Makrellbekken – ring3');
  });

  it('shortens a hyphen-joined stream title to the part its sites name, else the first', () => {
    expect(streamDisplayName('Ribeira de Bruscos - Ribeira de Condeixa', ['Condeixa'])).toBe('Ribeira de Condeixa');
    expect(streamDisplayName('Ribeira de Bruscos - Ribeira de Condeixa', ['Elsewhere'])).toBe('Ribeira de Bruscos');
    expect(streamDisplayName('Rio Ceira', ['Conraria'])).toBe('Rio Ceira');
  });

  it('no stream or site on screen in the five cities shows a raw code or a joined title', () => {
    for (const id of CITY_IDS) {
      const pack = readOut(`../../web/public/data/streams/${id}.json`) as { streams: { name: string; stations: { name: string }[] }[] };
      for (const s of pack.streams) {
        const stream = streamDisplayName(s.name, s.stations.map((x) => x.name));
        expect(stream, s.name).not.toMatch(/\s[-–—]\s/);
        for (const st of s.stations) expect(siteDisplayName(st.name, stream), st.name).not.toMatch(/\([A-Za-z]{1,3}\d+\)$/);
      }
    }
  });
});

// when a sample's result is ready, from the hour actually collected and the configured turnaround.
describe('the result after a sample', () => {
  const H = 3.6e6;
  const t0 = Date.parse('2026-10-02T14:00Z');

  it("is the collection hour plus the turnaround: the hour the strip offers, not the quest's best hour", () => {
    // round 3: the clock at 15:00Z, the best hour 14:00Z already gone, the strip offers 15:00Z; result_ready_utc
    // (best + 24 h) put the mark at 14:00Z the next day, one hour early
    const offered = t0 + H;
    const r = resultTiming(offered, 24, t0 + 151 * H);
    expect(r.readyMs - offered).toBe(24 * H);
    expect(new Date(r.readyMs).toISOString()).toBe('2026-10-03T15:00:00.000Z');
    expect(r.inForecast).toBe(true);
  });

  it("a test at the forecast's last hour has its result after the forecast, never at its end", () => {
    const last = t0 + 151 * H;
    expect(resultTiming(last, 24, last).inForecast).toBe(false);
    expect(resultTiming(last - 24 * H, 24, last).inForecast).toBe(true);
    expect(resultTiming(last - 23 * H, 24, last).inForecast).toBe(false);
  });

  it("every quest the web serves carries the pipeline's LAB_TURNAROUND_H, and its result_ready_utc is its best hour plus it", () => {
    const cfg = readFileSync(resolve(DATA_OUT, '..', '..', 'pipeline', 'config.py'), 'utf-8');
    const m = /^LAB_TURNAROUND_H\s*=\s*(\d+(?:\.\d+)?)/m.exec(cfg);
    expect(m, 'pipeline/config.py names LAB_TURNAROUND_H').not.toBeNull();
    const turn = Number(m![1]);
    let n = 0;
    for (const id of CITY_IDS) {
      const now = JSON.parse(readFileSync(resolve(DATA_OUT, '..', '..', 'web', 'public', 'data', `nowcast_${id}.json`), 'utf-8')) as { quests: { lab_turnaround_h: number; best_hour_utc: string; result_ready_utc: string }[] };
      for (const q of now.quests) {
        expect(q.lab_turnaround_h, id).toBe(turn);
        expect(Date.parse(q.result_ready_utc) - Date.parse(q.best_hour_utc)).toBe(turn * H);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('a window on a screen that shows its date', () => {
  const zone = 'Europe/Lisbon';
  it('says the times and the zone alone on the date shown, the weekday within six days after it, else in full', () => {
    const a = Date.parse('2026-10-02T14:00Z'),
      b = Date.parse('2026-10-02T19:00Z');
    expect(windowTextAfterDate(a, b, zone, Date.parse('2026-10-02T14:09Z'))).toBe('15:00–20:00 UTC+1');
    expect(windowTextAfterDate(a, b, zone, Date.parse('2026-10-01T14:09Z'))).toBe('Fri 15:00–20:00 UTC+1');
    expect(windowTextAfterDate(a, b, zone, Date.parse('2026-09-26T14:09Z'))).toBe('Fri 15:00–20:00 UTC+1');
    expect(windowTextAfterDate(a, b, zone, Date.parse('2026-09-25T14:09Z'))).toBe(windowText(a, b, zone));
    expect(windowTextAfterDate(a, b, zone, Date.parse('2026-10-03T14:09Z'))).toBe(windowText(a, b, zone));
    // the 3 Oct 22:31 UTC forecast's Sunday window, on a screen dated 3 Oct (Lisbon)
    expect(windowTextAfterDate(Date.parse('2026-10-04T07:00Z'), Date.parse('2026-10-04T19:00Z'), zone, Date.parse('2026-10-03T22:31Z'))).toBe('Sun 08:00–20:00 UTC+1');
  });
});
