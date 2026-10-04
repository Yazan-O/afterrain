// The test reading's pure parts: the opening's place and hour, the quest's window, the line
// after a test, and the records the x-ray shows for the line at a place and hour. The records' values are checked
// against the browser's own state (CityState) and against nowcast_CO.json, so the card says what the strip shows.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePointer } from '../e2e/harness/checks';
import { decode } from '../../src/data/decode';
import { streamPackFile } from '../../src/data/schemas';
import { fhirInstant, forecastRecord, isLiveKey, testRecord } from '../../src/fhir/liveRecords';
import { keyLines } from '../../src/fhir/xrayMap';
import { CityState } from '../../src/model/cityState';
import { openingHour, nextQuest, windowOpen, windowText } from '../../src/model/quest';
import { testResultLine, WET_MM } from '../../src/model/sentence';
import { disk, readOut } from './disk';

const here = dirname(fileURLToPath(import.meta.url));
const pack = () => decode('streams/CO.json', streamPackFile('CO'), JSON.parse(readFileSync(resolve(here, '..', '..', 'public', 'data', 'streams', 'CO.json'), 'utf-8')));

describe('the opening hour', () => {
  const base = { questHour: 30, from: 0, to: 100, wetMm: WET_MM, p50: (h: number) => (h === 60 ? 0.7 : h === 70 ? 0.7 : 0.2) };
  it("is the quest's own hour when the pipeline says it follows rain", () => {
    expect(openingHour({ ...base, questAfterRain: true, rainMm: () => 0 })).toEqual({ hour: 30, afterRain: true, rule: 'quest' });
  });
  it('else the after-rain hour with the highest estimate (the earliest of a tie)', () => {
    expect(openingHour({ ...base, questAfterRain: false, rainMm: (h) => (h >= 50 && h <= 80 ? 3 : 0) })).toEqual({ hour: 60, afterRain: true, rule: 'after-rain' });
  });
  it('else the quest hour, and the opening does not say "after rain"', () => {
    expect(openingHour({ ...base, questAfterRain: false, rainMm: () => 0.4 })).toEqual({ hour: 30, afterRain: false, rule: 'no-rain' });
  });
});

describe("the quest's window", () => {
  it("names the local day, date and hours with the place's zone, and the end day when it differs", () => {
    expect(windowText(Date.parse('2026-09-28T07:00Z'), Date.parse('2026-09-28T19:00Z'), 'Europe/Lisbon')).toBe('Mon 28 Sep 08:00–20:00 UTC+1');
    expect(windowText(Date.parse('2026-09-28T19:00Z'), Date.parse('2026-09-29T07:00Z'), 'Europe/Lisbon')).toBe('Mon 28 Sep 20:00–Tue 29 Sep 08:00 UTC+1');
    // a winter window says winter time
    expect(windowText(Date.parse('2026-11-02T08:00Z'), Date.parse('2026-11-02T17:00Z'), 'Europe/Lisbon')).toBe('Mon 2 Nov 08:00–17:00 UTC');
  });

  // the expiry logic at its boundary, the recommendation the map's lamp and the story's last
  // screen show
  const end = Date.parse('2026-10-02T19:00Z');
  const q = (code: string, endMs: number) => ({ code, endMs });
  it('is eligible until its end: one millisecond before closing it is open, at closing it is gone', () => {
    expect(windowOpen(end - 60_000, end)).toBe(true);
    expect(windowOpen(end - 1, end)).toBe(true);
    expect(windowOpen(end, end)).toBe(false);
    expect(windowOpen(end + 1, end)).toBe(false);
  });
  it('the next eligible site: the first open, unsampled, shown quest in rank order', () => {
    const quests = [q('C13', end), q('C17', end + 24 * 3.6e6), q('C9', end + 48 * 3.6e6)];
    const all = (): boolean => true;
    expect(nextQuest(quests, end - 1, new Set(), all)?.code).toBe('C13');
    expect(nextQuest(quests, end, new Set(), all)?.code).toBe('C17');
    expect(nextQuest(quests, end - 1, new Set(['C13']), all)?.code).toBe('C17');
    expect(nextQuest(quests, end - 1, new Set(), (x) => x.code !== 'C13')?.code).toBe('C17');
    expect(nextQuest(quests, end + 48 * 3.6e6, new Set(), all)).toBeNull();
  });
});

describe('the line after a test', () => {
  it('falls, rises or holds by the estimate at the tested hour; the storm tail only while storm hours are unknown', () => {
    expect(testResultLine(0.6, 0.3, true)).toBe('My estimate falls here. Storm hours remain uncertain.');
    expect(testResultLine(0.3, 0.6, true)).toBe('My estimate rises here. Storm hours remain uncertain.');
    expect(testResultLine(0.3, 0.6, false)).toBe('My estimate rises here.');
    expect(testResultLine(0.3, 0.302, false)).toBe('My estimate holds here.');
    expect(testResultLine(0.3, 0.1, false)).not.toMatch(/\bsafe\b/i);
  });
});

describe('the records behind the line', () => {
  it('"Forecast at <site>": every number read from nowcast_CO.json at the hour, a distinct id, the published peak as its source', async () => {
    const now = await disk.nowcast('CO');
    const raw = readOut('nowcast_CO.json');
    const si = now.sites.findIndex((s) => s.code === 'C4');
    const h = 40;
    const r = forecastRecord({ city: 'CO', code: 'C4', site: 'Eiras', siteIndex: si, hour: h, hourUtc: now.hours_utc[h]!, p50: now.sites[si]!.p50[h]!, fog: now.sites[si]!.fog[h]!, forecastFetchedUtc: now.forecast_fetched_utc, modelVersion: now.model_version, published: 'Observation/oah-risk-dog-owners-C4' });
    expect(isLiveKey(r.key)).toBe(true);
    expect(r.heading).toBe('Forecast at Eiras');
    expect(r.ref).not.toBe('Observation/oah-risk-dog-owners-C4');
    for (const ptr of ['/valueQuantity/value', '/component/0/valueQuantity/value']) {
      const src = r.src(ptr);
      expect(src.startsWith('nowcast_CO.json#')).toBe(true);
      expect(resolvePointer(raw, src.slice(src.indexOf('#') + 1))).toBe(resolvePointer(r.json, ptr));
    }
    // the hour as a FHIR dateTime (with seconds); its value is the nowcast's hour
    expect(resolvePointer(r.json, '/effectiveDateTime')).toBe(fhirInstant(now.hours_utc[h]!));
    expect(resolvePointer(r.json, '/derivedFrom/0/reference')).toBe('Observation/oah-risk-dog-owners-C4');
  });

  it('"Test estimate at <site>": the recomputed estimate at the hour, the binary reading verbatim, marked as a test, bound to its revision', async () => {
    const [spec, now] = await Promise.all([disk.updateSpec(), disk.nowcast('CO')]);
    const cs = new CityState(spec, pack(), now);
    const h = 40;
    cs.applyTestSample('C4', h, { over_900: true });
    const ser = cs.series('C4');
    const r = testRecord({ code: 'C4', site: 'Eiras', hour: h, hourUtc: now.hours_utc[h]!, collectedUtc: now.hours_utc[h]!, over900: true, p50: ser.p50[h]!, fog: ser.fog[h]!, revision: cs.revision, modelVersion: now.model_version, published: null });
    expect(r.heading).toBe('Test estimate at Eiras');
    expect(r.ref).toMatch(/^Observation\/afterrain-test-C4-\d{8}T\d{4}Z-r1$/);
    expect(resolvePointer(r.json, '/status')).toBe('preliminary');
    expect(resolvePointer(r.json, '/meta/tag/0/code')).toBe('test-reading');
    expect(resolvePointer(r.json, '/valueQuantity/value')).toBeCloseTo(ser.p50[h]!, 4);
    expect(resolvePointer(r.json, '/component/0/valueQuantity/value')).toBeCloseTo(ser.fog[h]!, 4);
    expect(resolvePointer(r.json, '/component/1/valueBoolean')).toBe(true);
    // no bacterial count is invented
    expect(JSON.stringify(r.json)).not.toMatch(/"count"|valueInteger/);
    expect(r.src('/valueQuantity/value')).toBe(`live:${r.ref}#/valueQuantity/value`);
    // the card shows the tag, the status and the reading
    const keys = keyLines(r.json).map((l) => l.key);
    for (const k of ['meta.tag.code', 'status', 'valueQuantity.value', 'effectiveDateTime', 'subject.reference', 'component.valueBoolean']) expect(keys).toContain(k);
    // a reset restores the prior; a new test is a new revision and a new record id
    cs.undo('C4');
    cs.applyTestSample('C4', h, { over_900: false });
    const r2 = testRecord({ code: 'C4', site: 'Eiras', hour: h, hourUtc: now.hours_utc[h]!, collectedUtc: now.hours_utc[h]!, over900: false, p50: cs.series('C4').p50[h]!, fog: cs.series('C4').fog[h]!, revision: cs.revision, modelVersion: now.model_version, published: null });
    expect(r2.ref).not.toBe(r.ref);
    expect(r2.key).not.toBe(r.key);
  });

  it("a test record keeps the reading's collection time when the estimate is read at another hour", async () => {
    const [spec, now] = await Promise.all([disk.updateSpec(), disk.nowcast('CO')]);
    const cs = new CityState(spec, pack(), now);
    const at = 40;
    cs.applyTestSample('C4', at, { over_900: true });
    const ser = cs.series('C4');
    const rec = (h: number) =>
      testRecord({ code: 'C4', site: 'Eiras', hour: h, hourUtc: now.hours_utc[h]!, collectedUtc: now.hours_utc[at]!, over900: true, p50: ser.p50[h]!, fog: ser.fog[h]!, revision: cs.revision, modelVersion: now.model_version, published: null });
    const [a, b] = [rec(at), rec(at + 12)];
    const note = (r: ReturnType<typeof rec>): string => String(resolvePointer(r.json, '/note/0/text'));
    expect(note(a)).toContain(`assumed collected ${now.hours_utc[at]}`);
    expect(note(b)).toContain(`assumed collected ${now.hours_utc[at]}`);
    expect(note(b)).not.toContain(`assumed collected ${now.hours_utc[at + 12]}`);
    // the estimate's own hour is the record's effective time; the collection time is a separate field
    expect(resolvePointer(b.json, '/effectiveDateTime')).toBe(fhirInstant(now.hours_utc[at + 12]!));
    expect(resolvePointer(a.json, '/effectiveDateTime')).toBe(fhirInstant(now.hours_utc[at]!));
    expect(resolvePointer(b.json, '/component/2/valueDateTime')).toBe(fhirInstant(now.hours_utc[at]!));
  });
});
