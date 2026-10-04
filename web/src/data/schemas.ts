// Schemas for every file the pipeline writes to sayr/data/out. Field names match the JSON exactly so a
// value on screen can be traced back to its file. Nullable fields are the ones the pipeline writes as null.
import {
  arr,
  bool,
  int,
  isoDate,
  literal,
  naiveDateTime,
  nullable,
  offsetDateTime,
  num,
  obj,
  optional,
  record,
  refine,
  str,
  tuple2,
  utcInstant,
  type Decoder,
} from './decode';

export const CITY_IDS = ['BE', 'CO', 'GH', 'OS', 'TO'] as const;
export type CityId = (typeof CITY_IDS)[number];
export const REPLAY_KEYS = ['2024-09-23', '2023-07-10'] as const;
export type ReplayKey = (typeof REPLAY_KEYS)[number];
export const MODEL_KEYS = ['warleigh', 'portable'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

// numbers.json -------------------------------------------------------------------------------------

const numberEntry = obj({
  value: (v, ctx) => (typeof v === 'string' ? str(v, ctx) : num(v, ctx)),
  counts: str,
  sources: arr(str),
  function: str,
});
export const numbersFile = refine(record(numberEntry), (r) => (Object.keys(r).length === 0 ? 'numbers.json is empty' : null));
export type NumberEntry = ReturnType<typeof numberEntry>;
export type NumbersFile = Record<string, NumberEntry>;

// model_*.json -------------------------------------------------------------------------------------

export const TRANSFORMS = ['identity', 'log1p', 'log', 'sin', 'cos'] as const;
export type TransformKind = (typeof TRANSFORMS)[number];

const feature = obj({
  name: str,
  input: str,
  transform: literal(...TRANSFORMS),
  fill_if_missing: num,
  mean: num,
  std: refine(num, (s) => (s > 0 ? null : 'std must be positive')),
  coef: num,
});

const testVector = obj({
  sample_time_utc: utcInstant,
  ecoli_observed: num,
  inputs: record(num),
  expected_probability: num,
});

const travel = obj({
  name: str,
  site_ids: arr(str),
  lat: num,
  lon: num,
  receiving_water: nullable(str),
  distance_m: nullable(num),
  snap_m: nullable(num),
  distance_approximate: bool,
  travel_hours: num,
});

// pipeline.model.metrics writes null for auc, pod and far when they are undefined (no exceedances, no warnings).
const scores = obj({
  n: int,
  exceedances: int,
  auc: nullable(num),
  brier: num,
  brier_base_rate: num,
  warned: int,
  warned_exceed: int,
  pod: nullable(num),
  far: nullable(num),
  threshold: num,
});

export const modelFile = refine(
  obj({
    site: str,
    target: str,
    note_900: str,
    formula: str,
    transforms: record(str),
    inputs: record(str),
    window_hours: num,
    cap_hours: num,
    velocity_m_per_s: num,
    intercept: num,
    features: arr(feature, { minLength: 1 }),
    threshold: num,
    travel: record(travel),
    test_vectors: arr(testVector, { minLength: 1 }),
    fitted_on: str,
    tested_on: str,
    train_n: int,
    train_exceedances: int,
    velocity_cv_logloss: record(num),
    test_2025: scores,
    train_cv: scores,
  }),
  (m) => {
    for (const f of m.features) if (!(f.input in m.inputs)) return `feature ${f.name} uses undocumented input ${f.input}`;
    const used = new Set(m.features.map((f) => f.input));
    for (const [i, v] of m.test_vectors.entries()) {
      for (const u of used) if (!(u in v.inputs)) return `test_vectors[${i}] lacks input ${u}`;
    }
    return null;
  },
);
export type ModelFile = ReturnType<typeof modelFile>;
export type ModelFeature = ReturnType<typeof feature>;

// replay_*.json ------------------------------------------------------------------------------------

const spillEvent = refine(
  obj({ site_id: str, start_utc: utcInstant, stop_utc: utcInstant, hours: num }),
  (e) => (Date.parse(e.stop_utc) < Date.parse(e.start_utc) ? `spill stops (${e.stop_utc}) before it starts (${e.start_utc})` : null),
);

const replayOverflow = obj({
  overflow: str,
  name: str,
  site_ids: arr(str),
  lat: num,
  lon: num,
  receiving_water: nullable(str),
  distance_to_weir_m: nullable(num),
  snap_to_river_m: nullable(num),
  travel_hours_by_velocity: nullable(record(num)),
  events: arr(spillEvent, { minLength: 1 }),
});

const replaySample = obj({
  time_utc: utcInstant,
  time_local: naiveDateTime,
  ecoli_per_100ml: num,
  enterococci_per_100ml: nullable(num),
  over_900: bool,
});

const flowDay = obj({ date: isoDate, gauge: str, m3_per_s: nullable(num), quality: str });
const rainDay = obj({ date: isoDate, gauge: str, mm: nullable(num), quality: str });
const lonLat = tuple2(num, num);
const riverLine = obj({ names: arr(str), coordinates: arr(lonLat, { minLength: 2 }) });

export const replayFile = refine(
  obj({
    window_local: tuple2(isoDate, isoDate),
    window_utc: tuple2(utcInstant, utcInstant),
    site: obj({ name: str, lat: num, lon: num }),
    overflows_spilling: int,
    overflows: arr(replayOverflow),
    samples: arr(replaySample),
    flow_daily: arr(flowDay, { minLength: 1 }),
    rain_daily: arr(rainDay, { minLength: 1 }),
    daily_note: str,
    river: arr(riverLine),
    sources: record(str),
    note_900: str,
  }),
  (r) =>
    r.overflows.length === r.overflows_spilling
      ? null
      : `overflows_spilling says ${r.overflows_spilling} but ${r.overflows.length} overflows are listed`,
);
export type ReplayFile = ReturnType<typeof replayFile>;
export type ReplayOverflow = ReturnType<typeof replayOverflow>;
export type ReplaySample = ReturnType<typeof replaySample>;
export type FlowDay = ReturnType<typeof flowDay>;
export type RainDay = ReturnType<typeof rainDay>;

// city_*.json --------------------------------------------------------------------------------------

const healthRisk = obj({
  samplingDate: naiveDateTime,
  scaledPathogenRisk: num,
  scaledFecalRisk: num,
  scaledArgRisk: num,
  healthRiskScore: num,
});

const geoJsonFeature = obj({ type: str, geometry: obj({ type: str, coordinates: arr((v) => v) }), properties: record((v) => v) });

const citySite = obj({
  code: str,
  name: str,
  lat: num,
  lon: num,
  // OneAquaHealth's own site payloads: the app reads none of them, and a published package may leave them out
  altitude: optional(nullable(num)),
  polygon: optional(nullable(obj({ type: str, features: arr(geoJsonFeature) }))),
  health_risk: optional(nullable(healthRisk)),
  rain_3d_before_sampling_mm: nullable(num),
  urban: optional(nullable(record(num))),
});

const citizenSite = obj({ userSiteCode: str, name: str, latitude: num, longitude: num, altitude: nullable(num) });

const waterway = obj({
  osm_way: int,
  waterway: str,
  name: nullable(str),
  intermittent: bool,
  coordinates: arr(lonLat, { minLength: 2 }),
});

const countPair = obj({ n: int, exceed: int });

const wetWeatherEvidence = obj({
  station: obj({ code: str, name: str, river: str, lat: num, lon: num }),
  samples: int,
  first: str,
  last: str,
  exceed: int,
  wet_2d_5mm: countPair,
  otherwise: countPair,
  dry_3d_1mm: countPair,
  separation_auc: record(num),
  flow_days_missing: int,
  definitions: record(str),
  sources: record(str),
  rows: arr(
    obj({
      date: isoDate,
      time: str,
      ecoli_per_100ml: num,
      over_900: bool,
      rain_2d_mm: nullable(num),
      rain_3d_mm: nullable(num),
      flow_prev_day_m3s: nullable(num),
      flow_day_m3s: nullable(num),
    }),
  ),
});

const cityShape = obj({
  city: obj({ id: literal(...CITY_IDS), name: str, longitude: num, latitude: num }),
  sites: arr(citySite, { minLength: 1 }),
  citizen_sites: optional(arr(citizenSite)),
  citizen_box: optional(arr(num)),
  dry_weather: obj({ samples: int, dry: int, wet_5mm: int }),
  waterways: obj({ bbox: arr(num), kinds: arr(str), attribution: str, features: arr(waterway) }),
  wet_weather_evidence: optional(wetWeatherEvidence),
  source: str,
});
export type CityFile = ReturnType<typeof cityShape>;

export const cityFile = (id: CityId): Decoder<CityFile> =>
  refine(cityShape, (c) => {
    if (c.city.id !== id) return `city.id is ${c.city.id}, expected ${id}`;
    if ((c.citizen_box && c.citizen_box.length !== 4) || c.waterways.bbox.length !== 4) return 'citizen_box and waterways.bbox must have 4 numbers';
    return null;
  });
export type CitySite = ReturnType<typeof citySite>;
export type Waterway = ReturnType<typeof waterway>;

// forecast_*.json ----------------------------------------------------------------------------------

const forecastSite = obj({
  code: str,
  name: str,
  grid_lat: num,
  grid_lon: num,
  members: int,
  hourly_members_mm: arr(arr(num)),
  hourly_p10_p50_p90_mm: arr(arr(num)),
  daily_dates: arr(isoDate),
  daily_member_totals_mm: arr(arr(num)),
  daily_prob_ge_5mm: arr(num),
  daily_prob_ge_10mm: arr(num),
});

export const forecastFile = (id: CityId) =>
  refine(
    obj({
      city: literal(id),
      fetched_utc: utcInstant,
      endpoint: str,
      model: str,
      timezone: literal('UTC'),
      hourly_times_utc: arr(naiveDateTime, { minLength: 1 }),
      licence: str,
      sites: arr(forecastSite, { minLength: 1 }),
    }),
    (f) => {
      const hours = f.hourly_times_utc.length;
      for (const s of f.sites) {
        const days = s.daily_dates.length;
        if (s.hourly_members_mm.length !== s.members) return `site ${s.code}: ${s.hourly_members_mm.length} hourly members, header says ${s.members}`;
        if (s.hourly_members_mm.some((m) => m.length !== hours)) return `site ${s.code}: a member does not have ${hours} hours`;
        if (s.hourly_p10_p50_p90_mm.length !== 3 || s.hourly_p10_p50_p90_mm.some((m) => m.length !== hours))
          return `site ${s.code}: hourly_p10_p50_p90_mm must be 3 rows of ${hours}`;
        if (s.daily_member_totals_mm.length !== s.members || s.daily_member_totals_mm.some((m) => m.length !== days))
          return `site ${s.code}: daily_member_totals_mm must be ${s.members} rows of ${days}`;
        if (s.daily_prob_ge_5mm.length !== days || s.daily_prob_ge_10mm.length !== days) return `site ${s.code}: daily probabilities must have ${days} values`;
      }
      return null;
    },
  );
export type ForecastFile = ReturnType<ReturnType<typeof forecastFile>>;

// transfer.json, warleigh_backtest.json, build_info.json -------------------------------------------

const ruleCounts = obj({
  n: int,
  warned: int,
  warned_exceed: int,
  warned_median: nullable(num),
  not_warned: int,
  not_warned_exceed: int,
  not_warned_median: nullable(num),
});

export const transferFile = obj({
  farleigh: obj({
    rule: ruleCounts,
    portable_model_no_refit: scores,
    overflows: arr(str),
    samples_first: str,
    samples_last: str,
    features: str,
  }),
  alewife: obj({
    cso_starts: int,
    samples: int,
    sampling_days: int,
    warned: int,
    warned_exceed: int,
    warned_median: nullable(num),
    not_warned: int,
    not_warned_exceed: int,
    not_warned_median: nullable(num),
    warned_days: int,
    note: str,
  }),
});
export type TransferFile = ReturnType<typeof transferFile>;

const RULES = ['freshford', 'near_field', 'any_upstream', 'rain', 'flow', 'combined'] as const;
const ruleFlags = obj(Object.fromEntries(RULES.map((r) => [r, bool])) as Record<(typeof RULES)[number], Decoder<boolean>>);

export const backtestFile = obj({
  site: str,
  window_hours: num,
  threshold: num,
  rules: record(str),
  samples: arr(
    obj({
      time_utc: utcInstant,
      time_local: naiveDateTime,
      ecoli: num,
      enterococci: nullable(num),
      over_900: bool,
      freshford_hours_48h: num,
      upstream_hours_48h: num,
      rain_2d_mm: nullable(num),
      flow_prev_day_m3s: nullable(num),
      rules: ruleFlags,
      unexplained: bool,
      model_probability: num,
      probability_kind: str,
    }),
    { minLength: 1 },
  ),
});
export type BacktestFile = ReturnType<typeof backtestFile>;

export const buildInfoFile = obj({
  built_utc: utcInstant,
  offline: bool,
  seconds: num,
  numbers: int,
  forecast_fetched_utc: record(utcInstant),
  fetch_log: arr((v) => v),
});
export type BuildInfoFile = ReturnType<typeof buildInfoFile>;

// update_spec.json (the citizen update and the fog; pipeline/updatespec.py) -------------------------

const FOG_STATES = ['usual', 'higher', 'high', 'unknown'] as const;

const updateSummary = obj({
  mean_a: num,
  mean_b: num,
  var_a: num,
  var_b: num,
  cov_ab: num,
  p_dry: num,
  p10: num,
  p50: num,
  p90: num,
  x_median: num,
  fog_rain: num,
  fog_local: num,
  fog: num,
  state: literal(...FOG_STATES),
});

const observation: Decoder<{ over_900: boolean } | { count: number }> = (v, ctx) =>
  typeof v === 'object' && v !== null && 'count' in v ? obj({ count: num })(v, ctx) : obj({ over_900: bool })(v, ctx);

const gridAxis = (tau: number, n: number, half: number): number[] =>
  Array.from({ length: n }, (_, i) => -half * tau + i * ((2 * half * tau) / (n - 1)));

export const updateSpecFile = refine(
  obj({
    model_version: str,
    params: obj({
      alpha: num,
      beta: num,
      tau_a: num,
      tau_b: num,
      s: refine(num, (x) => (x > 0 ? null : 's must be positive')),
      t_higher: num,
      t_high: num,
      fog_unknown: num,
      grid_n: int,
      grid_half_width_sd: num,
      z90: num,
      log10_900: num,
    }),
    axes: obj({ a: arr(num, { minLength: 2 }), b: arr(num, { minLength: 2 }) }),
    prior_at_probe: updateSummary,
    definitions: record(str),
    vectors: arr(
      obj({
        name: str,
        start: literal('prior'),
        steps: arr(obj({ r48_mm: num, obs: observation }), { minLength: 1 }),
        probe_members_r48_mm: arr(num, { minLength: 1 }),
        expected: updateSummary,
      }),
      { minLength: 1 },
    ),
  }),
  (u) => {
    const { grid_n: n, grid_half_width_sd: half, tau_a, tau_b } = u.params;
    for (const [name, axis, tau] of [['a', u.axes.a, tau_a], ['b', u.axes.b, tau_b]] as const) {
      if (axis.length !== n) return `axes.${name} has ${axis.length} points, params.grid_n is ${n}`;
      const expected = gridAxis(tau, n, half);
      const off = axis.findIndex((x, i) => Math.abs(x - expected[i]!) > 1e-9 * Math.max(1, Math.abs(x)));
      if (off >= 0) return `axes.${name}[${off}] does not follow the grid definition`;
    }
    return null;
  },
);
export type UpdateSpecFile = ReturnType<typeof updateSpecFile>;

// nowcast_*.json (the next hours' state, fog and quests per site; pipeline/nowcast.py) --------------

const nowcastSite = obj({
  code: str,
  name: str,
  lat: num,
  lon: num,
  grid_lat: num,
  grid_lon: num,
  offset: str,
  p10: arr(num),
  p50: arr(num),
  p90: arr(num),
  fog: arr(num),
  fog_rain: arr(num),
  fog_local: arr(num),
  state: arr(literal(...FOG_STATES)),
  r48_p50_mm: arr(num),
  r48_p90_mm: arr(num),
  /** OneAquaHealth's sample at the site followed 1 mm or more of rain in the 3 days before; null: no sample. */
  oah_sampled_after_rain: optional(nullable(bool)),
  oah_sample_date: optional(nullable(isoDate)),
});

const quest = obj({
  code: str,
  name: str,
  best_hour_utc: utcInstant,
  best_hour_local: offsetDateTime,
  window_start_local: offsetDateTime,
  window_end_local: offsetDateTime,
  window_start_utc: utcInstant,
  window_end_utc: utcInstant,
  fog_72h_mean_before: num,
  fog_72h_mean_after_expected: num,
  fog_reduction_expected: num,
  fog_at_hour_before: num,
  fog_at_hour_after_expected: num,
  p50_at_hour: num,
  state_at_hour: literal(...FOG_STATES),
  r48_median_mm_at_hour: num,
  tied_sites: arr(str),
  /** Rain forecast inside the quest window, mm: median and 90th percentile over the members. */
  rain_window_mm_p50: optional(num),
  rain_window_mm_p90: optional(num),
  benefit_hours: optional(int),
  /** The window as the site's local weekday and part of day ("Wednesday afternoon"; nowcast.py when_local). */
  when_local: str,
  /** The window lies in or just after rain (48 h rain to its end at or above thresholds.wet_mm_2d). */
  after_rain: bool,
  /** The city's other quests whose sample clears exactly as much fog. */
  tied_with: arr(str),
  window_rain_mm_p50: num,
  /** Hours from sampling to the E. coli result (pipeline/config.py LAB_TURNAROUND_H), and when the best hour's result is ready. */
  lab_turnaround_h: optional(num),
  result_ready_utc: optional(utcInstant),
});

const NOWCAST_SERIES = ['p10', 'p50', 'p90', 'fog', 'fog_rain', 'fog_local', 'state', 'r48_p50_mm', 'r48_p90_mm'] as const;

export const nowcastFile = (id: CityId) =>
  refine(
    obj({
      city: literal(id),
      timezone: str,
      model_version: str,
      forecast_fetched_utc: utcInstant,
      first_hour_utc: utcInstant,
      hours_utc: arr(utcInstant, { minLength: 1 }),
      hours_local: arr(offsetDateTime, { minLength: 1 }),
      quests: arr(quest),
      /** Later rounds (pipeline/nowcast.py FOURTH DATED CHANGE): the quests from sampling hours at or after from_utc. */
      later_quests: optional(arr(obj({ from_utc: utcInstant, from_local: offsetDateTime, quests: arr(quest) }))),
      sites: arr(nowcastSite, { minLength: 1 }),
      thresholds: optional(obj({ higher: num, high: num, unknown_fog: num })),
      meaning: optional(record(str)),
    }),
    (n) => {
      const h = n.hours_utc.length;
      if (n.hours_local.length !== h) return `hours_local has ${n.hours_local.length} entries, hours_utc ${h}`;
      if (n.hours_utc[0] !== n.first_hour_utc) return 'first_hour_utc is not hours_utc[0]';
      for (const s of n.sites)
        for (const k of NOWCAST_SERIES) if (s[k].length !== h) return `site ${s.code}: ${k} has ${s[k].length} hours, expected ${h}`;
      return null;
    },
  );
export type NowcastFile = ReturnType<ReturnType<typeof nowcastFile>>;

// city_model.json (the city model fit; pipeline/citymodel.py) --------------------------------------

const modelSample = obj({ time_utc: utcInstant, time_local: naiveDateTime, ecoli_per_100ml: num, over_900: bool, r48_mm: num });

export const cityModelFile = obj({
  chosen: str,
  why: str,
  alpha: num,
  beta: num,
  tau_a: num,
  tau_b: num,
  count_scale_s: num,
  t_higher: num,
  t_high: num,
  fog_unknown: num,
  t_high_r48_mm: num,
  t_higher_r48_mm: num,
  p_dry: num,
  candidates: record(obj({ cells: record(record((v) => v)), mean_brier: num, alpha_new_site: num, beta: num, site_alpha: record(num) })),
  train_n: int,
  train_exceedances: int,
  bath_train_n: int,
  bath_test_n: int,
  toulouse_n: int,
  gauge_vs_openmeteo: record((v) => v),
  rain: record(str),
  preregistration: str,
  samples: record(arr(modelSample)),
});
export type CityModelFile = ReturnType<typeof cityModelFile>;

// dark_hours.json (W2: the rain before each sample; pipeline/darkhours.py) ------------------------

const dryCounts = obj({ n: int, dry: int, not_dry: int, rain_missing: int });
const darkRow = {
  site: str,
  site_name: str,
  city: str,
  date: isoDate,
  rain_1d_mm: nullable(num),
  rain_3d_mm: nullable(num),
  rain_7d_mm: nullable(num),
  dry: nullable(bool),
};

export const darkHoursFile = obj({
  definition: str,
  rain_sources: record(str),
  note_900: str,
  summary: obj({
    oneaquahealth: dryCounts,
    toulouse_garonne: dryCounts,
    bath_warleigh: dryCounts,
    oneaquahealth_by_city: record(dryCounts),
  }),
  oneaquahealth: arr(obj({ ...darkRow, scaled_fecal_risk: optional(nullable(num)), health_risk_score: optional(nullable(num)) })),
  toulouse_garonne: arr(obj({ ...darkRow, rain_2d_mm: nullable(num), ecoli_per_100ml: num, over_900: bool, r48_era5_mm: nullable(num) })),
  bath_warleigh: arr(obj({ ...darkRow, time_local: naiveDateTime, ecoli_per_100ml: num, over_900: bool, r48_era5_mm: nullable(num) })),
});
export type DarkHoursFile = ReturnType<typeof darkHoursFile>;

// streams/<id>.json (the app's stream pack; sayr/web/scripts/build_streams.py) --------------------------

const streamStation = obj({ code: str, name: str, off_m: num, km: num });
const chainedStream = obj({
  name: str,
  osm_ids: arr(int),
  line: arr(lonLat, { minLength: 2 }),
  km: arr(num, { minLength: 2 }),
  length_km: num,
  stations: arr(streamStation, { minLength: 1 }),
  /** Ground elevation (m) at each point, baked from the terrain tiles at dem_zoom. */
  E: optional(arr(num)),
});
const packWay = obj({
  id: int,
  kind: literal('river', 'stream', 'minor'),
  name: str,
  c: arr(lonLat, { minLength: 2 }),
  site: arr(int),
  S: arr(num),
  chain: optional(int),
  km: optional(arr(num)),
  E: optional(arr(num)),
});

export const streamPackFile = (id: CityId) =>
  refine(
    obj({
      city: literal(id),
      name: str,
      center: lonLat,
      about: str,
      station_snap_m: num,
      dem_zoom: optional(int),
      hours_utc: arr(utcInstant, { minLength: 1 }),
      sites: arr(obj({ code: str, name: str, lat: num, lon: num, E: optional(num) }), { minLength: 1 }),
      streams: arr(chainedStream),
      ways: arr(packWay),
      cells: arr(obj({ grid: tuple2(num, num), sites: arr(str, { minLength: 1 }), r48_mm: arr(arr(num, { minLength: 1 })) }), { minLength: 1 }),
    }),
    (p) => {
      const h = p.hours_utc.length;
      for (const s of p.streams) {
        if (s.km.length !== s.line.length) return `stream ${s.name}: ${s.km.length} km values for ${s.line.length} points`;
        if (s.E && s.E.length !== s.line.length) return `stream ${s.name}: ${s.E.length} elevations for ${s.line.length} points`;
        for (let i = 1; i < s.stations.length; i++) if (s.stations[i]!.km < s.stations[i - 1]!.km) return `stream ${s.name}: stations not sorted by km`;
      }
      for (const w of p.ways) {
        if (w.site.length !== w.c.length || w.S.length !== w.c.length || (w.E && w.E.length !== w.c.length)) return `way ${w.id}: per-vertex arrays do not match its ${w.c.length} points`;
        if (w.site.some((k) => k >= p.sites.length)) return `way ${w.id}: site index out of range`;
        if (w.chain !== undefined && (w.chain >= p.streams.length || w.km?.length !== w.c.length)) return `way ${w.id}: bad chain reference`;
      }
      for (const c of p.cells) if (c.r48_mm.length !== h) return `cell ${c.grid.join(',')}: ${c.r48_mm.length} hours, expected ${h}`;
      return null;
    },
  );
export type StreamPackFile = ReturnType<ReturnType<typeof streamPackFile>>;
export type ChainedStream = ReturnType<typeof chainedStream>;
export type PackWay = ReturnType<typeof packWay>;
