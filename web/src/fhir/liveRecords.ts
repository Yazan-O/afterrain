// The records behind the stream's line at one place and hour, made in the browser from the state on screen, so the
// x-ray always shows what the strip shows:
//   forecast  "Forecast at <site>": the published forecast at the selected hour, every number read from
//             nowcast_<city>.json (the site has no test reading)
//   test      "Test estimate at <site>": the estimate the browser recomputed after a test reading, with that
//             reading's binary flag verbatim, its assumed collection time (fixed with the reading), the hour
//             the estimate is for, and the model revision it belongs to
// Neither is the published package: neither carries the validator's mark, and each names the published forecast
// peak (index.json siteRisk) as a separate source. A test record is marked as a test (meta.tag, status
// preliminary) and never invents a bacterial count.
//
// Every value on the card keeps a source: a number of a forecast record points into nowcast_<city>.json; anything
// else points into the record itself, registered on window.__sayrLive under its reference, where the quality
// checks read it ("live:<Type/id>#<pointer>").
import type { Json } from './xrayMap';

export const SAYR_CS = 'https://yazan-o.github.io/afterrain/fhir/CodeSystem/afterrain-cs';
/**
 * The OneAquaHealth health-measure profile AfterRain's published risk observations use (hl7.eu.fhir.oah). The forecast
 * record claims it; the test record does not, because the profile fixes status to final and a test estimate is
 * preliminary (HL7 validator, 2026-10-03).
 */
export const OAH_HEALTH_MEASURE = 'http://hl7.eu/fhir/ig/oah/StructureDefinition/observation-health-measure-oah';
const UCUM = 'http://unitsofmeasure.org';

declare global {
  interface Window {
    __sayrLive?: Record<string, Json>;
  }
}

export interface LiveRecord {
  /** The data-fhir key on screen ("forecast:C4:62", "test:C4:62:3"). */
  readonly key: string;
  /** The words above the card. */
  readonly heading: string;
  /** "Type/id" of the record. */
  readonly ref: string;
  readonly json: Json;
  /** The data-src of the value at a JSON pointer of the record. */
  readonly src: (ptr: string) => string;
  /** The published forecast peak for the site (served, validated), shown as a separate source; null when none. */
  readonly published: string | null;
  /** The hour as the screen says it ("Tue 6 Oct 15:00"), for the card's lead on a phone; absent when not given. */
  readonly when?: string;
}

const records = new Map<string, LiveRecord>();

/** Makes a record reachable from its key and its values checkable (window.__sayrLive). */
export function registerLive(r: LiveRecord): LiveRecord {
  records.set(r.key, r);
  (window.__sayrLive ??= {})[r.ref] = r.json;
  return r;
}
export const liveRecord = (key: string): LiveRecord | null => records.get(key) ?? null;
export const isLiveKey = (key: string): boolean => /^(forecast|test):/.test(key);

/** "2026-09-28T15:00Z" or "...:00.000Z" -> "20260928T1500Z". */
const stamp = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/(T\d{4})00Z$/, '$1Z').replace(/(T\d{4})Z$/, '$1Z');
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/** A FHIR dateTime needs seconds: "2026-10-06T14:00Z" -> "2026-10-06T14:00:00Z". */
export const fhirInstant = (iso: string): string => iso.replace(/T(\d\d:\d\d)Z$/, 'T$1:00Z');

export interface ForecastInput {
  readonly city: string;
  readonly code: string;
  readonly site: string;
  /** Index of the site in nowcast_<city>.json sites, and of the hour in its hours_utc. */
  readonly siteIndex: number;
  readonly hour: number;
  readonly hourUtc: string;
  readonly p50: number;
  readonly fog: number;
  readonly forecastFetchedUtc: string;
  readonly modelVersion: string;
  readonly published: string | null;
  readonly when?: string;
}

/** "Forecast at <site>": the nowcast's own values at one hour (no test reading at the site). */
export function forecastRecord(f: ForecastInput): LiveRecord {
  const id = `afterrain-forecast-${f.code}-${stamp(f.hourUtc)}`;
  const ref = `Observation/${id}`;
  const file = `nowcast_${f.city}.json`;
  const json: Json = {
    resourceType: 'Observation',
    id,
    meta: { profile: [OAH_HEALTH_MEASURE] },
    status: 'final',
    code: { coding: [{ system: SAYR_CS, code: 'ecoli-exceedance-probability', display: 'Probability of E. coli over 900 per 100 mL' }], text: `Forecast at ${f.site}` },
    subject: { reference: `Location/oah-site-${f.code}` },
    effectiveDateTime: fhirInstant(f.hourUtc),
    valueQuantity: { value: f.p50, unit: 'probability', system: UCUM, code: '1' },
    component: [{ code: { coding: [{ system: SAYR_CS, code: 'fog' }] }, valueQuantity: { value: f.fog, unit: 'fog', system: UCUM, code: '1' } }],
    ...(f.published ? { derivedFrom: [{ reference: f.published }] } : {}),
    note: [{ text: `Forecast fetched ${f.forecastFetchedUtc}; model ${f.modelVersion}.` }],
  };
  const fromFile: Record<string, string> = {
    '/valueQuantity/value': `${file}#/sites/${f.siteIndex}/p50/${f.hour}`,
    '/component/0/valueQuantity/value': `${file}#/sites/${f.siteIndex}/fog/${f.hour}`,
  };
  return { key: `forecast:${f.code}:${f.hour}`, heading: `Forecast at ${f.site}`, ref, json, src: (ptr) => fromFile[ptr] ?? `live:${ref}#${ptr}`, published: f.published, ...(f.when ? { when: f.when } : {}) };
}

export interface TestInput {
  readonly code: string;
  readonly site: string;
  readonly hour: number;
  /** The hour the estimate is for (the selected hour), UTC: the record's effective time. */
  readonly hourUtc: string;
  /** When the test reading is assumed collected, UTC: stored once with the reading, whatever hour is selected. */
  readonly collectedUtc: string;
  /** The test reading's flag, verbatim: true for "over 900". */
  readonly over900: boolean;
  /** The recomputed estimate and fog at that hour. */
  readonly p50: number;
  readonly fog: number;
  /** CityState.revision the values belong to. */
  readonly revision: number;
  readonly modelVersion: string;
  readonly published: string | null;
  readonly when?: string;
}

/** "Test estimate at <site>": the browser's recomputed estimate after one test reading. */
export function testRecord(t: TestInput): LiveRecord {
  const id = `afterrain-test-${t.code}-${stamp(t.hourUtc)}-r${t.revision}`;
  const ref = `Observation/${id}`;
  const reading = t.over900 ? 'over 900' : '900 or less';
  const json: Json = {
    resourceType: 'Observation',
    id,
    meta: { tag: [{ system: SAYR_CS, code: 'test-reading', display: 'Test reading, not a lab result' }] },
    status: 'preliminary',
    code: { coding: [{ system: SAYR_CS, code: 'ecoli-exceedance-probability', display: 'Probability of E. coli over 900 per 100 mL' }], text: `Test estimate at ${t.site}` },
    subject: { reference: `Location/oah-site-${t.code}` },
    effectiveDateTime: fhirInstant(t.hourUtc),
    valueQuantity: { value: round4(t.p50), unit: 'probability', system: UCUM, code: '1' },
    component: [
      { code: { coding: [{ system: SAYR_CS, code: 'fog' }] }, valueQuantity: { value: round4(t.fog), unit: 'fog', system: UCUM, code: '1' } },
      { code: { coding: [{ system: SAYR_CS, code: 'test-reading-over-900', display: 'Test reading over 900 E. coli per 100 mL (single-sample flag)' }] }, valueBoolean: t.over900 },
      { code: { coding: [{ system: SAYR_CS, code: 'test-reading-collected', display: 'Time the test reading is assumed collected' }] }, valueDateTime: fhirInstant(t.collectedUtc) },
    ],
    ...(t.published ? { derivedFrom: [{ reference: t.published }] } : {}),
    note: [
      {
        text: `Test reading: ${reading} E. coli per 100 mL, a single-sample flag, assumed collected ${t.collectedUtc}; estimate for ${t.hourUtc}. Recomputed in the browser from update_spec.json; model ${t.modelVersion}, revision ${t.revision}. Not a lab result.`,
      },
    ],
  };
  return { key: `test:${t.code}:${t.hour}:${t.revision}`, heading: `Test estimate at ${t.site}`, ref, json, src: (ptr) => `live:${ref}#${ptr}`, published: t.published, ...(t.when ? { when: t.when } : {}) };
}
