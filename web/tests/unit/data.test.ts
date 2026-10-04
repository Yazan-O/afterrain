import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DataError, decode } from '../../src/data/decode';
import { httpSource, loaders } from '../../src/data/loaders';
import { CITY_IDS, MODEL_KEYS, REPLAY_KEYS, cityFile, darkHoursFile, forecastFile, modelFile, numbersFile, replayFile } from '../../src/data/schemas';
import { DATA_OUT, disk, readOut } from './disk';

const clone = <T>(x: T): T => structuredClone(x);
const expectDataError = (fn: () => unknown, path: RegExp, problem: RegExp): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DataError);
    expect((e as DataError).path).toMatch(path);
    expect((e as DataError).problem).toMatch(problem);
    return;
  }
  throw new Error('expected a DataError, nothing was thrown');
};

const KNOWN_FILES = new Set([
  'numbers.json',
  'transfer.json',
  'warleigh_backtest.json',
  'build_info.json',
  'update_spec.json',
  'city_model.json',
  'dark_hours.json',
  ...MODEL_KEYS.map((k) => `model_${k}.json`),
  ...REPLAY_KEYS.map((k) => `replay_${k}.json`),
  ...CITY_IDS.map((c) => `city_${c}.json`),
  ...CITY_IDS.map((c) => `forecast_${c}.json`),
  ...CITY_IDS.map((c) => `nowcast_${c}.json`),
]);

describe('every pipeline output decodes against its schema', () => {
  it('has a schema and loader for every file in data/out', () => {
    const present = readdirSync(DATA_OUT).filter((f) => f.endsWith('.json'));
    expect(present.filter((f) => !KNOWN_FILES.has(f)), 'files in data/out without a schema and loader').toEqual([]);
    expect([...KNOWN_FILES].filter((f) => !present.includes(f)), 'files the app expects but data/out lacks').toEqual([]);
  });

  it('numbers.json', async () => expect(Object.keys(await disk.numbers()).length).toBeGreaterThan(200));
  it.each(MODEL_KEYS)('model_%s.json', async (k) => expect((await disk.model(k)).features.length).toBeGreaterThan(0));
  it.each(REPLAY_KEYS)('replay_%s.json', async (k) => expect((await disk.replay(k)).overflows.length).toBeGreaterThan(0));
  it.each(CITY_IDS)('city_%s.json', async (c) => expect((await disk.city(c)).city.id).toBe(c));
  it.each(CITY_IDS)('forecast_%s.json', async (c) => expect((await disk.forecast(c)).sites.length).toBeGreaterThan(0));
  it('transfer.json', async () => expect((await disk.transfer()).farleigh.rule.n).toBeGreaterThan(0));
  it('warleigh_backtest.json', async () => expect((await disk.backtest()).samples.length).toBeGreaterThan(0));
  it('build_info.json', async () => expect((await disk.buildInfo()).numbers).toBeGreaterThan(0));
  it.each(CITY_IDS)('nowcast_%s.json', async (c) => expect((await disk.nowcast(c)).sites.length).toBeGreaterThan(0));
  it('update_spec.json', async () => expect((await disk.updateSpec()).vectors.length).toBeGreaterThan(0));
  it('city_model.json', async () => expect((await disk.cityModel()).train_n).toBeGreaterThan(0));
  it('dark_hours.json', async () => expect((await disk.darkHours()).summary.oneaquahealth.n).toBeGreaterThan(0));
});

describe('OneAquaHealth payload fields are optional in published data', () => {
  // the published package may leave out the source's own site payloads (health risk, urban cover, polygons,
  // altitudes, citizen sites); the app reads none of them, so their absence is never an error
  it.each(CITY_IDS)('city_%s.json without them', (c) => {
    const f = clone(readOut(`city_${c}.json`)) as { sites: Record<string, unknown>[] } & Record<string, unknown>;
    for (const s of f.sites) for (const k of ['health_risk', 'urban', 'polygon', 'altitude']) delete s[k];
    delete f['citizen_sites'];
    delete f['citizen_box'];
    expect(decode(`city_${c}.json`, cityFile(c), f).city.id).toBe(c);
  });
  it('dark_hours.json without them', () => {
    const f = clone(readOut('dark_hours.json')) as { oneaquahealth: Record<string, unknown>[] };
    for (const r of f.oneaquahealth) for (const k of ['scaled_fecal_risk', 'health_risk_score']) delete r[k];
    expect(decode('dark_hours.json', darkHoursFile, f).oneaquahealth.length).toBe(f.oneaquahealth.length);
  });
});

describe('schema checks fail loudly', () => {
  it('a missing required field is an error naming its path, never a default', () => {
    const m = clone(readOut('model_warleigh.json')) as { features: Record<string, unknown>[] };
    delete m.features[2]!['coef'];
    expectDataError(() => decode('model_warleigh.json', modelFile, m), /^features\[2\]\.coef$/, /missing required field/);
  });

  it('null where the pipeline never writes null is an error', () => {
    const r = clone(readOut('replay_2024-09-23.json')) as { samples: Record<string, unknown>[] };
    r.samples[3]!['ecoli_per_100ml'] = null;
    expectDataError(() => decode('replay', replayFile, r), /^samples\[3\]\.ecoli_per_100ml$/, /expected finite number, got null/);
  });

  it('a wrong type is an error', () => {
    const n = clone(readOut('numbers.json')) as Record<string, Record<string, unknown>>;
    n['warleigh.samples']!['value'] = true;
    expectDataError(() => decode('numbers.json', numbersFile, n), /^warleigh\.samples\.value$/, /expected finite number/);
  });

  it('a time without a UTC marker is an error', () => {
    const r = clone(readOut('replay_2024-09-23.json')) as { overflows: { events: Record<string, unknown>[] }[] };
    r.overflows[0]!.events[0]!['start_utc'] = '2024-09-22T16:10:00';
    expectDataError(() => decode('replay', replayFile, r), /^overflows\[0\]\.events\[0\]\.start_utc$/, /UTC ISO instant/);
  });

  it('a replay whose overflow count disagrees with its list is an error', () => {
    const r = clone(readOut('replay_2024-09-23.json')) as { overflows: unknown[] };
    r.overflows.pop();
    expectDataError(() => decode('replay', replayFile, r), /^$/, /overflows_spilling says 24 but 23/);
  });

  it('a forecast member with the wrong number of hours is an error', () => {
    const f = clone(readOut('forecast_CO.json')) as { sites: { hourly_members_mm: number[][] }[] };
    f.sites[0]!.hourly_members_mm[5]!.pop();
    expectDataError(() => decode('forecast_CO.json', forecastFile('CO'), f), /^$/, /a member does not have 168 hours/);
  });

  it('a city file under the wrong id is an error', async () => {
    const wrong = loaders(async () => readOut('city_TO.json'));
    await expect(wrong.city('CO')).rejects.toThrow(/city\.id is TO, expected CO/);
  });

  it('extra fields from a newer pipeline are allowed', () => {
    const r = clone(readOut('replay_2023-07-10.json')) as Record<string, unknown>;
    r['added_later'] = { anything: 1 };
    expect(decode('replay', replayFile, r).overflows_spilling).toBe(11);
  });

  it('an HTTP error is a DataError with the status', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    try {
      await expect(loaders(httpSource('/data/')).numbers()).rejects.toThrow(/numbers\.json: \(root\): HTTP 404/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('an HTML page served in place of a data file is a DataError, not a parse surprise', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    try {
      await expect(loaders(httpSource('/data/')).model('warleigh')).rejects.toThrow(/model_warleigh\.json: \(root\): expected JSON from \/data\/model_warleigh\.json, got "text\/html"/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
