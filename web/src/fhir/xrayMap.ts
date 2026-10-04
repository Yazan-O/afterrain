// The FHIR x-ray's pure parts: which OAH-FHIR resource sits behind a thing on screen, and which lines of that
// resource the flipped card typesets. The resources are Sayr's own, copied from sayr/fhir/fhir-static into
// /data/fhir by `npm run data` (scripts/sync-fhir.mjs), which also writes index.json.
//
//   a replay sample (data-src "replay_<key>.json#/samples/<i>/...")  ObservationIndicatorsOah + SpecimenOah
//   Warleigh Weir                                                     LocationOah
//   a OneAquaHealth site's published forecast peak (data-fhir          its ObservationHealthMeasureOah (the
//   "site:<code>")                                                     build serves one per site; none is an error)
//   the stream's line at a place and hour (data-fhir "forecast:..."    a record made in the browser from the state on
//   or "test:...")                                                     screen (src/fhir/liveRecords.ts), never this
//   the proposed alert (data-fhir "alert")                             the proposed AlertOah Communication
//
// Every line keeps its JSON pointer, so the card binds each value to the served file by data-src.

/** public/data/fhir/index.json as scripts/sync-fhir.mjs writes it. */
export interface FhirIndex {
  readonly resources: readonly string[];
  /** Site Location reference -> its ObservationHealthMeasureOah references. */
  readonly healthMeasures: Readonly<Record<string, readonly string[]>>;
  /** OneAquaHealth site code -> that site's risk (its ObservationHealthMeasureOah for dog owners). */
  readonly siteRisk: Readonly<Record<string, string>>;
  readonly alerts: readonly string[];
  readonly validation: string;
}

export interface XrayTarget {
  /** "Type/id" references, in the order the card shows them. */
  readonly refs: readonly string[];
  /** The resource is Sayr's proposal, not a profile of the guide. */
  readonly proposed: boolean;
}

/** "2024-09-24T08:10:00Z" -> "20240924T0810Z", the stamp in the Warleigh resource ids. */
export function idStamp(timeUtc: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::00(?:\.0+)?)?Z$/.exec(timeUtc);
  if (!m) throw new Error(`not a whole-minute UTC time: ${timeUtc}`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}Z`;
}

export const sampleRefs = (timeUtc: string): string[] => [`Observation/warleigh-ecoli-${idStamp(timeUtc)}`, `Specimen/warleigh-water-${idStamp(timeUtc)}`];
export const WEIR_REF = 'Location/warleigh-weir';
export const siteRef = (code: string): string => `Location/oah-site-${code}`;

/** A replay sample's data-src ("replay_2024-09-23.json#/samples/4/ecoli_per_100ml") -> the file and the index. */
export function parseSampleSrc(src: string): { file: string; index: number } | null {
  const m = /^(replay_[\d-]+\.json)#\/samples\/(\d+)\/ecoli_per_100ml$/.exec(src);
  return m ? { file: m[1]!, index: Number(m[2]) } : null;
}

const known = (index: FhirIndex, refs: readonly string[]): boolean => refs.length > 0 && refs.every((r) => index.resources.includes(r));

/**
 * The resources behind a data-fhir key: explicit "Type/id" references (space-separated), "site:<code>", or
 * "alert". Null when the build has no such resource (the element then gets no x-ray).
 */
export function resolveKey(key: string, index: FhirIndex): XrayTarget | null {
  if (key === 'alert') return index.alerts.length ? { refs: [index.alerts[0]!], proposed: true } : null;
  if (key.startsWith('site:')) {
    const code = key.slice(5);
    const risk = index.siteRisk[code];
    if (!risk) throw new Error(`x-ray: the build serves no ObservationHealthMeasureOah for ${siteRef(code)}`);
    return known(index, [risk]) ? { refs: [risk], proposed: false } : null;
  }
  const refs = key.split(/\s+/).filter(Boolean);
  return known(index, refs) ? { refs, proposed: false } : null;
}

/** A replay sample's resources, from its time in the replay file. */
export function resolveSample(timeUtc: string, index: FhirIndex): XrayTarget | null {
  const refs = sampleRefs(timeUtc);
  return known(index, refs) ? { refs, proposed: false } : null;
}

// ----- the key lines -----

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface KeyValue {
  /** RFC 6901 pointer into the resource file. */
  readonly ptr: string;
  readonly value: string | number | boolean;
}

export interface KeyLine {
  /** The element's path, FHIRPath style, without indices ("valueQuantity.value", "code.coding.code"). */
  readonly key: string;
  readonly values: readonly KeyValue[];
  /** The line that holds what the front of the card showed. */
  readonly hot: boolean;
}

const at = (doc: Json, ptr: string): Json | undefined => {
  let cur: Json | undefined = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = /^\d+$/.test(k) ? cur[Number(k)] : undefined;
    else if (cur !== null && typeof cur === 'object') cur = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
    else return undefined;
  }
  return cur;
};

/** One line from a path and its pointers; pointers that resolve to nothing (or to a non-leaf) are dropped. */
const line = (r: Json, key: string, ptrs: readonly string[], hot = false): KeyLine | null => {
  const values: KeyValue[] = [];
  for (const ptr of ptrs) {
    const v = at(r, ptr);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values.push({ ptr, value: v });
  }
  return values.length ? { key, values, hot } : null;
};

const arr = (r: Json, ptr: string): Json[] => {
  const v = at(r, ptr);
  return Array.isArray(v) ? v : [];
};

const obj = (v: Json | undefined): Record<string, Json> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * The lines of a resource the card shows, the profile first. Chosen per resource type: what the thing is, its
 * value, its time and place, and the references that tie it to the rest.
 */
export function keyLines(r: Json): KeyLine[] {
  const type = obj(r)['resourceType'];
  const codings = (base: string, field: string): string[] => arr(r, `${base}/coding`).map((_, i) => `${base}/coding/${i}/${field}`);
  const plan: (KeyLine | null)[] = [line(r, 'meta.profile', ['/meta/profile/0']), line(r, 'meta.tag.code', arr(r, '/meta/tag').map((_, i) => `/meta/tag/${i}/code`))];
  if (type === 'Observation') {
    plan.push(
      at(r, '/meta/tag') !== undefined ? line(r, 'status', ['/status']) : null,
      line(r, 'code.coding.code', codings('/code', 'code')),
      // what the code means, beside it: the code's text, else its display
      at(r, '/code/text') !== undefined ? line(r, 'code.text', ['/code/text']) : line(r, 'code.coding.display', codings('/code', 'display')),
      line(r, 'focus.reference', arr(r, '/focus').map((_, i) => `/focus/${i}/reference`)),
      line(r, 'valueQuantity.value', ['/valueQuantity/value'], true),
      line(r, 'valueQuantity.code', ['/valueQuantity/code']),
      line(r, 'effectiveDateTime', ['/effectiveDateTime']),
      line(r, 'referenceRange.high.value', ['/referenceRange/0/high/value']),
      line(r, 'subject.reference', ['/subject/reference']),
      line(r, 'specimen.reference', ['/specimen/reference']),
      line(r, 'component.code.coding.code', arr(r, '/component').map((_, i) => `/component/${i}/code/coding/0/code`)),
      line(r, 'component.valueQuantity.value', arr(r, '/component').map((_, i) => `/component/${i}/valueQuantity/value`)),
      line(r, 'component.valueBoolean', arr(r, '/component').map((_, i) => `/component/${i}/valueBoolean`)),
      line(r, 'derivedFrom.reference', arr(r, '/derivedFrom').map((_, i) => `/derivedFrom/${i}/reference`)),
    );
  } else if (type === 'Specimen') {
    plan.push(
      line(r, 'type.coding.display', codings('/type', 'display')),
      line(r, 'collection.collectedDateTime', ['/collection/collectedDateTime']),
      line(r, 'collection.collector.reference', ['/collection/collector/reference']),
    );
  } else if (type === 'Location') {
    plan.push(
      line(r, 'identifier.value', arr(r, '/identifier').map((_, i) => `/identifier/${i}/value`)),
      line(r, 'name', ['/name'], true),
      line(r, 'type.coding.display', codings('/type/0', 'display')),
      line(r, 'position.latitude', ['/position/latitude']),
      line(r, 'position.longitude', ['/position/longitude']),
      line(r, 'partOf.reference', ['/partOf/reference']),
    );
  } else if (type === 'Communication') {
    const ext = arr(r, '/extension').findIndex((e) => /alert-validity-period$/.test(String(obj(e)['url'] ?? '')));
    plan.push(
      line(r, 'category.coding.code', codings('/category/0', 'code')),
      line(r, 'subject.reference', ['/subject/reference']),
      line(r, 'about.reference', arr(r, '/about').map((_, i) => `/about/${i}/reference`)),
      ext >= 0 ? line(r, 'extension.valuePeriod.end', [`/extension/${ext}/valuePeriod/end`]) : null,
      line(r, 'payload.contentString', arr(r, '/payload').map((_, i) => `/payload/${i}/contentString`), true),
    );
  }
  return plan.filter((l): l is KeyLine => l !== null);
}

/** The profile's name, the last segment of its canonical URL ("observation-indicators-oah"). */
export const profileName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);
