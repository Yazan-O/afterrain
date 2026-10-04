// The FHIR x-ray's number-to-resource mapping (src/fhir/xrayMap.ts) against tracked resources
// (fhir/served) and the served copy (public/data/fhir, written by `npm run data`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePointer } from '../e2e/harness/checks';
import { formatNumber } from '../../src/format/numfmt';
import { idStamp, keyLines, parseSampleSrc, profileName, resolveKey, resolveSample, sampleRefs, siteRef, WEIR_REF, type FhirIndex, type Json } from '../../src/fhir/xrayMap';
import { readOut } from './disk';

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE = resolve(here, '..', '..', '..', 'fhir', 'served');
const SERVED = resolve(here, '..', '..', 'public', 'data', 'fhir');
const need = (dir: string, how: string): void => {
  if (!existsSync(dir)) throw new Error(`${dir} is missing: ${how}`);
};
const readRef = (dir: string, ref: string): Json => JSON.parse(readFileSync(resolve(dir, `${ref}.json`), 'utf-8')) as Json;
const index = (): FhirIndex => {
  need(SERVED, 'run `npm run data` (it syncs the FHIR resources the app uses)');
  return JSON.parse(readFileSync(resolve(SERVED, 'index.json'), 'utf-8')) as FhirIndex;
};

describe('x-ray mapping', () => {
  it('turns a replay sample time into its Observation and Specimen ids', () => {
    expect(idStamp('2024-09-24T08:10:00Z')).toBe('20240924T0810Z');
    expect(sampleRefs('2024-09-24T08:10:00Z')).toEqual(['Observation/warleigh-ecoli-20240924T0810Z', 'Specimen/warleigh-water-20240924T0810Z']);
    expect(() => idStamp('2024-09-24T08:10:30Z')).toThrow(/whole-minute/);
    expect(parseSampleSrc('replay_2024-09-23.json#/samples/4/ecoli_per_100ml')).toEqual({ file: 'replay_2024-09-23.json', index: 4 });
    expect(parseSampleSrc('replay_2024-09-23.json#/overflows_spilling')).toBeNull();
  });

  it('maps a site to its health measure (a site without one is an error, never another resource); the alert is proposed', () => {
    const idx: FhirIndex = {
      resources: ['Location/oah-site-C4', 'Location/oah-site-C3', 'Observation/risk-c3', 'Communication/a1', WEIR_REF],
      healthMeasures: { 'Location/oah-site-C3': ['Observation/risk-c3'] },
      siteRisk: { C3: 'Observation/risk-c3' },
      alerts: ['Communication/a1'],
      validation: 'sayr.summary.json',
    };
    expect(() => resolveKey('site:C4', idx)).toThrow(/no ObservationHealthMeasureOah for Location\/oah-site-C4/);
    expect(resolveKey('site:C3', idx)).toEqual({ refs: ['Observation/risk-c3'], proposed: false });
    expect(() => resolveKey('site:C99', idx)).toThrow(/no ObservationHealthMeasureOah/);
    expect(resolveKey('alert', idx)).toEqual({ refs: ['Communication/a1'], proposed: true });
    expect(resolveKey(WEIR_REF, idx)).toEqual({ refs: [WEIR_REF], proposed: false });
    expect(resolveKey('Location/nowhere', idx)).toBeNull();
    expect(resolveKey('alert', { ...idx, alerts: [] })).toBeNull();
  });
});

describe('x-ray mapping on the tracked FHIR resources', () => {
  it('every replay sample resolves to an ObservationIndicatorsOah and a SpecimenOah holding its value and time', () => {
    need(REFERENCE, 'restore tracked fhir/served resources');
    const idx = index();
    let n = 0;
    for (const key of ['2024-09-23', '2023-07-10']) {
      const pack = readOut(`replay_${key}.json`) as { samples: { time_utc: string; ecoli_per_100ml: number }[] };
      for (const s of pack.samples) {
        const t = resolveSample(s.time_utc, idx);
        expect(t, s.time_utc).not.toBeNull();
        const [obs, spec] = t!.refs.map((r) => readRef(REFERENCE, r)) as [Record<string, Json>, Record<string, Json>];
        expect(resolvePointer(obs, '/meta/profile/0')).toBe('http://hl7.eu/fhir/ig/oah/StructureDefinition/observation-indicators-oah');
        expect(resolvePointer(obs, '/valueQuantity/value')).toBe(s.ecoli_per_100ml);
        expect(Date.parse(resolvePointer(obs, '/effectiveDateTime') as string)).toBe(Date.parse(s.time_utc));
        expect(resolvePointer(obs, '/specimen/reference')).toBe(t!.refs[1]);
        expect(resolvePointer(spec, '/meta/profile/0')).toBe('http://hl7.eu/fhir/ig/oah/StructureDefinition/specimen-oah');
        expect(Date.parse(resolvePointer(spec, '/collection/collectedDateTime') as string)).toBe(Date.parse(s.time_utc));
        n++;
      }
    }
    expect(n).toBe(16);
    // the 31,000 of 24 September 2024
    expect(resolveSample('2024-09-24T08:10:00Z', idx)!.refs[0]).toBe('Observation/warleigh-ecoli-20240924T0810Z');
    expect(resolvePointer(readRef(REFERENCE, 'Observation/warleigh-ecoli-20240924T0810Z'), '/valueQuantity/value')).toBe(31000);
  });

  it("every OneAquaHealth site's risk turns over to its own ObservationHealthMeasureOah, about that site's LocationOah", () => {
    const idx = index();
    const weir = readRef(REFERENCE, WEIR_REF);
    expect(resolvePointer(weir, '/meta/profile/0')).toBe('http://hl7.eu/fhir/ig/oah/StructureDefinition/location-oah');
    let n = 0;
    for (const id of ['CO', 'BE', 'GH', 'OS', 'TO'] as const) {
      const city = readOut(`city_${id}.json`) as { sites: { code: string; name: string }[] };
      const now = readOut(`nowcast_${id}.json`) as { quests: { code: string }[] };
      for (const site of city.sites) {
        const t = resolveKey(`site:${site.code}`, idx)!;
        expect(t.proposed, `${id} ${site.code}`).toBe(false);
        expect(t.refs, `${id} ${site.code}`).toHaveLength(1);
        const risk = readRef(REFERENCE, t.refs[0]!);
        expect(resolvePointer(risk, '/meta/profile/0')).toBe('http://hl7.eu/fhir/ig/oah/StructureDefinition/observation-health-measure-oah');
        expect(resolvePointer(risk, '/subject/reference')).toBe(siteRef(site.code));
        expect(JSON.stringify(risk)).not.toMatch(/warleigh/i); // never the Warleigh alert or weir
        const loc = readRef(REFERENCE, siteRef(site.code));
        expect(resolvePointer(loc, '/identifier/0/value')).toBe(site.code);
        expect(resolvePointer(loc, '/partOf/reference')).toBe(`Location/oah-city-${id}`);
        n++;
      }
      // the quest's line (data-fhir "site:<code>") has its site's risk
      for (const q of now.quests) expect(resolveKey(`site:${q.code}`, idx)!.refs[0]).toMatch(/^Observation\//);
    }
    expect(n).toBe(106);
  }, 60_000); // reads every site's resources from disk: slow on a busy machine

  it('the proposed alert is an AlertOah Communication about Warleigh Weir', () => {
    const idx = index();
    const t = resolveKey('alert', idx)!;
    expect(t.proposed).toBe(true);
    const c = readRef(REFERENCE, t.refs[0]!);
    expect(profileName(resolvePointer(c, '/meta/profile/0') as string)).toBe('alert-oah');
    expect(resolvePointer(c, '/about/0/reference')).toBe(WEIR_REF);
  });

  it('the served copy holds only recorded Sayr resource ids, each identical to the tracked resource', () => {
    const idx = index();
    const validation = JSON.parse(readFileSync(resolve(here, '..', '..', '..', 'docs', 'validation.json'), 'utf-8')) as { own_resource_ids: string[] };
    const own = new Set(validation.own_resource_ids);
    const onDisk = readdirSync(SERVED, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(resolve(SERVED, d.name)).map((f) => `${d.name}/${f.replace(/\.json$/, '')}`));
    expect(onDisk.sort()).toEqual([...idx.resources].sort());
    for (const ref of onDisk) {
      expect(own.has(ref), ref).toBe(true);
      expect(readFileSync(resolve(SERVED, `${ref}.json`), 'utf-8')).toBe(readFileSync(resolve(REFERENCE, `${ref}.json`), 'utf-8'));
    }
    const summary = JSON.parse(readFileSync(resolve(SERVED, 'sayr.summary.json'), 'utf-8')) as { counts: { error: number; fatal: number }; files_with_errors: unknown[] };
    expect(summary.counts.error).toBe(0);
    expect(summary.counts.fatal).toBe(0);
    expect(summary.files_with_errors).toEqual([]);
  }, 60_000); // reads the served copy and tracked resources from disk
});

describe('the card\'s key lines', () => {
  it('put the profile first, point at every value, and keep digits out of the keys', () => {
    const idx = index();
    const refs = [...resolveSample('2024-09-24T08:10:00Z', idx)!.refs, WEIR_REF, siteRef('C4'), ...resolveKey('site:C4', idx)!.refs, ...resolveKey('alert', idx)!.refs];
    for (const ref of refs) {
      const r = readRef(REFERENCE, ref);
      const lines = keyLines(r);
      expect(lines[0]!.key, ref).toBe('meta.profile');
      // the card's first resource carries what the front showed; the Specimen beside the sample has none
      expect(lines.filter((l) => l.hot)).toHaveLength(ref.startsWith('Specimen/') ? 0 : 1);
      for (const l of lines) {
        expect(l.key, `${ref} ${l.key}`).not.toMatch(/\d/); // a digit outside data-src would fail number provenance
        for (const v of l.values) {
          expect(resolvePointer(r, v.ptr), `${ref}#${v.ptr}`).toBe(v.value);
          if (typeof v.value === 'number') expect(formatNumber(v.value, 'raw')).toBe(JSON.stringify(v.value));
        }
      }
    }
    const obs = keyLines(readRef(REFERENCE, 'Observation/warleigh-ecoli-20240924T0810Z'));
    expect(obs.find((l) => l.hot)).toMatchObject({ key: 'valueQuantity.value', values: [{ ptr: '/valueQuantity/value', value: 31000 }] });
    expect(obs.map((l) => l.key)).toContain('referenceRange.high.value');
    // what the code means sits beside it: code.text, else the coding's display
    const code = obs.findIndex((l) => l.key === 'code.coding.code');
    expect(obs[code + 1]!.key).toMatch(/^code\.(text|coding\.display)$/);
    const risk = keyLines(readRef(REFERENCE, resolveKey('site:C4', idx)!.refs[0]!));
    expect(risk.find((l) => l.hot)!.key).toBe('valueQuantity.value');
    expect(risk.map((l) => l.key)).toEqual(expect.arrayContaining(['code.coding.code', 'code.coding.display', 'subject.reference', 'focus.reference']));
    const alert = keyLines(readRef(REFERENCE, resolveKey('alert', idx)!.refs[0]!));
    expect(alert.map((l) => l.key)).toEqual(['meta.profile', 'category.coding.code', 'subject.reference', 'about.reference', 'extension.valuePeriod.end', 'payload.contentString']);
  });
});
