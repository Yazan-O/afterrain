// Every AfterRain code a browser-made record uses is defined, with
// the same display, in the AfterRain code system the guide publishes (fhir/sayr-ig/input/fsh/terminology.fsh); the forecast
// record claims the OneAquaHealth health-measure profile (the test record cannot: the profile fixes status to final);
// every dateTime has seconds. Checks reject a live record using a term the code system lacks.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forecastRecord, OAH_HEALTH_MEASURE, SAYR_CS, testRecord } from '../../src/fhir/liveRecords';
import type { Json } from '../../src/fhir/xrayMap';

const FSH = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fhir', 'sayr-ig', 'input', 'fsh', 'terminology.fsh'), 'utf-8');
const defined = new Map<string, string>();
let inCs = false;
for (const line of FSH.split(/\r?\n/)) {
  if (/^CodeSystem:\s*AfterRainCs\b/.test(line)) inCs = true;
  else if (/^(CodeSystem|ValueSet|Profile|Instance|Extension):/.test(line)) inCs = false;
  const m = inCs ? /^\* #([\w-]+) "([^"]*)"/.exec(line) : null;
  if (m) defined.set(m[1]!, m[2]!);
}

function codings(j: Json, out: { code: string; display?: string }[] = []): { code: string; display?: string }[] {
  if (Array.isArray(j)) for (const x of j) codings(x, out);
  else if (j && typeof j === 'object') {
    const o = j as Record<string, Json>;
    if (o['system'] === SAYR_CS && typeof o['code'] === 'string') out.push({ code: o['code'], ...(typeof o['display'] === 'string' ? { display: o['display'] } : {}) });
    for (const v of Object.values(o)) codings(v, out);
  }
  return out;
}

describe('live FHIR records use only defined AfterRain terms', () => {
  const recs = [
    forecastRecord({ city: 'CO', code: 'C4', site: 'Eiras', siteIndex: 3, hour: 64, hourUtc: '2026-10-06T14:00Z', p50: 0.46, fog: 0.95, forecastFetchedUtc: '2026-10-03T22:31:18Z', modelVersion: 'm', published: null }),
    ...[false, true].map((over900) => testRecord({ code: 'C4', site: 'Eiras', hour: 64, hourUtc: '2026-10-06T14:00Z', collectedUtc: '2026-10-06T14:00Z', over900, p50: 0.3, fog: 0.7, revision: 1, modelVersion: 'm', published: null })),
  ];
  it('finds the code system', () => expect(defined.size).toBeGreaterThanOrEqual(10));
  for (const r of recs)
    it(`${r.ref}: every code is defined, displays match, the profile claim fits, dateTimes are valid`, () => {
      const cs = codings(r.json);
      expect(cs.length).toBeGreaterThan(0);
      for (const c of cs) {
        expect(defined.has(c.code), `AfterRainCs#${c.code} is not defined`).toBe(true);
        if (c.display !== undefined) expect(c.display).toBe(defined.get(c.code));
      }
      const j = r.json as { status: string; meta: { profile?: string[] }; effectiveDateTime: string };
      expect(j.meta.profile ?? []).toEqual(j.status === 'final' ? [OAH_HEALTH_MEASURE] : []);
      for (const m of JSON.stringify(r.json).matchAll(/"(?:effectiveDateTime|valueDateTime)":"([^"]+)"/g)) expect(m[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/);
    });
});
