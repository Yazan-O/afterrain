// The city scene (spec section 4): the night terrain map with its streams as flowing light (rest), a stream
// lifting off the map and straightening into a line (unroll), and the forecast's hours below it, one thin thread
// of water per hour, with the four lives on its bank (strip). Place runs across (true downstream distances), time
// runs down; a thread's colour is the estimated chance of the single-sample flag, its fog the missing knowledge.
// A test reading recomputes the field outward from the sampled place and hour, and the x-ray reads the record of
// what is on screen. Every colour, fog value and sentence comes from CityState through the along-stream rule;
// every motion reads the app clock.
import type { Feature, FeatureCollection } from 'geojson';
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import type { CityId, NowcastFile } from '../data/schemas';
import type { FogState, Observation } from '../engine/fog';
import { formatClock, formatDayMonth, formatDayTime, formatZone, localParts } from '../engine/timefmt';
import { pointOnStream, type SiteSeries } from '../model/alongStream';
import { CityState, type FullSeries } from '../model/cityState';
import { forecastRecord, registerLive, testRecord, type LiveRecord } from '../fhir/liveRecords';
import { activeRound, nextQuest as nextQuestOf, questClaim, resultTiming, windowOpen, windowText, windowTextAfterDate, type Round } from '../model/quest';
import { hourSentence, testResultLine, WET_MM } from '../model/sentence';
import { humanSentence, type Piece } from '../model/humanSentence';
import { planDemo } from '../model/demo';
import { formatNumber } from '../format/numfmt';
import type { Scene, SceneContext, Theme } from '../scenes/types';
import { buildGeometry, computeField, emptyField, evalNetwork, fillFieldRows, forecastNow, stripRows, NX, stationAt, stripBaseHour, type Chain, type CityGeometry, type Field, type Way } from './cityData';
import { FIGURE_KINDS, figureSvg, type FigureKind, type Level } from './figures';
import { DATA_BASE_URL } from '../data/loaders';
import { demSource, DEM_MAXZOOM, EXAGGERATION, hillLayer, LABEL_OPACITY, LABEL_OPACITY_DIM, mapStyle, PAINT, PAL, wwColor, type CameraLike, type Palette, type RGB } from './mapStyle';
import { CMP, compareLayout, compareScale, stippleAlong } from './compareLayout';
import { probabilityColour } from './probabilityColour';
import { clamp, easeIO, easeOut, hash, lerp, sstep } from './util';
import { crossesLine, NEAR, overlaps, placeNear, placeOnCurve, rect, rectDist, type Rect } from './labelPlace';

type Phase = 'rest' | 'settle' | 'opening' | 'strip' | 'closing' | 'compare';
const GUESS_WORD = ['usual', 'higher', 'high'] as const;
/** The reveal after a test reading: the recomputed field spreads out from the sampled place and hour. */
const LIFT_MS = 3000;
/**
 * The strip's word budget: the place, the selected hour with its date, the downstream direction and the estimate
 * with its unit are never cut; the other labels give way by priority (tests/e2e/harness/checks.ts WORD_BUDGETS).
 */
const STRIP_WORDS = 34;
/** The story's slow move down the strip to the forecast's peak-risk hour. */
const STORM_SCRUB_MS = 4600;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hh = (n: number): string => String(n).padStart(2, '0');
/** Coimbra opens with a close camera; other cities open on the fit of their stations. */
const CLOSE_VIEWS: Partial<Record<CityId, { desktop: CameraLike; phone: CameraLike }>> = {
  CO: {
    desktop: { center: [-8.443, 40.221], zoom: 12.3, pitch: 54, bearing: -14 },
    phone: { center: [-8.444, 40.222], zoom: 11.55, pitch: 46, bearing: -14 },
  },
};


interface Layout {
  phone: boolean;
  xL: number;
  xR: number;
  lineY: number;
  fT: number;
  fB: number;
  vt: number;
  vs: number;
  vw: number;
  fs: number;
  gap: number;
  back: [number, number, number];
}

interface Quest {
  /** Its place in its round's list: 0 is the round's quest #1, the sample with the largest expected fog reduction. */
  readonly rank: number;
  /** The code of its round's quest #1 (a quest tied with it clears as much fog). */
  readonly firstCode: string;
  /** 0: the nowcast's saved quests; 1 and on: a later round from the forecast's remaining hours. */
  readonly round: number;
  readonly code: string;
  readonly name: string;
  /** The readable name (src/model/names.ts). */
  readonly display: string;
  readonly fields: NowcastFile['quests'][number];
  readonly bestMs: number;
  readonly startMs: number;
  readonly endMs: number;
}

interface Lift {
  ci: number;
  km: number;
  row: number;
  prog: number;
  /** How far the wipe travels by its end: past the field's furthest corner. */
  reach: number;
  before: Field;
  /** The sample read "over 900": the change radiates out as a warm wave. */
  over: boolean;
  /** The line's chance and fog before the sample (ahead of the wipe). */
  lineP: Float32Array;
  lineF: Float32Array;
}

interface Blob {
  ll: readonly [number, number];
  w: Way;
  k: number;
  e: number;
  r: number;
  a: number;
  ph: number;
  sp: number;
  x: number;
  y: number;
  s: number;
}

interface TransformLike {
  locationToScreenPoint(ll: maplibregl.LngLat, terrain: unknown): { x: number; y: number };
}

declare global {
  interface Window {
    sayr?: Record<string, unknown>;
  }
}

const radial = (stops: [number, string][]): HTMLCanvasElement => {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return c;
};
/**
 * The mist's grain: a fine stipple of single-pixel dots over a faint wash, tiled. Drawn at device resolution so it
 * reads as mist, not cloud. Deterministic (hash), so film renders repeat exactly.
 */
const grainTex = (dot: RGB, dotA: number, wash: RGB, washA: number, frac = 0.26): HTMLCanvasElement => {
  const S = 192;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    const h = hash(i * 0.731 + 17.3);
    const isDot = h > 1 - frac;
    const rgb = isDot ? dot : wash;
    d[4 * i] = rgb[0];
    d[4 * i + 1] = rgb[1];
    d[4 * i + 2] = rgb[2];
    d[4 * i + 3] = Math.round(255 * (isDot ? dotA * (0.45 + 0.55 * hash(i * 3.17 + 1.1)) : washA));
  }
  g.putImageData(img, 0, 0);
  return c;
};
const glowSprite = (rgb: RGB): HTMLCanvasElement =>
  radial([
    [0, `rgba(${rgb.join(',')},.95)`],
    [0.12, `rgba(${rgb.join(',')},.55)`],
    [0.4, `rgba(${rgb.join(',')},.12)`],
    [1, `rgba(${rgb.join(',')},0)`],
  ]);
const MASK_STOPS: [number, string][] = [
  [0, 'rgba(255,255,255,1)'],
  [0.5, 'rgba(255,255,255,.55)'],
  [1, 'rgba(255,255,255,0)'],
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
};

/** The viewer has opened a stream this session: the "tap a stream" cue has done its work. */
let viewerTapped = false;

export function createCityScene(city: CityId): Scene & { route(params: readonly string[]): void; view(): { cam: CameraLike; river: [number, number] | null } | null } {
  let ctx!: SceneContext;
  let root!: HTMLElement;
  let disposed = false;
  const offs: (() => void)[] = [];

  // ----- state -----
  let cs!: CityState;
  let geo!: CityGeometry;
  let nowcast!: NowcastFile;
  let zone = 'UTC';
  let map!: MLMap;
  let theme: Theme = 'night';
  let pal: Palette = PAL.night;
  let W = innerWidth;
  let H = innerHeight;
  let DPR = Math.min(2, devicePixelRatio || 1);
  const phoneW = (): boolean => W < 700;
  let phase: Phase = 'rest';
  let sel: Chain | null = null;
  let hoverCi = -1;
  let restA = 1;
  let introA = 0;
  let introT0 = 0;
  let morphE = 0;
  let unroll = 0;
  let hNow = 0;
  /** Story mode shows the map at the example test reading's hour from its key beat to the fold (null: the clock's hour). */
  let storyHour: number | null = null;
  let hb = 0;
  let evalHour = -1;
  let evalRev = -1;
  let evalHeld = false;
  let field: Field | null = null;
  let lift: Lift | null = null;
  /** The last test reading's run (its reveal and its line); the story's test cue waits on it. */
  let sampling: Promise<void> = Promise.resolve();
  let questA = 1;
  let dirty = true;
  let elevReady = false;
  /** The terrain's exaggeration now: 0 until its tiles are in when the pack carries elevations, then it rises. */
  let exag = EXAGGERATION;
  let riseT0 = -1;
  let mapShown = false;
  /** The stream the link asks for (null: the city at rest); every animation ends by moving toward it. */
  let want: string | null = null;
  /** Bumps when a stream opens or closes, or the scene unmounts: a step of an older animation stops there. */
  let gen = 0;
  /** Where the viewer had the camera before a stream opened: the stream folds back to it. */
  let restCam: CameraLike | null = null;
  /** The hour the viewer has scrubbed the strip to, from its first row (0: the sentence for now). */
  let scrubH = 0;
  /** The strip's span in hours after its first row: to the forecast's end, at most a week (cityData.stripRows). */
  let span = 72;
  let voiceMode: 'sentence' | 'figure' | 'quest' | 'kit' | 'result' | 'hour' | 'calm' | 'request' | 'next' = 'sentence';
  /** The strip row a test reading is assumed collected at: the selected hour when the kit opened. */
  let testRow = 0;
  /**
   * The test reading on the open strip, until "Reset test" or the strip closes: its place and hour, the reading,
   * the field before it ("Hold before" shows it) and the result line. The reading itself stays in the model
   * (`readings`, `cs`); reopening its stream shows it here again.
   */
  let test: { code: string; row: number; over: boolean; before: Field; line: string; site: string; prior: FullSeries } | null = null;
  /** "Hold before" is pressed: the map, the line, the field, the readouts and the record show the state before the test. */
  let holding = false;
  /**
   * The test readings in the model, by site, until "Reset test": the reading, its collection hour (an index of the
   * forecast's hours) and time, stored once when it is taken, and what a strip needs to show it again.
   */
  interface Reading {
    readonly code: string;
    readonly hour: number;
    readonly collectedUtc: string;
    readonly over: boolean;
    readonly line: string;
    readonly site: string;
    readonly prior: FullSeries;
    /** The stream's field from before the reading, for the strip it was built for (its first row and span). */
    before: { hb: number; span: number; field: Field } | null;
  }
  const readings = new Map<string, Reading>();
  /** A site's series as the screen shows it: from before the test while "Hold before" is pressed. */
  const seriesFull = (code: string): FullSeries => (holding && test && code === test.code ? test.prior : cs.series(code));
  const seriesShown = (code: string): SiteSeries => seriesFull(code);
  const stationShown = (code: string, h: number): ReturnType<typeof stationAt> => stationAt(cs, code, h, seriesFull(code));
  /**
   * Story mode's opening: a labelled test demonstration on the Ribeira das Eiras at one
   * fixed hour (src/model/demo.ts), shown as a comparison (see "the opening comparison"). Null in free exploration.
   */
  let opening: { ci: number; code: string; up: string; hour: number; rule: string } | null = null;
  const done = new Set<string>();
  const taught = new Set<string>();
  let lastRealFrame = 0;
  let myHooks: Record<string, unknown> | null = null;
  const perf = { n: 0, gaps: [] as number[], ms: { project: 0, flow: 0, fog: 0, lamps: 0, strip: 0 } };

  // ----- DOM -----
  let worldEl!: HTMLDivElement;
  let veilEl!: HTMLDivElement;
  let mapEl!: HTMLDivElement;
  let RC!: HTMLCanvasElement;
  let rc!: CanvasRenderingContext2D;
  let SC!: HTMLCanvasElement;
  let sc!: CanvasRenderingContext2D;
  let voiceEl!: HTMLDivElement;
  let questEl!: HTMLDivElement;
  let backBtn!: HTMLButtonElement;
  let lnowEl!: HTMLDivElement;
  let scrubEl!: HTMLDivElement;
  let lkmEl!: HTMLDivElement;
  let daysEl!: HTMLDivElement;
  let ui!: HTMLDivElement;
  let axisDownEl!: HTMLDivElement;
  let axisTimeEl!: HTMLDivElement;
  const stationEls: HTMLDivElement[] = [];
  let estEl!: HTMLDivElement;
  let fogEl!: HTMLDivElement;
  let rainEl!: HTMLDivElement;
  /** The curve's scale words ("Chance over 900 E. coli/100 ml", "100%", "0%"), its result mark's word and "Hours". */
  let axisPEl!: HTMLDivElement;
  let scaleEls: HTMLDivElement[] = [];
  /** The time axis' first and last dates, the day of the month under each end ("2", "9"). */
  let endEls: HTMLDivElement[] = [];
  let resultEl!: HTMLDivElement;
  /** The collection hour's word on the time axis ("Sample"), each curve's name, and the value's connector. */
  let sampleEl!: HTMLDivElement;
  let beforeEl!: HTMLDivElement;
  let withEl!: HTMLDivElement;
  let leadEl!: HTMLDivElement;
  let hoursBtn!: HTMLButtonElement;
  let winEl!: HTMLSpanElement;
  let whenEl!: HTMLSpanElement;
  let testedEl!: HTMLSpanElement;
  /** The flag's value as numbers.json gives it ("900"), for the readings' words. */
  let flagText = '900';
  let figsEl!: HTMLDivElement;
  let bankSvg!: SVGSVGElement;
  let mistSvg!: SVGSVGElement;
  let teachEl!: HTMLDivElement;
  let tapCueEl!: HTMLDivElement;
  /** The site's name beside its lamp while the opening asks for its sample. */
  let nameEl!: HTMLDivElement;
  let navEl!: HTMLElement;
  let questBtn!: HTMLButtonElement;
  /** The story's last control: "Sample <site>", the next eligible sampling site. */
  let nextBtn!: HTMLButtonElement;
  /** The comparison's words: the two ribbons' names and readouts, the fog's, the direction and the unit. */
  let cmpEls!: { site: HTMLElement; bl: HTMLElement; al: HTMLElement; bv: HTMLElement; av: HTMLElement; fog: HTMLElement; scale: HTMLElement; ref: HTMLElement; unit: HTMLElement };
  let cmpWhenEl!: HTMLSpanElement;
  const figEls = {} as Record<FigureKind, HTMLElement>;

  // ----- textures -----
  let GRAIN!: HTMLCanvasElement;
  let grainPatR: CanvasPattern | null = null;
  let FC!: HTMLCanvasElement;
  let fgf!: CanvasRenderingContext2D;
  /** Glow sprites by chance (20 steps of the one ramp), made as they are needed. */
  let glows = new Map<number, HTMLCanvasElement>();
  const glowOf = (p: number): HTMLCanvasElement => {
    const k = Math.round(clamp(p, 0, 1) * 20);
    let g = glows.get(k);
    if (!g) glows.set(k, (g = glowSprite(probabilityColour(k / 20, theme))));
    return g;
  };
  const MASK = radial(MASK_STOPS);
  const fogC = document.createElement('canvas');
  const fg = fogC.getContext('2d')!;
  const FL = document.createElement('canvas');
  const fl = FL.getContext('2d')!;

  const setTextures = (): void => {
    // by day the mist is a darker stipple on a light wash, so it reads on paper without greying the colours out
    GRAIN = theme === 'night' ? grainTex([196, 206, 203], 0.95, [120, 131, 128], 0.2) : grainTex([92, 100, 98], 0.85, [243, 241, 234], 0.3, 0.2);
    grainPatR = null;
    fogDrawnAt = -1;
    glows = new Map();
  };
  /** The fog's stipple: neutral, the same in every state (only how many dots show changes). */
  const STIPPLE: Record<Theme, string> = { night: 'rgba(170,181,178,.7)', day: 'rgba(92,100,98,.8)' };

  // ----- time -----
  const hourLabel = (h: number): string => formatClock(cs.hoursMs[Math.round(h)]!, zone);
  const msOfRow = (r: number): number => cs.hoursMs[Math.min(cs.hoursMs.length - 1, hb + r)]!;

  /**
   * The animations' steps: run by the scene's one clock listener before its frame, so the camera a step moves is
   * the camera the frame projects the streams with (a step run after the frame left the streams a frame behind).
   */
  const steps = new Set<() => void>();
  const tween = (ms: number, fn: (e: number) => void): Promise<void> =>
    new Promise((res) => {
      if (ctx.reducedMotion || ms <= 0) {
        fn(1);
        res();
        return;
      }
      const s0 = ctx.clock.seconds();
      const step = (): void => {
        const e = clamp((ctx.clock.seconds() - s0) / (ms / 1000), 0, 1);
        fn(e);
        if (e >= 1) {
          off();
          res();
        }
      };
      steps.add(step);
      const off = (): void => void steps.delete(step);
      offs.push(off);
    });
  const wait = (ms: number): Promise<void> => tween(ms, () => undefined);

  // ----- quests -----
  const siteDisplay = (code: string, name: string): string => {
    for (const c of geo.chains) for (const s of c.stations) if (s.code === code) return s.display;
    return name;
  };
  const toQuests = (list: NowcastFile['quests'], round: number): Quest[] =>
    list.map((q, rank) => ({
      rank,
      firstCode: list[0]!.code,
      round,
      code: q.code,
      name: q.name,
      display: siteDisplay(q.code, q.name),
      fields: q,
      bestMs: Date.parse(q.best_hour_utc),
      startMs: Date.parse(q.window_start_utc),
      endMs: Date.parse(q.window_end_utc),
    }));
  // The saved quests (round 0), then the later rounds the pipeline computed from the forecast's remaining hours.
  let roundsOf: { src: NowcastFile; rounds: Round<Quest>[] } | null = null;
  const rounds = (): Round<Quest>[] => {
    if (roundsOf?.src !== nowcast)
      roundsOf = {
        src: nowcast,
        rounds: [
          { fromMs: Date.parse(nowcast.first_hour_utc), quests: toQuests(nowcast.quests, 0) },
          ...(nowcast.later_quests ?? []).map((r, i) => ({ fromMs: Date.parse(r.from_utc), quests: toQuests(r.quests, i + 1) })),
        ],
      };
    return roundsOf.rounds;
  };
  const hasStrip = (q: Quest): boolean => geo.chains.some((c) => c.stations.some((s) => s.code === q.code));
  /** The round on offer at the clock; -1 when the remaining forecast hours hold no request (the dated fallback). */
  const roundNow = (): number => activeRound(rounds(), nowMs(), done, hasStrip);
  /** The quests on offer: the active round's, or the saved quests when no round has an open one. */
  const quests = (): Quest[] => rounds()[Math.max(0, roundNow())]!.quests.slice();
  const questOpen = (q: Quest): boolean => !done.has(q.code) && windowOpen(nowMs(), q.endMs);
  // The lamp on the map: the active round's quest #1 (the sample with the largest expected fog reduction) while it is
  // open and its site has a strip; the next in rank otherwise. The rest view frames every quest site, so it is on screen.
  const restQuest = (): Quest | null => nextQuestOf(quests(), nowMs(), done, hasStrip);

  // ----- the forecast's reach: live, or a dated forecast that no longer covers the clock -----
  /** The forecast covers the clock with a full strip after it (cityData.forecastNow). */
  const live = (): boolean => !storyDated && forecastNow(cs.hoursMs, ctx.clock.ms()).live;
  /** "Now" for the scene: the clock while the forecast covers it, else the forecast's own first hour (dated). */
  const nowMs = (): number => (storyDated ? cs.hoursMs[0]! : forecastNow(cs.hoursMs, ctx.clock.ms()).nowMs);
  /**
   * Story mode's scenario: when no quest with a strip is open at the clock, the story plays the forecast as it was
   * supplied, from its own first hour, and says so (dated), so the opening always has its quest.
   */
  let storyDated = false;
  // The quest on a strip: at its best hour, or at the strip's first hour once that has passed while the window is open.
  const stripQuest = (ch: Chain): (Quest & { km: number; row: number }) | null => {
    for (const q of quests()) {
      const st = ch.stations.find((s) => s.code === q.code);
      if (!st || !questOpen(q)) continue;
      const row = Math.max(0, cs.hourOf(q.bestMs) - hb);
      if (row > span) continue;
      return { ...q, km: st.km, row };
    }
    return null;
  };

  // ----- map -----
  /**
   * Per way and vertex, how far inside the city's waterway extract it lies (1 in the core, 0 at the extract's edge):
   * the network dissolves toward the edge instead of stopping at a rectangle. Named streams are never faded.
   */
  let EF: Float32Array[] = [];
  const edgeOf = (w: Way): Float32Array => (EF[w.idx] ??= w.chain >= 0 && w.kind !== 'river' ? new Float32Array(w.n).fill(1) : Float32Array.from(w.c, (c) => edgeFade(c)));
  function mapFeatures(): FeatureCollection {
    const F: Feature[] = [];
    const eq = (w: Way, k: number): number => Math.round(edgeOf(w)[k]! * 5) / 5;
    // the chance in steps of 2% (a line is split where its step changes): no visible jump between neighbours
    const pq = (w: Way, k: number): number => (w.kind === 'river' ? 0 : Math.round(clamp(w.p50[k]!, 0, 1) * 50) / 50);
    const feat = (w: Way, a: number, b: number): Feature => ({
      type: 'Feature',
      properties: { id: w.id, p: pq(w, a), k: w.kind, e: eq(w, a) },
      geometry: { type: 'LineString', coordinates: w.c.slice(a, b + 1).map((p) => [p[0], p[1]]) },
    });
    for (const w of geo.ways) {
      let s = 0;
      for (let k = 1; k < w.n; k++) if (pq(w, k) !== pq(w, s) || eq(w, k) !== eq(w, s)) {
        F.push(feat(w, s, k));
        s = k;
      }
      if (w.n - 1 > s) F.push(feat(w, s, w.n - 1));
    }
    return { type: 'FeatureCollection', features: F };
  }

  // The rest view. The city opens on its close framing (Coimbra's close camera; elsewhere the fit of its
  // stations), and a moment after the map is complete glides once, slowly, at the same bearing and pitch, to the
  // closest framing that still holds the city's centre and the lamp of quest #1 inside the screen's clear area
  // (the city up the screen, the quest nearer the camera when it lies that way). Under reduced motion it opens
  // there. The viewer may pan and zoom within the city from either.
  const BEARING = -14;
  const pitchNow = (): number => (phoneW() ? 46 : 54);
  const fit = (pts: readonly (readonly [number, number])[], bearing: number, pad: { top: number; bottom: number; left: number; right: number }): CameraLike | null => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    const cam = map.cameraForBounds(
      [
        [x0, y0],
        [x1, y1],
      ],
      { padding: pad, pitch: pitchNow(), bearing },
    );
    if (!cam?.center || cam.zoom === undefined) return null;
    const c = maplibregl.LngLat.convert(cam.center);
    return { center: [c.lng, c.lat], zoom: Math.min(13.2, cam.zoom), pitch: pitchNow(), bearing };
  };
  const stationPts = (): (readonly [number, number])[] => geo.chains.flatMap((c) => c.stations.map((s) => c.line[kIndex(c, s.km)]!));
  const closeView = (): CameraLike => {
    const fixed = CLOSE_VIEWS[city];
    if (fixed) return { ...(phoneW() ? fixed.phone : fixed.desktop) };
    return (
      fit(stationPts(), BEARING, phoneW() ? { top: 120, bottom: 140, left: 20, right: 20 } : { top: 140, bottom: 140, left: 180, right: 180 }) ?? {
        center: cs.pack.center as [number, number],
        zoom: 12,
        pitch: pitchNow(),
        bearing: BEARING,
      }
    );
  };
  let questCam: { key: string; cam: CameraLike } | null = null;
  const questView = (): CameraLike => {
    const key = `${W}x${H}`;
    if (questCam?.key === key) return questCam.cam;
    const close = closeView();
    const q = restQuest();
    const site = q ? cs.pack.sites.find((s) => s.code === q.code) : undefined;
    let cam = close;
    if (site) {
      // the clear area: away from the wordmark, the day and night control, and the name and links at the foot
      const box = phoneW() ? { x0: 72, x1: W - 72, y0: H * 0.24, y1: H - 210 } : { x0: 140, x1: W - 140, y0: H * 0.24, y1: H - 170 };
      const inBox = (p: { x: number; y: number }): boolean => p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1;
      const t0 = map.getCenter(),
        z0 = map.getZoom(),
        b0 = map.getBearing(),
        p0 = map.getPitch();
      // what the close framing is about: its own centre on a wide screen; on a phone, narrower than that framing,
      // the city's centre (city_<id>.json)
      const [cx, cy] = phoneW() ? cs.pack.center : close.center;
      const holds = (c: CameraLike): boolean => {
        map.jumpTo({ ...c, padding: ZERO_PAD });
        return inBox(map.project([cx, cy])) && inBox(map.project([site.lon, site.lat]));
      };
      if (!holds(close)) {
        // the highest zoom, and at it the centre along the line from the city to the quest, that holds both
        const along = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9, 0.05, 0.95, 0, 1];
        let found = false;
        search: for (let z = close.zoom; z > close.zoom - 3.5; z -= 0.05)
          for (const s of along) {
            const c: CameraLike = { center: [lerp(cx, site.lon, s), lerp(cy, site.lat, s)], zoom: z, pitch: close.pitch, bearing: close.bearing };
            if (holds(c)) {
              cam = c;
              found = true;
              break search;
            }
          }
        // nothing holds both: the lamp itself, a little nearer the camera than the middle
        if (!found) cam = { center: [site.lon, site.lat + 0.004], zoom: close.zoom - 0.6, pitch: close.pitch, bearing: close.bearing };
      }
      map.jumpTo({ center: t0, zoom: z0, bearing: b0, pitch: p0 });
    }
    questCam = { key, cam };
    return cam;
  };
  /** The camera has finished its opening glide (or needed none). */
  let camSettled = false;
  let glideGen = 0;
  const view = (): CameraLike => (camSettled ? questView() : closeView());
  function settleCamera(): void {
    camSettled = true;
    root.dataset['camera'] = 'settled';
    void wait(ctx.reducedMotion ? 0 : 300).then(teachRest);
  }
  /**
   * One slow, eased glide from the close framing to the quest's, clock-driven; any touch of the map stops it. It
   * starts two seconds after the basemap and terrain are complete (never while the land is still rising), and
   * waits for them at most four seconds.
   */
  async function glide(): Promise<void> {
    const g = ++glideGen;
    // mounted underneath (story mode): the glide waits until the city is on screen
    while (hiddenLayer() && g === glideGen && !disposed) await wait(100);
    for (let i = 0; i < 80 && root.dataset['map'] !== 'idle' && g === glideGen; i++) await wait(50);
    await wait(2000);
    if (g !== glideGen || phase !== 'rest' || disposed) return;
    const to = questView();
    const c = map.getCenter();
    if (Math.abs(to.zoom - map.getZoom()) < 0.01 && Math.hypot(to.center[0] - c.lng, to.center[1] - c.lat) < 1e-5) return settleCamera();
    await flyTo({ ...to, padding: ZERO_PAD }, 4200, easeIO, () => g === glideGen && phase === 'rest');
    if (g === glideGen) settleCamera();
  }
  /** The opening glide was cut short by the viewer's own touch before it held the quest's lamp. */
  let glideCut = false;
  const stopGlide = (): void => {
    if (camSettled) return;
    glideGen++;
    glideCut = true;
    settleCamera();
  };
  /** After a cut glide, once the viewer lets go: if quest #1's lamp is off the screen, the camera brings it back. */
  function afterViewerMove(): void {
    if (!glideCut || phase !== 'rest' || disposed) return;
    glideCut = false;
    const q = restQuest();
    const site = q ? cs.pack.sites.find((s) => s.code === q.code) : undefined;
    if (!site) return;
    const pt = map.project([site.lon, site.lat]);
    const m = phoneW() ? 48 : 80;
    if (pt.x > m && pt.x < W - m && pt.y > H * 0.15 && pt.y < H - 150) return;
    const g = ++glideGen;
    void flyTo({ ...questView(), padding: ZERO_PAD }, 1800, easeIO, () => g === glideGen && phase === 'rest');
  }

  // Projection: map.project() with terrain queries the DEM on every call; each vertex carries its ground elevation
  // in metres (baked into the stream pack by build_streams.py, else measured once from the loaded terrain) and is
  // projected through the map's own transform at the terrain's current exaggeration (falls back to map.project()).
  const LLq = new maplibregl.LngLat(0, 0);
  const FAKE = {
    v: 0,
    getElevationForLngLat(): number {
      return this.v;
    },
    getElevationForLngLatZoom(): number {
      return this.v;
    },
  };
  let fastOK = true;
  const proj = (ll: readonly [number, number], e: number): { x: number; y: number } => {
    if (fastOK) {
      try {
        LLq.lng = ll[0];
        LLq.lat = ll[1];
        FAKE.v = e * exag;
        return (map as unknown as { transform: TransformLike }).transform.locationToScreenPoint(LLq, FAKE);
      } catch {
        fastOK = false;
      }
    }
    return map.project([ll[0], ll[1]]);
  };
  /** Ground elevation (m) from the loaded terrain, for a pack without baked elevations. */
  const elevAt = (ll: readonly [number, number]): number => {
    try {
      const T = (map as unknown as { terrain?: { exaggeration: number; getElevationForLngLatZoom(ll: maplibregl.LngLat, z: number): number } }).terrain;
      if (!T || !T.exaggeration) return 0;
      LLq.lng = ll[0];
      LLq.lat = ll[1];
      // at the terrain's deepest zoom: the covering-tile search of getElevationForLngLat costs a millisecond a call
      return (T.getElevationForLngLatZoom(LLq, DEM_MAXZOOM) || 0) / T.exaggeration;
    } catch {
      return 0;
    }
  };
  let elevJobs: { o: { E: Float32Array; n: number }; c: readonly (readonly [number, number])[]; k: number }[] | null = null;
  let elevI = 0;
  const startElev = (): void => {
    elevJobs = [];
    elevI = 0;
    for (const w of geo.ways) {
      for (let k = 0; k < w.n; k += 3) elevJobs.push({ o: w, c: w.c, k });
      if ((w.n - 1) % 3) elevJobs.push({ o: w, c: w.c, k: w.n - 1 });
    }
    for (const ch of geo.chains) {
      for (let k = 0; k < ch.n; k += 3) elevJobs.push({ o: ch, c: ch.line, k });
      if ((ch.n - 1) % 3) elevJobs.push({ o: ch, c: ch.line, k: ch.n - 1 });
    }
  };
  /** The fallback elevation pass: at most ELEV_BUDGET_MS of each frame, so the page never blocks. */
  const ELEV_BUDGET_MS = 8;
  const runElev = (): void => {
    if (!elevJobs) return;
    const J = elevJobs;
    const t0 = performance.now();
    while (elevI < J.length) {
      const j = J[elevI++]!;
      j.o.E[j.k] = elevAt(j.c[j.k]!);
      if ((elevI & 31) === 0 && performance.now() - t0 > ELEV_BUDGET_MS) return;
    }
    for (const o of [...geo.ways, ...geo.chains])
      for (let k = 0; k < o.n; k++) {
        if (k % 3 === 0 || k === o.n - 1) continue;
        const a = k - (k % 3);
        const b = Math.min(o.n - 1, a + 3);
        o.E[k] = o.E[a]! + ((o.E[b]! - o.E[a]!) * (k - a)) / (b - a);
      }
    for (const b of blobs) b.e = b.w.E[b.k]!;
    for (const s of lamps) s.e = elevAt(s.ll);
    elevJobs = null;
    elevReady = true;
    introT0 = ctx.clock.seconds();
    dirty = true;
  };

  // ----- the streams on the map's own ground -----
  // map.project() reads the ground from the terrain's DEM at the zoom of its covering tiles, falling back to a parent
  // tile while a tile loads: the ground the map draws its rivers on. Each vertex's elevation (w.E, ch.E, metres) is
  // read the same way, once whenever that zoom changes or a DEM tile arrives (only the vertices under that tile),
  // never per frame; the baked elevations stand in until the terrain is there.
  type TerrainLike = {
    exaggeration: number;
    getElevationForLngLat(ll: maplibregl.LngLat, tr: unknown): number;
    getElevationForLngLatZoom(ll: maplibregl.LngLat, z: number): number;
    _getOverscaledTileIDFromLngLatZoom(ll: maplibregl.LngLat, z: number): { tileID: unknown; mercatorX: number; mercatorY: number };
    getDEMElevation(id: unknown, x: number, y: number, extent: number): number;
  };
  const EXT = 8192;
  let liveZ = -1;
  let liveCam = '';
  let liveAll = true;
  let liveOK = true;
  const tileDirty: [number, number, number, number][] = [];
  const bboxes = new Map<object, [number, number, number, number]>();
  const bboxOf = (o: object, c: readonly (readonly [number, number])[]): [number, number, number, number] => {
    let b = bboxes.get(o);
    if (!b) {
      b = [180, 90, -180, -90];
      for (const p of c) b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
      bboxes.set(o, b);
    }
    return b;
  };
  const tileBox = (c: { z: number; x: number; y: number }): [number, number, number, number] => {
    const n = 2 ** c.z;
    const lat = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    return [(c.x / n) * 360 - 180, lat(c.y + 1), ((c.x + 1) / n) * 360 - 180, lat(c.y)];
  };
  /** The zoom map.project() reads the terrain at for this camera (the deepest of its covering tiles). */
  const terrainZoom = (T: TerrainLike): number => {
    let z = liveZ;
    const own = T.getElevationForLngLatZoom;
    T.getElevationForLngLatZoom = (ll, zz) => ((z = zz), own.call(T, ll, zz));
    try {
      T.getElevationForLngLat(map.getCenter(), (map as unknown as { transform: unknown }).transform);
    } finally {
      T.getElevationForLngLatZoom = own;
    }
    return z;
  };
  function liveElev(): void {
    if (!elevReady || !liveOK) return;
    const T = (map as unknown as { terrain?: TerrainLike }).terrain;
    if (!T) return;
    try {
      const cam = camKey();
      if (cam !== liveCam) {
        liveCam = cam;
        const z = terrainZoom(T);
        if (z !== liveZ) {
          liveZ = z;
          liveAll = true;
        }
      }
      if (!liveAll && !tileDirty.length) return;
      const raw = (ll: readonly [number, number]): number => {
        LLq.lng = ll[0];
        LLq.lat = ll[1];
        const r = T._getOverscaledTileIDFromLngLatZoom(LLq, liveZ);
        return T.getDEMElevation(r.tileID, r.mercatorX % EXT, r.mercatorY % EXT, EXT);
      };
      const hit = (b: [number, number, number, number]): boolean => liveAll || tileDirty.some((t) => b[0] <= t[2] && b[2] >= t[0] && b[1] <= t[3] && b[3] >= t[1]);
      for (const w of geo.ways) if (hit(bboxOf(w, w.c))) for (let k = 0; k < w.n; k++) w.E[k] = raw(w.c[k]!);
      for (const ch of geo.chains) if (hit(bboxOf(ch, ch.line))) for (let k = 0; k < ch.n; k++) ch.E[k] = raw(ch.line[k]!);
      for (const b of blobs) b.e = b.w.E[b.k]!;
      for (const l of lamps) l.e = raw(l.ll);
      liveAll = false;
      tileDirty.length = 0;
      dirty = true;
    } catch (e) {
      // a MapLibre without these internals: the baked elevations stay
      liveOK = false;
      console.warn('city: live terrain elevations unavailable', e);
    }
  }
  /**
   * The map renders now, in this frame, when it has a render pending (a camera step, its own pan or zoom, a tile):
   * the streams are then projected with the camera the map has just drawn, and both reach the screen together.
   */
  function renderMapNow(): void {
    const m = map as unknown as { _frameRequest?: AbortController | null };
    if (!m._frameRequest) return;
    try {
      map.redraw();
    } catch {
      /* the map renders on its own frame */
    }
  }

  let blobs: Blob[] = [];
  // Fog thins out toward the edge of the city's waterway extract, so the extract's rectangle never shows.
  let extract: [number, number, number, number] | null = null;
  const extractBox = (): [number, number, number, number] => {
    if (!extract) {
      // the dense core of the extract (ways crossing its edge are kept whole, so the raw extent overshoots)
      const xs = geo.ways.flatMap((w) => w.c.map((c) => c[0])).sort((a, b) => a - b);
      const ys = geo.ways.flatMap((w) => w.c.map((c) => c[1])).sort((a, b) => a - b);
      const q = (v: number[], f: number): number => v[Math.floor((v.length - 1) * f)]!;
      extract = [q(xs, 0.01), q(ys, 0.01), q(xs, 0.99), q(ys, 0.99)];
    }
    return extract;
  };
  const edgeFade = (ll: readonly [number, number]): number => {
    const [x0, y0, x1, y1] = extractBox();
    const dm = Math.min((ll[0] - x0) * geo.proj.kx, (x1 - ll[0]) * geo.proj.kx, (ll[1] - y0) * geo.proj.ky, (y1 - ll[1]) * geo.proj.ky);
    return sstep(400, 4200, dm);
  };
  const makeBlobs = (): void => {
    blobs = [];
    let i = 0;
    for (const w of geo.ways) {
      if (w.kind === 'river') continue;
      let k = 0;
      for (let s = 90; s < w.L; s += 260) {
        while (k < w.n - 2 && w.cd[k + 1]! < s) k++;
        const u = w.fog[k]!;
        const a = sstep(0.45, 0.98, u) * edgeFade(w.c[k]!);
        if (a < 0.05) continue;
        const h = hash(++i * 7.1);
        blobs.push({ ll: w.c[k]!, w, k, e: w.E[k]!, r: 90 + 170 * sstep(0.5, 1, u) + h * 40, a, ph: h * 6.28, sp: 0.4 + hash(i * 3.3) * 0.8, x: 0, y: 0, s: 1 });
      }
    }
  };

  interface SiteLamp {
    code: string;
    ll: readonly [number, number];
    e: number;
    x: number;
    y: number;
    ci: number;
  }
  let lamps: SiteLamp[] = [];

  let mpp0 = 1;
  const MPP = (): number => (40075016.686 * Math.cos((cs.pack.center[1] * Math.PI) / 180)) / (512 * Math.pow(2, map.getZoom()));

  function project(): void {
    for (const w of geo.ways) {
      let x0 = 1e9,
        y0 = 1e9,
        x1 = -1e9,
        y1 = -1e9;
      for (let k = 0; k < w.n; k++) {
        const p = proj(w.c[k]!, w.E[k]!);
        const ok = Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x - W / 2) < W * 2 && p.y > -H && p.y < H * 3;
        w.P[2 * k] = ok ? p.x : NaN;
        w.P[2 * k + 1] = ok ? p.y : NaN;
        if (!ok) continue;
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
      w.vis = x1 > -80 && x0 < W + 80 && y1 > -80 && y0 < H + 80 && Number.isFinite(x0);
    }
    if (phase === 'rest' || phase === 'settle' || phase === 'compare')
      for (const ch of geo.chains)
        for (let k = 0; k < ch.n; k++) {
          const p = proj(ch.line[k]!, ch.E[k]!);
          ch.P[2 * k] = p.x;
          ch.P[2 * k + 1] = p.y;
        }
    const dLon = 200 / geo.proj.kx;
    for (const b of blobs) {
      const p = proj(b.ll, b.e);
      const q = proj([b.ll[0] + dLon, b.ll[1]], b.e);
      b.x = p.x;
      b.y = p.y;
      b.s = Math.hypot(q.x - p.x, q.y - p.y) / 200;
    }
    if (probe) projCam = camKey();
    for (const s of lamps) {
      const p = proj(s.ll, s.e);
      s.x = p.x;
      s.y = p.y;
    }
    dirty = false;
  }
  const projectChainFlat = (ch: Chain): void => {
    for (let k = 0; k < ch.n; k++) {
      const p = map.project([ch.line[k]![0], ch.line[k]![1]]);
      ch.P[2 * k] = p.x;
      ch.P[2 * k + 1] = p.y;
    }
    for (let k = 0; k < ch.n; k++)
      if (!Number.isFinite(ch.P[2 * k]!)) {
        const j = k > 0 ? k - 1 : k + 1;
        ch.P[2 * k] = ch.P[2 * j]!;
        ch.P[2 * k + 1] = ch.P[2 * j + 1]!;
      }
  };

  // ----- the geo-sync probe (tests): where the overlay last drew a set of stream vertices, against where the map's
  // last render put the same ground (map.project with the live terrain); both are what the screen shows -----
  let probe: { v: { w: Way; k: number }[]; drawn: Float64Array; ref: Float64Array } | null = null;
  const camKey = (): string => {
    const c = map.getCenter();
    return [c.lng, c.lat, map.getZoom(), map.getPitch(), map.getBearing()].map((v) => v.toFixed(7)).join(',');
  };
  let projCam = '';
  let renderCam = '';
  const probeDrawn = (): void => {
    if (!probe) return;
    probe.v.forEach(({ w, k }, i) => {
      probe!.drawn[2 * i] = w.P[2 * k]!;
      probe!.drawn[2 * i + 1] = w.P[2 * k + 1]!;
    });
  };
  const probeRendered = (): void => {
    if (!probe) return;
    renderCam = camKey();
    probe.v.forEach(({ w, k }, i) => {
      const p = map.project([w.c[k]![0], w.c[k]![1]]);
      probe!.ref[2 * i] = p.x;
      probe!.ref[2 * i + 1] = p.y;
    });
  };
  const probeError = (): { n: number; max: number; mean: number; lag: boolean } => {
    let n = 0,
      max = 0,
      sum = 0;
    if (probe)
      for (let i = 0; i < probe.v.length; i++) {
        const [x, y, rx, ry] = [probe.drawn[2 * i]!, probe.drawn[2 * i + 1]!, probe.ref[2 * i]!, probe.ref[2 * i + 1]!];
        if (![x, y, rx, ry].every(Number.isFinite) || rx < 0 || rx > W || ry < 0 || ry > H) continue;
        const d = Math.hypot(x - rx, y - ry);
        n++;
        sum += d;
        max = Math.max(max, d);
      }
    return { n, max, mean: n ? sum / n : 0, lag: projCam !== renderCam };
  };

  // ----- evaluation: when the hour or a sample changes -----
  function evaluate(force = false): void {
    const h = cmp ? cmp.hour : (storyHour ?? hNow);
    const hi = Math.floor(h);
    if (!force && hi === evalHour && cs.revision === evalRev && evalHeld === holding) return;
    evalHour = hi;
    evalRev = cs.revision;
    evalHeld = holding;
    evalNetwork(geo, cs, h, seriesShown);
    makeBlobs();
    try {
      (map.getSource('ww') as maplibregl.GeoJSONSource | undefined)?.setData(mapFeatures());
    } catch {
      /* the style may still be loading; the next evaluation sets it */
    }
    updateNav();
    dirty = true;
  }

  // ----- rest drawing -----
  const flowStyle = (w: Way): { sp: number; gap: number; tr: number; lw: number; a: number; spread: number } => {
    if (w.kind === 'river') return { sp: 8, gap: 11, tr: 40, lw: 0.9, a: 0.3, spread: 9 };
    if (w.kind === 'minor') return { sp: 12, gap: 110, tr: 10, lw: 0.7, a: 0.22, spread: 0 };
    const p = w.pm;
    return { sp: 22 + 34 * p, gap: 24 - 16 * sstep(0.2, 0.7, p), tr: 16 + 6 * p, lw: 1.15 + 0.5 * p, a: 0.95, spread: 0 };
  };
  const pos = (P: Float32Array, cd: ArrayLike<number>, n: number, s: number, out: number[], off: number): number => {
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cd[m]! <= s) lo = m;
      else hi = m;
    }
    const t = (s - cd[lo]!) / Math.max(1e-6, cd[hi]! - cd[lo]!);
    const ax = P[2 * lo]!,
      ay = P[2 * lo + 1]!,
      bx = P[2 * hi]!,
      by = P[2 * hi + 1]!;
    let x = ax + (bx - ax) * t;
    let y = ay + (by - ay) * t;
    if (off) {
      const dx = bx - ax,
        dy = by - ay,
        l = Math.hypot(dx, dy) || 1;
      x += (-dy / l) * off;
      y += (dx / l) * off;
    }
    out[0] = x;
    out[1] = y;
    return t < 0.5 ? lo : hi;
  };
  const A = [0, 0],
    Bp = [0, 0],
    Cp = [0, 0];

  function drawFlow(t: number): void {
    const buckets = new Map<number, { c: number; a: number; lw: number; seg: number[] }>();
    const day = theme === 'day';
    const hideSet = sel && phase !== 'rest' && phase !== 'settle' ? sel.ids : null;
    for (const w of geo.ways) {
      if (!w.vis || (hideSet && hideSet.has(w.id))) continue;
      const s = flowStyle(w);
      const gap = s.gap * mpp0,
        sp = s.sp * mpp0,
        tr = s.tr * mpp0;
      const N = Math.max(1, Math.floor(w.L / gap));
      const hov = hoverCi >= 0 && geo.chains[hoverCi]!.ids.has(w.id);
      for (let k = 0; k < N; k++) {
        const h = hash(w.idx * 131 + k * 17);
        const off = s.spread ? (hash(w.idx * 71 + k * 13) - 0.5) * 2 * s.spread : 0;
        let p = ((k + h * 0.7) * gap + (ctx.reducedMotion ? 7.3 : t) * sp * (0.85 + 0.3 * h)) % w.L;
        if (p < 0) p += w.L;
        let a = s.a * (0.55 + 0.45 * hash(k * 3 + w.idx)) * Math.min(1, p / (tr * 1.5 + 1), (w.L - p) / (tr + 1)) * restA;
        if (hov) a = Math.min(1, a * 1.6);
        if (a < 0.04) continue;
        const vi = pos(w.P, w.cd, w.n, p, A, off);
        a *= clamp((A[1]! - H * 0.08) / (H * 0.2), 0, 1) * edgeOf(w)[vi]!;
        if (a < 0.04) continue;
        const c = w.kind === 'river' ? -1 : Math.round(clamp(w.p50[vi]!, 0, 1) * 20);
        const q = Math.round(a * 6);
        const lwq = Math.round(s.lw * 10);
        const bk = ((c + 1) * 8 + q) * 64 + lwq;
        let b = buckets.get(bk);
        if (!b) {
          b = { c, a: q / 6, lw: lwq / 10, seg: [] };
          buckets.set(bk, b);
        }
        pos(w.P, w.cd, w.n, Math.max(0, p - tr * 0.5), Bp, off);
        pos(w.P, w.cd, w.n, Math.max(0, p - tr), Cp, off);
        if (!(Math.abs(A[0]! - Cp[0]!) + Math.abs(A[1]! - Cp[1]!) < 90) || !Number.isFinite(Bp[0]!)) continue;
        b.seg.push(A[0]!, A[1]!, Bp[0]!, Bp[1]!, Cp[0]!, Cp[1]!);
      }
    }
    rc.globalCompositeOperation = pal.comp;
    rc.lineCap = 'round';
    const D = DPR;
    for (const b of buckets.values()) {
      const rgb = (b.c < 0 ? pal.river : probabilityColour(b.c / 20, theme)).join(',');
      const sg = b.seg;
      // the soft glow only on streams (minor ditches and the big rivers are drawn faint without it)
      if (!day && b.lw >= 1) {
        rc.strokeStyle = `rgba(${rgb},${b.a * 0.16})`;
        rc.lineWidth = (b.lw + 3.5) * D;
        rc.beginPath();
        for (let i = 0; i < sg.length; i += 6) {
          rc.moveTo(sg[i]! * D, sg[i + 1]! * D);
          rc.lineTo(sg[i + 2]! * D, sg[i + 3]! * D);
        }
        rc.stroke();
      }
      rc.strokeStyle = `rgba(${rgb},${b.a * (day ? 0.5 : 0.35)})`;
      rc.lineWidth = b.lw * D;
      rc.beginPath();
      for (let i = 0; i < sg.length; i += 6) {
        rc.moveTo(sg[i + 2]! * D, sg[i + 3]! * D);
        rc.lineTo(sg[i + 4]! * D, sg[i + 5]! * D);
      }
      rc.stroke();
      rc.strokeStyle = `rgba(${rgb},${b.a * (day ? 1 : 0.8)})`;
      rc.beginPath();
      for (let i = 0; i < sg.length; i += 6) {
        rc.moveTo(sg[i]! * D, sg[i + 1]! * D);
        rc.lineTo(sg[i + 2]! * D, sg[i + 3]! * D);
      }
      rc.stroke();
      if (!day) {
        rc.fillStyle = `rgba(255,255,255,${b.a * 0.5})`;
        const hs = 1.8 * D;
        for (let i = 0; i < sg.length; i += 6) rc.fillRect(sg[i]! * D - hs / 2, sg[i + 1]! * D - hs / 2, hs, hs);
      }
    }
    rc.globalCompositeOperation = 'source-over';
  }

  // The mist at rest: a density field of soft spots along the waterways (denser where the fog value is higher),
  // rendered as a fine drifting grain at device resolution on its own canvas, its opacity capped (CSS) so the
  // streams' best-guess light stays readable through it. It is redrawn at most 20 times per second, camera moves
  // included, and not at all while the rest view is hidden.
  const MIST_CAP: Record<Theme, number> = { night: 0.62, day: 0.7 };
  let fogDrawnAt = -1;
  function drawFogRest(t: number, alpha: number): void {
    FC.style.opacity = (MIST_CAP[theme] * alpha).toFixed(3);
    if (alpha < 0.01) return;
    // while a stream opens or folds the mist holds its last picture and only fades (the camera is moving anyway)
    if ((phase === 'opening' || phase === 'closing') && fogDrawnAt >= 0) return;
    const FS = 0.3;
    const fw = Math.ceil(W * FS),
      fh = Math.ceil(H * FS);
    if (fogC.width !== fw || fogC.height !== fh) {
      fogC.width = fw;
      fogC.height = fh;
      fogDrawnAt = -1;
    }
    // the mist's own canvas: device pixels on a desktop, CSS pixels on a phone (its grain still reads as mist),
    // redrawn 20 times a second on a desktop and 12 on a phone
    const fr = phoneW() ? 1 : DPR;
    if (FC.width !== Math.round(W * fr) || FC.height !== Math.round(H * fr)) {
      FC.width = Math.round(W * fr);
      FC.height = Math.round(H * fr);
      grainPatR = null;
      fogDrawnAt = -1;
    }
    const tt = ctx.reducedMotion ? 7.3 : t;
    if (fogDrawnAt < 0 || t - fogDrawnAt >= (phoneW() ? 1 / 12 : 0.05) || t < fogDrawnAt) {
      fogDrawnAt = t;
      fg.globalCompositeOperation = 'source-over';
      fg.clearRect(0, 0, fw, fh);
      for (const b of blobs) {
        if (!Number.isFinite(b.x) || b.x < -300 || b.x > W + 300 || b.y < -300 || b.y > H + 300) continue;
        // capped on screen: near the camera a bank of mist would otherwise smear into a band
      const r = Math.min(b.r * b.s, 70) * (1 + 0.1 * Math.sin(tt * 0.2 * b.sp + b.ph)) * FS;
        const dx = Math.sin(tt * 0.05 * b.sp + b.ph) * 14 * b.s * FS;
        const dy = Math.cos(tt * 0.04 * b.sp + b.ph * 1.3) * 6 * b.s * FS;
        fg.globalAlpha = b.a * (0.8 + 0.2 * Math.sin(tt * 0.15 * b.sp + b.ph * 2));
        fg.drawImage(MASK, b.x * FS + dx - r * 1.5, b.y * FS + dy - r * 0.6, r * 3, r * 1.2);
      }
      fg.globalAlpha = 1;
      if (!grainPatR) grainPatR = fgf.createPattern(GRAIN, 'repeat');
      fgf.globalCompositeOperation = 'source-over';
      fgf.clearRect(0, 0, FC.width, FC.height);
      fgf.imageSmoothingEnabled = true;
      fgf.drawImage(fogC, 0, 0, FC.width, FC.height);
      fgf.globalCompositeOperation = 'source-in';
      fgf.save();
      fgf.translate(Math.round((tt * 3.2) % 192), Math.round((tt * 1.1) % 192));
      fgf.fillStyle = grainPatR!;
      fgf.fillRect(-192, -192, FC.width + 384, FC.height + 384);
      fgf.restore();
      fgf.globalCompositeOperation = 'source-over';
    }
  }

  const lampState = (code: string): { p: number; unk: boolean } => {
    const s = stationAt(cs, code, cmp ? cmp.hour : (storyHour ?? hNow));
    return { p: s.p50, unk: s.state === 'unknown' };
  };
  const GUESS_INDEX_OF = (g: 'usual' | 'higher' | 'high'): number => (g === 'high' ? 2 : g === 'higher' ? 1 : 0);

  function drawLamps(t: number): void {
    const D = DPR,
      day = theme === 'day';
    const rq = restQuest();
    for (const s of lamps) {
      if (!Number.isFinite(s.x) || s.y < H * 0.08) continue;
      if (sel && phase !== 'rest' && phase !== 'settle' && sel.stations.some((x) => x.code === s.code)) continue;
      const { p, unk } = lampState(s.code);
      if (!day) {
        rc.globalCompositeOperation = 'lighter';
        const g = (unk ? 22 : 30) * D * (p >= cs.thresholds.high && !ctx.reducedMotion ? 1 + 0.18 * Math.sin(t * 3.2 + s.x) : 1);
        rc.globalAlpha = (unk ? 0.4 : 0.95) * restA;
        rc.drawImage(glowOf(p), s.x * D - g / 2, s.y * D - g / 2, g, g);
        rc.globalCompositeOperation = 'source-over';
      }
      rc.globalAlpha = restA;
      rc.fillStyle = day ? '#f3f1ea' : '#06100e';
      rc.beginPath();
      rc.arc(s.x * D, s.y * D, 3.6 * D, 0, 7);
      rc.fill();
      rc.fillStyle = day ? pal.core : unk ? '#b4bdba' : '#ffffff';
      rc.beginPath();
      rc.arc(s.x * D, s.y * D, 2.3 * D, 0, 7);
      rc.fill();
      if (rq && rq.code === s.code && !cmp) drawQuestLight(rc, s.x, s.y, t, restA);
    }
    rc.globalAlpha = 1;
  }
  /** The quest: one lamp that breathes slowly (no rings), warm on the night map, ink with a soft halo by day. */
  const QGLOW = glowSprite([255, 238, 206]);
  function drawQuestLight(g: CanvasRenderingContext2D, x: number, y: number, t: number, alpha: number): void {
    const D = DPR,
      day = theme === 'day';
    const b = ctx.reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin(t * 1.55);
    if (!day) {
      g.globalCompositeOperation = 'lighter';
      const s = (40 + 26 * b) * D;
      g.globalAlpha = (0.6 + 0.4 * b) * alpha;
      g.drawImage(QGLOW, x * D - s / 2, y * D - s / 2, s, s);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    } else {
      // a paper-coloured halo keeps the ring clear of what is under it
      g.strokeStyle = `rgba(243,241,234,${0.85 * alpha})`;
      g.lineWidth = 4 * D;
      g.beginPath();
      g.arc(x * D, y * D, (8.5 + 3.5 * b) * D, 0, 7);
      g.stroke();
      g.strokeStyle = `rgba(27,35,37,${alpha})`;
      g.lineWidth = 1.6 * D;
      g.beginPath();
      g.arc(x * D, y * D, (8.5 + 3.5 * b) * D, 0, 7);
      g.stroke();
    }
    g.fillStyle = day ? `rgba(27,35,37,${alpha})` : `rgba(255,248,234,${alpha})`;
    g.beginPath();
    g.arc(x * D, y * D, (3.1 + 0.7 * b) * D, 0, 7);
    g.fill();
  }
  function drawHover(): void {
    if (hoverCi < 0 || phase !== 'rest') return;
    const ch = geo.chains[hoverCi]!,
      D = DPR;
    rc.strokeStyle = theme === 'day' ? 'rgba(27,35,37,.35)' : 'rgba(230,240,245,.3)';
    rc.lineWidth = 5 * D;
    rc.lineJoin = 'round';
    rc.lineCap = 'round';
    rc.beginPath();
    for (let k = 0; k < ch.n; k++) {
      const x = ch.P[2 * k]! * D,
        y = ch.P[2 * k + 1]! * D;
      if (k) rc.lineTo(x, y);
      else rc.moveTo(x, y);
    }
    rc.stroke();
  }

  // ----- strip layout -----
  // The sentence at the top, the line with the four lives on its bank, the forecast's hours below. On a phone the line sits
  // just below three lines of the sentence and the far-back figures (no empty band), the field leaves a gutter on the
  // left for the day labels, and the sentence keeps the full width.
  let LY!: Layout;
  const HOURS_BAND = 34,
    HOURS_BAND_PHONE = 48;
  /** The field's bottom without the "Hours" band: the strip's controls under it keep their places in both views. */
  const baseFB = (): number => H - (LY.phone ? 58 : 46);
  const layout = (): Layout => {
    if (!phoneW()) {
      const xL = Math.round(clamp(W * 0.085, 96, 160)),
        lineY = Math.round(H * 0.46);
      // "Hours" keeps a clear band under the field for the selected hour's readouts
      return { phone: false, xL, xR: W - xL, lineY, fT: lineY + 26, fB: H - 46 - (hoursMode ? HOURS_BAND : 0), vt: Math.round(H * 0.1), vs: Math.round(clamp(W * 0.026, 27, 40)), vw: Math.round(Math.min(980, W * 0.68)), fs: 1.75, gap: 118, back: [0, 44, 90] };
    }
    const vt = 66,
      vs = 22;
    // the sentence (three lines), the quest's control or the kit's answers (58 px), then the far-back figures
    const lineY = Math.round(clamp(vt + 3 * vs * 1.06 + 58 + 64 + 62 + 14, H * 0.36, H * 0.5));
    return { phone: true, xL: 48, xR: W - 26, lineY, fT: lineY + 34, fB: H - 58 - (hoursMode ? HOURS_BAND_PHONE : 0), vt, vs, vw: W - 36, fs: 1.1, gap: 80, back: [0, 32, 64] };
  };
  const X = (km: number): number => LY.xL + (km / sel!.L) * (LY.xR - LY.xL);
  /**
   * The strip shows a window of hours (24 on a phone, 48 on a desktop), each hour's row at least 8 px from the next;
   * the rest of the forecast is a scroll away (wheel, a drag past the field's edge, the arrow keys, End).
   */
  let vTop = 0;
  const viewRows = (): number => Math.max(1, Math.min(span, LY.phone ? 24 : 48));
  const pitch = (): number => (LY.fB - LY.fT) / viewRows();
  const Y = (row: number): number => LY.fT + (row - vTop) * pitch();
  /** The strip's hour under a y (fractional, from the strip's first hour). */
  const hourAtY = (y: number): number => vTop + (y - LY.fT) / pitch();
  const rowIn = (r: number): boolean => !hoursMode || (r >= vTop - 1e-6 && r <= vTop + viewRows() + 1e-6);
  /** Moves the window of hours so its first row is `top`. */
  function scrollRows(top: number): void {
    const t = clamp(Math.round(top), 0, Math.max(0, span - viewRows()));
    if (t === vTop) return;
    vTop = t;
    paintField();
    positionStripUI();
  }
  /** Keeps a row inside the window. */
  const follow = (row: number): void => {
    if (row < vTop) scrollRows(row);
    else if (row > vTop + viewRows()) scrollRows(row - viewRows());
  };

  // ----- strip morph -----
  let MD: { n: number; P: Float32Array; Q: Float32Array; lp: Float32Array; lq: Float32Array; ang: Float64Array; anc: number; R: Float64Array; out: Float32Array } | null = null;
  function prepMorph(ch: Chain, xL = LY.xL, xR = LY.xR, y = LY.lineY): void {
    const n = ch.n,
      P = Float32Array.from(ch.P),
      Qt = new Float32Array(2 * n),
      lp = new Float32Array(n),
      lq = new Float32Array(n),
      ang = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      Qt[2 * i] = xL + (ch.km[i]! / ch.L) * (xR - xL);
      Qt[2 * i + 1] = y;
    }
    let prev = 0,
      sum = 0,
      wsum = 0;
    for (let i = 0; i < n - 1; i++) {
      const dx = P[2 * i + 2]! - P[2 * i]!,
        dy = P[2 * i + 3]! - P[2 * i + 1]!;
      lp[i] = Math.hypot(dx, dy);
      lq[i] = Qt[2 * i + 2]! - Qt[2 * i]!;
      let a = lp[i]! > 1e-6 ? Math.atan2(dy, dx) : prev;
      if (i > 0) {
        while (a - prev > Math.PI) a -= 2 * Math.PI;
        while (a - prev < -Math.PI) a += 2 * Math.PI;
      }
      ang[i] = a;
      prev = a;
      sum += a * lq[i]!;
      wsum += lq[i]!;
    }
    const shift = 2 * Math.PI * Math.round(sum / (wsum || 1) / (2 * Math.PI));
    for (let i = 0; i < n - 1; i++) ang[i] = ang[i]! - shift;
    let anc = 0;
    while (anc < n - 1 && ch.km[anc]! < ch.L / 2) anc++;
    MD = { n, P, Q: Qt, lp, lq, ang, anc, R: new Float64Array(2 * n), out: new Float32Array(2 * n) };
  }
  function morphPos(e: number): Float32Array {
    const m = MD!,
      n = m.n,
      out = m.out;
    if (e <= 0) {
      out.set(m.P);
      return out;
    }
    if (e >= 1) {
      out.set(m.Q);
      return out;
    }
    const R = m.R,
      a = m.anc;
    R[2 * a] = 0;
    R[2 * a + 1] = 0;
    for (let i = a; i < n - 1; i++) {
      const l = lerp(m.lp[i]!, m.lq[i]!, e),
        g = m.ang[i]! * (1 - e);
      R[2 * i + 2] = R[2 * i]! + l * Math.cos(g);
      R[2 * i + 3] = R[2 * i + 1]! + l * Math.sin(g);
    }
    for (let i = a - 1; i >= 0; i--) {
      const l = lerp(m.lp[i]!, m.lq[i]!, e),
        g = m.ang[i]! * (1 - e);
      R[2 * i] = R[2 * i + 2]! - l * Math.cos(g);
      R[2 * i + 1] = R[2 * i + 3]! - l * Math.sin(g);
    }
    const ax = lerp(m.P[0]!, m.Q[0]!, e),
      ay = lerp(m.P[1]!, m.Q[1]!, e),
      bx = lerp(m.P[2 * n - 2]!, m.Q[2 * n - 2]!, e),
      by = lerp(m.P[2 * n - 1]!, m.Q[2 * n - 1]!, e);
    const vx = R[2 * n - 2]! - R[0]!,
      vy = R[2 * n - 1]! - R[1]!,
      wx = bx - ax,
      wy = by - ay,
      vv = vx * vx + vy * vy || 1;
    const c = (vx * wx + vy * wy) / vv,
      s = (vx * wy - vy * wx) / vv;
    for (let i = 0; i < n; i++) {
      const rx = R[2 * i]! - R[0]!,
        ry = R[2 * i + 1]! - R[1]!;
      out[2 * i] = ax + c * rx - s * ry;
      out[2 * i + 1] = ay + s * rx + c * ry;
    }
    return out;
  }
  const kIndex = (ch: Chain, km: number): number => {
    let lo = 0,
      hi = ch.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ch.km[m]! <= km) lo = m;
      else hi = m;
    }
    return km - ch.km[lo]! < ch.km[hi]! - km ? lo : hi;
  };

  // ----- strip field -----
  // The hours below the line, one thin thread of water per hour with dark ground between them: down the screen the
  // hours (the first row is the strip's first hour), across it the stream from its source to its mouth at true
  // distances. A thread's colour is the model's estimated chance of the single-sample flag, in three steps at the
  // nowcast's thresholds (cool white usual, amber higher, orange high) and nothing else: no texture, no bloom, no
  // streaks. The fog is the missing knowledge: its density follows the fog value alone, whatever the colour. A test
  // reading recomputes the field; the new threads spread out from the sampled place and hour over LIFT_MS, the old
  // ones ahead of the front ("Hold before" shows the old field whole).
  /** Distance from the lift's origin in (km / 1.6, hours / 16) units: the reveal runs further along time than along the stream. */
  const liftD = (km: number, it: number): number => Math.hypot((km - lift!.km) / 1.6, (it - lift!.row) / 16);
  const liftFront = (): number => lift!.prog * lift!.reach;
  /** 1 once the reveal has passed a cell, 0 ahead of it (a soft front). */
  const behind = (ix: number, it: number): number => 1 - sstep(liftFront() - 0.45, liftFront(), liftD((ix / (NX - 1)) * sel!.L, it));
  /** The field shown: the one before the test while "Hold before" is pressed. */
  const shownField = (): Field => (holding && test ? test.before : field!);
  const fogAt = (ix: number, it: number): number => {
    const i = it * NX + ix;
    return lift ? lerp(lift.before.fog[i]!, field!.fog[i]!, behind(ix, it)) : shownField().fog[i]!;
  };
  const pAt = (ix: number, it: number): number => {
    const i = it * NX + ix;
    return lift ? lerp(lift.before.p50[i]!, field!.p50[i]!, behind(ix, it)) : shownField().p50[i]!;
  };
  const sized = (c: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement => {
    const k = c ?? document.createElement('canvas');
    if (k.width !== w || k.height !== h) {
      k.width = w;
      k.height = h;
    }
    return k;
  };
  let FIELDC: HTMLCanvasElement | null = null;
  /** The threads' width in CSS px: under half the row pitch (dark ground and the fog's stipple between them). */
  const threadW = (): number => clamp(0.36 * pitch(), 0.6, 3.2);
  /** How much of the stipple a fog value shows: the comparison's rule (src/city/compareLayout.ts stippleAlong). */
  const fogCover = (f: number): number => Math.pow(clamp((f - 0.45) / 0.55, 0, 1), 1.4);
  function paintRows(): void {
    if (!sel || !field) return;
    const D = DPR,
      nt = field.nt,
      day = theme === 'day';
    if (FL.width !== W * D || FL.height !== H * D) {
      FL.width = W * D;
      FL.height = H * D;
    }
    fl.clearRect(0, 0, FL.width, FL.height);
    FIELDC = sized(FIELDC, NX, nt);
    const img = new ImageData(NX, nt);
    const A = day ? 1 : 0.95;
    for (let it = 0; it < nt; it++)
      for (let ix = 0; ix < NX; ix++) {
        const rgb = probabilityColour(pAt(ix, it), theme);
        const o = 4 * (it * NX + ix);
        img.data[o] = rgb[0];
        img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2];
        // one opacity for every chance; the source and the mouth fade out over a few columns
        img.data[o + 3] = 255 * A * sstep(0, 3, ix) * sstep(0, 3, NX - 1 - ix);
      }
    FIELDC.getContext('2d')!.putImageData(img, 0, 0);
    const x0 = LY.xL,
      x1 = LY.xR,
      tw = threadW();
    const r0 = Math.max(0, Math.floor(vTop)),
      r1 = Math.min(nt - 1, Math.ceil(vTop + viewRows()));
    // the fog: neutral stipple at fixed places in the dark ground between the hours, more dots where the fog is
    // thicker (a dot never moves), drawn behind the threads so the fog never changes a thread's colour
    const gap = pitch() - tw - 2;
    const lanes = gap >= 6 ? 2 : 1;
    const step = 3;
    const ncol = Math.floor((x1 - x0) / step);
    const ds = Math.max(2, Math.round(1.2 * D));
    fl.fillStyle = STIPPLE[theme];
    fl.beginPath();
    for (let it = r0; it < r1; it++) {
      const y0 = Y(it) + tw / 2 + 1;
      for (let j = 0; j < lanes; j++)
        for (let k = 0; k < ncol; k++) {
          const sd = it * 4099 + k * 7 + j * 3;
          const fx = x0 + (k + hash(sd * 0.37 + 1.3)) * step;
          const ix = clamp(Math.round(((fx - x0) / (x1 - x0)) * (NX - 1)), 0, NX - 1);
          if (hash(sd * 0.71 + 9.1) >= fogCover(0.5 * (fogAt(ix, it) + fogAt(ix, it + 1)))) continue;
          const fy = y0 + ((j + hash(sd * 0.53 + 4.7)) / lanes) * gap;
          fl.rect(Math.round(fx * D), Math.round(fy * D), ds, ds);
        }
    }
    fl.fill();
    fl.imageSmoothingEnabled = true;
    for (let it = r0; it <= r1; it++) fl.drawImage(FIELDC, 0, it, NX, 1, Math.round(x0 * D), Math.round(Y(it) * D - (tw * D) / 2), Math.round((x1 - x0) * D), Math.max(1, Math.round(tw * D)));
  }
  /** The strip's main view, or its hours ("Hours"): one paint function for whichever is on. */
  function paintField(): void {
    if (hoursMode) paintRows();
    else paintCurve();
  }

  // ----- the forecast curve -----
  // The strip's main view: one curve for the strip's place (the station its test, its quest or its middle names),
  // time across the forecast's whole horizon, the chance on a fixed 0 to 100% scale upward. The selected hour is a
  // dot on the curve with its value written beside it, never on a stroke; the quest's sampling window is a faint band
  // and the time its result is ready a mark on the time axis, both from the nowcast; the fog is the stipple along the
  // curve (the comparison's rule). A test adds its recomputed curve while the original stays as a fine dashed line,
  // the change spreading out from the tested hour. "Hours" swaps in the spatial strip (place across, an hour a row).
  let hoursMode = false;
  interface Box {
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
  }
  const curveBox = (): Box => {
    const y0 = LY.fT + (LY.phone ? 60 : 70);
    const y1 = Math.min(LY.fB - (LY.phone ? 50 : 58), y0 + (LY.phone ? 270 : 300));
    return { x0: LY.xL, x1: LY.xR, y0, y1 };
  };
  const cxOf = (r: number, b: Box = curveBox()): number => b.x0 + (clamp(r, 0, span) / Math.max(1, span)) * (b.x1 - b.x0);
  const cyOf = (p: number, b: Box = curveBox()): number => b.y1 - clamp(p, 0, 1) * (b.y1 - b.y0);
  const rowAtX = (x: number): number => {
    const b = curveBox();
    return ((x - b.x0) / (b.x1 - b.x0)) * span;
  };
  /** A strip row (fractional) for an instant; past the forecast's ends it is outside 0..span (never clamped onto them). */
  const rowOfMs = (ms: number): number => (ms - cs.hoursMs[0]!) / 3.6e6 - hb;
  /**
   * The curve's chance and fog at strip row r: during a test's reveal the new values once the change has passed the
   * row (it spreads from the tested hour), the old ones ahead of it; "Hold before" shows the old curve.
   */
  function curveAt(r: number): { p: number; f: number } {
    const code = anchorStation(sel!).code;
    const h = clamp(hb + Math.round(r), 0, cs.hoursMs.length - 1);
    const now = seriesFull(code);
    if (lift && test && test.code === code) {
      const m = 1 - sstep(liftFront() - 0.45, liftFront(), Math.abs(r - lift.row) / 16);
      return { p: lerp(test.prior.p50[h]!, now.p50[h]!, m), f: lerp(test.prior.fog[h]!, now.fog[h]!, m) };
    }
    return { p: now.p50[h]!, f: now.fog[h]! };
  }
  /** The drawn curves' screen points (x, y pairs): the current one, and the one from before the test (or null). */
  let curveXY: Float32Array | null = null;
  let priorXY: Float32Array | null = null;
  /**
   * The sample on the curve: the row it is collected at (the test's hour, the kit's, or the
   * hour the quest offers on this strip) and when its result is ready, that hour plus the lab's turnaround as the
   * nowcast carries it (pipeline/config.py LAB_TURNAROUND_H); `inForecast` is false past the curve's last hour.
   */
  function sampleTiming(): { row: number; readyRow: number; turn: number; src: string; inForecast: boolean } | null {
    if (!sel) return null;
    const q = stripQuest(sel);
    if (!test && !q) return null;
    const row = test ? test.row : voiceMode === 'kit' ? testRow : askRow(q!);
    const code = test ? test.code : q!.code;
    let k = nowcast.quests.findIndex((x) => x.code === code && x.lab_turnaround_h !== undefined);
    if (k < 0) k = nowcast.quests.findIndex((x) => x.lab_turnaround_h !== undefined);
    if (k < 0) return null;
    const turn = nowcast.quests[k]!.lab_turnaround_h!;
    const t = resultTiming(msOfRow(row), turn, msOfRow(span));
    return { row, readyRow: rowOfMs(t.readyMs), turn, src: `nowcast_${city}.json#/quests/${k}/lab_turnaround_h`, inForecast: t.inForecast };
  }
  function paintCurve(): void {
    if (!sel) return;
    const D = DPR,
      day = theme === 'day',
      b = curveBox();
    if (FL.width !== W * D || FL.height !== H * D) {
      FL.width = W * D;
      FL.height = H * D;
    }
    fl.clearRect(0, 0, FL.width, FL.height);
    const n = span + 1;
    const xy = new Float32Array(2 * n),
      ps = new Float32Array(n),
      fs = new Float32Array(n),
      xs = new Float32Array(n),
      ys = new Float32Array(n);
    for (let r = 0; r < n; r++) {
      const v = curveAt(r);
      xs[r] = xy[2 * r] = cxOf(r, b);
      ys[r] = xy[2 * r + 1] = cyOf(v.p, b);
      ps[r] = v.p;
      fs[r] = v.f;
    }
    curveXY = xy;
    const ink = day ? '27,35,37' : '231,238,234';
    // the scale: hairlines at 100%, 50% and 0% (the 0% line is the time axis)
    for (const q of [1, 0.5, 0]) {
      fl.fillStyle = `rgba(${ink},${q === 0 ? (day ? 0.45 : 0.36) : day ? 0.16 : 0.12})`;
      fl.fillRect(Math.round(b.x0 * D), Math.round(cyOf(q, b) * D), Math.round((b.x1 - b.x0) * D), Math.max(1, Math.round(D * (q === 0 ? 1 : 0.6))));
    }
    // the quest's sampling window, from the nowcast: a faint band through the scale
    const q = stripQuest(sel);
    if (q && !test) {
      const a = cxOf(rowOfMs(q.startMs), b),
        z = cxOf(rowOfMs(q.endMs), b);
      fl.fillStyle = `rgba(${ink},${day ? 0.09 : 0.075})`;
      fl.fillRect(Math.round(a * D), Math.round(b.y0 * D), Math.max(Math.round(2 * D), Math.round((z - a) * D)), Math.round((b.y1 - b.y0) * D));
    }
    // the days: a short tick down from the time axis at each local midnight
    fl.fillStyle = `rgba(${ink},${day ? 0.5 : 0.42})`;
    for (let r = 1; r <= span; r++)
      if (localParts(msOfRow(r), zone).hour === 0) fl.fillRect(Math.round(cxOf(r, b) * D), Math.round(b.y1 * D), Math.max(1, Math.round(D * 0.8)), Math.round(5 * D));
    // the sample and its result: a tick across the time axis at the collection hour and one at the hour its result
    // is ready, joined under the axis by the wait between them (to the curve's end when the result comes after it)
    const st = sampleTiming();
    if (st) {
      fl.fillStyle = `rgba(${ink},${day ? 0.85 : 0.8})`;
      const tick = (r: number): void => fl.fillRect(Math.round(cxOf(r, b) * D - 0.6 * D), Math.round((b.y1 - 6) * D), Math.max(1, Math.round(1.3 * D)), Math.round(13 * D));
      // a reading collected before the strip's first hour: no collection tick, and the wait starts at the strip's edge
      if (st.row >= 0) tick(st.row);
      if (st.inForecast && st.readyRow >= 0) tick(st.readyRow);
      const xa = cxOf(Math.max(0, st.row), b),
        xz = st.inForecast ? cxOf(st.readyRow, b) : b.x1;
      fl.fillStyle = `rgba(${ink},${day ? 0.6 : 0.5})`;
      if (xz > xa) fl.fillRect(Math.round(xa * D), Math.round((b.y1 + 6) * D), Math.max(1, Math.round((xz - xa) * D)), Math.max(1, Math.round(D)));
    }
    // the fog: neutral stipple at fixed places along the curve (less fog removes dots, never moves one)
    drawDots(fl, stippleAlong(xs, ys, fs, LY.phone ? 7 : 9, 3, 3, 13), 1);
    // the curve from before the test, while a test is on screen and not held: fine and dashed, in the same ramp
    priorXY = null;
    if (test && !holding && test.code === anchorStation(sel).code) {
      const pp = new Float32Array(n),
        pxy = new Float32Array(2 * n);
      for (let r = 0; r < n; r++) {
        const h = clamp(hb + r, 0, cs.hoursMs.length - 1);
        pp[r] = test.prior.p50[h]!;
        pxy[2 * r] = xs[r]!;
        pxy[2 * r + 1] = cyOf(pp[r]!, b);
      }
      priorXY = pxy;
      fl.globalCompositeOperation = 'source-over';
      strokeRuns(fl, pxy, n, (k) => 0.5 * (pp[k]! + pp[k + 1]!), [[1.3, 1]], 1, [3, 4]);
    }
    // the curve: one opacity for every chance, drawn over (never added to) what is under it
    fl.globalCompositeOperation = 'source-over';
    strokeRuns(fl, xy, n, (k) => 0.5 * (ps[k]! + ps[k + 1]!), day ? [[2.4, 1]] : [[7, 0.12], [2.4, 1]]);
  }
  /** The selected hour on the curve: a dot in its own chance's colour on a ground-coloured ring (nothing added over it). */
  function drawCurvePoint(g: CanvasRenderingContext2D, r: number): void {
    const D = DPR,
      day = theme === 'day';
    const v = curveAt(r);
    const x = cxOf(r),
      y = cyOf(v.p);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = day ? '#f3f1ea' : '#04090a';
    g.beginPath();
    g.arc(x * D, y * D, 6.4 * D, 0, 7);
    g.fill();
    g.strokeStyle = day ? '#1b2325' : '#e7eeea';
    g.lineWidth = 1.2 * D;
    g.stroke();
    g.fillStyle = `rgb(${probabilityColour(v.p, theme).join(',')})`;
    g.beginPath();
    g.arc(x * D, y * D, 3.6 * D, 0, 7);
    g.fill();
  }
  /** A label's box crosses a drawn curve (sampled every 2 px across the box, with a small margin). */
  function hitsCurve(r: DOMRect, pad = 3): boolean {
    for (const xy of [curveXY, priorXY]) {
      if (!xy) continue;
      const n = xy.length / 2;
      for (let k = 0; k < n - 1; k++) {
        const ax = xy[2 * k]!,
          bx = xy[2 * k + 2]!;
        if (bx < r.left - pad || ax > r.right + pad) continue;
        const ay = xy[2 * k + 1]!,
          by = xy[2 * k + 3]!;
        for (let x = Math.max(ax, r.left - pad); x <= Math.min(bx, r.right + pad); x += 2) {
          const y = ay + ((by - ay) * (x - ax)) / Math.max(1e-6, bx - ax);
          if (y >= r.top - pad && y <= r.bottom + pad) return true;
        }
      }
    }
    return false;
  }
  /** The selected value's distance from its point (CSS px), and whether a connector joins them (readouts hook). */
  let estGap = 0;
  let estLead = false;
  /**
   * Places the selected value at the nearest place beside its point that crosses no curve:
   * within NEAR px it needs nothing more; farther, a short connector runs from the point to it. The fog's words go
   * under the value, else over it; where neither is clear of every curve, they give way.
   */
  function placeClear(e: HTMLElement, x: number, y: number, under?: HTMLElement): void {
    const b = curveBox();
    const w = e.offsetWidth || 50,
      h = e.offsetHeight || 18;
    const uw = under && under.dataset['empty'] === undefined ? under.offsetWidth : 0,
      uh = under && under.dataset['empty'] === undefined ? under.offsetHeight + 2 : 0;
    // the value may use the margin right of the curve's end (wide on a desktop) so it stays beside a late point
    const xMax = Math.min(W - 10, b.x1 + (LY.phone ? 2 : 90));
    const inBox = (r: Rect): boolean => r.left >= b.x0 - 2 && r.right <= xMax && r.top >= b.y0 - 4 && r.bottom <= b.y1 - 2;
    const clearOfCurves = (r: Rect): boolean => !crossesLine(r, curveXY ?? []) && !(priorXY && crossesLine(r, priorXY));
    // the value's box keeps 8 px from its point's ring; with the fog's words it wants room for them under or over it
    const ok = (r: Rect): boolean => inBox(r) && clearOfCurves(r) && rectDist(x, y, r) >= 8;
    const withWords = (r: Rect): boolean =>
      ok(r) && (!uw || [rect(r.left, r.bottom + 2, uw, uh - 2), rect(r.left, r.top - uh - 2, uw, uh - 2)].some((u) => inBox(u) && clearOfCurves(u) && rectDist(x, y, u) >= 8));
    const at = placeNear(x, y, w, h, withWords) ?? placeNear(x, y, w, h, ok) ?? { x: clamp(x - w / 2, b.x0, b.x1 - w), y: b.y0 - h - 8, dist: Infinity, lead: true };
    put(e, at.x, at.y);
    estGap = at.dist;
    estLead = at.lead;
    // the connector: a hairline from the point's ring to the value's nearest edge
    leadEl.hidden = !at.lead || phase !== 'strip' || hoursMode;
    if (!leadEl.hidden) {
      const qx = clamp(x, at.x, at.x + w),
        qy = clamp(y, at.y, at.y + h);
      const len = Math.hypot(qx - x, qy - y);
      const ux = (qx - x) / Math.max(1e-6, len),
        uy = (qy - y) / Math.max(1e-6, len);
      leadEl.style.left = `${x + ux * 8}px`;
      leadEl.style.top = `${y + uy * 8}px`;
      leadEl.style.width = `${Math.max(0, len - 11)}px`;
      leadEl.style.transform = `rotate(${Math.atan2(uy, ux)}rad)`;
    }
    if (!under) return;
    delete under.dataset['clash'];
    if (!uw) return;
    const below = rect(at.x, at.y + h + 2, uw, uh - 2);
    const above = rect(at.x, at.y - uh - 2, uw, uh - 2);
    const pick = [below, above].find((u) => inBox(u) && clearOfCurves(u) && rectDist(x, y, u) >= 8);
    if (pick) put(under, pick.left, pick.top);
    else under.dataset['clash'] = '';
  }

  /** Rows whose rain over the 48 hours before reaches WET_MM at the place the strip is about (the sentence's rule). */
  let rainRows: Uint8Array | null = null;
  const evalRain = (): void => {
    if (!sel) return;
    const code = anchorStation(sel).code;
    rainRows = Uint8Array.from({ length: span + 1 }, (_, r) => (cs.rainMm(code, hb + r) >= WET_MM ? 1 : 0));
  };

  // ----- the line's chance and fog at the selected hour (the map line under the strip follows the hour) -----
  let lineP: Float32Array | null = null;
  let lineF: Float32Array | null = null;
  function evalLine(): void {
    if (!sel) return;
    const h = hb + scrubH;
    lineP = new Float32Array(sel.n);
    lineF = new Float32Array(sel.n);
    for (let k = 0; k < sel.n; k++) {
      const p = pointOnStream(sel.stations, seriesShown, sel.km[k]!, h, cs.thresholds);
      lineP[k] = p.p50;
      lineF[k] = p.fog;
    }
  }
  /** The state at a station at the strip's selected hour (the lamps on the line and the four lives read it). */
  const stationNow = (code: string): { p: number; unk: boolean } => {
    const s = stationShown(code, hb + scrubH);
    return { p: s.p50, unk: s.state === 'unknown' };
  };

  let dragging = false;
  /** The latest pointer y (and x, for the curve) of a drag on the strip, applied once per frame. */
  let pendingY: number | null = null;
  let pendingX: number | null = null;
  /** The strip's hour under a pointer: by x on the curve, by y on the hours. */
  const hourAt = (x: number, y: number): number => (hoursMode ? hourAtY(y) : rowAtX(x));
  /** Where the quest's lamp is on the strip: on the curve at its hour, or on the hours at its place and hour. */
  const questPt = (q: Quest & { km: number; row: number }): [number, number] => (hoursMode ? [X(q.km), Y(askRow(q))] : [cxOf(askRow(q)), cyOf(curveAt(askRow(q)).p)]);
  /** "Hours": the spatial strip in place of the curve, or back. */
  function setHours(on: boolean): void {
    if (hoursMode === on || !sel) return;
    hoursMode = on;
    root.classList.toggle('hours', on);
    hoursBtn.setAttribute('aria-pressed', String(on));
    SC.setAttribute('aria-orientation', on ? 'vertical' : 'horizontal');
    LY = layout();
    if (on) follow(Math.round(scrubH));
    paintField();
    positionStripUI();
    if (voiceMode === 'result' && test && !holding) setVoice(resultVoice(), 'result', false);
  }
  /** The curve's words: the dates under the time axis, what the scale measures and its ends, "Hours", the result's mark, the quest's lamp. */
  function curveUI(): void {
    if (!sel) return;
    const b = curveBox();
    const gx = b.x0 - (LY.phone ? 6 : 12);
    daysEl.innerHTML = '';
    for (let r = 1; r <= span; r++) {
      const p = localParts(msOfRow(r), zone);
      if (p.hour !== 0) continue;
      // each midnight: the day of the month (the selected hour's label carries the weekday and the month)
      const s = el('span', 'tick', daysEl, { 'data-time': '' });
      s.textContent = String(p.day);
      put(s, cxOf(r, b), b.y1 + 9, 'c');
    }
    // the time axis' first and last dates: the day of the month under each end, on the second
    // row ("Sample" and its result take the first); the selected hour's label takes an end's place on that day
    endEls.forEach((e, i) => {
      e.textContent = String(localParts(msOfRow(i ? span : 0), zone).day);
      put(e, i ? b.x1 : b.x0, b.y1 + 27, i ? 'r' : 'l');
    });
    // what the scale measures, the flag's meaning beside its number (on a phone, on a second line)
    put(axisPEl, b.x0, b.y0 - (LY.phone ? 45 : 36));
    put(scaleEls[0]!, gx, cyOf(1, b) - 7, 'r');
    put(scaleEls[1]!, gx, cyOf(0, b) - 7, 'r');
    put(hoursBtn, b.x1 + 6, b.y0 - (LY.phone ? 46 : 52), 'r');
    put(axisDownEl, LY.xR, LY.lineY + 9, 'r');
    rainEl.hidden = true;
    // the sample's two marks under their ticks: "Sample" ending at its tick, "Result +24 h" starting at its own (the
    // turnaround from the nowcast), or "Result after forecast" at the curve's end; they never touch
    const st = sampleTiming();
    sampleEl.hidden = resultEl.hidden = !st;
    sampleEl.textContent = 'Sample';
    if (st) {
      if (st.inForecast) {
        const n = document.createElement('span');
        n.dataset['src'] = st.src;
        n.textContent = formatNumber(st.turn, null);
        resultEl.replaceChildren(textNode('Result +'), n, textNode(' h'));
      } else resultEl.replaceChildren(textNode('Result after forecast'));
      const xs = cxOf(Math.max(0, st.row), b);
      const sw = sampleEl.offsetWidth || 50;
      // the gutter left of the time axis takes "Sample" when its tick is at the curve's start
      if (xs - sw >= 4) put(sampleEl, xs + 1, b.y1 + 9, 'r');
      else put(sampleEl, xs - 1, b.y1 + 9);
      const sr = sampleEl.getBoundingClientRect();
      if (st.inForecast) put(resultEl, Math.max(cxOf(st.readyRow, b) - 1, sr.right + 10), b.y1 + 9);
      else {
        put(resultEl, b.x1, b.y1 + 9, 'r');
        // a sample near the curve's end says both in one mark
        if (resultEl.getBoundingClientRect().left < sr.right + 10) {
          resultEl.hidden = true;
          sampleEl.textContent = 'Sample · result after forecast';
          put(sampleEl, xs + 1, b.y1 + 9, 'r');
        }
      }
      // collected before the strip's first hour: no "Sample" mark (the line says the reading's hour); its result
      // keeps its mark while that hour is still on the strip
      if (st.row < 0) {
        sampleEl.hidden = true;
        resultEl.hidden = st.inForecast && st.readyRow < 0;
        if (!st.inForecast) {
          resultEl.replaceChildren(textNode('Result after forecast'));
          put(resultEl, b.x1, b.y1 + 9, 'r');
        } else if (st.readyRow >= 0) put(resultEl, cxOf(st.readyRow, b) - 1, b.y1 + 9);
      }
    }
    const q = stripQuest(sel);
    questBtn.hidden = !q;
    if (q) {
      const [qx, qy] = questPt(q);
      questBtn.style.left = `${qx - 22}px`;
      questBtn.style.top = `${qy - 22}px`;
      questBtn.setAttribute('aria-label', `Quest at ${q.display}. ${questClaim(q)}`);
    }
    positionScrub();
  }
  /** The curve's selected hour: its day and time on the time axis, its value beside its dot (clear of every curve), the fog's words under the value. */
  function curveScrub(): void {
    if (!sel) return;
    const on = phase === 'strip';
    scrubEl.hidden = estEl.hidden = fogEl.hidden = !on;
    if (!on) {
      leadEl.hidden = beforeEl.hidden = withEl.hidden = true;
      bindRecord();
      fitLabels();
      return;
    }
    const b = curveBox();
    const row = Math.round(scrubH);
    const p = localParts(msOfRow(row), zone);
    // the line or the kit already says the selected hour while "Hold before" is pressed, and at the collection
    // hour while the kit, the reading going in or its result is on screen (its "Sample" tick marks it): the axis
    // does not say it twice
    // while a test is on screen the line says the selected hour with its zone ("Test reading · ... Fri 2 16:00 UTC+1",
    // "With test · ...", "Before test · ..."), and the kit says it at the collection hour: the axis does not say it twice
    const sampleRow = test ? test.row : testRow;
    if (holding || (voiceMode === 'result' && test) || (voiceMode === 'kit' && row === sampleRow)) scrubEl.hidden = true;
    // the selected hour with its date in full and its zone: the time axis' own marks are the days of the month. While
    // the quest asks, its window over the strip says the day and the zone ("Fri 2 Oct 15:00–20:00 UTC+1"): the axis
    // says the hour alone ("16:00"), or the day and hour when the hour falls on another day than the window's start
    const q = !questEl.hidden && questEl.dataset['stage'] === 'ask' ? stripQuest(sel) : null;
    const w0 = q ? localParts(q.startMs, zone) : null;
    const onWinDay = !!w0 && w0.day === p.day && w0.month === p.month;
    scrubEl.textContent = q ? `${onWinDay ? '' : `${p.day} ${DAY_MONTH[p.month - 1]} `}${hh(p.hour)}:00` : `${p.day} ${DAY_MONTH[p.month - 1]} ${hh(p.hour)}:00 ${formatZone(msOfRow(row), zone)}`;
    placeScrubLabel(row, b, !onWinDay);
    // a date gives way to the sample's marks where they would touch
    const marks = [sampleEl, resultEl].filter((e) => !e.hidden).map((e) => e.getBoundingClientRect());
    for (const d of daysEl.children as HTMLCollectionOf<HTMLElement>) {
      const r = d.getBoundingClientRect();
      if (marks.some((m) => r.right + 8 > m.left && r.left - 8 < m.right)) d.dataset['clash'] = '';
      else delete d.dataset['clash'];
    }
    const st = anchorStation(sel);
    const rec = recordAt(st.code, clamp(hb + row, 0, cs.hoursMs.length - 1));
    estEl.replaceChildren(...estimateNodes(rec, true));
    const v = curveAt(row);
    // the fog's words follow the selected hour's own fog, in the state on screen ("Hold before": before the test)
    const fogText = fogWords(v.f, st.code);
    fogEl.textContent = fogText;
    if (fogText) delete fogEl.dataset['empty'];
    else fogEl.dataset['empty'] = '';
    placeClear(estEl, cxOf(row, b), cyOf(v.p, b), fogEl);
    placeCurveNames();
    bindRecord();
    fitLabels();
  }
  /**
   * The selected hour's label on the axis' second row, under its point, between the axis' first and last dates. On
   * the day of an end it takes that end's place when it says its date (the same day, with its month); otherwise it
   * moves clear.
   */
  function placeScrubLabel(row: number, b: Box, dated: boolean): void {
    const [e0, e1] = endEls as [HTMLDivElement, HTMLDivElement];
    e0.hidden = e1.hidden = false;
    delete scrubEl.dataset['end'];
    if (scrubEl.hidden) return;
    const p = localParts(msOfRow(row), zone);
    const sameDay = (r: number): boolean => {
      const q = localParts(msOfRow(r), zone);
      return q.day === p.day && q.month === p.month;
    };
    const w = scrubEl.offsetWidth || 120;
    let left = cxOf(row, b) - w / 2;
    const minL = b.x0 + e0.offsetWidth + 10;
    const maxR = b.x1 - e1.offsetWidth - 10;
    if (left < minL) {
      if (dated && sameDay(0)) {
        e0.hidden = true;
        scrubEl.dataset['end'] = 'first';
        left = Math.max(b.x0, left);
      } else left = minL;
    }
    if (left + w > maxR) {
      if (dated && sameDay(span)) {
        e1.hidden = true;
        scrubEl.dataset['end'] = 'last';
        left = Math.min(b.x1 - w, left);
      } else left = maxR - w;
    }
    put(scrubEl, left, b.y1 + 27);
  }
  /** The fog's words at a fog value for a station, as the screen shows it now (a held test is not on screen). */
  function fogWords(f: number, code: string): string {
    if (f < cs.thresholds.unknown_fog) return '';
    return test?.code === code && !holding ? 'Still uncertain' : sampledFlag.get(code) === true ? 'Too few storm samples here' : 'No storm E. coli measurement here';
  }
  /** The readouts' boxes on screen now (the value, its fog words), which the curves' names keep clear of. */
  const readoutRects = (): Rect[] =>
    [estEl, fogEl].filter((e) => !e.hidden && e.dataset['empty'] === undefined && e.dataset['clash'] === undefined).map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
  /**
   * Each curve's name beside its own curve: after a test "With test" by the solid curve and
   * "Before" by the dashed one, each on the side away from the other; while "Hold before" is pressed the one curve
   * on screen is "Before". Before any test, neither.
   */
  function placeCurveNames(): void {
    const b = curveBox();
    const on = phase === 'strip' && !hoursMode && !!test && !!sel && test.code === anchorStation(sel).code && !lift && !!curveXY;
    beforeEl.hidden = withEl.hidden = !on;
    delete beforeEl.dataset['clash'];
    delete withEl.dataset['clash'];
    if (!on) return;
    const taken = readoutRects();
    const dot = [cxOf(Math.round(scrubH), b), cyOf(curveAt(Math.round(scrubH)).p, b)] as const;
    const clear =
      (more: Rect[]) =>
      (r: Rect): boolean =>
        r.left >= b.x0 && r.right <= b.x1 && r.top >= b.y0 - 4 && r.bottom <= b.y1 - 2 && rectDist(dot[0], dot[1], r) > 10 && !crossesLine(r, curveXY!) && !(priorXY && crossesLine(r, priorXY)) && ![...taken, ...more].some((t) => overlaps(r, t, 4));
    const fit = (e: HTMLElement, xy: Float32Array, other: Float32Array | null, more: Rect[]): Rect | null => {
      const w = e.offsetWidth || 60,
        h = e.offsetHeight || 16;
      const at = placeOnCurve(xy, other, w, h, b.x0, b.x1, clear(more));
      if (!at) {
        e.dataset['clash'] = '';
        return null;
      }
      put(e, at.x, at.y);
      return rect(at.x, at.y, w, h);
    };
    if (holding || !priorXY) {
      withEl.hidden = true;
      fit(beforeEl, curveXY!, null, []);
      return;
    }
    const wr = fit(withEl, curveXY!, priorXY, []);
    fit(beforeEl, priorXY, curveXY!, wr ? [wr] : []);
  }
  /** The y of the finger during a drag (beyond the field's edge the window of hours creeps on). */
  let dragY: number | null = null;
  let edgeT = 0;
  function drawStrip(t: number): void {
    const D = DPR,
      day = theme === 'day';
    if (!sel || !field || phase === 'rest' || phase === 'settle' || phase === 'compare' || !MD) return;
    const pts = morphPos(morphE);
    if (unroll > 0) {
      const x0 = LY.xL,
        x1 = LY.xR,
        y0 = LY.fT - 4,
        fh = LY.fB - LY.fT + 8,
        yU = y0 + fh * unroll;
      sc.save();
      sc.beginPath();
      sc.rect((x0 - 2) * D, y0 * D, (x1 - x0 + 4) * D, (yU - y0) * D);
      sc.clip();
      sc.drawImage(FL, 0, 0);
      if (!hoursMode) {
        // the curve's quest lamp at its best hour, and the selected hour's dot
        const q = stripQuest(sel);
        const qRow = q ? askRow(q) : -1;
        if (q && !test && unroll > 0.9) drawQuestLight(sc, cxOf(qRow), cyOf(curveAt(qRow).p), t, sstep(0.9, 1, unroll) * questA);
        if (unroll > 0.95 && !(q && !test && Math.round(qRow) === Math.round(scrubH))) drawCurvePoint(sc, scrubH);
        sc.restore();
        if (phase === 'strip' && document.activeElement === SC && SC.matches(':focus-visible')) {
          const b = curveBox();
          sc.strokeStyle = day ? 'rgba(27,35,37,.7)' : 'rgba(231,238,234,.7)';
          sc.lineWidth = D;
          sc.strokeRect(Math.round((b.x0 - 8) * D) + 0.5, Math.round((b.y0 - 8) * D) + 0.5, Math.round((b.x1 - b.x0 + 16) * D), Math.round((b.y1 - b.y0 + 16) * D));
        }
      } else {
      // the selected hour: its thread a little wider, in its own colours (nothing added over it), with short ink
      // marks just outside the field at both ends
      if (unroll > 0.95 && FIELDC && scrubH <= span && rowIn(scrubH)) {
        const it = Math.round(scrubH);
        const y = Y(it) * D;
        const tw = Math.max(2, Math.round(threadW() * D * 1.6)) + D;
        sc.globalAlpha = 1;
        sc.globalCompositeOperation = 'source-over';
        sc.imageSmoothingEnabled = true;
        sc.drawImage(FIELDC, 0, it, NX, 1, Math.round(x0 * D), Math.round(y - tw / 2), Math.round((x1 - x0) * D), tw);
      }
      const q = stripQuest(sel);
      const lampKm = anchorStation(sel).km;
      const qRow = q ? askRow(q) : -1;
      if (q && !test && unroll > 0.9 && rowIn(qRow)) drawQuestLight(sc, X(q.km), Y(qRow), t, sstep(0.9, 1, unroll) * questA);
      // a small lamp marks the place on the selected thread
      if (unroll > 0.95 && rowIn(scrubH) && !(q && !test && qRow === Math.round(scrubH) && q.km === lampKm)) drawSiteLamp(sc, X(lampKm), Y(scrubH));
      sc.restore();
      if (unroll > 0.95 && scrubH <= span && rowIn(scrubH)) {
        const y = Math.round(Y(Math.round(scrubH)) * D);
        sc.fillStyle = day ? 'rgba(27,35,37,.8)' : 'rgba(231,238,234,.8)';
        const th = Math.max(1, Math.round(1.4 * D));
        sc.fillRect(Math.round((x0 - 10) * D), y - (th >> 1), Math.round(6 * D), th);
        sc.fillRect(Math.round((x1 + 4) * D), y - (th >> 1), Math.round(6 * D), th);
      }
      // the hours after rain: quiet grey ticks in the right margin
      if (rainRows) {
        sc.fillStyle = day ? 'rgba(84,93,91,.75)' : 'rgba(150,162,158,.7)';
        const tx = Math.round((x1 + (LY.phone ? 4 : 8)) * D),
          tl = Math.round((LY.phone ? 7 : 9) * D);
        const th = Math.max(1, Math.round(D * 0.8));
        for (let r = 0; r <= span; r++) if (rainRows[r] && rowIn(r) && Y(r) <= yU) sc.fillRect(tx, Math.round(Y(r) * D - th / 2), tl, th);
      }
      // where the window of hours lies in the whole forecast: a hairline at the screen's edge, the window on it
      if (span > viewRows() && unroll > 0.95) {
        const tx = Math.round((W - (LY.phone ? 6 : 24)) * D);
        const h0 = LY.fT,
          hh_ = LY.fB - LY.fT;
        sc.fillStyle = day ? 'rgba(27,35,37,.22)' : 'rgba(231,238,234,.2)';
        sc.fillRect(tx, Math.round(h0 * D), Math.max(1, Math.round(D * 0.6)), Math.round(hh_ * D));
        sc.fillStyle = day ? 'rgba(27,35,37,.7)' : 'rgba(231,238,234,.7)';
        sc.fillRect(tx - Math.round(D), Math.round((h0 + (vTop / span) * hh_) * D), Math.round(2.6 * D), Math.max(2, Math.round((viewRows() / span) * hh_ * D)));
      }
      // the strip is a slider: in keyboard focus its field carries a thin frame
      if (phase === 'strip' && document.activeElement === SC && SC.matches(':focus-visible')) {
        sc.strokeStyle = day ? 'rgba(27,35,37,.7)' : 'rgba(231,238,234,.7)';
        sc.lineWidth = D;
        sc.strokeRect(Math.round((x0 - 6) * D) + 0.5, Math.round((LY.fT - 6) * D) + 0.5, Math.round((x1 - x0 + 12) * D), Math.round((LY.fB - LY.fT + 12) * D));
      }
      }
    }
    if (morphE > 0 && morphE < 1) {
      const a = 0.35 * (1 - morphE);
      sc.strokeStyle = day ? `rgba(27,35,37,${a})` : `rgba(214,236,247,${a})`;
      sc.lineWidth = D;
      sc.setLineDash([2 * D, 4 * D]);
      sc.beginPath();
      for (let k = 0; k < MD.n; k++) {
        const x = MD.P[2 * k]! * D,
          y = MD.P[2 * k + 1]! * D;
        if (k) sc.lineTo(x, y);
        else sc.moveTo(x, y);
      }
      sc.stroke();
      sc.setLineDash([]);
    }
    drawRibbon(pts, t);
    for (const st of sel.stations) {
      const k = kIndex(sel, st.km);
      const x = pts[2 * k]!,
        y = pts[2 * k + 1]!;
      const { p, unk } = stationNow(st.code);
      if (!day) {
        sc.globalCompositeOperation = 'lighter';
        const g = (unk ? 20 : 26) * D;
        sc.globalAlpha = unk ? 0.45 : 1;
        sc.drawImage(glowOf(p), x * D - g / 2, y * D - g / 2, g, g);
        sc.globalAlpha = 1;
        sc.globalCompositeOperation = 'source-over';
      }
      sc.fillStyle = day ? '#f3f1ea' : '#06100e';
      sc.beginPath();
      sc.arc(x * D, y * D, 4 * D, 0, 7);
      sc.fill();
      sc.fillStyle = day ? pal.core : unk ? '#b4bdba' : '#ffffff';
      sc.beginPath();
      sc.arc(x * D, y * D, 2.5 * D, 0, 7);
      sc.fill();
    }
  }
  /** The small lamp on the selected thread: a bright dot on a ground-coloured ring. */
  function drawSiteLamp(g: CanvasRenderingContext2D, x: number, y: number): void {
    const D = DPR,
      day = theme === 'day';
    g.fillStyle = day ? '#f3f1ea' : '#04090a';
    g.beginPath();
    g.arc(x * D, y * D, 5.2 * D, 0, 7);
    g.fill();
    g.fillStyle = day ? '#1b2325' : '#fff8ea';
    g.beginPath();
    g.arc(x * D, y * D, 3.2 * D, 0, 7);
    g.fill();
  }
  /** Dots of the fog's stipple (x, y pairs in CSS px), neutral, at `alpha`. */
  function drawDots(g: CanvasRenderingContext2D, dots: readonly number[], alpha: number): void {
    if (alpha <= 0.01 || !dots.length) return;
    const D = DPR,
      ds = Math.max(2, Math.round(1.3 * D));
    g.globalAlpha = alpha;
    g.fillStyle = STIPPLE[theme];
    g.beginPath();
    for (let i = 0; i < dots.length; i += 2) g.rect(Math.round(dots[i]! * D - ds / 2), Math.round(dots[i + 1]! * D - ds / 2), ds, ds);
    g.fill();
    g.globalAlpha = 1;
  }
  /**
   * A line in passes [width, alpha], coloured segment by segment by its chance (64 steps of the one ramp: no visible
   * step). Runs of one colour are stroked as one path, so a translucent pass never doubles up at its joints.
   */
  function strokeRuns(g: CanvasRenderingContext2D, pts: ArrayLike<number>, n: number, pSeg: (k: number) => number, passes: readonly (readonly [number, number])[], alpha = 1, dash?: readonly number[]): void {
    const D = DPR;
    g.lineJoin = 'round';
    g.setLineDash(dash ? dash.map((v) => v * D) : []);
    for (const [lw, a] of passes) {
      g.lineWidth = lw * D;
      g.lineCap = a >= 0.9 ? 'round' : 'butt';
      let k = 0;
      while (k < n - 1) {
        const q = Math.round(clamp(pSeg(k), 0, 1) * 64);
        let j = k + 1;
        while (j < n - 1 && Math.round(clamp(pSeg(j), 0, 1) * 64) === q) j++;
        g.strokeStyle = `rgba(${probabilityColour(q / 64, theme).join(',')},${a * alpha})`;
        g.beginPath();
        g.moveTo(pts[2 * k]! * D, pts[2 * k + 1]! * D);
        for (let i = k + 1; i <= j; i++) g.lineTo(pts[2 * i]! * D, pts[2 * i + 1]! * D);
        g.stroke();
        k = j;
      }
    }
    g.setLineDash([]);
  }
  const Pa = [0, 0],
    Pb = [0, 0];
  function drawRibbon(pts: Float32Array, t: number): void {
    const ch = sel!,
      n = ch.n,
      D = DPR,
      day = theme === 'day';
    // the line's chance and fog: the selected hour's once the strip is open (during a lift, the old ones ahead of the wipe)
    const LP = lineP ?? ch.p50,
      LF = lineF ?? ch.fog;
    const ahead = (k: number): boolean => !!lift && liftD(ch.km[k]!, scrubH) > liftFront();
    const pK = (k: number): number => (ahead(k) ? lift!.lineP[k]! : LP[k]!);
    // the fog around the line: stipple at fixed places along it, behind the water
    if (morphE >= 1) {
      const xs = new Float32Array(n),
        ys = new Float32Array(n),
        fs = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        xs[k] = pts[2 * k]!;
        ys[k] = pts[2 * k + 1]!;
        fs[k] = ahead(k) ? lift!.lineF[k]! : LF[k]!;
      }
      drawDots(sc, stippleAlong(xs, ys, fs, LY.phone ? 7 : 9, 3, 3, 3), 1);
    }
    const rise = 1 + 0.5 * Math.sin(Math.PI * clamp(morphE, 0, 1)) * (phase === 'opening' || phase === 'closing' ? 1 : 0);
    const passes: [number, number][] = day
      ? [[2.4, 1]]
      : [
          [12 * rise, 0.07],
          [4.5, 0.22],
          [1.5, 0.95],
        ];
    // drawn over what is under it, never added to it: the line's colour is its chance's colour
    sc.globalCompositeOperation = 'source-over';
    strokeRuns(sc, pts, n, (k) => 0.5 * (pK(k) + pK(k + 1)), passes);
    sc.lineCap = 'round';
    const N = Math.floor(ch.L * (phoneW() ? 9 : 14)),
      sp = 0.32;
    for (let i = 0; i < N; i++) {
      const h = hash(i * 13.7 + ch.ci);
      const s = (((i + h * 0.8) / N) * ch.L + (ctx.reducedMotion ? 7.3 : t) * sp * (0.8 + 0.4 * h)) % ch.L;
      const tail = 0.09 + 0.05 * h;
      const vi = pos(pts, ch.km, n, s, Pa, 0);
      pos(pts, ch.km, n, Math.max(0, s - tail), Pb, 0);
      const a = Math.min(1, s / 0.3, (ch.L - s) / 0.2);
      if (day) {
        sc.strokeStyle = `rgba(243,241,234,${0.9 * a})`;
        sc.lineWidth = 1.2 * D;
      } else {
        sc.strokeStyle = `rgba(${probabilityColour(pK(vi), theme).join(',')},${0.9 * a})`;
        sc.lineWidth = 1.6 * D;
      }
      sc.beginPath();
      sc.moveTo(Pb[0]! * D, Pb[1]! * D);
      sc.lineTo(Pa[0]! * D, Pa[1]! * D);
      sc.stroke();
    }
    sc.globalCompositeOperation = 'source-over';
  }

  // ----- figures and the bank -----
  /** The four at the stream: one riverbank scene, each in one fixed pose (level 1, upright). */
  interface FigState {
    level: Level;
  }
  let figState: Record<FigureKind, FigState> | null = null;
  const figAnim = {} as Record<FigureKind, { x: number; y: number; o: number; tx: number; ty: number; to: number; init: boolean }>;
  for (const k of FIGURE_KINDS) figAnim[k] = { x: 0, y: 0, o: 0, tx: 0, ty: 0, to: 0, init: false };
  let lastFigT = 0;
  function stepFigs(t: number): void {
    const dt = clamp(t - lastFigT, 0, 0.1);
    lastFigT = t;
    const k = ctx.reducedMotion ? 1 : 1 - Math.exp(-dt * 5.5);
    for (const kind of FIGURE_KINDS) {
      const a = figAnim[kind];
      if (!a.init) {
        a.x = a.tx;
        a.y = a.ty + 12;
        a.init = true;
      }
      a.x += (a.tx - a.x) * k;
      a.y += (a.ty - a.y) * k;
      a.o += (a.to - a.o) * k;
      const e = figEls[kind];
      e.style.transform = `translate(${a.x.toFixed(2)}px,${a.y.toFixed(2)}px)`;
      e.style.opacity = a.o.toFixed(3);
    }
  }
  // The bank the four lives stand on: the station a sample has been taken at (they stay where the sample was),
  // else the station with this stream's quest, else the middle station.
  const anchorStation = (ch: Chain): (typeof ch.stations)[number] => {
    const q = stripQuest(ch);
    return (
      ch.stations.find((s) => cs.hasSample(s.code)) ||
      (q && ch.stations.find((s) => s.code === q.code)) ||
      ch.stations[Math.floor((ch.stations.length - 1) / 2)]!
    );
  };
  /** The four stand in fixed poses: who uses the place. What the stream is like is the curve's, the line's and the fog's to say. */
  function computeFigs(): Record<FigureKind, FigState> {
    const out = {} as Record<FigureKind, FigState>;
    for (const k of FIGURE_KINDS) out[k] = { level: 1 };
    return out;
  }
  const figGroup = (): { cx: number; gw: number } => {
    const gw = FIGURE_KINDS.length * LY.gap;
    const lo = LY.xL + gw / 2 + 24,
      hi = LY.xR - gw / 2 - 24;
    const cx = lo <= hi ? clamp(X(anchorStation(sel!).km), lo, hi) : (LY.xL + LY.xR) / 2;
    return { cx, gw };
  };
  function placeFigs(showing: boolean): void {
    if (!sel || !figState) return;
    // the story's composition is the stream and the test: the four wait for free exploration
    const show = showing && !ctx.story;
    const { cx, gw } = figGroup();
    // one bank for all four, a step back from the water: the same ground, the same distance, nobody at the edge
    const footY = LY.lineY - 7 - LY.back[1];
    const inkA = theme === 'day' ? 'rgba(27,35,37,' : 'rgba(231,238,234,';
    const x0 = cx - gw / 2 - 22,
      x1 = cx + gw / 2 + 22;
    const bank = `<path d="M${x0} ${footY + 1.5}H${x1}" stroke="${inkA}.42)" stroke-width="1"/>`;
    FIGURE_KINDS.forEach((k, i) => {
      const e = figEls[k];
      const svg = figureSvg(k, 1);
      const scale = LY.fs * 0.87;
      const fx = cx - gw / 2 + LY.gap * (i + 0.5);
      e.innerHTML = `<svg width="${(svg.w * scale).toFixed(1)}" height="${(svg.h * scale).toFixed(1)}" viewBox="${svg.viewBox}" aria-hidden="true">${svg.paths}</svg>`;
      const vb = svg.viewBox.split(' ').map(Number);
      const an = figAnim[k];
      if (!show && an.o < 0.01) an.init = false;
      an.tx = fx + vb[0]! * scale;
      an.ty = footY + vb[1]! * scale + (show ? 0 : 12);
      an.to = show ? 1 : 0;
    });
    bankSvg.innerHTML = show ? bank : '';
    bankSvg.style.opacity = show ? '1' : '0';
    mistSvg.innerHTML = '';
  }

  // ----- the voice -----
  const sampledFlag = new Map<string, boolean | null | undefined>();
  /** The person's sentence at a place (src/model/humanSentence.ts): place, day, chance in words, why, what to do until when. */
  function humanAt(code: string): ReturnType<typeof humanSentence> {
    const rain = Array.from({ length: cs.hoursMs.length }, (_, h) => cs.rainMm(code, h));
    return humanSentence({ place: siteName(code), zone, nowMs: nowMs(), hoursMs: cs.hoursMs, p: cs.series(code).p50, rainMm: rain, thresholds: cs.thresholds, unmeasuredAfterRain: sampledFlag.get(code) !== true });
  }
  const pieceNodes = (ps: readonly Piece[]): Node[] =>
    ps.map((q) => {
      if (q.ms === undefined) return document.createTextNode(q.text);
      const t = document.createElement('span');
      t.dataset['time'] = '';
      t.textContent = q.text;
      return t;
    });
  /** The open stream's first line: the person's sentence at its place; the curve and the strip under it are the why. */
  function sentence(): Node[] {
    const h = humanAt(anchorStation(sel!).code);
    const out = pieceNodes(h.lead);
    if (h.fog) {
      const f = document.createElement('span');
      f.className = 'vfog';
      f.textContent = h.fog;
      out.push(document.createTextNode(' '), f);
    }
    return out;
  }
  /** The line for the scrubbed hour, at the four lives' bank: the day and hour drawn as a time. */
  function hourVoice(): Node[] {
    const st = anchorStation(sel!);
    const moment = (h: number) => {
      const s = stationShown(st.code, h);
      return { ms: cs.hoursMs[Math.max(0, Math.min(cs.hoursMs.length - 1, Math.round(h)))]!, state: s.state, guess: s.guess, rainMm: s.rainMm };
    };
    // "before" is three hours earlier (one row): the first row of a rise is said as arriving, of a fall as clearing
    const { when, text } = hourSentence(moment(hb + scrubH), zone, moment(hb + scrubH - 3));
    const w = document.createElement('span');
    w.dataset['time'] = '';
    w.textContent = when;
    return [w, document.createTextNode(`. ${text}`)];
  }
  /**
   * The one line over the strip, and the controls under it by stage: 'ask' ("Try a test reading" and the sampling
   * window), 'kit' (the test's date, time and zone, the two readings, the unit), 'testing' (the reading entered,
   * while the field changes), 'result' (the reading, "Hold before", "Reset test"), 'next' (the story's last screen: "Sample <site>" and its window).
   * The FHIR x-ray reads the line as the record of the place at the selected hour (bindRecord).
   */
  type Stage = 'ask' | 'kit' | 'testing' | 'result' | 'next';
  function setVoice(text: string | Node[], stage: false | Stage = false, fade = true): void {
    if (typeof text === 'string') voiceEl.textContent = text;
    else voiceEl.replaceChildren(...text);
    voiceEl.classList.add('on');
    questEl.hidden = !stage;
    questEl.dataset['stage'] = stage || '';
    if (stage) {
      const r = voiceEl.getBoundingClientRect();
      questEl.style.top = `${Math.round(r.bottom + (LY.phone ? 10 : 16))}px`;
    }
    root.classList.toggle('questing', !!stage);
    // the estimate says its unit unless the kit says it: its words follow the stage
    if (sel && phase === 'strip') positionScrub();
    else {
      bindRecord();
      fitLabels();
    }
    if (fade) fadeIn(voiceEl);
  }
  /** A line fades in; while it does it is marked data-fading (the contrast check reads it at full strength). */
  function fadeIn(e: HTMLElement): void {
    e.style.opacity = '0';
    e.dataset['fading'] = '';
    void tween(420, (x) => {
      e.style.opacity = String(easeOut(x));
      if (x >= 1) delete e.dataset['fading'];
    });
  }
  const clearVoice = (): void => {
    voiceEl.classList.remove('on');
    voiceEl.textContent = '';
    delete voiceEl.dataset['fhir'];
    questEl.hidden = true;
    root.classList.remove('questing');
  };

  // ----- self-teaching legend: a state's word appears beside it the first time it shows, then fades -----
  function teach(word: string, rgbCss: string, x: number, y: number): void {
    // the map's key is up: its labels say it, the state word waits for another time
    if (taught.has(word) || ctx.reducedMotion || mapLabels.some((l) => l.on)) return;
    taught.add(word);
    const s = el('span', '', teachEl);
    s.textContent = word;
    s.style.color = rgbCss;
    s.style.left = `${clamp(x, 12, W - 110)}px`;
    s.style.top = `${clamp(y, 60, H - 60)}px`;
    // data-fading marks the word while it fades in or out (the contrast check reads it at full strength)
    s.dataset['fading'] = '';
    void tween(500, (e) => (s.style.opacity = String(e)))
      .then(() => {
        delete s.dataset['fading'];
        return wait(2600);
      })
      .then(() => {
        s.dataset['fading'] = '';
        return tween(600, (e) => (s.style.opacity = String(1 - e)));
      })
      .then(() => s.remove());
  }
  const hideTeach = (): void => {
    for (const s of [...teachEl.children]) s.remove();
  };
  const TEXT_VAR: Record<FogState, string> = { usual: 'var(--t-usual)', higher: 'var(--t-higher)', high: 'var(--t-high)', unknown: 'var(--t-fog)' };
  function teachRest(): void {
    // the "tap a stream" cue comes after the fog's own word has had its turn (never beside it: eight words at rest)
    tapCueFrom = ctx.clock.seconds() + 0.7;
    // a dated forecast's corner already carries its date: the rest view stays within its eight words
    if (!live()) return;
    // the fog first (every stream is unmeasured today), at the densest bank in the middle of the view
    let best: Blob | null = null;
    for (const b of blobs) if (b.x > W * 0.2 && b.x < W * 0.78 && b.y > H * 0.25 && b.y < H * 0.75 && (!best || b.a > best.a)) best = b;
    if (best) teach('unknown', TEXT_VAR.unknown, best.x + 10, best.y - 24);
  }
  // ----- strip labels -----
  // The strip names its own parts, beside them: "Downstream →" above the line and the stations at
  // their places on it; "Time ↓" and the dated day marks in the left gutter; the selected hour's day and time beside
  // its thread; the estimate's word ("Usual estimate") beside the lamp on that thread; the fog's meaning there ("No
  // storm E. coli measurement here", or "Still uncertain" after a test); "After rain" by the rain ticks. The words
  // never pass the strip's budget: the line and its controls come first, then the labels in that order of need.
  function applyLayoutVars(): void {
    const r = root.style;
    r.setProperty('--xl', `${LY.xL}px`);
    r.setProperty('--vl', `${LY.phone ? 18 : LY.xL}px`);
    r.setProperty('--vt', `${LY.vt}px`);
    r.setProperty('--vs', `${LY.vs}px`);
    r.setProperty('--vw', `${LY.vw}px`);
  }
  const countWords = (t: string | null): number => (t ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  /** The words a label shows (its hidden parts left out). */
  const shownWords = (e: HTMLElement): number => {
    let t = '';
    const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!n.parentElement?.closest('[hidden]')) t += n.textContent;
    return countWords(t);
  };
  /** Words the line and its controls show now (the part of the budget the labels cannot take). */
  function fixedWords(): number {
    let n = voiceEl.classList.contains('on') ? countWords(voiceEl.textContent) : 0;
    // the rest view's teaching word can still be fading out as a deep link's strip opens
    n += countWords(teachEl.textContent);
    if (!questEl.hidden)
      for (const c of questEl.children as HTMLCollectionOf<HTMLElement>) if (!c.hidden && getComputedStyle(c).display !== 'none') n += countWords(c.textContent);
    const nm = backBtn.querySelector<HTMLElement>('.nm')!;
    if (!backBtn.hidden && getComputedStyle(nm).display !== 'none') n += countWords(nm.textContent);
    return n;
  }
  /** Shows the labels by need while they fit the budget; the rest wait. */
  function fitLabels(): void {
    if (!sel || !LY || phase === 'compare') return;
    let left = STRIP_WORDS - fixedWords();
    // never cut: the selected hour with its date, the place, the downstream direction, the estimate with its unit
    const days = [...(daysEl.children as HTMLCollectionOf<HTMLElement>)];
    const others = stationEls.filter((e) => e.dataset['sel'] === undefined);
    // the curve: its value, its time and place, what its scale measures and the control that swaps it are never cut;
    // the dates come next, then the fog's words and the result's mark, then the rest
    // while the line itself names the place (the quest's ask, the kit, the reading going in), its label on the
    // stream gives way to the curve's words
    const named = !hoursMode && !questEl.hidden && ['ask', 'kit', 'testing'].includes(questEl.dataset['stage'] ?? '');
    const place = stationEls.filter((e) => e.dataset['sel'] !== undefined);
    for (const e of place) {
      e.classList.toggle('named', named);
      if (named) e.classList.add('off');
    }
    // on the curve the reading marks come before any prose: the selected hour with its zone,
    // what the scale measures with the flag's meaning, its 0% and 100%, the axis' first and last dates, the sample
    // and its result, each curve's name. Once a test is on screen (the ask and the kit named its place) the place's
    // label leads the optional words. These are reserved in the quest's states: the ask, and a test on screen
    // (its result, a scrub, "Hold before"). The sample's marks are reserved through the kit too (the kit says the unit
    // and the flag itself). Elsewhere (the stream's sentence, the hour's sentence) they lead the optional words.
    const stage = questEl.hidden ? '' : (questEl.dataset['stage'] ?? '');
    const reading = stage === 'ask' || stage === 'result';
    // the kit says the unit and the flag beside its readings ("E. coli/100 ml · single-sample flag"): the caption's
    // own "single-sample flag" gives way while the kit or the reading going in is on screen
    axisPEl.querySelector<HTMLElement>('.ssf')!.hidden = stage === 'kit' || stage === 'testing';
    const questing = reading || stage === 'kit' || stage === 'testing';
    const scale = [scaleEls[0]!, scaleEls[1]!];
    const ends = [...endEls];
    const marks = [sampleEl, resultEl];
    const reserved: HTMLElement[] = hoursMode
      ? [scrubEl, ...place, axisDownEl, estEl, hoursBtn]
      : [scrubEl, ...(named || stage === 'result' ? [] : place), estEl, axisPEl, hoursBtn, withEl, beforeEl, ...(questing ? marks : []), ...(reading ? [...scale, ...ends] : [])];
    // on the curve the midnights are one group: all of them or none (a time axis with gaps would misread)
    const want: (HTMLElement | HTMLElement[])[] = hoursMode
      ? [...reserved, fogEl, axisTimeEl, ...others, rainEl, lnowEl, lkmEl, ...days]
      : [...reserved, ...(stage === 'result' && !named ? place : []), ...(reading ? [] : [scale, ends]), ...(questing ? [] : [marks]), fogEl, days, axisDownEl, ...others, lnowEl, lkmEl];
    // a label never lands on the four lives (their bank, above the line, wherever their steps back take them) or on
    // a label already shown (hidden labels keep their layout, so they are measurable)
    const taken: DOMRect[] = [];
    if (!ctx.story && figState) {
      const { cx, gw } = figGroup();
      taken.push(new DOMRect(cx - gw / 2 - 12, LY.lineY - 220, gw + 24, 218));
    }
    const hits = (r: DOMRect): boolean => r.width > 0 && taken.some((o) => r.left < o.right - 1 && r.right > o.left + 1 && r.top < o.bottom - 1 && r.bottom > o.top + 1);
    for (const item of want) {
      if (Array.isArray(item)) {
        const shown = item.filter((d) => d.dataset['clash'] === undefined && !d.hidden);
        const n = shown.reduce((s, d) => s + shownWords(d), 0);
        const fits = n <= left;
        for (const d of item) d.classList.toggle('off', !fits || d.dataset['clash'] !== undefined);
        if (fits) left -= n;
        continue;
      }
      const e = item;
      if (e.classList.contains('named')) {
        e.classList.add('off');
        continue;
      }
      const n = e.dataset['empty'] !== undefined ? Infinity : shownWords(e);
      const kept = reserved.includes(e);
      let fits = (kept ? n < Infinity : n <= left) && e.dataset['clash'] === undefined;
      // a reserved mark is never dropped for touching another label (its placement keeps it clear)
      if (fits && !e.hidden) {
        const r = e.getBoundingClientRect();
        if (hits(r) && !kept) fits = false;
        else taken.push(r);
      }
      e.classList.toggle('off', !fits);
      if (fits && !e.hidden) left -= n;
    }
  }
  /** A label sits at (x, y), aligned by its left edge, centre or right edge. */
  const put = (e: HTMLElement, x: number, y: number, align: 'l' | 'c' | 'r' = 'l'): void => {
    e.style.left = `${Math.round(x)}px`;
    e.style.top = `${Math.round(y)}px`;
    e.style.transform = align === 'c' ? 'translateX(-50%)' : align === 'r' ? 'translateX(-100%)' : '';
  };
  const DAY_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function positionStripUI(): void {
    if (!sel) return;
    applyLayoutVars();
    // the way back: the stream's name with an arrow, where the wordmark sits at rest
    const nm = backBtn.querySelector<HTMLElement>('.nm')!;
    // the readable name (src/model/names.ts); the pack's own name carries its source
    nm.textContent = sel.display;
    if (sel.display === sel.name) nm.dataset['src'] = `streams/${city}.json#/streams/${sel.ci}/name`;
    else delete nm.dataset['src'];
    backBtn.setAttribute('aria-label', `Back to the map of ${cs.pack.name}`);
    const L = sel.L;
    lkmEl.innerHTML = `<span data-src="streams/${city}.json#/streams/${sel.ci}/length_km" data-fmt="${L < 10 ? 'fixed:1' : 'fixed:0'}">${L < 10 ? L.toFixed(1) : Math.round(L).toString()}</span> km`;
    // the strip's first hour: "now" while the forecast covers the clock, else its own day and hour (never "now")
    if (live()) {
      lnowEl.textContent = 'now';
      delete lnowEl.dataset['time'];
    } else {
      const p = localParts(msOfRow(0), zone);
      lnowEl.textContent = `${DAY3[p.weekday]} ${p.day} ${hh(p.hour)}:00`;
      lnowEl.dataset['time'] = '';
    }
    const gx = LY.xL - (LY.phone ? 6 : 14);
    put(lnowEl, gx, LY.lineY - 8, 'r');
    if (!LY.phone) put(lkmEl, LY.xR + 16, LY.lineY - 8);
    else put(lkmEl, LY.xR, LY.lineY + 9, 'r');
    // the axes: downstream above the line's mouth end, time at the head of the gutter
    // "Downstream →" above the line's mouth end; where the four lives stand on the line (free exploration), under
    // the field's end instead, clear of them
    if (!ctx.story) put(axisDownEl, LY.xR - (LY.phone ? 22 : 0), baseFB() + 8, 'r');
    else put(axisDownEl, LY.xR, LY.lineY - (LY.phone ? 46 : 52), 'r');
    put(axisTimeEl, gx, LY.fT - 4, 'r');
    // the stations at their places above the line (the one the strip is about is marked: it is named first)
    const anchor = anchorStation(sel).code;
    while (stationEls.length < sel.stations.length) stationEls.push(el('div', 'tick sta', ui));
    stationEls.forEach((e, i) => {
      const st = sel!.stations[i];
      e.hidden = !st;
      if (!st) return;
      e.textContent = st.display;
      if (st.display === st.name) e.dataset['src'] = `streams/${city}.json#/streams/${sel!.ci}/stations/${i}/name`;
      else delete e.dataset['src'];
      if (st.code === anchor) e.dataset['sel'] = '';
      else delete e.dataset['sel'];
      const x = X(st.km);
      // on a phone the four lives stand over the line: the place's name goes under it
      const under = !ctx.story && st.code === anchor;
      // (on a desktop just left of the lamp, so the estimate beside the lamp keeps its place)
      if (under && !LY.phone && x > LY.xL + 120) put(e, x - 12, LY.lineY + 9, 'r');
      else put(e, clamp(x, LY.xL, LY.xR), under ? LY.lineY + 9 : LY.lineY - (LY.phone ? 24 : 26), x < LY.xL + 40 ? 'l' : x > LY.xR - 40 ? 'r' : 'c');
    });
    // two station names that would touch: the one away from the strip's place gives way
    for (const e of stationEls) delete e.dataset['clash'];
    for (let i = 0; i < stationEls.length; i++)
      for (let j = i + 1; j < stationEls.length; j++) {
        const a = stationEls[i]!,
          b = stationEls[j]!;
        if (a.hidden || b.hidden) continue;
        const ra = a.getBoundingClientRect(),
          rb = b.getBoundingClientRect();
        if (ra.right + 8 > rb.left && rb.right + 8 > ra.left) (a.dataset['sel'] !== undefined ? b : a).dataset['clash'] = '';
      }
    axisPEl.hidden = hoursMode;
    for (const s of [...scaleEls, ...endEls]) s.hidden = hoursMode;
    resultEl.hidden = sampleEl.hidden = beforeEl.hidden = withEl.hidden = leadEl.hidden = true;
    axisTimeEl.hidden = !hoursMode;
    if (!hoursMode) {
      curveUI();
      return;
    }
    put(hoursBtn, LY.xL, baseFB() + 4);
    // the dated day marks: the gutter at each local midnight in the window ("Tue 29")
    daysEl.innerHTML = '';
    for (let r = Math.max(1, Math.ceil(vTop)); r <= Math.min(span, vTop + viewRows()); r++) {
      const p = localParts(msOfRow(r), zone);
      if (p.hour !== 0) continue;
      const s = el('span', 'tick', daysEl, { 'data-time': '' });
      s.textContent = `${DAY3[p.weekday]} ${p.day}`;
      put(s, gx, Y(r) - 8, 'r');
    }
    evalRain();
    // "After rain" by the first run of rain ticks in the window
    let first = -1;
    if (rainRows) for (let r = Math.max(0, Math.ceil(vTop)); r <= Math.min(span, vTop + viewRows()) && first < 0; r++) if (rainRows[r]) first = r;
    rainEl.hidden = first < 0;
    if (first >= 0) {
      if (LY.phone) put(rainEl, LY.xR + 11, Y(first) - 22, 'r');
      else put(rainEl, LY.xR + 22, Y(first) - 8);
    }
    const q = stripQuest(sel);
    questBtn.hidden = !q || !rowIn(askRow(q));
    if (q) {
      questBtn.style.left = `${X(q.km) - 22}px`;
      questBtn.style.top = `${Y(askRow(q)) - 22}px`;
      questBtn.setAttribute('aria-label', `Quest at ${q.display}. ${questClaim(q)}`);
    }
    positionScrub();
  }
  /**
   * The selected hour's labels: its day and time in the gutter (beside its thread on a phone), the estimate's word
   * and the fog's meaning beside the lamp; then the slider's value, the record behind the line, and the budget.
   */
  function positionScrub(): void {
    if (!sel) return;
    const on = phase === 'strip';
    const row = Math.round(scrubH);
    SC.setAttribute('aria-valuenow', String(row));
    SC.setAttribute('aria-valuemax', String(span));
    const p = localParts(msOfRow(row), zone);
    SC.setAttribute('aria-valuetext', `${WEEKDAY[p.weekday]} ${p.day} ${DAY_MONTH[p.month - 1]} ${hh(p.hour)}:00`);
    // the selected hour's words show while its row is in the window
    if (!hoursMode) {
      curveScrub();
      return;
    }
    const shown = on && rowIn(row);
    scrubEl.hidden = !shown;
    estEl.hidden = !shown;
    fogEl.hidden = !shown;
    const y = Y(row);
    // a day mark gives way to the selected hour's label and to "Time ↓" when it would touch them
    for (const d of daysEl.children as HTMLCollectionOf<HTMLElement>) {
      const dy = Number.parseFloat(d.style.top) + 8;
      if (Math.abs(dy - y) < 16 || Math.abs(dy - (LY.fT + 4)) < 16) d.dataset['clash'] = '';
      else delete d.dataset['clash'];
    }
    if (Math.abs(LY.lineY - y) < 18) lnowEl.dataset['clash'] = '';
    else delete lnowEl.dataset['clash'];
    if (!shown) {
      bindRecord();
      fitLabels();
      return;
    }
    scrubEl.textContent = `${DAY3[p.weekday]} ${p.day} ${hh(p.hour)}:00`;
    // the selected hour's words sit in clear margins, never across the repeated strokes: on a desktop its day and
    // time in the left gutter beside its row, the estimate and the fog's words in the band under the field; on a
    // phone all three in that band (the day and time with the fog's words, the estimate under them)
    if (LY.phone) put(scrubEl, LY.xL, LY.fB + 8);
    else put(scrubEl, LY.xL - 14, y - 8, 'r');
    // the place on the selected thread: its estimate and its fog, at the lamp
    const st = anchorStation(sel);
    const ix = Math.round((st.km / sel.L) * (NX - 1));
    // the chance at the place and hour, as its record holds it; the unit is said here unless the kit says it
    const rec = recordAt(st.code, clamp(hb + row, 0, cs.hoursMs.length - 1));
    estEl.replaceChildren(...estimateNodes(rec, !questEl.hidden && questEl.dataset['stage'] === 'kit'));
    put(estEl, LY.xL, LY.fB + (LY.phone ? 27 : 8));
    const fogText = fogWords(fogAt(ix, row), st.code);
    fogEl.textContent = fogText;
    if (fogText) delete fogEl.dataset['empty'];
    else fogEl.dataset['empty'] = '';
    const lead = (LY.phone ? scrubEl : estEl).getBoundingClientRect();
    put(fogEl, lead.right + 16, LY.fB + (LY.phone ? 9 : 11));
    bindRecord();
    fitLabels();
  }

  // ----- camera -----
  /** A stream turned to run across the screen: its middle (lon, lat), its turn, and its extent along and across (m). */
  function streamFrame(ch: Chain): { center: [number, number]; phi: number; ex: number; ey: number } {
    const kx = geo.proj.kx,
      ky = geo.proj.ky;
    const pts = ch.line.map((c) => [c[0] * kx, c[1] * ky] as const);
    const a = pts[0]!,
      b = pts[pts.length - 1]!;
    const phi = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cs_ = Math.cos(phi),
      sn = Math.sin(phi);
    let x0 = 1e18,
      x1 = -1e18,
      y0 = 1e18,
      y1 = -1e18;
    for (const p of pts) {
      const x = p[0] * cs_ + p[1] * sn,
        y = -p[0] * sn + p[1] * cs_;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const mx = (x0 + x1) / 2,
      my = (y0 + y1) / 2,
      cx = mx * cs_ - my * sn,
      cy = mx * sn + my * cs_;
    return { center: [cx / kx, cy / ky], phi, ex: x1 - x0, ey: y1 - y0 };
  }
  const zoomFor = (mpp: number): number => Math.log2((40075016.686 * Math.cos((cs.pack.center[1] * Math.PI) / 180)) / (512 * mpp));
  function cameraFor(ch: Chain, pitch = 30): CameraLike & { padding: { top: number; bottom: number; left: number; right: number } } {
    const f = streamFrame(ch);
    const band = phoneW() ? 150 : 200;
    const mpp = Math.max(f.ex / ((LY.xR - LY.xL) * 0.9), (f.ey / (band * 2)) * 0.85);
    return { center: f.center, zoom: zoomFor(mpp), bearing: (-f.phi * 180) / Math.PI, pitch, padding: { top: 0, bottom: Math.max(0, H - 2 * LY.lineY), left: 0, right: 0 } };
  }
  /** The comparison's camera: from straight above, the stream across the map band (src/city/compareLayout.ts). */
  function compareCamera(ch: Chain): CameraLike & { padding: { top: number; bottom: number; left: number; right: number } } {
    const f = streamFrame(ch);
    const mpp = compareScale(f.ex, f.ey, CL.xL, CL.xR, CL.band);
    return { center: f.center, zoom: zoomFor(mpp), bearing: (-f.phi * 180) / Math.PI, pitch: 0, padding: { top: 0, bottom: Math.max(0, H - 2 * CL.mapY), left: 0, right: 0 } };
  }
  function flyTo(
    cam: CameraLike & { padding?: { top: number; bottom: number; left: number; right: number } },
    ms: number,
    ease: (x: number) => number,
    alive: () => boolean = () => true,
  ): Promise<void> {
    const c0 = map.getCenter(),
      z0 = map.getZoom(),
      b0 = map.getBearing(),
      p0 = map.getPitch(),
      pad0 = map.getPadding();
    let db = cam.bearing - b0;
    while (db > 180) db -= 360;
    while (db < -180) db += 360;
    const pad1 = cam.padding ?? { top: 0, bottom: 0, left: 0, right: 0 };
    return tween(ms, (e) => {
      if (!alive()) return;
      const k = ease(e);
      map.jumpTo({
        center: [lerp(c0.lng, cam.center[0], k), lerp(c0.lat, cam.center[1], k)],
        zoom: lerp(z0, cam.zoom, k),
        bearing: b0 + db * k,
        pitch: lerp(p0, cam.pitch, k),
        padding: { top: lerp(pad0.top ?? 0, pad1.top, k), bottom: lerp(pad0.bottom ?? 0, pad1.bottom, k), left: lerp(pad0.left ?? 0, pad1.left, k), right: lerp(pad0.right ?? 0, pad1.right, k) },
      });
    });
  }
  const mapSettled = (): Promise<void> =>
    new Promise((res) => {
      if (!map.isMoving()) {
        map.once('render', () => res());
        map.triggerRepaint();
      } else map.once('moveend', () => res());
    });

  function setPhase(p: Phase): void {
    phase = p;
    document.body.dataset['state'] = p === 'strip' ? 'strip' : p === 'rest' ? 'rest' : p;
    root.classList.toggle('open', p === 'opening' || p === 'strip');
    root.classList.toggle('strip', p === 'strip');
    // the streams' buttons are for the city at rest: out of the tab order and the accessibility tree otherwise
    navEl.inert = p !== 'rest';
    // the strip is a slider while it is open, and out of the accessibility tree otherwise
    SC.tabIndex = p === 'strip' ? 0 : -1;
    if (p === 'strip') SC.removeAttribute('aria-hidden');
    else SC.setAttribute('aria-hidden', 'true');
  }
  const ZERO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
  const camNow = (): CameraLike => {
    const c = map.getCenter();
    return { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  };
  const setTitle = (stream: string | null): void => {
    if (!ctx.story) document.title = `AfterRain: ${cs.pack.name}${stream ? `, ${stream}` : ''}`;
  };
  /** Pan and zoom within the city at rest (mouse and touch); the camera belongs to the animation otherwise. */
  let panBounds: maplibregl.LngLatBoundsLike | null = null;
  let restZoom = 12;
  function setInteractive(on: boolean): void {
    if (!map) return;
    for (const h of [map.dragPan, map.scrollZoom, map.touchZoomRotate]) {
      if (on) h.enable();
      else h.disable();
    }
    if (on) map.touchZoomRotate.disableRotation();
    try {
      map.setMaxBounds(on ? panBounds : null);
      map.setMinZoom(on ? restZoom - 0.7 : null);
      map.setMaxZoom(on ? restZoom + 2.6 : null);
    } catch {
      /* style not ready */
    }
  }

  /**
   * Moves toward the stream the link asks for once nothing is animating: opens it, closes the strip, or corrects a
   * link to a stream this city does not have. Every animation calls it when it ends, so the link and the screen
   * agree even when the viewer goes back, presses Escape or picks another stream mid-way.
   */
  function reconcile(): void {
    if (disposed || !geo || root.dataset['ready'] !== 'true') return;
    if (phase === 'compare') {
      if (want) void closeCompare();
      return;
    }
    if (phase === 'rest') {
      if (!want) return;
      const ci = geo.chains.findIndex((c) => c.slug === want);
      if (ci >= 0) void openStream(ci, { fromRoute: true });
      else {
        want = null;
        ctx.navigate(`#/city/${city}`, { replace: true });
      }
    } else if (phase === 'strip' && sel && want !== sel.slug) void closeStrip(true);
  }

  // ----- open / close -----
  interface OpenOpts {
    /** The link already names the stream (a deep link, back or forward). */
    readonly fromRoute?: boolean;
    /** Opened from the keyboard: focus goes into the strip. */
    readonly focusInside?: boolean;
    /** Opened from the quest's lamp: the strip arrives on the quest. */
    readonly quest?: boolean;
    /** Story mode's opening: the camera is already on the stream; the request stays the line; the asked hour is selected. */
    readonly opening?: boolean;
  }
  async function openStream(ci: number, o: OpenOpts = {}): Promise<void> {
    if (phase !== 'rest' || !elevReady || disposed) return;
    const ch = geo.chains[ci];
    if (!ch) return;
    const my = ++gen;
    stopGlide();
    endNext();
    sel = ch;
    want = ch.slug;
    hoverCi = -1;
    scrubH = 0;
    hoursMode = false;
    root.classList.remove('hours');
    LY = layout();
    setPhase('settle');
    hideTeach();
    applyLayoutVars();
    if (!o.fromRoute) ctx.navigate(`#/city/${city}/stream/${ch.slug}`);
    setTitle(ch.display);
    restCam = camNow();
    setInteractive(false);
    // the hours ahead are computed while the camera flies, a few rows a frame, so the tap never freezes the screen
    const hb0 = stripBaseHour(cs, nowMs());
    const span0 = Math.max(1, stripRows(cs, hb0));
    const fieldP = buildFieldSliced(ch, hb0, span0, () => my === gen, o.opening ? 48 : 12);
    if (!o.opening) {
      await flyTo(cameraFor(ch), 1150, easeOut);
      await mapSettled();
    }
    const built = await fieldP;
    if (my !== gen) return;
    // the viewer went back, or asked for another stream, before the line lifted: fold straight back
    if (want !== ch.slug) {
      await backToRest(my);
      return;
    }
    projectChainFlat(ch);
    prepMorph(ch);
    hb = hb0;
    span = span0;
    field = built;
    lineP = lineF = null;
    showReading(ch);
    // the window of hours starts now, unless the strip's quest lies beyond it: then it starts just above the quest's
    // hour (the quest is the strip's call to action)
    vTop = 0;
    {
      const q = stripQuest(ch);
      if (q && askRow(q) > viewRows() - 1) vTop = clamp(Math.round(askRow(q)) - 2, 0, Math.max(0, span - viewRows()));
    }
    evalLine();
    paintField();
    setPhase('opening');
    hideMapChain(true);
    SC.style.pointerEvents = 'auto';
    if (test) scrubH = testRowOnStrip();
    else if (o.opening) {
      const q = stripQuest(ch);
      if (q) scrubH = askRow(q);
    }
    await tween(o.opening ? 1000 : 1200, (e) => {
      morphE = easeIO(e);
      restA = 1 - sstep(0, 0.45, e);
    });
    if (my !== gen) return;
    positionStripUI();
    figState = computeFigs();
    placeFigs(false);
    const un = tween(o.opening ? 800 : 950, (e) => (unroll = easeOut(e)));
    await wait(250);
    if (my !== gen) return;
    root.classList.add('strip');
    if (test) {
      // a tested site's stream: its reading on the line, with "Hold before" and "Reset test"
      testedEl.replaceChildren(...testedNodes());
      root.dataset['tested'] = test.over ? 'over' : 'under';
      voiceMode = 'result';
      setVoice(resultVoice(), 'result');
    } else if (!o.opening) {
      setVoice(sentence());
      voiceMode = 'sentence';
    }
    await wait(250);
    if (my !== gen) return;
    placeFigs(true);
    await un;
    if (my !== gen) return;
    setPhase('strip');
    // the way back shows before the labels are fitted: its name counts against the strip's words
    backBtn.hidden = false;
    positionScrub();
    if (relayoutDue) relayoutStrip();
    if (o.quest && !test && stripQuest(ch)) tapQuest(o.focusInside);
    else if (o.focusInside) backBtn.focus({ preventScroll: true });
    reconcile();
  }
  /**
   * The strip's test from a reading kept in the model, when the stream has a tested site. The reading and its Reset
   * stay whether or not its collection hour is on this strip: once the clock has passed that hour the row is before
   * the strip, and only the collection mark is left off (sampleTiming). The field from before it is rebuilt when the
   * strip starts at another hour than the one it was built for (the reading is taken back, the field computed, and
   * the same reading applied again).
   */
  function showReading(ch: Chain): void {
    test = null;
    const st = ch.stations.find((x) => readings.has(x.code) && cs.hasSample(x.code));
    const r = st ? readings.get(st.code)! : null;
    if (!r) return;
    if (!r.before || r.before.hb !== hb || r.before.span !== span) {
      cs.undo(r.code);
      const f = computeField(ch, cs, hb, span);
      cs.applyTestSample(r.code, r.hour, { over_900: r.over });
      r.before = { hb, span, field: f };
    }
    test = { code: r.code, row: r.hour - hb, over: r.over, before: r.before.field, line: r.line, site: r.site, prior: r.prior };
  }
  /** One app frame from now (a yield that keeps the page drawing between slices of work). */
  const nextFrame = (): Promise<void> =>
    new Promise((r) => {
      const off = ctx.clock.onFrame(() => {
        off();
        r();
      });
    });
  /** The field under a stream, 12 rows per frame; the edge texture for its span is made on the way. */
  async function buildFieldSliced(ch: Chain, hb_: number, span_: number, alive: () => boolean, rows = 12): Promise<Field> {
    const f = emptyField(hb_, span_);
    for (let it = 0; it < f.nt && alive(); it += rows) {
      fillFieldRows(f, ch, cs, it, it + rows);
      await nextFrame();
    }
    return f;
  }
  /** An opening abandoned before the line lifted: the camera goes back to where the viewer had it. */
  async function backToRest(my: number): Promise<void> {
    sel = null;
    setTitle(null);
    await flyTo({ ...(restCam ?? view()), padding: ZERO_PAD }, 900, easeIO);
    if (my !== gen) return;
    setPhase('rest');
    setInteractive(true);
    reconcile();
  }
  async function closeStrip(fromRoute = false, to?: CameraLike): Promise<void> {
    if (!sel) return;
    // a close the viewer asked for clears the stream the link wants; a close the link asked for (another stream,
    // or back) keeps what the link wants, and the strip moves there when it has folded
    if (phase !== 'strip') {
      // mid-way through opening: the link goes back now and the strip folds as soon as it has opened
      if ((phase === 'settle' || phase === 'opening') && !fromRoute) {
        want = null;
        ctx.navigate(`#/city/${city}`);
      }
      return;
    }
    const my = ++gen;
    if (!fromRoute) want = null;
    lift = null;
    setPhase('closing');
    if (!fromRoute) ctx.navigate(`#/city/${city}`);
    hideTeach();
    clearVoice();
    scrubH = 0;
    backBtn.hidden = true;
    questBtn.hidden = true;
    placeFigs(false);
    root.classList.remove('strip');
    await tween(480, (e) => (unroll = 1 - easeIO(e)));
    if (my !== gen) return;
    root.classList.remove('open');
    SC.style.pointerEvents = 'none';
    await tween(1100, (e) => {
      morphE = 1 - easeIO(e);
      restA = sstep(0.5, 1, e);
    });
    if (my !== gen) return;
    hideMapChain(false);
    setPhase('settle');
    const done_ = sel;
    sel = null;
    field = null;
    // the strip's presentation of its test goes with it; the reading stays in the model until "Reset test"
    test = null;
    holding = false;
    root.classList.remove('holding');
    dirty = true;
    evaluate(true);
    setTitle(null);
    await flyTo({ ...(to ?? restCam ?? view()), padding: ZERO_PAD }, 1300, easeIO);
    if (my !== gen) return;
    setPhase('rest');
    setInteractive(true);
    if (!fromRoute && !to) navEl.querySelectorAll('button')[geo.chains.indexOf(done_)]?.focus({ preventScroll: true });
    reconcile();
  }
  function hideMapChain(on: boolean): void {
    const f: maplibregl.FilterSpecification | null = on && sel ? ['!', ['in', ['get', 'id'], ['literal', [...sel.ids]]]] : null;
    try {
      map.setFilter('glow', f);
      map.setFilter('core', f);
    } catch {
      /* style not ready */
    }
  }

  // ----- interactions -----
  /** A site's name as a node: its own name carries its data source (a name can hold digits); a readable one needs none. */
  const siteNode = (q: Quest): HTMLSpanElement => {
    const s = document.createElement('span');
    s.textContent = q.display;
    if (q.display === q.name) s.dataset['src'] = `nowcast_${city}.json#/quests/${q.rank}/name`;
    return s;
  };
  const textNode = (t: string): Text => document.createTextNode(t);
  const timeNode = (t: string): HTMLSpanElement => {
    const s = document.createElement('span');
    s.dataset['time'] = '';
    s.textContent = t;
    return s;
  };
  /** The hour of a strip row with its day and date: "Mon 28 16:00" (the month is on the strip's day marks). */
  const rowTime = (r: number): string => {
    const p = localParts(msOfRow(r), zone);
    return `${DAY3[p.weekday]} ${p.day} ${hh(p.hour)}:00`;
  };

  // ----- the record behind the line: what the strip shows at its place and selected hour (src/fhir/liveRecords.ts) -----
  /** The published forecast peak of a site (public/data/fhir/index.json siteRisk), once the index has loaded. */
  let fhirIndex: { siteRisk: Record<string, string> } | null = null;
  const siteRiskRef = (code: string): string | null => fhirIndex?.siteRisk[code] ?? null;
  const siteName = (code: string): string => {
    for (const c of geo.chains) for (const st of c.stations) if (st.code === code) return st.display;
    return nowcast.sites.find((s) => s.code === code)?.name ?? code;
  };
  /**
   * The record of a place at an hour: the test estimate when the site has a test reading (and "Hold before" is not
   * pressed), else the published forecast there; null where the nowcast has no value.
   */
  function recordAt(code: string, h: number): LiveRecord | null {
    const rd = readings.get(code);
    if (rd && cs.hasSample(code) && !(holding && test?.code === code)) {
      const ser = cs.series(code);
      return registerLive(testRecord({ code, site: siteName(code), hour: h, hourUtc: nowcast.hours_utc[h]!, collectedUtc: rd.collectedUtc, over900: rd.over, p50: ser.p50[h]!, fog: ser.fog[h]!, revision: cs.revision, modelVersion: nowcast.model_version, published: siteRiskRef(code), when: `${formatDayTime(cs.hoursMs[h]!, zone)} ${formatZone(cs.hoursMs[h]!, zone)}` }));
    }
    return forecastAt(code, h);
  }
  /** The published forecast of a place at an hour (nowcast_<city>.json), whatever test is on screen. */
  function forecastAt(code: string, h: number): LiveRecord | null {
    const published = siteRiskRef(code);
    const hourUtc = nowcast.hours_utc[h]!;
    const site = siteName(code);
    const si = nowcast.sites.findIndex((s) => s.code === code);
    const ns = nowcast.sites[si];
    const p50 = ns?.p50[h];
    const fog = ns?.fog[h];
    if (!ns || p50 === null || p50 === undefined || fog === null || fog === undefined) return null;
    return registerLive(forecastRecord({ city, code, site, siteIndex: si, hour: h, hourUtc, p50, fog, forecastFetchedUtc: nowcast.forecast_fetched_utc, modelVersion: nowcast.model_version, published, when: `${formatDayTime(cs.hoursMs[h]!, zone)} ${formatZone(cs.hoursMs[h]!, zone)}` }));
  }
  /** Binds the line to the record of its place at the selected hour: the forecast there, or the test estimate. */
  function bindRecord(): void {
    if (!sel || phase === 'compare' || !voiceEl.classList.contains('on')) return;
    const r = recordAt(anchorStation(sel).code, clamp(hb + Math.round(scrubH), 0, cs.hoursMs.length - 1));
    if (r) voiceEl.dataset['fhir'] = r.key;
    else delete voiceEl.dataset['fhir'];
  }
  /** The flag's number, bound to numbers.json. */
  const flagNode = (): HTMLSpanElement => {
    const n = document.createElement('span');
    n.dataset['num'] = 'thresholds.ecoli_flag_per_100ml';
    n.textContent = flagText;
    return n;
  };
  const unitNode = (): HTMLSpanElement => {
    const u = document.createElement('span');
    u.dataset['unit'] = 'E. coli/100 ml';
    u.textContent = 'E. coli/100 ml';
    return u;
  };
  /** The chance a record holds, as "46.2%", bound to its source. */
  const chanceNode = (rec: LiveRecord): HTMLSpanElement => {
    const v = (rec.json as { valueQuantity: { value: number } }).valueQuantity.value;
    const n = document.createElement('span');
    n.dataset['src'] = rec.src('/valueQuantity/value');
    n.dataset['fmt'] = 'pct:1';
    n.textContent = formatNumber(v, 'pct:1');
    return n;
  };
  /** "46.2% chance over 900 E. coli/100 ml" (the chance alone when `short`). */
  const estimateNodes = (rec: LiveRecord | null, short: boolean): Node[] => {
    if (!rec) return [];
    return short ? [chanceNode(rec)] : [chanceNode(rec), textNode(' chance over '), flagNode(), textNode(' '), unitNode()];
  };

  /** The hour the quest asks for on a strip: the opening's hour in story mode, else the quest's own. */
  const askRow = (q: Quest & { row: number }): number => q.row;
  const askAfterRain = (q: Quest): boolean => q.fields.after_rain;

  /**
   * The quest's ask: "Sample <site> after rain" ("after rain" only when its hour follows rain), its
   * sampling window from the nowcast, and "Try a test reading". The strip moves to the asked hour, where a test
   * reading would be assumed collected. A dated forecast says so.
   */
  function tapQuest(fromKeyboard = false): void {
    if (phase !== 'strip' || !sel || test) return;
    const q = stripQuest(sel);
    if (!q) return;
    hideTeach();
    const nodes: Node[] = [];
    if (!live()) nodes.push(textNode('Forecast of '), timeNode(formatDayMonth(Date.parse(nowcast.forecast_fetched_utc), zone)), textNode(': '));
    nodes.push(textNode('Sample '), siteNode(q), textNode(askAfterRain(q) ? ' after rain' : ''));
    // a dated ask already says its date ("Forecast of 2 Oct:"): its window says the times and zone alone on that date
    winEl.textContent = live() ? windowText(q.startMs, q.endMs, zone) : windowTextAfterDate(q.startMs, q.endMs, zone, Date.parse(nowcast.forecast_fetched_utc));
    voiceMode = 'quest';
    setScrub(askRow(q), false);
    setVoice(nodes, 'ask', true);
    placeFigs(true);
    if (fromKeyboard) questEl.querySelector<HTMLButtonElement>('.add')?.focus({ preventScroll: true });
  }
  /**
   * "Try a test reading": the choices, said as a test at the site, with the date, time and zone it is assumed
   * collected at (the selected hour), the two readings, and the unit with the flag's meaning.
   */
  function openKit(fromKeyboard = false): void {
    if (phase !== 'strip' || !sel || voiceMode !== 'quest' || test) return;
    const q = stripQuest(sel);
    if (!q) return;
    testRow = Math.round(scrubH);
    const ms = msOfRow(testRow);
    whenEl.textContent = `${formatDayTime(ms, zone)} ${formatZone(ms, zone)}`;
    voiceMode = 'kit';
    setVoice([textNode('Test reading at '), siteNode(q)], 'kit', true);
    placeFigs(true);
    if (fromKeyboard) questEl.querySelector<HTMLButtonElement>('button[data-obs]')?.focus({ preventScroll: true });
  }
  /** Scrub the hours: the strip's hour under the viewer's finger or arrow keys. A test's line stays while it is on. */
  function setScrub(h: number, voice = true): void {
    if (!sel || phase !== 'strip') return;
    const nh = clamp(Math.round(h), 0, span);
    if (nh === scrubH && voice && voiceMode === (nh ? 'hour' : 'sentence')) return;
    scrubH = nh;
    follow(nh);
    evalLine();
    const was = figState;
    figState = computeFigs();
    if (!was) placeFigs(true);
    positionScrub();
    if (holding) setVoice(beforeVoice(), 'result', false);
    else if (test && voiceMode === 'result' && !lift) setVoice(resultVoice(), 'result', false);
    if (!voice || test) return;
    if (scrubH === 0) {
      setVoice(sentence(), false, false);
      voiceMode = 'sentence';
    } else {
      setVoice(hourVoice(), false, false);
      voiceMode = 'hour';
    }
  }
  /** "900 or less" or "over 900" as nodes, the flag's number bound to numbers.json. */
  const readingNodes = (over: boolean): Node[] => {
    const n = flagNode();
    return over ? [textNode('over '), n] : [n, textNode(' or less')];
  };
  /**
   * A test reading, through the same handler for a viewer and for the story: the reading is
   * assumed collected at the selected hour, the site's estimate is recomputed (src/engine/fog.ts), and the new field
   * spreads out from the sampled place and hour over LIFT_MS. The line says what changed once the reveal has passed
   * the site's hours; the cursor stays on the tested hour.
   */
  async function submitSample(obs: Observation): Promise<void> {
    if (phase !== 'strip' || !sel || lift || test) return;
    const q = stripQuest(sel);
    if (!q) return;
    const my = gen;
    const ch = sel;
    const before = field!;
    const row = voiceMode === 'kit' ? testRow : askRow(q);
    if (!lineP) evalLine();
    const lineP0 = lineP!,
      lineF0 = lineF!;
    const prior = cs.series(q.code);
    const at = Math.min(cs.hoursMs.length - 1, hb + row);
    const pBefore = prior.p50[at]!;
    const over = 'over_900' in obs && obs.over_900;
    const applied = cs.applyTestSample(q.code, hb + row, obs);
    done.add(q.code);
    field = computeField(sel, cs, hb, span);
    // the fog's own words ("Still uncertain") say what stays unsure: the line says only which way the estimate went
    const line = testResultLine(pBefore, cs.series(q.code).p50[at]!, false);
    readings.set(q.code, { code: q.code, hour: applied.hour, collectedUtc: nowcast.hours_utc[applied.hour]!, over, line, site: q.display, prior, before: { hb, span, field: before } });
    test = { code: q.code, row, over, before, line, site: q.display, prior };
    scrubH = row;
    evalLine();
    let reach = 0;
    for (const [km, it] of [
      [0, 0],
      [sel.L, 0],
      [0, span],
      [sel.L, span],
    ] as const)
      reach = Math.max(reach, Math.hypot((km - q.km) / 1.6, (it - row) / 16));
    // the line comes once the reveal has passed every hour at the site
    const atSite = Math.max(row, span - row) / 16;
    lift = { ci: sel.ci, km: q.km, row, prog: 0, reach: reach + 0.5, before, over, lineP: lineP0, lineF: lineF0 };
    questBtn.hidden = true;
    testedEl.replaceChildren(...testedNodes());
    voiceMode = 'kit';
    setVoice([textNode('Test reading at '), siteNode(q)], 'testing', false);
    root.dataset['sampled'] = String(ctx.clock.seconds());
    root.dataset['tested'] = over ? 'over' : 'under';
    positionScrub();
    let painted = -1;
    let said = false;
    const say = (): void => {
      said = true;
      voiceMode = 'result';
      setVoice(resultVoice(), 'result', true);
      voiceEl.focus({ preventScroll: true });
    };
    await tween(LIFT_MS, (e) => {
      if (!lift || my !== gen) return;
      lift.prog = easeIO(e);
      questA = 1 - sstep(0, 0.15, e);
      // the field is repainted at most 30 times a second while the reveal runs
      const now = ctx.clock.seconds();
      if (now - painted >= 1 / 30 || e >= 1) {
        painted = now;
        paintField();
        positionScrub();
      }
      if (!said && liftFront() >= atSite + 0.45) say();
    });
    // the strip closed during the reveal: the test stays, the city shows it at rest
    if (my !== gen || sel !== ch) {
      lift = null;
      return;
    }
    lift = null;
    if (!said) say();
    paintField();
    evaluate(true);
    figState = computeFigs();
    positionStripUI();
    placeFigs(true);
  }
  /** "Test reading · 900 or less · Fri 2 16:00 UTC+1": the reading on screen, its hour and the place's zone. */
  function testedNodes(): Node[] {
    if (!test) return [];
    const ms = msOfRow(test.row);
    return [textNode('Test reading · '), ...readingNodes(test.over), textNode(' · '), timeNode(`${rowTime(test.row)} ${formatZone(ms, zone)}`)];
  }
  /**
   * The line once a test's change has run: on the curve the reading itself (the dashed and the solid curve say
   * which way the estimate went); on the hours the result's sentence ("My estimate falls here.").
   */
  const resultVoice = (): string | Node[] => (hoursMode || !test ? (test?.line ?? '') : Math.round(scrubH) === testRowOnStrip() ? testedNodes() : stateVoice('With test'));
  /** The test's row on the strip; a reading collected before the strip's first hour (or after its last) sits at that end. */
  function testRowOnStrip(): number {
    return test ? clamp(test.row, 0, span) : 0;
  }
  /** "Reset test": the starting state again (the field, the line, the record), ready for another test. */
  function resetTest(fromKeyboard = false): void {
    if (!test || lift || !sel) return;
    cs.undo(test.code);
    readings.delete(test.code);
    done.delete(test.code);
    field = computeField(sel, cs, hb, span);
    test = null;
    holding = false;
    root.classList.remove('holding');
    delete root.dataset['tested'];
    paintField();
    evaluate(true);
    evalLine();
    figState = computeFigs();
    positionStripUI();
    placeFigs(true);
    tapQuest(fromKeyboard);
  }
  /** "Hold before": while pressed, the strip shows the field from before the test. */
  function holdBefore(on: boolean): void {
    if (!test || lift || holding === on) return;
    holding = on;
    root.classList.toggle('holding', on);
    // one switch for everything on screen: the map, the line, the field, the four lives, the words and the record
    evalLine();
    paintField();
    evaluate(true);
    figState = computeFigs();
    placeFigs(true);
    setVoice(on ? beforeVoice() : resultVoice(), 'result', false);
    positionScrub();
  }
  /**
   * The state on screen and the selected hour: "Before test · Sun 4 08:00 UTC+1" while "Hold before" is pressed,
   * "With test · Sun 4 08:00 UTC+1" at any other hour than the test's once it is released (the "Sample" tick marks
   * the test's hour; at that hour the line is the reading itself).
   */
  function stateVoice(state: 'Before test' | 'With test'): Node[] {
    const row = Math.round(scrubH);
    return [textNode(`${state} · `), timeNode(`${rowTime(row)} ${formatZone(msOfRow(row), zone)}`)];
  }
  const beforeVoice = (): Node[] => stateVoice('Before test');

  /**
   * The stream under a tap: the nearest stream line within reach. A site's dot wins only when it is nearer than
   * every line, so a tap on a line never opens a neighbouring stream through its dot. `quest` is true when the tap
   * was on the quest's lamp (it opens straight onto the quest).
   */
  function hitChain(x: number, y: number): { ci: number; quest: boolean } {
    const th = phoneW() ? 30 : 22;
    let best: [number, number] = [th, -1];
    for (const ch of geo.chains)
      for (let k = 0; k < ch.n - 1; k++) {
        const ax = ch.P[2 * k]!,
          ay = ch.P[2 * k + 1]!,
          bx = ch.P[2 * k + 2]!,
          by = ch.P[2 * k + 3]!,
          dx = bx - ax,
          dy = by - ay,
          L2 = dx * dx + dy * dy;
        const t = L2 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
        const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
        if (d < best[0] && ay > H * 0.1) best = [d, ch.ci];
      }
    const rq = restQuest();
    const ql = rq ? lamps.find((l) => l.code === rq.code) : undefined;
    if (ql && ql.ci >= 0 && Number.isFinite(ql.x)) {
      const d = Math.hypot(x - ql.x, y - ql.y);
      if (d < (phoneW() ? 26 : 22) && (best[1] < 0 || best[1] === ql.ci || d < best[0])) return { ci: ql.ci, quest: true };
    }
    for (const s of lamps) {
      if (s.ci < 0 || !Number.isFinite(s.x)) continue;
      const d = Math.hypot(x - s.x, y - s.y);
      if (d < 14 && d < best[0]) best = [d, s.ci];
    }
    return { ci: best[1], quest: false };
  }

  function streamLabel(ch: Chain): string {
    const states = ch.stations.map((s) => stationAt(cs, s.code, hNow));
    const known = states.filter((s) => s.state !== 'unknown');
    const worstGuess = states.reduce((m, s) => Math.max(m, GUESS_INDEX_OF(s.guess)), 0);
    const now = known.length ? `${known.reduce((m, s) => Math.max(m, GUESS_INDEX_OF(s.guess)), 0) === 0 ? 'usual' : GUESS_WORD[known.reduce((m, s) => Math.max(m, GUESS_INDEX_OF(s.guess)), 0)]}` : `unknown, best guess ${GUESS_WORD[worstGuess]}`;
    return `${ch.display}: ${now}. Open its hours ahead.`;
  }
  function updateNav(): void {
    navEl.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-label', streamLabel(geo.chains[i]!)));
  }

  // ----- theme -----
  function setTheme(t: Theme): void {
    if (t === theme && GRAIN) return;
    theme = t;
    pal = PAL[t];
    setTextures();
    if (map) {
      const P = PAINT[t];
      for (const [id, props] of Object.entries(P))
        for (const [k, v] of Object.entries(props)) {
          try {
            map.setPaintProperty(id, k, v);
          } catch {
            /* layer not ready */
          }
        }
      try {
        map.setPaintProperty('glow', 'line-color', wwColor(t));
        map.setPaintProperty('core', 'line-color', wwColor(t));
      } catch {
        /* layer not ready */
      }
      setSky();
    }
    if (sel && field) {
      paintField();
      placeFigs(phase === 'strip');
    }
    dirty = true;
  }
  const setSky = (): void => {
    const c = theme === 'night' ? '#050b0b' : '#f3f1ea';
    try {
      map.setSky({ 'sky-color': c, 'horizon-color': c, 'fog-color': c, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0 });
    } catch {
      /* style not ready */
    }
  };

  // ----- resize -----
  function resize(): void {
    W = innerWidth;
    H = innerHeight;
    DPR = Math.min(2, devicePixelRatio || 1);
    for (const c of [RC, SC]) {
      c.width = W * DPR;
      c.height = H * DPR;
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    FC.style.width = `${W}px`;
    FC.style.height = `${H}px`;
    dirty = true;
  }

  // ----- the land rises: the terrain starts flat and lifts to its exaggeration once its tiles are in -----
  function riseTerrain(t: number): void {
    if (!geo.baked || exag >= EXAGGERATION) return;
    if (riseT0 < 0) {
      let loaded = false;
      try {
        loaded = !!map.isStyleLoaded() && !!map.getSource('demT') && map.isSourceLoaded('demT') === true;
      } catch {
        /* not ready */
      }
      if (!loaded) return;
      riseT0 = t;
    }
    const e = ctx.reducedMotion ? 1 : easeIO(clamp((t - riseT0) / 1.8, 0, 1));
    exag = e >= 1 ? EXAGGERATION : EXAGGERATION * e;
    const T = (map as unknown as { terrain?: { exaggeration: number } }).terrain;
    if (T) T.exaggeration = exag;
    // jumpTo re-reads the ground under the centre, so the camera and the streams' projection rise together
    if (!map.isMoving()) map.jumpTo({});
    else map.triggerRepaint();
    dirty = true;
  }

  // ----- the basemap's place and river names: quiet, and dimmed under the opening comparison -----
  let placeNameA = LABEL_OPACITY;
  function dimPlaceNames(a: number): void {
    if (a === placeNameA) return;
    placeNameA = a;
    for (const id of ['plbl', 'wlbl'])
      try {
        map.setPaintProperty(id, 'text-opacity', a);
      } catch {
        /* style not ready */
      }
  }

  // ----- the frame -----
  /** The scene's layer or one around it is fully transparent (inline opacity 0): the scene is not on screen. */
  const LOW_RES = 0.25;
  let mapLowRes = false;
  /** The product of the inline opacities of the scene's layer and those around it (1: fully on screen). */
  const layerAlpha = (): number => {
    let a = 1;
    for (let e: HTMLElement | null = root; e && e !== document.body; e = e.parentElement) if (e.style.opacity !== '') a *= Number(e.style.opacity);
    return a;
  };
  const hiddenLayer = (): boolean => {
    for (let e: HTMLElement | null = root; e && e !== document.body; e = e.parentElement) {
      const o = e.style.opacity;
      if (o !== '' && Number(o) <= 0) return true;
    }
    return false;
  };
  function frame(): void {
    if (disposed || !geo) return;
    const real = performance.now();
    if (lastRealFrame) {
      const g = real - lastRealFrame;
      perf.gaps.push(g);
      if (perf.gaps.length > 600) perf.gaps.shift();
    }
    lastRealFrame = real;
    perf.n++;
    const t = ctx.clock.seconds();
    hNow = cs.hourOf(nowMs());
    // a forecast that no longer covers the clock is shown dated: the shell writes its date where the hour was
    const isLive = live();
    if (isLive === ('forecastOf' in root.dataset)) {
      if (isLive) delete root.dataset['forecastOf'];
      else root.dataset['forecastOf'] = nowcast.forecast_fetched_utc;
      if (sel && phase === 'strip') positionStripUI();
    }
    if (phase === 'rest') evaluate();
    // an open strip follows the clock: when the live hour moves on, its first row moves with it
    if (sel && field && phase === 'strip' && isLive && !lift && !test && !dragging) {
      const nb = stripBaseHour(cs, nowMs());
      if (nb !== hb) rebase(nb);
    }
    runElev();
    if (elevReady && introA < 1) {
      introA = ctx.reducedMotion ? 1 : clamp((t - introT0) / 1.8, 0, 1);
      if (introA >= 1 && root.dataset['ready'] !== 'true') {
        root.dataset['ready'] = 'true';
        // seconds from navigation when the live scene was ready (the loading checks read it)
        root.dataset['readyAt'] = (performance.now() / 1000).toFixed(2);
        document.body.dataset['ready'] = 'true';
        setInteractive(phase !== 'compare');
        if (camSettled) {
          if (!ctx.story) void wait(0).then(teachRest);
        } else void glide();
        reconcile();
      }
    }
    // mounted underneath and not yet shown (story mode loads the city at opacity 0): nothing is drawn, and the map
    // renders at a quarter of a pixel per pixel until it is on screen (its tiles still load)
    const hidden = hiddenLayer();
    if (hidden !== mapLowRes) {
      mapLowRes = hidden;
      try {
        map.setPixelRatio(hidden ? LOW_RES : devicePixelRatio || 1);
      } catch {
        /* not ready */
      }
    }
    if (hidden) return;
    drawLabels();
    let m0 = performance.now();
    const lap = (k: keyof typeof perf.ms): void => {
      const m1 = performance.now();
      perf.ms[k] += m1 - m0;
      m0 = m1;
    };
    riseTerrain(t);
    liveElev();
    renderMapNow();
    if (dirty && (phase === 'rest' || phase === 'settle' || restA > 0)) project();
    lap('project');
    rc.clearRect(0, 0, RC.width, RC.height);
    sc.clearRect(0, 0, SC.width, SC.height);
    const restShown = restA * easeIO(introA);
    if (restShown > 0) {
      const keep = restA;
      restA = restShown;
      drawFlow(t);
      lap('flow');
      drawLamps(t);
      drawHover();
      lap('lamps');
      restA = keep;
    }
    // the comparison's fog is its own stipple: the drifting mist of the rest view gives way to it
    drawFogRest(t, restShown * (cmp ? 1 - cmpIn : 1));
    lap('fog');
    if (dragging && pendingY !== null) {
      setScrub(hourAt(pendingX ?? 0, pendingY));
      pendingY = null;
    }
    // a finger held past the field's top or bottom edge moves the window of hours on, an hour at a time
    if (hoursMode && dragging && dragY !== null && phase === 'strip' && t - edgeT > 0.09) {
      const dir = dragY > LY.fB ? 1 : dragY < LY.fT ? -1 : 0;
      if (dir) {
        edgeT = t;
        setScrub(scrubH + dir);
      }
    }
    drawStrip(t);
    drawCompare();
    placeCompareWords();
    dimPlaceNames(cmp ? LABEL_OPACITY_DIM : LABEL_OPACITY);
    lap('strip');
    probeDrawn();
    stepFigs(t);
    placeTapCue();
    if (!nameEl.hidden && opening) {
      const l = lamps.find((x) => x.code === opening!.code);
      if (l && Number.isFinite(l.x)) put(nameEl, l.x + 16, l.y - 11);
    }
    const o = sel && !cmp ? Math.max(morphE, unroll) : 0;
    // the map recedes under the strip: a scale on its own layer and the ground-coloured veil (a CSS filter here
    // would re-rasterise the map every frame); under the comparison the map stays where it is, and the veil is
    // the ground below its band, for the ribbons
    worldEl.style.transform = o > 0 ? `scale(${(1 - 0.045 * o).toFixed(4)}) translateY(${(-1.2 * o).toFixed(3)}%)` : '';
    veilEl.style.opacity = (cmp ? 0.94 * cmp.veil * (1 - cmp.out) : 0.9 * o).toFixed(3);
    // fog drifting through ghosted figures, from the clock (a CSS animation would not follow a film render)
    // the mist at the figures' feet drifts slowly, from the clock
    if (phase === 'strip' && !ctx.reducedMotion) {
      const g = mistSvg.firstElementChild?.nextElementSibling as SVGGElement | null;
      g?.setAttribute('transform', `translate(${(Math.sin(t * 0.35) * 3).toFixed(2)} ${(Math.cos(t * 0.27) * 1).toFixed(2)})`);
    }
  }

  // ----- the "tap a stream" cue: at rest in free exploration, after the fog's word, until the viewer's first tap -----
  let tapCueA = 0;
  let tapCueT = -1;
  /** Clock seconds after which the cue may show: once the fog's own word has had its turn. */
  let tapCueFrom = Infinity;
  function placeTapCue(): void {
    const now = ctx.clock.seconds();
    const dt = tapCueT < 0 ? 0 : clamp(now - tapCueT, 0, 0.25);
    tapCueT = now;
    const menuOpen = document.querySelector('.cities:not([hidden])') !== null;
    const want = phase === 'rest' && camSettled && !viewerTapped && !ctx.story && voiceMode !== 'next' && now >= tapCueFrom && teachEl.childElementCount === 0 && !menuOpen;
    tapCueA = ctx.reducedMotion ? (want ? 1 : 0) : clamp(tapCueA + (want ? dt / 0.6 : -dt / 0.25), 0, 1);
    tapCueEl.style.opacity = tapCueA.toFixed(3);
    tapCueEl.style.visibility = tapCueA > 0.01 ? 'visible' : 'hidden';
    // mid-fade, the contrast check reads it at full strength (as it does the self-teaching words)
    if (tapCueA > 0.01 && tapCueA < 0.999) tapCueEl.dataset['fading'] = '';
    else delete tapCueEl.dataset['fading'];
    if (tapCueA > 0.01) document.body.dataset['cue'] = 'tap';
    else if (document.body.dataset['cue'] === 'tap') delete document.body.dataset['cue'];
    if (tapCueA <= 0.01) return;
    // beside the quest's lamp (the light in the fog), never on it and never over the corners' words: the first of
    // right, left, above, below that fits on screen; else the middle of the view
    const q = restQuest();
    const lamp = q ? lamps.find((l) => l.code === q.code) : undefined;
    const w = tapCueEl.offsetWidth,
      h = tapCueEl.offsetHeight || 22;
    const fits = (x: number, y: number): boolean => x >= 16 && x + w <= W - 16 && y >= 80 && y + h <= H - 120;
    let at: [number, number] = [W / 2 - w / 2, H * 0.62];
    if (lamp && Number.isFinite(lamp.x + lamp.y)) {
      const gap = 22;
      const options: [number, number][] = [
        [lamp.x + gap, lamp.y - h / 2],
        [lamp.x - gap - w, lamp.y - h / 2],
        [lamp.x - w / 2, lamp.y - gap - h],
        [lamp.x - w / 2, lamp.y + gap],
      ];
      at = options.find(([x, y]) => fits(x, y)) ?? at;
    }
    tapCueEl.style.left = `${Math.round(clamp(at[0], 16, W - 16 - w))}px`;
    tapCueEl.style.top = `${Math.round(clamp(at[1], 80, H - 120 - h))}px`;
  }

  // ----- build DOM -----
  function buildDom(): void {
    root.classList.add('city');
    worldEl = el('div', 'world', root);
    mapEl = el('div', 'map', worldEl, { role: 'img', 'aria-label': `${cs.pack.name}: streams drawn as light; fog where nobody has measured` });
    RC = el('canvas', 'rest', worldEl, { 'aria-hidden': 'true' });
    rc = RC.getContext('2d')!;
    FC = el('canvas', 'rest fog', worldEl, { 'aria-hidden': 'true' });
    fgf = FC.getContext('2d')!;
    veilEl = el('div', 'veil', root);
    SC = el('canvas', 'stripc', root);
    sc = SC.getContext('2d')!;
    ui = el('div', 'ui', root);
    voiceEl = el('div', 'voice', ui, { 'aria-live': 'polite', tabindex: '-1' });
    questEl = el('div', 'questui', ui);
    questEl.hidden = true;
    // the ask: one control that opens the kit; the kit: what the citizen's kit read, the unit and the flag said once
    // the ask, the kit (the test's time, the two readings, the unit and the flag's meaning said once), the result's
    // two controls, and story mode's way into free exploration
    questEl.innerHTML =
      '<span class="win" data-time></span>' +
      '<button type="button" class="add">Try a test reading</button>' +
      '<span class="when" data-time></span>' +
      '<button type="button" data-obs="under"><span data-num="thresholds.ecoli_flag_per_100ml">900</span> or less</button>' +
      '<button type="button" data-obs="over">Over <span data-num="thresholds.ecoli_flag_per_100ml">900</span></button>' +
      '<span class="unit"><span data-unit>E. coli/100 ml</span> · single-sample flag</span>' +
      '<span class="tested"></span>' +
      '<span class="cmpk">Example test reading · <span class="cmpt" data-time></span></span>' +
      '<button type="button" class="hold">Hold before</button>' +
      '<button type="button" class="reset" aria-label="Reset test">Reset</button>' +
      '<button type="button" class="next"></button>';
    winEl = questEl.querySelector<HTMLSpanElement>('.win')!;
    cmpWhenEl = questEl.querySelector<HTMLSpanElement>('.cmpt')!;
    whenEl = questEl.querySelector<HTMLSpanElement>('.when')!;
    testedEl = questEl.querySelector<HTMLSpanElement>('.tested')!;
    for (const n of questEl.querySelectorAll<HTMLElement>('[data-num]')) n.textContent = flagText;
    questEl.querySelector<HTMLButtonElement>('.add')!.addEventListener('click', (e) => {
      e.stopPropagation();
      openKit(e.detail === 0);
    });
    questEl.querySelectorAll<HTMLButtonElement>('button[data-obs]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const over = b.dataset['obs'] === 'over';
        sampling = phase === 'compare' ? submitCompare(over) : submitSample({ over_900: over });
      });
    });
    questEl.querySelector('button[data-obs="over"]')!.setAttribute('aria-label', 'Test reading: over nine hundred E. coli per 100 ml');
    questEl.querySelector('button[data-obs="under"]')!.setAttribute('aria-label', 'Test reading: nine hundred E. coli per 100 ml or less');
    // "Hold before": pressed (pointer or keyboard), the strip shows the field from before the test
    const hold = questEl.querySelector<HTMLButtonElement>('.hold')!;
    hold.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      hold.setPointerCapture(e.pointerId);
      holdBefore(true);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) hold.addEventListener(t, () => holdBefore(false));
    hold.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        holdBefore(true);
      }
    });
    hold.addEventListener('keyup', () => holdBefore(false));
    hold.addEventListener('blur', () => holdBefore(false));
    hold.addEventListener('click', (e) => e.stopPropagation());
    questEl.querySelector<HTMLButtonElement>('.reset')!.addEventListener('click', (e) => {
      e.stopPropagation();
      resetTest(e.detail === 0);
    });
    nextBtn = questEl.querySelector<HTMLButtonElement>('.next')!;
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const q = nextQuest;
      endNext();
      const ci = q ? geo.chains.findIndex((c) => c.stations.some((st) => st.code === q.code)) : -1;
      if (ci >= 0) {
        viewerTapped = true;
        void openStream(ci, { quest: true, focusInside: e.detail === 0 });
      } else ctx.navigate(`#/city/${city}`);
    });
    backBtn = el('button', 'back', ui, { type: 'button' });
    backBtn.innerHTML = '<span class="ar" aria-hidden="true">&larr;</span><span class="nm"></span>';
    backBtn.hidden = true;
    backBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (phase === 'compare') void closeCompare();
      else void closeStrip();
    });
    const cw = el('div', 'cmp', ui);
    const cp = (cls: string, html = ''): HTMLElement => {
      const e = el('p', cls, cw);
      e.innerHTML = html;
      e.style.visibility = 'hidden';
      return e;
    };
    cmpEls = {
      // the tested place's name over its two strokes (the reference pair carries its own)
      site: cp('cn', ''),
      bl: cp('cl', 'Before'),
      al: cp('cl', 'With test'),
      bv: cp('cv'),
      av: cp('cv'),
      fog: cp('cf', 'Still uncertain'),
      // the scale's fixed end, a constant of the drawing (the scale is never rescaled)
      scale: cp('cs', '<span data-unit="100%">100%</span>'),
      // the upstream reference: its name, and where it is
      ref: cp('cr', '<span class="nm"></span> <span class="up">upstream</span>'),
      unit: cp('cu', 'Chance over <span data-num="thresholds.ecoli_flag_per_100ml"></span> <span data-unit>E. coli/100 ml</span> &middot; single-sample flag'),
    };
    cmpEls.unit.querySelector<HTMLElement>('[data-num]')!.textContent = flagText;
    lnowEl = el('div', 'tick', ui);
    lnowEl.textContent = 'now';
    lkmEl = el('div', 'tick', ui);
    scrubEl = el('div', 'tick scrub', ui, { 'data-time': '' });
    scrubEl.hidden = true;
    daysEl = el('div', 'days', ui);
    axisDownEl = el('div', 'tick axis', ui);
    axisDownEl.innerHTML = 'Downstream <span aria-hidden="true">&rarr;</span>';
    axisTimeEl = el('div', 'tick axis', ui);
    axisTimeEl.innerHTML = 'Time <span aria-hidden="true">&darr;</span>';
    estEl = el('div', 'tick est', ui);
    fogEl = el('div', 'tick fogl', ui);
    rainEl = el('div', 'tick rainl', ui);
    rainEl.textContent = 'After rain';
    // the curve's own words: what its scale measures, the scale's fixed ends, and when a result is ready
    axisPEl = el('div', 'tick axisp', ui);
    // the flag's meaning stays beside its number; on a phone it takes a second line
    axisPEl.innerHTML = 'Chance over <span data-num="thresholds.ecoli_flag_per_100ml"></span> <span data-unit>E. coli/100 ml</span><span class="ssf"><span class="dot"> · </span>single-sample flag</span>';
    axisPEl.querySelector<HTMLElement>('[data-num]')!.textContent = flagText;
    scaleEls = ['100%', '0%'].map((v) => {
      const s = el('div', 'tick scale', ui);
      s.innerHTML = `<span data-unit="${v}">${v}</span>`;
      return s;
    });
    endEls = ['first', 'last'].map((k) => el('div', 'tick aend', ui, { 'data-time': '', 'data-end': k }));
    resultEl = el('div', 'tick resl', ui);
    sampleEl = el('div', 'tick resl', ui);
    sampleEl.textContent = 'Sample';
    beforeEl = el('div', 'tick cname prior', ui);
    beforeEl.textContent = 'Before';
    withEl = el('div', 'tick cname', ui);
    withEl.textContent = 'With test';
    leadEl = el('div', 'tick lead', ui, { 'aria-hidden': 'true' });
    leadEl.hidden = true;
    hoursBtn = el('button', 'tick hoursb', ui, { type: 'button', 'aria-pressed': 'false' });
    hoursBtn.textContent = 'Hours';
    hoursBtn.setAttribute('aria-label', 'Hours: every hour along the stream');
    hoursBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setHours(!hoursMode);
    });
    bankSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bankSvg.setAttribute('class', 'bank');
    bankSvg.setAttribute('aria-hidden', 'true');
    ui.appendChild(bankSvg);
    figsEl = el('div', 'figs', ui, { role: 'img', 'aria-label': 'Who uses the stream: a child, an adult, a dog and a heron on its bank' });
    mistSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mistSvg.setAttribute('class', 'bank mist');
    mistSvg.setAttribute('aria-hidden', 'true');
    for (const k of FIGURE_KINDS) {
      const b = el('span', 'fig', figsEl, { 'aria-hidden': 'true' });
      b.dataset['k'] = k;
      figEls[k] = b;
    }
    ui.appendChild(mistSvg);
    questBtn = el('button', 'questbtn', ui, { type: 'button' });
    questBtn.hidden = true;
    questBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tapQuest(e.detail === 0);
    });
    teachEl = el('div', 'teach', ui, { 'aria-hidden': 'true' });
    labelsEl = el('div', 'maplabels', ui);
    keyBtn = el('button', 'keybtn', ui, { type: 'button', 'aria-label': 'What am I looking at?' });
    keyBtn.innerHTML = '<span class="g" aria-hidden="true">?</span><span class="w" aria-hidden="true">What am I looking at?</span>';
    keyBtn.hidden = true;
    keyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (phase === 'rest') showKey(9);
    });
    tapCueEl = el('div', 'tapcue', ui, { 'aria-hidden': 'true' });
    nameEl = el('div', 'sitename', ui);
    nameEl.hidden = true;
    tapCueEl.textContent = 'tap a stream';
    navEl = el('nav', 'sr', ui, { 'aria-label': `${cs.pack.name} streams` });
    geo.chains.forEach((ch, i) => {
      const b = el('button', '', navEl, { type: 'button' });
      b.addEventListener('focus', () => {
        if (phase === 'rest') hoverCi = i;
      });
      b.addEventListener('blur', () => {
        if (hoverCi === i) hoverCi = -1;
      });
      b.addEventListener('click', (e) => {
        viewerTapped = true;
        void openStream(i, { focusInside: e.detail === 0 });
      });
      void ch;
    });
    updateNav();
    // On the strip: the quest's lamp opens the quest; the field scrubs the hour (drag); the line brings back the
    // stream's sentence; only a tap on the map around the strip folds it back.
    SC.setAttribute('role', 'slider');
    SC.setAttribute('aria-label', 'Selected hour: drag, or use the arrow keys');
    SC.setAttribute('aria-orientation', 'horizontal');
    SC.setAttribute('aria-valuemin', '0');
    SC.setAttribute('aria-valuemax', '0');
    SC.setAttribute('aria-valuenow', '0');
    SC.setAttribute('aria-hidden', 'true');
    SC.tabIndex = -1;
    const inField = (x: number, y: number): boolean => {
      if (hoursMode) return x > LY.xL - 12 && x < LY.xR + 12 && y > LY.fT - 8 && y < LY.fB + 8;
      const b = curveBox();
      return x > b.x0 - 12 && x < b.x1 + 12 && y > b.y0 - 16 && y < b.y1 + 16;
    };
    const inside = (el_: HTMLElement, x: number, y: number): boolean => {
      if (el_.hidden) return false;
      const r = el_.getBoundingClientRect();
      return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
    };
    SC.addEventListener('pointerdown', (e) => {
      if (phase !== 'strip' || !sel) return;
      const q = stripQuest(sel);
      if (q && !test && Math.hypot(e.clientX - questPt(q)[0], e.clientY - questPt(q)[1]) < 30) {
        tapQuest();
        return;
      }
      if (inField(e.clientX, e.clientY)) {
        if (lift || voiceMode === 'quest' || voiceMode === 'kit' || holding) return;
        dragging = true;
        document.body.dataset['dragging'] = 'true';
        SC.setPointerCapture(e.pointerId);
        pendingX = e.clientX;
        setScrub(hourAt(e.clientX, e.clientY));
        return;
      }
      if (Math.abs(e.clientY - LY.lineY) < 18 && e.clientX > LY.xL - 10 && e.clientX < LY.xR + 10) {
        if (!test && (voiceMode !== 'sentence' || scrubH !== 0)) {
          if (scrubH !== 0) setScrub(0, false);
          setVoice(sentence());
          voiceMode = 'sentence';
          placeFigs(true);
        }
        return;
      }
      // the words and the quest's buttons are not the map
      if (inside(voiceEl, e.clientX, e.clientY) || inside(questEl, e.clientX, e.clientY)) return;
      void closeStrip();
    });
    SC.addEventListener('pointermove', (e) => {
      // the finger's latest place is read once per frame (a phone sends several moves a frame)
      if (dragging) {
        pendingY = dragY = e.clientY;
        pendingX = e.clientX;
      } else if (e.pointerType === 'mouse') SC.style.cursor = phase === 'strip' && inField(e.clientX, e.clientY) && !lift && voiceMode !== 'quest' && voiceMode !== 'kit' ? (hoursMode ? 'ns-resize' : 'ew-resize') : '';
    });
    const endDrag = (): void => {
      if (dragging && pendingY !== null) setScrub(hourAt(pendingX ?? 0, pendingY));
      pendingY = dragY = null;
      dragging = false;
      delete document.body.dataset['dragging'];
    };
    SC.addEventListener(
      'wheel',
      (e) => {
        if (!hoursMode || phase !== 'strip' || !sel || !inField(e.clientX, e.clientY)) return;
        e.preventDefault();
        scrollRows(vTop + Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40)));
      },
      { passive: false },
    );
    SC.addEventListener('pointerup', endDrag);
    SC.addEventListener('pointercancel', endDrag);
    const onKey = (e: KeyboardEvent): void => {
      // a city on its way out (another route is replacing it) or hidden under the story hears no keys
      if (disposed || root.closest('.leaving') || hiddenLayer()) return;
      if (e.key === 'Escape') {
        if (phase === 'compare') void closeCompare();
        else void closeStrip();
        return;
      }
      if (phase !== 'strip' || lift || voiceMode === 'quest' || voiceMode === 'kit' || document.activeElement?.closest('.questui')) return;
      const step = e.shiftKey ? 6 : 1;
      const to =
        e.key === 'ArrowDown' || e.key === 'ArrowRight' ? scrubH + step : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? scrubH - step : e.key === 'Home' ? 0 : e.key === 'End' ? span : null;
      if (to === null) return;
      e.preventDefault();
      setScrub(to);
    };
    addEventListener('keydown', onKey);
    offs.push(() => removeEventListener('keydown', onKey));
    // A resize or a rotation: the map measures its new size first (every framing is computed through it). At rest the
    // camera goes straight to the framing that holds quest #1's lamp (a glide under way stops there); an open strip
    // is laid out again; a strip still opening is laid out again as soon as it has opened.
    const onResize = (): void => {
      resize();
      try {
        map.resize();
      } catch {
        /* not ready */
      }
      questCam = null;
      if (phase === 'rest') {
        LY = layout();
        applyLayoutVars();
        stopGlide();
        map.jumpTo({ ...questView(), padding: ZERO_PAD });
      }
      if (phase === 'compare') relayoutCompare();
      mpp0 = MPP();
      if (sel && phase === 'strip') relayoutStrip();
      else if (sel && (phase === 'settle' || phase === 'opening')) relayoutDue = true;
    };
    addEventListener('resize', onResize);
    offs.push(() => removeEventListener('resize', onResize));
  }

  /**
   * The storm (story mode): the hour at the four lives' bank where the forecast's chance peaks, if it reaches
   * "higher". The strip moves there slowly, clock-driven, so the figures step back as the storm arrives, and the
   * stream speaks that hour's line. A forecast with no raised hour says so and stays where it is.
   */
  function peakHour(): number | null {
    if (!sel) return null;
    const s = cs.series(anchorStation(sel).code);
    let best = -1,
      at = -1;
    for (let h = 0; h <= span; h++) {
      const v = s.p50[Math.min(s.p50.length - 1, hb + h)]!;
      if (v > best) {
        best = v;
        at = h;
      }
    }
    return best >= cs.thresholds.higher ? at : null;
  }
  async function stormCue(): Promise<boolean> {
    if (phase !== 'strip' || !sel) return false;
    const my = gen;
    const peak = peakHour();
    if (peak === null) {
      setVoice('My forecast stays calm. No storm hours ahead.');
      voiceMode = 'calm';
      return true;
    }
    dragging = false;
    const from = scrubH;
    await tween(STORM_SCRUB_MS, (e) => {
      if (my !== gen) return;
      setScrub(lerp(from, peak, easeIO(e)), false);
    });
    if (my !== gen) return false;
    setScrub(peak);
    return scrubH === peak;
  }

  /**
   * The strip's first row moves to the clock's new hour. An hour the viewer selected keeps its absolute time (its
   * row moves up); "now" stays now.
   */
  function rebase(nb: number): void {
    if (!sel) return;
    const abs = hb + scrubH;
    const atNow = scrubH === 0;
    hb = nb;
    span = Math.max(1, stripRows(cs, hb));
    field = computeField(sel, cs, hb, span);
    scrubH = atNow ? 0 : clamp(abs - hb, 0, span);
    evalLine();
    paintField();
    positionStripUI();
    figState = computeFigs();
    placeFigs(true);
    if (voiceMode === 'sentence') setVoice(sentence(), false, false);
    else if (voiceMode === 'hour') setVoice(hourVoice(), false, false);
  }
  /** Lays an open strip out again for the screen's size: its camera, its line, its field, its words and figures. */
  let relayoutDue = false;
  function relayoutStrip(): void {
    if (!sel) return;
    relayoutDue = false;
    LY = layout();
    applyLayoutVars();
    map.jumpTo(cameraFor(sel));
    projectChainFlat(sel);
    prepMorph(sel);
    paintField();
    positionStripUI();
    placeFigs(true);
    if (!questEl.hidden) questEl.style.top = `${Math.round(voiceEl.getBoundingClientRect().bottom + (LY.phone ? 10 : 16))}px`;
  }

  /** The story's last screen gives way: the viewer explores. */
  function endNext(): void {
    if (voiceMode !== 'next') return;
    clearVoice();
    voiceMode = 'sentence';
    if (document.body.dataset['cue'] === 'next') delete document.body.dataset['cue'];
  }

  // ----- the map's key, on the map itself: what a line, its orange and its dots are -----
  // Story mode shows it once, at its key beat; free exploration brings it back from "What am I looking at?" (it
  // fades after it has been read, or when the viewer moves the map). Each label stands beside a real place on the
  // map: a stream's line, the brightest line on screen, and the densest fog's dots.
  interface MapLabel {
    readonly ll: readonly [number, number];
    readonly e: number;
    readonly el: HTMLElement;
    /** Seconds after it is asked for that it starts to show (the three come one after another). */
    readonly delay: number;
    on: boolean;
    from: number;
    a: number;
  }
  let mapLabels: MapLabel[] = [];
  let keyOffAt = Infinity;
  let labelsEl!: HTMLDivElement;
  let keyBtn: HTMLButtonElement | null = null;
  const KEY_WORDS = { stream: 'Each line is a stream.', orange: 'Brighter orange: higher chance the water is over the line.', fog: 'Dots: nobody has measured here after rain.' } as const;
  function addLabel(ll: readonly [number, number], e: number, text: string, cls: string, delay: number): void {
    const d = el('div', `mk ${cls}`, labelsEl);
    const t = el('span', 'mk-t', d);
    t.textContent = text;
    d.style.opacity = '0';
    d.style.visibility = 'hidden';
    mapLabels.push({ ll, e, el: d, delay, on: true, from: ctx.clock.seconds(), a: 0 });
  }
  /** The key's three places, read from what is on screen now; `fadeAfter` seconds (null: until hidden). */
  function showKey(fadeAfter: number | null): void {
    hideMapLabels(true);
    hideTeach();
    const phone = phoneW();
    const box = phone ? { x0: W * 0.06, x1: W * 0.5, y0: H * 0.32, y1: H * 0.78 } : { x0: W * 0.14, x1: W * 0.66, y0: H * 0.28, y1: H * 0.8 };
    type Cand = { ll: readonly [number, number]; e: number; x: number; y: number; p: number; fog: number };
    const cands: Cand[] = [];
    for (const w of geo.ways) {
      if (w.kind !== 'stream') continue;
      for (let k = 0; k < w.n; k += 3) {
        const pt = proj(w.c[k]!, w.E[k]!);
        if (pt.x < box.x0 || pt.x > box.x1 || pt.y < box.y0 || pt.y > box.y1) continue;
        cands.push({ ll: w.c[k]!, e: w.E[k]!, x: pt.x, y: pt.y, p: w.p50[k]!, fog: w.fog[k]! });
      }
    }
    if (!cands.length) return;
    // labels stand apart vertically (each is one or two lines of text to the side of its place)
    const far = (c: Cand, picked: readonly Cand[]): number => Math.min(Infinity, ...picked.map((q) => Math.max(Math.abs(q.x - c.x) * 0.25, Math.abs(q.y - c.y))));
    const gap = phone ? 80 : 84;
    const orange = cands.reduce((a, b) => (b.p > a.p ? b : a));
    const fogC = cands.filter((c) => far(c, [orange]) >= gap);
    const fog = fogC.length ? fogC.reduce((a, b) => (b.fog > a.fog ? b : a)) : null;
    const picked = fog ? [orange, fog] : [orange];
    const streamC = cands.filter((c) => far(c, picked) >= gap);
    const stream = streamC.length ? streamC.reduce((a, b) => (far(b, picked) > far(a, picked) ? b : a)) : null;
    const order: [Cand | null, string][] = [
      [stream, KEY_WORDS.stream],
      [orange, KEY_WORDS.orange],
      [fog, KEY_WORDS.fog],
    ];
    let i = 0;
    for (const [c, text] of order) if (c) addLabel(c.ll, c.e, text, 'mk-key', ctx.reducedMotion ? 0 : 1.1 * i++);
    keyOffAt = fadeAfter === null ? Infinity : ctx.clock.seconds() + fadeAfter;
    root.dataset['key'] = 'on';
  }
  /** A site's name beside its place (the story's person's sentence and request are about it). */
  function showSiteLabel(code: string): void {
    const s = cs.pack.sites.find((x) => x.code === code);
    if (!s) return;
    addLabel([s.lon, s.lat], s.E ?? 0, siteName(code), 'mk-site', 0);
  }
  function hideMapLabels(now = false): void {
    const t = ctx.clock.seconds();
    for (const l of mapLabels) {
      if (now) l.el.remove();
      else if (l.on) {
        l.on = false;
        l.from = t;
      }
    }
    if (now) mapLabels = [];
    keyOffAt = Infinity;
    delete root.dataset['key'];
  }
  let labelT = 0;
  /** Each frame: the labels follow the map and fade on the clock (at once under reduced motion). */
  function drawLabels(): void {
    const t = ctx.clock.seconds();
    const dt = Math.max(0, t - labelT);
    labelT = t;
    if (t >= keyOffAt) hideMapLabels();
    if (keyBtn) keyBtn.hidden = ctx.story === true || phase !== 'rest' || mapLabels.some((l) => l.on) || root.dataset['ready'] !== 'true';
    if (!mapLabels.length) return;
    const phone = phoneW();
    for (const l of mapLabels) {
      const target = l.on && t - l.from >= l.delay ? 1 : 0;
      l.a = ctx.reducedMotion ? target : target > l.a ? Math.min(1, l.a + dt / 0.5) : Math.max(0, l.a - dt / 0.5);
      const pt = proj(l.ll, l.e);
      const left = pt.x > W * (phone ? 0.55 : 0.68);
      l.el.classList.toggle('mk-l', left);
      // the words stay on the screen: as wide as the room beside the place allows
      (l.el.firstElementChild as HTMLElement).style.maxWidth = `${Math.round(clamp((left ? pt.x : W - pt.x) - 52, 120, phone ? 220 : 340))}px`;
      l.el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
      l.el.style.opacity = l.a.toFixed(3);
      l.el.style.visibility = l.a > 0.01 ? 'visible' : 'hidden';
      if (l.a > 0 && l.a < 1) l.el.dataset['fading'] = '';
      else delete l.el.dataset['fading'];
    }
    mapLabels = mapLabels.filter((l) => {
      if (!l.on && l.a <= 0) {
        l.el.remove();
        return false;
      }
      return true;
    });
  }
  /** Story mode's key beat: the map at the example test reading's hour (after the rain), and its key on it. */
  async function keyCue(): Promise<boolean> {
    if (phase !== 'rest') return false;
    if (opening) {
      storyHour = opening.hour;
      root.dataset['shown'] = nowcast.hours_utc[opening.hour]!;
      evaluate(true);
    }
    await nextFrame();
    await nextFrame();
    showKey(null);
    return true;
  }
  /** Story mode's person's sentence: the camera comes to the tested place, its name beside it. */
  async function humanCue(): Promise<boolean> {
    hideMapLabels();
    if (!opening || phase !== 'rest') return false;
    const s = cs.pack.sites.find((x) => x.code === opening!.code);
    if (s) {
      const c = closeView();
      const to = { center: [s.lon, s.lat] as [number, number], zoom: c.zoom + 0.7, pitch: c.pitch, bearing: c.bearing, padding: ZERO_PAD };
      if (ctx.reducedMotion) map.jumpTo(to);
      else await flyTo(to, 1600, easeIO, () => !disposed && phase === 'rest');
    }
    showSiteLabel(opening.code);
    return true;
  }
  /** "Nobody has measured Eiras after rain. AfterRain asks for one sample: Sunday, 08:00 to 20:00." from the nowcast. */
  function askLine(code: string): Node[] | null {
    const all = rounds().flatMap((r) => r.quests);
    const at = (q: Quest): boolean => hasStrip(q) && questOpen(q);
    const q = quests().find((x) => x.code === code && at(x)) ?? all.find((x) => x.code === code && at(x)) ?? restQuest();
    if (!q) return null;
    const out: Node[] = [];
    if (sampledFlag.get(code) !== true) out.push(document.createTextNode(`Nobody has measured ${siteName(code)} after rain. `));
    const t = (ms: number): HTMLElement => {
      const e = document.createElement('span');
      e.dataset['time'] = '';
      e.textContent = formatClock(ms, zone);
      return e;
    };
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][localParts(q.startMs, zone).weekday]!;
    out.push(document.createTextNode(`AfterRain asks for one sample${q.code === code ? '' : ` at ${q.display}`}: ${day}, `), t(q.startMs), document.createTextNode(' to '), t(q.endMs), document.createTextNode('.'));
    return out;
  }

  // ----- story mode's opening and close -----
  /** The opening: the mapped stream at the test's hour, then its copy straightens into the "Before" ribbon. */
  async function openingCue(): Promise<boolean> {
    if (!opening) return false;
    if (!cmp && phase === 'rest') enterCompare();
    const c = cmp;
    if (!c) return phase === 'strip';
    const my = gen;
    // the copy straightens at CMP.morphAt seconds from navigation; a live scene that arrives later picks it up
    // where the page's first paint has it
    await untilNav(CMP.morphAt, navSec() >= CMP.morphAt ? 0 : 300);
    if (my !== gen || cmp !== c) return false;
    const from = clamp((navSec() - CMP.morphAt) / CMP.morph, 0, 1);
    await tween((1 - from) * CMP.morph * 1000, (e) => {
      c.morph = from + (1 - from) * e;
      c.veil = Math.max(c.veil, c.morph);
    });
    return my === gen && cmp === c;
  }
  /** The test's real controls: "Test reading", the assumed collection date, the two readings. */
  async function kitCue(): Promise<boolean> {
    if (cmp) {
      const c = cmp;
      const my = gen;
      await untilNav(CMP.kitAt, 0);
      if (my !== gen || cmp !== c) return false;
      showCompareKit();
      // a live scene that arrives late (a slow phone) keeps the script's order on shorter steps
      const late = navSec() > CMP.testAt;
      await tween(CMP.show * (late ? 600 : 1000), (e) => (c.kitA = Math.max(c.kitA, e)));
      await untilNav(CMP.testAt, late ? 250 : 400);
      return my === gen && cmp === c;
    }
    if (phase !== 'strip' || test) return !!test;
    if (voiceMode !== 'quest') tapQuest();
    openKit();
    await wait(1000);
    return voiceMode === 'kit';
  }
  /**
   * "900 or less", chosen through the same handler as a person's click; done when that reading's change has run
   * (or was cut short: the story never waits on a lost reveal).
   */
  async function testCue(): Promise<boolean> {
    if (cmp) {
      if (!cmp.applied) questEl.querySelector<HTMLButtonElement>('button[data-obs="under"]')!.click();
      await sampling;
      return !!cmp?.applied;
    }
    if (phase !== 'strip') return false;
    if (!test) questEl.querySelector<HTMLButtonElement>('button[data-obs="under"]')!.click();
    await sampling;
    return voiceMode === 'result';
  }
  /** The record behind the changed line, turned over by the story (it does not hold the story). */
  async function recordCue(): Promise<boolean> {
    if (phase !== 'strip' && phase !== 'compare') return false;
    // a direct link plays this beat while the city's layer is still fading in: the card turns once it is on screen
    for (let i = 0; i < 180 && layerAlpha() < 0.95 && !disposed; i++) await nextFrame();
    // the comparison's tested number turns over (its record); on the strip, the line
    document.dispatchEvent(new CustomEvent('sayr:xray', { detail: { el: cmp ? cmpEls.av : voiceEl, story: true } }));
    await wait(900);
    return true;
  }
  /**
   * The card turns back, the comparison folds into Coimbra and the camera settles on the next eligible sampling
   * site (the nowcast's quest #1 while its window is open): its name is the one control, its window carries the zone.
   */
  async function foldCue(): Promise<boolean> {
    document.dispatchEvent(new CustomEvent('sayr:xray-close'));
    // back to the clock's hour: the request that follows is for now
    storyHour = null;
    delete root.dataset['shown'];
    hideMapLabels(true);
    await wait(ctx.reducedMotion ? 0 : 750);
    // the camera comes to rest on the next site's lamp, at the city's close framing
    const q = restQuest();
    const site = q ? cs.pack.sites.find((x) => x.code === q.code) : undefined;
    const c = closeView();
    const to = site ? { center: [site.lon, site.lat] as [number, number], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing } : undefined;
    if (phase === 'compare') await closeCompare(to);
    else if (phase === 'strip') await closeStrip(false, to);
    if ((phase as Phase) !== 'rest') return false;
    showNext();
    return true;
  }
  /** The quest the story's last screen names. */
  let nextQuest: Quest | null = null;
  /** The story's last screen: the window (with its zone) and "Sample <site>", which opens the site's stream on its quest. */
  function showNext(): void {
    const open = restQuest();
    // A live forecast whose remaining hours hold no request (every window closed, review 2026-10-03): the latest
    // request the forecast made, with its full date ("Wed 7 Oct 08:00–10:00 UTC+1"), so the ending never loses its
    // action and says which day the request was for.
    const latest = (): Quest | null => {
      for (const r of [...rounds()].reverse()) for (const x of r.quests) if (hasStrip(x)) return x;
      return null;
    };
    const q = open ?? latest();
    const fetchedMs = Date.parse(nowcast.forecast_fetched_utc);
    voiceMode = 'next';
    nextQuest = q;
    if (q) {
      // an old forecast keeps its corner ("forecast 2 Oct") through the handover; the window then says its times
      // and zone alone when it falls on that date, its weekday within the days after
      winEl.textContent = live() ? windowText(q.startMs, q.endMs, zone) : windowTextAfterDate(q.startMs, q.endMs, zone, fetchedMs);
      nextBtn.replaceChildren(textNode('Sample '), siteNode(q));
      nextBtn.setAttribute('aria-label', `Sample ${q.display}: open its stream`);
      questEl.dataset['request'] = !open ? 'dated' : q.round > 0 ? 'later' : 'saved';
      questEl.dataset['endMs'] = String(q.endMs);
    } else {
      // no quest on a stream at all: the control opens the city map
      winEl.textContent = '';
      nextBtn.replaceChildren(textNode('Explore the map'));
      nextBtn.setAttribute('aria-label', 'Explore the map');
      questEl.dataset['request'] = 'none';
    }
    clearVoice();
    questEl.hidden = false;
    questEl.dataset['stage'] = 'next';
    questEl.style.top = `${LY.vt}px`;
    questEl.style.opacity = '';
    root.classList.add('questing');
    fadeIn(questEl);
    document.body.dataset['cue'] = 'next';
  }

  // ----- the opening comparison -----
  // The mapped stream stays in the upper part of the screen the whole time, the camera and the hour fixed (Tue 6 Oct
  // 15:00, src/model/demo.ts). Under it the tested place's chance is a length on one fixed 0 to 100% scale: the
  // "Before" stroke grows from the scale's origin; the real test control takes "Test reading: 900 or less"; the
  // "With test" stroke, adjacent and aligned, starts at the "Before" length and shrinks or grows to the recomputed
  // chance while the mapped stream changes from the tested place outward. The upstream reference (Escravote) has the
  // same pair, thin, and its two strokes stay equal. Colour is the chance (one ramp), the stipple is the fog: two
  // channels. The script runs on seconds from navigation (CMP), so the page's first paint and the live scene show
  // one moment.
  interface Vals {
    readonly p: Float32Array;
    readonly f: Float32Array;
  }
  /** A station's chance and fog at the comparison's hour. */
  interface Bar {
    readonly p: number;
    readonly f: number;
  }
  interface Cmp {
    readonly ci: number;
    readonly code: string;
    readonly up: string;
    readonly hour: number;
    readonly rule: string;
    readonly before: Vals;
    /** What the mapped stream changes from: the baseline, or the reading on screen before this one. */
    from: Vals;
    after: Vals | null;
    /** The tested (s) and upstream (u) stations: before the test, what the "With test" strokes change from, and with the reading. */
    readonly sB: Bar;
    readonly uB: Bar;
    sFrom: Bar;
    uFrom: Bar;
    sA: Bar | null;
    uA: Bar | null;
    over: boolean | null;
    /** The site's own test reading is applied (a new reading takes it back first: one baseline for every test). */
    applied: boolean;
    /** The "Before" strokes' growth from the origin (0..1). */
    morph: number;
    kitA: number;
    afterA: number;
    wipe: number;
    veil: number;
    out: number;
    /** The chain's km of the tested station. */
    kT: number;
  }
  let cmp: Cmp | null = null;
  /** The comparison is fully on (1) or fading out (to 0). */
  let cmpIn = 0;
  let CL = compareLayout(innerWidth, innerHeight);
  let cmpWordsOn = false;
  const manualClock = (): boolean => (window as { __sayrClock?: { mode?: string } }).__sayrClock?.mode === 'manual';
  /**
   * Seconds since navigation: real time (the app's animation seconds fall behind it on a slow phone), or the film
   * clock's own seconds when it is stepped by hand.
   */
  /** The comparison's script starts when it is entered (one second before its strokes grow), wherever the story is. */
  let cmpBase = 0;
  const navSec = (): number => (manualClock() ? ctx.clock.seconds() : performance.now() / 1000) - cmpBase;
  /** Waits at least `minMs` of animation time, then until `at` seconds from navigation. */
  async function untilNav(at: number, minMs: number): Promise<void> {
    if (minMs > 0) await wait(minMs);
    const my = gen;
    while (navSec() < at && my === gen && !disposed) await nextFrame();
  }
  const valsAt = (ch: Chain, h: number): Vals => {
    const p = new Float32Array(ch.n),
      f = new Float32Array(ch.n);
    for (let k = 0; k < ch.n; k++) {
      const v = pointOnStream(ch.stations, (c) => cs.series(c), ch.km[k]!, h, cs.thresholds);
      p[k] = v.p50;
      f[k] = v.fog;
    }
    return { p, f };
  };
  const barOf = (code: string, h: number): Bar => {
    const s = cs.series(code);
    return { p: s.p50[h]!, f: s.fog[h]! };
  };
  function applyCompareVars(): void {
    const r = root.style;
    r.setProperty('--vl', `${CL.vl}px`);
    r.setProperty('--vt', `${CL.vt}px`);
    r.setProperty('--vs', `${CL.vs}px`);
    r.setProperty('--vw', `${W - 2 * CL.vl}px`);
  }
  function enterCompare(): void {
    if (!opening || cmp) return;
    const ch = geo.chains[opening.ci]!;
    gen++;
    sel = ch;
    CL = compareLayout(W, H);
    LY = layout();
    const before = valsAt(ch, opening.hour);
    const kT = ch.stations.find((s) => s.code === opening!.code)!.km;
    const sB = barOf(opening.code, opening.hour);
    const uB = barOf(opening.up, opening.hour);
    cmp = { ...opening, before, from: before, after: null, sB, uB, sFrom: sB, uFrom: uB, sA: null, uA: null, over: null, applied: false, morph: 0, kitA: 0, afterA: 0, wipe: 0, veil: 0, out: 0, kT };
    cmpBase = 0;
    cmpBase = navSec() - (CMP.morphAt - 1);
    hideMapLabels(true);
    cmpIn = 1;
    root.classList.add('cmp', 'questing');
    setPhase('compare');
    setInteractive(false);
    hideTeach();
    hideMapChain(true);
    map.jumpTo(compareCamera(ch));
    projectChainFlat(ch);
    evaluate(true);
    applyCompareVars();
    setVoice('Try one water test.', false, false);
    voiceMode = 'request';
    // the way back is its arrow alone here: the comparison's words are its own
    root.classList.add('questing');
    nameEl.textContent = siteName(opening.code);
    nameEl.hidden = false;
    cmpEls.ref.firstElementChild!.textContent = siteName(opening.up);
    cmpEls.site.textContent = siteName(opening.code);
    backBtn.querySelector<HTMLElement>('.nm')!.textContent = ch.display;
    backBtn.setAttribute('aria-label', `Back to the map of ${cs.pack.name}`);
    backBtn.hidden = false;
    const ms = cs.hoursMs[opening.hour]!;
    cmpWhenEl.textContent = `${formatDayMonth(ms, zone)} ${formatClock(ms, zone)} ${formatZone(ms, zone)}`;
    bindCompare();
    root.dataset['compare'] = 'map';
  }
  /**
   * A direct link into a later beat of the story (#/story/back, record, fold): the comparison as the uninterrupted
   * story left it, built at once: the "Before" strokes grown, the controls shown, "900 or less" taken and its change
   * run through.
   */
  function holdCompare(): void {
    const c = cmp;
    if (!c) return;
    c.morph = 1;
    c.veil = 1;
    showCompareKit();
    c.kitA = 1;
    applyCompare(c, false);
    c.afterA = 1;
    c.wipe = 1;
    root.dataset['compare'] = 'held';
    root.dataset['held'] = navSec().toFixed(2);
  }
  /** A screen of another size: the camera and the strokes are laid out again. */
  function relayoutCompare(): void {
    const c = cmp;
    if (!c || !sel) return;
    CL = compareLayout(W, H);
    LY = layout();
    map.jumpTo(compareCamera(sel));
    projectChainFlat(sel);
    applyCompareVars();
    if (!questEl.hidden) questEl.style.top = `${CL.yKit}px`;
    dotCache.clear();
  }
  function showCompareKit(): void {
    if (!cmp) return;
    clearVoice();
    questEl.hidden = false;
    questEl.dataset['stage'] = 'cmp';
    questEl.style.top = `${CL.yKit}px`;
    root.classList.add('questing');
    root.dataset['compare'] = 'kit';
  }
  /** The readouts at the tested place, each bound to its record: the published forecast, then the test estimate. */
  function bindCompare(): void {
    const c = cmp;
    if (!c) return;
    const fb = forecastAt(c.code, c.hour);
    cmpEls.bv.replaceChildren(...(fb ? [chanceNode(fb)] : []));
    if (fb) cmpEls.bv.dataset['fhir'] = fb.key;
    const ta = c.applied ? recordAt(c.code, c.hour) : null;
    cmpEls.av.replaceChildren(...(ta ? [chanceNode(ta)] : []));
    if (ta) cmpEls.av.dataset['fhir'] = ta.key;
    else delete cmpEls.av.dataset['fhir'];
    questEl.querySelectorAll<HTMLButtonElement>('button[data-obs]').forEach((b) => b.setAttribute('aria-pressed', String(c.applied && (b.dataset['obs'] === 'over') === c.over)));
  }
  /** Takes the reading: the site's earlier reading back first (one baseline), then the new one, recomputed at the test's hour. */
  function applyCompare(c: Cmp, over: boolean): void {
    const prev = c.after;
    const sPrev = c.sA;
    const uPrev = c.uA;
    if (c.applied) cs.undo(c.code);
    const prior = cs.series(c.code);
    const applied = cs.applyTestSample(c.code, c.hour, { over_900: over });
    c.applied = true;
    readings.set(c.code, { code: c.code, hour: applied.hour, collectedUtc: nowcast.hours_utc[applied.hour]!, over, line: testResultLine(prior.p50[applied.hour]!, cs.series(c.code).p50[applied.hour]!, false), site: siteName(c.code), prior, before: null });
    done.add(c.code);
    c.from = prev ?? c.before;
    c.sFrom = sPrev ?? c.sB;
    c.uFrom = uPrev ?? c.uB;
    c.after = valsAt(sel!, c.hour);
    c.sA = barOf(c.code, c.hour);
    c.uA = barOf(c.up, c.hour);
    c.over = over;
    c.wipe = 0;
    root.dataset['tested'] = over ? 'over' : 'under';
    evaluate(true);
    bindCompare();
  }
  /**
   * A test reading in the comparison, through the real controls: the site's earlier reading (if any) is taken
   * back first, so a low and a high test start from the same baseline; the "With test" strokes show at the length
   * they change from and run to the new chance while the change runs out from the tested place on the map.
   */
  async function submitCompare(over: boolean): Promise<void> {
    const c = cmp;
    if (!c || !sel || (c.applied && c.over === over)) return;
    if (c.wipe > 0 && c.wipe < 1) return;
    const my = gen;
    applyCompare(c, over);
    root.dataset['compare'] = 'test';
    const late = navSec() > CMP.testAt + 0.8;
    if (c.afterA < 1) await tween(CMP.show * (late ? 600 : 1000), (e) => (c.afterA = Math.max(c.afterA, e)));
    if (my !== gen || cmp !== c) return;
    await tween(CMP.wipe * (late ? 600 : 1000), (e) => (c.wipe = easeIO(e)));
    if (my !== gen || cmp !== c) return;
    c.wipe = 1;
    root.dataset['compare'] = 'held';
    if (!root.dataset['held']) root.dataset['held'] = navSec().toFixed(2);
  }
  /** The comparison gives way to the city at rest (the test stays applied), and the terrain comes in. */
  async function closeCompare(to?: CameraLike): Promise<void> {
    const c = cmp;
    if (!c || phase !== 'compare') return;
    const my = ++gen;
    questEl.hidden = true;
    clearVoice();
    nameEl.hidden = true;
    backBtn.hidden = true;
    root.classList.remove('questing');
    await tween(450, (e) => {
      c.out = easeIO(e);
      cmpIn = 1 - c.out;
    });
    if (my !== gen) return;
    cmp = null;
    cmpIn = 0;
    root.classList.remove('cmp');
    delete root.dataset['compare'];
    hideMapChain(false);
    sel = null;
    setPhase('settle');
    enableTerrain();
    evaluate(true);
    dirty = true;
    await flyTo({ ...(to ?? view()), padding: ZERO_PAD }, 1300, easeIO);
    if (my !== gen) return;
    setPhase('rest');
    setInteractive(true);
    reconcile();
  }
  /** The DEM sources, the hillshade and the 3D ground, added after the opening (it is a flat map). */
  let terrainOn = true;
  function enableTerrain(): void {
    if (terrainOn) return;
    terrainOn = true;
    try {
      map.addSource('demT', demSource());
      map.addSource('demH', demSource());
      map.addLayer(hillLayer(theme), 'water');
      exag = 0;
      riseT0 = -1;
      map.setTerrain({ source: 'demT', exaggeration: 0 });
      liveAll = true;
    } catch (e) {
      console.error('city: the terrain could not be added', e);
    }
  }
  /** A tested or reference place on the map: a dark ring with a light core (the tested one larger). */
  function drawMark(x: number, y: number, tested: boolean, a: number): void {
    const D = DPR,
      day = theme === 'day';
    if (a <= 0.01) return;
    sc.globalAlpha = a;
    sc.fillStyle = day ? '#f3f1ea' : '#04090a';
    sc.beginPath();
    sc.arc(x * D, y * D, (tested ? 6.2 : 4.6) * D, 0, 7);
    sc.fill();
    if (tested) {
      sc.fillStyle = day ? '#1b2325' : '#fff8ea';
      sc.beginPath();
      sc.arc(x * D, y * D, 3.8 * D, 0, 7);
      sc.fill();
    } else {
      sc.strokeStyle = day ? '#1b2325' : '#e7eeea';
      sc.lineWidth = 1.4 * D;
      sc.beginPath();
      sc.arc(x * D, y * D, 2.8 * D, 0, 7);
      sc.stroke();
    }
    sc.globalAlpha = 1;
  }
  /** The comparison's stipple, kept while its line and fog do not change (a held frame costs nothing). */
  const dotCache = new Map<string, { key: string; dots: number[] }>();
  const cachedDots = (slot: string, key: string, make: () => number[]): number[] => {
    const hit = dotCache.get(slot);
    if (hit && hit.key === key) return hit.dots;
    const dots = make();
    dotCache.set(slot, { key, dots });
    return dots;
  };
  /** Where a chance ends on the strokes' fixed scale. */
  const barX = (p: number): number => CL.x0 + clamp(p, 0, 1) * (CL.x1 - CL.x0);
  /** The scale under a stroke: a faint hairline from 0% to 100%, closed by a short tick at each end. */
  function drawTrack(y: number, w: number, a: number): void {
    const D = DPR;
    if (a <= 0.01) return;
    sc.globalAlpha = a;
    sc.fillStyle = theme === 'day' ? 'rgba(27,35,37,.3)' : 'rgba(231,238,234,.24)';
    const th = Math.max(1, Math.round(D));
    sc.fillRect(Math.round(CL.x0 * D), Math.round(y * D - th / 2), Math.round((CL.x1 - CL.x0) * D), th);
    const tk = Math.round((w / 2 + 3) * D);
    sc.fillRect(Math.round(CL.x0 * D - th / 2), Math.round(y * D) - tk, th, 2 * tk);
    sc.fillRect(Math.round(CL.x1 * D - th / 2), Math.round(y * D) - tk, th, 2 * tk);
    sc.globalAlpha = 1;
  }
  /** One probability stroke: from the scale's origin to the chance `p`, in the colour of `colourP` (its own chance). */
  function drawBar(y: number, w: number, p: number, colourP: number, a: number): void {
    const D = DPR;
    if (a <= 0.01) return;
    sc.globalAlpha = a;
    sc.strokeStyle = `rgb(${probabilityColour(colourP, theme).join(',')})`;
    sc.lineWidth = w * D;
    sc.lineCap = 'round';
    sc.beginPath();
    sc.moveTo(CL.x0 * D, y * D);
    sc.lineTo(Math.max(CL.x0 + 0.01, barX(p)) * D, y * D);
    sc.stroke();
    sc.globalAlpha = 1;
  }
  /** The fog's stipple along a stroke's whole scale (its fog, not its length, decides how many dots show). */
  const barDots = (slot: string, y: number, f: number, R: number, inner: number, seed: number): number[] =>
    cachedDots(slot, `${y}|${f.toFixed(4)}|${CL.x0},${CL.x1}`, () => stippleAlong([CL.x0, CL.x1], [y, y], [f, f], R, inner, 3, seed));
  function drawCompare(): void {
    const c = cmp;
    if (!c || !sel) return;
    const ch = sel,
      n = ch.n,
      day = theme === 'day',
      A = 1 - c.out;
    // the change runs out from the tested place: a vertex shows its new state once the front has passed it
    const reach = Math.max(c.kT, ch.L - c.kT) + 0.3;
    const mix = (k: number): number => (c.after ? 1 - sstep(c.wipe * reach - 0.3, c.wipe * reach, Math.abs(ch.km[k]! - c.kT)) : 0);
    const to = c.after ?? c.from;
    const pNow = new Float32Array(n),
      fNow = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const m = mix(k);
      pNow[k] = lerp(c.from.p[k]!, to.p[k]!, m);
      fNow[k] = lerp(c.from.f[k]!, to.f[k]!, m);
    }
    const mx = new Float32Array(n),
      my = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      mx[k] = ch.P[2 * k]!;
      my[k] = ch.P[2 * k + 1]!;
    }
    const kUp = kIndex(ch, ch.stations.find((s) => s.code === c.up)?.km ?? 0);
    const kTi = kIndex(ch, c.kT);
    const thin: [number, number][] = day ? [[3.5, 1]] : [[10, 0.12], [3.5, 1]];
    sc.globalCompositeOperation = 'source-over';
    // the mapped stream, where it lies: the fog's stipple around it, the water over it at one opacity
    const state = `${c.over}|${c.wipe.toFixed(3)}|${W}x${H}`;
    drawDots(sc, cachedDots('map', `${state}|${ch.P[0]!.toFixed(1)},${ch.P[1]!.toFixed(1)},${ch.P[2 * n - 1]!.toFixed(1)}`, () => stippleAlong(mx, my, fNow, CL.mapFogR, 3.5, 2.6, 11)), A);
    strokeRuns(sc, ch.P, n, (k) => 0.5 * (pNow[k]! + pNow[k + 1]!), thin, A);
    drawMark(ch.P[2 * kUp]!, ch.P[2 * kUp + 1]!, false, A);
    drawMark(ch.P[2 * kTi]!, ch.P[2 * kTi + 1]!, true, A);
    // "Before": the tested place's chance and the reference's, grown from the scale's origin
    const g = easeIO(c.morph);
    const bA = sstep(0, 0.12, c.morph) * A;
    if (bA > 0.01) {
      drawTrack(CL.yBefore, CL.barW, bA);
      drawDots(sc, barDots('sB', CL.yBefore, c.sB.f, CL.fogR, CL.fogIn, 5), sstep(0.6, 1, c.morph) * A);
      drawBar(CL.yBefore, CL.barW, c.sB.p * g, c.sB.p, bA);
      drawTrack(CL.yRef, CL.refW, bA);
      drawDots(sc, barDots('uB', CL.yRef, c.uB.f, CL.fogR * 0.45, CL.refW / 2 + 1.5, 7), sstep(0.6, 1, c.morph) * A);
      drawBar(CL.yRef, CL.refW, c.uB.p * g, c.uB.p, bA);
    }
    // "With test": adjacent, aligned; it starts at the length it changes from and runs to the new chance
    if (c.afterA > 0.01) {
      const a = c.afterA * A;
      const w = c.sA ? c.wipe : 0;
      const sP = lerp(c.sFrom.p, c.sA?.p ?? c.sFrom.p, w),
        sF = lerp(c.sFrom.f, c.sA?.f ?? c.sFrom.f, w);
      const uP = lerp(c.uFrom.p, c.uA?.p ?? c.uFrom.p, w),
        uF = lerp(c.uFrom.f, c.uA?.f ?? c.uFrom.f, w);
      drawTrack(CL.yAfter, CL.barW, a);
      drawDots(sc, barDots('sA', CL.yAfter, sF, CL.fogR, CL.fogIn, 5), a);
      drawBar(CL.yAfter, CL.barW, sP, sP, a);
      drawTrack(CL.yRef2, CL.refW, a);
      drawDots(sc, barDots('uA', CL.yRef2, uF, CL.fogR * 0.45, CL.refW / 2 + 1.5, 7), a);
      drawBar(CL.yRef2, CL.refW, uP, uP, a);
    }
  }
  /** The comparison's words, each beside its stroke, faded with it (marked data-fading while it fades). */
  function placeCompareWords(): void {
    const c = cmp;
    if (!c && !cmpWordsOn) return;
    cmpWordsOn = !!c;
    const fade = (e: HTMLElement, a: number): void => {
      e.style.opacity = a.toFixed(3);
      e.style.visibility = a > 0.01 ? 'visible' : 'hidden';
      if (a > 0.01 && a < 0.99) e.dataset['fading'] = '';
      else delete e.dataset['fading'];
    };
    if (!c || !sel) {
      for (const e of Object.values(cmpEls)) fade(e, 0);
      return;
    }
    const A = 1 - c.out;
    const bA = sstep(0.85, 1, c.morph) * A;
    // "Before" and the place's name come in as the stroke starts to grow
    const bL = sstep(0, 0.12, c.morph) * A;
    const aA = c.afterA * A;
    // a word of font size s centred on y (sizes from styles.css, read once per screen size)
    const mid = (e: HTMLElement, x: number, y: number, align: 'l' | 'r' = 'l'): void => put(e, x, y - Math.round(fontPx(e) * 0.55), align);
    put(cmpEls.site, CL.xL, CL.yBefore - CL.barW / 2 - CL.fogIn - CL.fogR - fontPx(cmpEls.site) - 3);
    mid(cmpEls.bl, CL.xL, CL.yBefore);
    mid(cmpEls.al, CL.xL, CL.yAfter);
    // a readout sits just past its stroke's end, or over the stroke's end when that is near the screen's edge
    const readout = (e: HTMLElement, y: number, p: number): void => {
      const x = barX(p) + CL.barW / 2 + (CL.phone ? 8 : 12);
      if (x + (e.offsetWidth || 64) > W - 6) put(e, barX(p), y - CL.barW / 2 - fontPx(e) - 2, 'r');
      else mid(e, x, y);
    };
    readout(cmpEls.bv, CL.yBefore, c.sB.p * easeIO(c.morph));
    const w = c.sA ? c.wipe : 0;
    readout(cmpEls.av, CL.yAfter, lerp(c.sFrom.p, c.sA?.p ?? c.sFrom.p, w));
    put(cmpEls.scale, CL.x1, CL.yBefore - CL.barW / 2 - CL.fogIn - CL.fogR - fontPx(cmpEls.scale) - 3, 'r');
    put(cmpEls.fog, CL.x0, CL.yAfter + CL.fogIn + CL.fogR + 4);
    put(cmpEls.ref, CL.xL, Math.round((CL.yRef + CL.yRef2) / 2 - (cmpEls.ref.offsetHeight || 2 * fontPx(cmpEls.ref)) / 2));
    put(cmpEls.unit, CL.xL, CL.yUnit);
    fade(cmpEls.site, bL);
    fade(cmpEls.bl, bL);
    fade(cmpEls.bv, bA);
    fade(cmpEls.scale, bA);
    fade(cmpEls.ref, bA);
    fade(cmpEls.al, aA);
    fade(cmpEls.av, c.applied ? aA : 0);
    fade(cmpEls.unit, bA);
    const unsure = !!c.sA && c.sA.f >= cs.thresholds.unknown_fog;
    fade(cmpEls.fog, unsure ? aA * sstep(0.3, 0.7, c.wipe) : 0);
    questEl.style.opacity = c.kitA.toFixed(3);
    if (c.kitA > 0.01 && c.kitA < 0.99) questEl.dataset['fading'] = '';
    else delete questEl.dataset['fading'];
  }
  /** An element's font size in CSS px, read once per element and screen width. */
  const fontCache = new WeakMap<HTMLElement, { w: number; px: number }>();
  const fontPx = (e: HTMLElement): number => {
    const hit = fontCache.get(e);
    if (hit && hit.w === W) return hit.px;
    const px = Number.parseFloat(getComputedStyle(e).fontSize) || 18;
    fontCache.set(e, { w: W, px });
    return px;
  };

  function hooks(): void {
    const figPoint = (k: FigureKind): [number, number] => {
      const r = figEls[k].getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    window.sayr = myHooks = {
      city,
      phase: () => phase,
      streams: () => geo.chains.map((c) => ({ slug: c.slug, name: c.name, km: c.L, stations: c.stations.map((s) => s.code) })),
      open: (slugOrIndex: string | number, quest = false) => openStream(typeof slugOrIndex === 'number' ? slugOrIndex : geo.chains.findIndex((c) => c.slug === slugOrIndex), { quest }),
      close: () => closeStrip(),
      quest: () => tapQuest(),
      sample: (over: boolean) => {
        if (voiceMode !== 'kit') {
          tapQuest();
          openKit();
        }
        return (sampling = submitSample({ over_900: over }));
      },
      reset: () => resetTest(),
      hold: (on: boolean) => holdBefore(on),
      /** The test on screen: its place, strip row, reading and result line; null before a test or after a reset. */
      test: () => (test ? { code: test.code, row: test.row, over: test.over, line: test.line } : null),
      opening: () => opening,
      /** The opening comparison: its place, hour and stage, and the values at the tested and upstream stations. */
      compare: () => {
        if (!cmp) return null;
        const at = (code: string) => {
          const s = cs.series(code);
          return { p: s.p50[cmp!.hour]!, fog: s.fog[cmp!.hour]! };
        };
        return { code: cmp.code, up: cmp.up, hour: cmp.hour, hourUtc: nowcast.hours_utc[cmp.hour], rule: cmp.rule, stage: root.dataset['compare'] ?? null, over: cmp.over, applied: cmp.applied, morph: cmp.morph, afterA: cmp.afterA, wipe: cmp.wipe, tested: at(cmp.code), upstream: at(cmp.up), held: root.dataset['held'] ?? null };
      },
      /** The record key the line is bound to (the x-ray opens it). */
      record: () => voiceEl.dataset['fhir'] ?? null,
      /** The strip's labels a viewer can read now: their text, by kind. */
      labels: () =>
        Object.fromEntries(
          ([['time', scrubEl], ['estimate', estEl], ['fog', fogEl], ['downstream', axisDownEl], ['axisTime', axisTimeEl], ['rain', rainEl]] as const).map(([k, e]) => [k, !e.hidden && !e.classList.contains('off') && getComputedStyle(e).visibility === 'visible' ? e.textContent : null]),
        ),
      questStream: () => {
        for (const ch of geo.chains) if (stripQuestAt(ch)) return ch.slug;
        return null;
      },
      /** The stream of the quest whose lamp shows at rest (the city's quest #1 when it has a strip). */
      restQuestStream: () => {
        const q = restQuest();
        return q ? (geo.chains.find((c) => c.stations.some((s) => s.code === q.code))?.slug ?? null) : null;
      },
      questPoint: () => {
        const q = sel ? stripQuest(sel) : null;
        return q ? questPt(q) : null;
      },
      /** The curve's point at a strip row (the selected hour's dot sits there). */
      hourPoint: (h: number) => (sel && LY && !hoursMode ? [cxOf(h), cyOf(curveAt(h).p)] : null),
      /** "Hours": the spatial strip (true) or the curve (false). */
      hours: (on: boolean) => setHours(on),
      hoursOn: () => hoursMode,
      /**
       * The curve's readouts (the value and the fog's words) and whether either crosses a drawn curve: the value
       * must never sit on a stroke.
       */
      readouts: () => ({
        est: estEl.hidden || estEl.classList.contains('off') ? null : estEl.getBoundingClientRect().toJSON(),
        fog: fogEl.hidden || fogEl.classList.contains('off') || fogEl.dataset['empty'] !== undefined ? null : fogEl.getBoundingClientRect().toJSON(),
        hitsCurve: [estEl, fogEl, beforeEl, withEl].some((e) => !e.hidden && !e.classList.contains('off') && e.dataset['empty'] === undefined && hitsCurve(e.getBoundingClientRect(), 0)),
        box: sel && LY && !hoursMode ? curveBox() : null,
        /** The value's distance from its point (CSS px) and whether a connector joins them: near means within NEAR. */
        gap: estGap,
        lead: estLead && !leadEl.hidden,
        near: NEAR,
        /** The curves' names on screen, and the sample's marks under the time axis (their text and box). */
        names: Object.fromEntries(
          ([['before', beforeEl], ['with', withEl], ['sample', sampleEl], ['result', resultEl]] as const).map(([k, e]) => [k, e.hidden || e.classList.contains('off') ? null : { text: e.textContent, rect: e.getBoundingClientRect().toJSON() }]),
        ),
        sampleTiming: sampleTiming(),
        curves: curveXY && LY && !hoursMode ? { now: [...curveXY], prior: priorXY ? [...priorXY] : null } : null,
      }),
      restQuestPoint: () => {
        const q = restQuest();
        const s = q && lamps.find((l) => l.code === q.code);
        return s ? [s.x, s.y] : null;
      },
      chainPoint: (ci: number) => {
        const ch = geo.chains[ci]!;
        const k = Math.floor(ch.n * 0.45);
        return [ch.P[2 * k], ch.P[2 * k + 1]];
      },
      figurePoint: figPoint,
      figures: () => (figState ? Object.fromEntries(FIGURE_KINDS.map((k) => [k, { ...figState![k], rect: figEls[k].getBoundingClientRect().toJSON() }])) : null),
      info: () => ({ phase, stream: sel?.display ?? null, sentence: sel ? sentence().map((n) => n.textContent).join('') : null, hour: hourLabel(hNow), hb, span, revision: cs.revision, scrub: scrubH, live: live(), dated: storyDated, want, voiceMode }),
      scrub: (h: number) => setScrub(h),
      /** The hour the story's storm moves to (the forecast's peak at the four lives' bank), or null when calm. */
      peakHour: () => peakHour(),
      kit: () => openKit(),
      /** The quest's ask, then the kit at strip row h (a test assumed collected at that hour; tests and stills). */
      kitAt: (h: number) => {
        tapQuest();
        setScrub(h, false);
        openKit();
      },
      /** The wave of a test sample is running: its progress 0..1, else null. */
      lifting: () => (lift ? lift.prog : null),
      /**
       * The screen point of a strip cell whose chance is "higher" (between the two thresholds) and whose fog is at
       * or above the unknown threshold, or null: the contrast check reads the band there, under the mist.
       */
      higherCell: () => {
        if (!field || !sel) return null;
        const T = cs.thresholds;
        if (!hoursMode) {
          for (let r = 2; r < span - 2; r++) {
            const v = curveAt(r);
            if (v.p >= T.higher * 1.12 && v.p <= T.high * 0.9 && v.f >= T.unknown_fog) return [cxOf(r), cyOf(v.p)];
          }
          return null;
        }
        let best: [number, number] | null = null;
        let bs = -1;
        for (let it = 2; it < field.nt - 2; it++)
          for (let ix = 12; ix < NX - 12; ix += 3) {
            const i = it * NX + ix;
            const p = field.p50[i]!;
            if (p < T.higher * 1.12 || p > T.high * 0.9) continue;
            const s = field.fog[i]!;
            if (s > bs) {
              bs = s;
              best = [X((ix / (NX - 1)) * sel.L), Y(it)];
            }
          }
        return best;
      },
      /** Every quest of the city: its rank, whether it is open and has a strip, and where its site's lamp is. */
      questLamps: () =>
        quests().map((q) => {
          const l = lamps.find((x) => x.code === q.code);
          return { code: q.code, rank: q.rank, open: questOpen(q), strip: geo.chains.find((c) => c.stations.some((s) => s.code === q.code))?.slug ?? null, x: l?.x ?? NaN, y: l?.y ?? NaN };
        }),
      camera: () => camNow(),
      cameraSettled: () => camSettled,
      field: () => (sel && LY ? (hoursMode ? { x0: LY.xL, x1: LY.xR, y0: LY.fT, y1: LY.fB, lineY: LY.lineY } : { ...curveBox(), lineY: LY.lineY }) : null),
      rowY: (h: number) => (sel && LY ? Y(h) : null),
      hit: (x: number, y: number) => hitChain(x, y),
      /** The first strip hour (from the top) whose row shows a raised best guess anywhere along the stream, or -1. */
      stormRow: () => {
        if (!field) return -1;
        for (let it = 0; it < field.nt; it++) for (let ix = 0; ix < NX; ix++) if (field.guess[it * NX + ix]! > 0) return it;
        return -1;
      },
      questRank: () => {
        const q = sel ? stripQuest(sel) : restQuest();
        return q ? q.rank : -1;
      },
      /** The geo-sync probe: on (about 1500 vertices spread over every way), and its error now (CSS px). */
      syncProbe: (on: boolean) => {
        if (!on) return void (probe = null);
        const all: { w: Way; k: number }[] = [];
        for (const w of geo.ways) for (let k = 0; k < w.n; k += 3) all.push({ w, k });
        const v = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 1500)) === 0);
        probe = { v, drawn: new Float64Array(2 * v.length).fill(NaN), ref: new Float64Array(2 * v.length).fill(NaN) };
        // the map at rest has rendered this camera already: its reference is read now, the streams reprojected
        probeRendered();
        dirty = true;
      },
      syncError: () => probeError(),
      /** Test cameras: a jump, and the scene's own flight (ms of the app clock). */
      jump: (cam: CameraLike) => map.jumpTo(cam),
      fly: (cam: CameraLike, ms: number) => void flyTo(cam, ms, easeIO),
      mapIdle: () => map.loaded() && !map.isMoving() && map.areTilesLoaded(),
      perf: () => {
        const g = [...perf.gaps].sort((a, b) => a - b);
        const mean = g.reduce((s, x) => s + x, 0) / Math.max(1, g.length);
        const per = Object.fromEntries(Object.entries(perf.ms).map(([k, v]) => [k, +(v / Math.max(1, perf.n)).toFixed(2)]));
        const res = { frames: g.length, meanMs: mean, fps: 1000 / mean, p95Ms: g[Math.floor(g.length * 0.95)] ?? 0, cpuMsPerFrame: per, blobs: blobs.length };
        perf.gaps = [];
        perf.n = 0;
        for (const k of Object.keys(perf.ms) as (keyof typeof perf.ms)[]) perf.ms[k] = 0;
        return res;
      },
    };
  }
  const stripQuestAt = (ch: Chain): boolean => {
    const save = hb;
    hb = stripBaseHour(cs, nowMs());
    const q = stripQuest(ch);
    hb = save;
    return q !== null;
  };

  /** Gives the page a turn between the heavy steps of a mount, so no single task freezes what is on screen. */
  const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  async function init(): Promise<void> {
    const [spec, now, pack] = await Promise.all([ctx.data.updateSpec(), ctx.data.nowcast(city), ctx.data.streams(city)]);
    if (disposed) return;
    nowcast = now;
    zone = now.timezone;
    for (const s of now.sites) sampledFlag.set(s.code, s.oah_sampled_after_rain);
    await breathe();
    if (disposed) return;
    cs = new CityState(spec, pack, now);
    await breathe();
    if (disposed) return;
    geo = buildGeometry(pack);
    await breathe();
    if (disposed) return;
    // story mode's opening: the test demonstration at its fixed place and hour (src/model/demo.ts)
    if (ctx.story && ctx.params[1] === 'opening') {
      const d = planDemo(cs.hoursMs, (c, h) => cs.series(c).p50[h]!, cs.thresholds.higher);
      const ci = geo.chains.findIndex((c) => c.stations.some((st) => st.code === d.code));
      if (ci >= 0) {
        opening = { ci, code: d.code, up: d.upstream, hour: d.hour, rule: d.rule };
        root.dataset['opening'] = `${d.code}:${d.hour}:${d.rule}`;
      }
    }
    hNow = cs.hourOf(nowMs());
    evalNetwork(geo, cs, hNow);
    evalHour = Math.floor(hNow);
    evalRev = cs.revision;
    buildDom();
    resize();
    LY = layout();
    applyLayoutVars();
    theme = ctx.theme.get();
    pal = PAL[theme];
    setTextures();
    offs.push(ctx.theme.subscribe((t) => setTheme(t)));
    exag = geo.baked ? 0 : EXAGGERATION;
    // the opening is a flat map: its terrain (and the terrain's tiles) wait until it has been seen
    const heldOpening = opening !== null && ctx.params[2] === 'held';
    terrainOn = !(heldOpening && geo.baked);
    CL = compareLayout(W, H);
    await breathe();
    if (disposed) return;
    map = new maplibregl.Map({
      container: mapEl,
      style: mapStyle(theme, mapFeatures(), exag, terrainOn),
      attributionControl: false,
      maxPitch: 70,
      fadeDuration: 0,
      // pan and zoom within the city (enabled at rest, setInteractive); the camera's angle stays the scene's
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
      // mounted underneath (story mode) the map starts at low resolution; the frame restores it once it shows
      pixelRatio: hiddenLayer() ? LOW_RES : devicePixelRatio || 1,
    });
    mapLowRes = hiddenLayer();
    setInteractive(false);
    const v0 = closeView();
    map.jumpTo(v0);
    const vq = questView();
    restZoom = Math.min(v0.zoom, vq.zoom);
    if (heldOpening) {
      // a link into the comparison's later beats: the stream from straight above, across the map band
      map.jumpTo(compareCamera(geo.chains[opening!.ci]!));
      camSettled = true;
      root.dataset['camera'] = 'settled';
    } else if (ctx.reducedMotion || ctx.story) {
      // story mode narrates over a still camera: the framing that holds the quest's lamp, at once
      map.jumpTo(vq);
      camSettled = true;
      root.dataset['camera'] = 'settled';
    }
    // the viewer's own drag or wheel ends the opening glide where it is
    map.on('movestart', (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) {
        stopGlide();
        if (!ctx.story) hideMapLabels();
      }
    });
    map.on('moveend', (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) afterViewerMove();
    });
    {
      const pad = 0.3;
      const [ex0, ey0, ex1, ey1] = extractBox();
      panBounds = [
        [ex0 - (ex1 - ex0) * pad, ey0 - (ey1 - ey0) * pad],
        [ex1 + (ex1 - ex0) * pad, ey1 + (ey1 - ey0) * pad],
      ];
    }
    mpp0 = MPP();
    map.on('load', setSky);
    map.on('move', () => {
      dirty = true;
    });
    map.on('render', probeRendered);
    map.on('sourcedata', (e) => {
      if (e.sourceId !== 'demT') return;
      dirty = true;
      const c = (e as { tile?: { tileID?: { canonical?: { z: number; x: number; y: number } } } }).tile?.tileID?.canonical;
      if (c) tileDirty.push(tileBox(c));
      else liveAll = true;
    });
    lamps = cs.pack.sites.map((s) => {
      const ci = geo.chains.findIndex((c) => c.stations.some((t) => t.code === s.code));
      return { code: s.code, ll: [s.lon, s.lat] as const, e: s.E ?? 0, x: NaN, y: NaN, ci };
    });
    makeBlobs();
    // the map's own click (never fired at the end of a drag) and hover, in the map's pixels
    const mapCanvas = map.getCanvasContainer();
    map.on('click', (e) => {
      if (phase !== 'rest') return;
      const hit = hitChain(e.point.x, e.point.y);
      if (hit.ci >= 0) {
        viewerTapped = true;
        void openStream(hit.ci, { quest: hit.quest });
      }
    });
    map.on('mousemove', (e) => {
      if (phase !== 'rest') return;
      hoverCi = hitChain(e.point.x, e.point.y).ci;
      mapCanvas.style.cursor = hoverCi >= 0 ? 'pointer' : '';
    });
    // The streams draw as soon as the pack is here: with baked elevations they need neither the basemap nor the
    // terrain. The basemap fades in under them once its style and first tiles are in; the terrain starts flat and
    // rises when its tiles have loaded (see riseTerrain). A pack without elevations waits for the terrain and
    // measures them (runElev), as before.
    let started = false;
    const start = (): void => {
      if (started || disposed) return;
      started = true;
      root.dataset['drawing'] = 'true';
      if (geo.baked) {
        elevReady = true;
        // the opening is already on screen (the page's first paint): the streams draw at full strength at once
        introT0 = ctx.clock.seconds() - (heldOpening ? 2 : 0);
        dirty = true;
      } else startElev();
    };
    const showMap = (): void => {
      if (mapShown || disposed) return;
      mapShown = true;
      void tween(1400, (e) => (mapEl.style.opacity = String(e)));
    };
    if (geo.baked) start();
    if (heldOpening) {
      // a direct link to a later beat of the story: the comparison as the story left it, with its test
      enterCompare();
      holdCompare();
    }
    map.on('idle', () => {
      showMap();
      if (exag >= EXAGGERATION) root.dataset['map'] = 'idle';
    });
    const offReady = ctx.clock.onFrame(() => {
      try {
        if (!map.isStyleLoaded()) return;
        if (!geo.baked && map.getSource('demT') && map.isSourceLoaded('demT')) start();
        if (map.isSourceLoaded('omt')) showMap();
        if (started && mapShown) offReady();
      } catch {
        /* not ready */
      }
    });
    offs.push(offReady);
    // a slow or blocked tile host never keeps the city from drawing
    void wait(6000).then(showMap);
    void wait(15000).then(start);
    offs.push(
      ctx.clock.onFrame(() => {
        for (const st of [...steps]) st();
        frame();
      }),
    );
    hooks();
    // the published forecast peaks the records name (off the opening's path)
    void fetch(`${DATA_BASE_URL}fhir/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ siteRisk: Record<string, string> }>) : null))
      .then((ix) => {
        if (!ix || disposed) return;
        fhirIndex = ix;
        bindRecord();
      })
      .catch(() => undefined);
  }

  return {
    mount(r, c) {
      root = r;
      ctx = c;
      document.body.dataset['state'] = 'rest';
      want = c.params[1] === 'stream' ? (c.params[2] ?? null) : null;
      init().catch((e: unknown) => {
        // a missing or broken forecast: a few plain words instead of an empty map
        if (disposed) return;
        root.classList.add('city');
        const p = document.createElement('p');
        p.className = 'nodata';
        p.textContent = 'Forecast unavailable.';
        root.append(p);
        root.dataset['drawing'] = 'true';
        document.body.dataset['ready'] = 'failed';
        console.error(e);
      });
    },
    unmount() {
      disposed = true;
      gen++;
      glideGen++;
      for (const o of offs) o();
      try {
        map?.remove();
      } catch {
        /* already gone */
      }
      if (window.sayr === myHooks) delete window.sayr;
      if (document.body.dataset['cue'] === 'tap' || document.body.dataset['cue'] === 'next') delete document.body.dataset['cue'];
      delete root.dataset['ready'];
      delete root.dataset['drawing'];
      root.innerHTML = '';
      root.className = '';
    },
    async cue(name) {
      if (disposed || !geo) return false;
      if (name === 'opening') return openingCue();
      if (name === 'key') return keyCue();
      if (name === 'human') return humanCue();
      if (root.dataset['ready'] !== 'true') return false;
      if (name === 'kit') return kitCue();
      if (name === 'test') return testCue();
      if (name === 'record') return recordCue();
      if (name === 'fold') return foldCue();
      if (name === 'unroll') {
        if (phase !== 'rest') return phase === 'strip';
        // the stream whose lamp carries the quest's light, else the first
        const q = restQuest();
        const ci = Math.max(0, q ? geo.chains.findIndex((c) => c.stations.some((st) => st.code === q.code)) : 0);
        await openStream(ci);
        return (phase as Phase) === 'strip';
      }
      if (name === 'storm') return stormCue();
      if (name === 'quest') {
        tapQuest(false);
        return voiceMode === 'quest';
      }
      return false;
    },
    route(params) {
      want = params[1] === 'stream' ? (params[2] ?? null) : null;
      reconcile();
    },
    /**
     * Where the city's camera is, and the point of its main river nearest the camera's centre (the story's
     * flight into the city lands here and names that river); null until the map is up.
     */
    view() {
      if (disposed || !geo || !map) return null;
      const c = map.getCenter();
      let river: [number, number] | null = null;
      let bd = Infinity;
      for (const w of cs.pack.ways)
        if (w.kind === 'river' && /Mondego/.test(w.name))
          for (const p of w.c) {
            const d = (p[0] - c.lng) ** 2 + (p[1] - c.lat) ** 2;
            if (d < bd) {
              bd = d;
              river = [p[0], p[1]];
            }
          }
      return { cam: camNow(), river };
    },
    narrate(beat) {
      if (disposed || !geo || !opening) return null;
      if (beat === 'human') return pieceNodes(humanAt(opening.code).lead);
      if (beat === 'ask') return askLine(opening.code);
      return null;
    },
  };
}

