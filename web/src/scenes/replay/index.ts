// W3 "Replay the storm": the River Avon above Warleigh Weir, the logged overflows departing at their minutes,
// their plumes travelling to the weir at the engine's velocity, the lab samples arriving, the river folding
// into a timetable, and the proof. Routes: #/replay (23 September 2024), #/replay/2023-07-10, and either with
// /timetable to open folded. A change between them while the scene is up (a link, back, forward) arrives through
// route(): the fold follows the hash, and another storm loads in place. The Fold control writes its state into
// the hash, so back unfolds.
//
// The scene teaches its own words once, beside their first instance, then lets them fade (SPEC section 4):
// "overflow" at the first spill, "overflow water" beside the first plume that stays long enough to read,
// "lab sample" at the first sample, and the timetable's two axes.
//
// Time: when the app clock sits inside the replay window (a ?t= pin, a running ?rate=, or a film's
// __sayrClock.set), the clock is the storm time. Otherwise the scene runs its own playhead from the play
// control, paced by the schedule's tempo. Under a pinned clock every animation phase is a function of story
// time, so the same ?t= draws the same frame. The storm holds still while an x-ray card is open (hold(), or
// the shell's xr-open mark) and while a finger rests on a sample's number, so a long press turns over the
// number under the finger.
//
// The mount is cheap: the load runs in slices that yield to the browser between them, so mounting underneath
// another scene (story mode mounts the replay under the dark hours) never holds a frame for long, and nothing is
// drawn while the scene's layer is fully transparent.
//
// The end: the proof stays on screen until the viewer moves on; the shell's "Now see Coimbra" is placed at the
// element .rp-proof, which here is an empty line under the proof (so the way on sits beneath it, never on it).
import '@fontsource/archivo/500.css';
import '@fontsource/archivo/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';
import terrainUrl from './assets/terrain.bin?url';
import waterwaysUrl from './assets/waterways.json?url';
import type { Scene, SceneContext } from '../types';
import type { BacktestFile, ModelFile, NumbersFile, ReplayFile, ReplayKey } from '../../data/schemas';
import { formatNumber } from '../../format/numfmt';
import { activeInterval, buildTimeline, dailyAt, type ReplayTimeline } from '../../engine/replay';
import { avonAssumptions, buildTransport, distanceAt, gaugeMedianFlow, pulsesAt, timeAtDistance, velocityAt, weirIndex, type Pulse, type TransportReplay } from '../../engine/transport';
import { localParts } from '../../engine/timefmt';
import { buildNetworkSliced, distM, type RiverNetwork } from './network';
import { BATH_ZONE, buildSchedule, clockLabel, type Schedule } from './schedule';
import { fitPose, makeCamera, project, type Camera } from './camera';
import { decodeDemSliced, elevationAt, EXAGGERATION, TerrainRenderer, toX, toY, type Dem } from './terrain';
import { clamp, drawField, drawFlow, drawLamp, glowSprite, hash, mixRGB, PALETTES, plumeColour, plumeLevel, posAlong, rgba, sstep, strokeTracks, weirColour, type FlowStyle, type Palette, type RGB, type Track } from './render';
import { ReplayAudio } from './audio';
import { DEFAULT_KEY, parseReplayRoute, replayHash } from './route';

const HOUR = 3_600_000;
const FOLD_SECONDS = 1.7;
const STRIP_HOURS = 30; // long enough that the 31,000 and the 10:28 from Freshford share one timetable
const ROW_MS = 25 * 60_000; // 72 rows in the window, the city strip's 72 lines
const NB = 240; // distance bins across the timetable

interface Waterways {
  readonly ways: readonly { readonly k: 'river' | 'stream' | 'minor'; readonly c: readonly (readonly [number, number])[] }[];
}

interface Loaded {
  key: ReplayKey;
  pack: ReplayFile;
  tl: ReplayTimeline;
  sched: Schedule;
  tr: TransportReplay;
  net: RiverNetwork;
  dem: Dem;
  numbers: NumbersFile;
  backtest: BacktestFile;
  ways: Waterways;
  wayCum: Float64Array[];
  wayZ: Float64Array[];
  /** The river's vertices and the overflows' pipes: lifted heights (camera-independent). */
  nodeZ: Float64Array;
  pipeZ: Float64Array;
  /** strip field: one row per ROW_MS from rowStartMs, NB distance bins, summed plume survival */
  field: Float32Array;
  rowStartMs: number;
  rows: number;
  dmax: number;
  maxIndex: number;
  /** cumulative visual flow travel (metres) per story-second step, for pinned frames */
  phaseTable: Float64Array;
  heads: HeadPath[];
  /** The replay river's lines as node indices, each oriented downstream, with metres along each. */
  netIds: { ids: Int32Array; cum: Float64Array }[];
  /** Where "overflow water" is taught: the first plume that lights one place long enough to read beside it. */
  water: WaterWord | null;
}

/** The first plume whose water lights one place for WATER_LIFE story seconds, and where its word sits. */
interface WaterWord {
  readonly overflow: string;
  /** How far down the overflow's path the word sits, as a fraction of the path. */
  readonly frac: number;
  /** Story second at which the plume's first water reaches that place. */
  readonly sigma: number;
}

/** A newer route or the unmount superseded a load in flight: it stops quietly. */
class Superseded extends Error {}

/** One macrotask: the browser may paint and run other scenes' frames before the load carries on. */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });

/** Story seconds a plume's water must keep lighting the word's place for the word to be read beside it. */
const WATER_LIFE = 1.7;
/** The word sits this far along the plume's path from its overflow. */
const WATER_AT = 0.35;

/** Where the first (head) or last (tail) water of one spill is over time: metres to the weir against storm time. */
interface HeadPath {
  readonly m: Float64Array;
  readonly t: Float64Array;
  readonly hero: boolean;
  readonly tail: boolean;
}

interface Layout {
  W: number;
  H: number;
  phone: boolean;
  cam: Camera;
  xL: number;
  xR: number;
  yTop: number;
  yBottom: number;
  pxH: number;
}

const PHASE_STEP = 0.05;
/** Metres the drawn river and lamps sit above the relief, so the terrain never cuts them. */
const LIFT = 4;
const VISUAL_FLOW = 900; // visual metres per story second per (m/s) of river velocity

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

/** Story seconds a taught word stays before it fades (SPEC section 4: the legend teaches itself). */
const TEACH_HOLD = 3.4;
const TEACH_FADE = 0.8;

/** Everything a storm shares with the others: the terrain, the waterways, the numbers and the models. */
interface Shared {
  numbers: NumbersFile;
  backtest: BacktestFile;
  warleigh: ModelFile;
  portable: ModelFile;
  dem: Dem;
  ways: Waterways;
  /** Metres along each waterway, vertex by vertex, and each vertex's lifted height (camera-independent, once). */
  wayCum: Float64Array[];
  wayZ: Float64Array[];
}

class ReplayScene implements Scene {
  private root!: HTMLElement;
  private ctx!: SceneContext;
  private box!: HTMLDivElement;
  private gl!: HTMLCanvasElement;
  private cv!: HTMLCanvasElement;
  private g!: CanvasRenderingContext2D;
  private veil!: HTMLDivElement;
  private ui!: HTMLDivElement;
  private dom!: {
    voice: HTMLElement;
    place: HTMLElement;
    clock: HTMLElement;
    play: HTMLButtonElement;
    fold: HTMLButtonElement;
    /** "overflow" beside the first spill, "lab sample" beside the first sample, and the timetable's axes. */
    teachSpill: HTMLElement;
    teachWater: HTMLElement;
    teachSample: HTMLElement;
    axisTime: HTMLElement;
    axisDown: HTMLElement;
    weir: HTMLElement;
    unit: HTMLElement;
    deps: Map<number, HTMLElement>;
    arrivals: HTMLElement[];
    ticks: HTMLElement[];
    proof: HTMLElement;
    credits: HTMLElement;
  };
  private data: Loaded | null = null;
  private terrain: TerrainRenderer | null = null;
  private lay: Layout | null = null;
  private pal: Palette = PALETTES.night;
  private offs: (() => void)[] = [];
  private disposed = false;
  private audio = new ReplayAudio();
  private key: ReplayKey = DEFAULT_KEY;
  /** The storm the route asks for; a newer route wins over a load still in flight. */
  private loadToken = 0;
  private shared: Promise<Shared> | null = null;
  private terrainP: Promise<TerrainRenderer> | null = null;
  /** The label faces, loading since the mount. */
  private fontsIn: Promise<void> = Promise.resolve();
  /** False until a storm is fully loaded: no frame draws a half-built storm. */
  private live = false;
  /** Where "overflow water" sits on screen (from the camera), and the side its words go. */
  private waterXY: [number, number, boolean] | null = null;
  /** The shell holds the scene (an x-ray card is open): the storm stops where it is. */
  private heldByShell = false;
  /** A finger or pointer rests on a sample's number: the storm stops so the long press turns over that number. */
  private pressing: { x: number; y: number } | null = null;
  private wasHeld = false;
  /** The storm was playing when the hold began: it plays on when the hold ends. */
  private resumeAfterHold = false;
  /** Story second at which the timetable last finished unrolling (its axis words fade from there). */
  private foldDoneSigma: number | null = null;
  /** Animation second of the viewer's last pointer move or touch: it brings the controls back over the proof. */
  private touchedAt = -Infinity;

  // time state
  private takeover = false;
  private playing = false;
  private sigma = 0;
  private lastSec = 0;
  private lastT = NaN;
  private flowPhase = 0;
  private fold = 0;
  private foldTarget = 0;

  // geometry caches (per camera)
  private mapNodes = new Float64Array(0);
  private mapPipes = new Float64Array(0);
  private mapWeir = [NaN, NaN];
  private ctxTracks: { t: Track; k: 'river' | 'stream' | 'minor' }[] = [];
  private netLines: { nodes: Int32Array; t: Track }[] = [];
  private pathTracks = new Map<string, { nodes: readonly number[]; t: Track; scale: number }>();
  private curNodes = new Float64Array(0);
  private nodeSum = new Float32Array(0);
  private overflowIndex = new Map<string, number>();
  /** Cached layers under the live overlay, redrawn only when the camera or theme changes. */
  private ctxLayer!: HTMLCanvasElement;
  private bedLayer!: HTMLCanvasElement;
  private layersReady = false;

  mount(root: HTMLElement, ctx: SceneContext): void {
    this.root = root;
    this.ctx = ctx;
    this.pal = PALETTES[ctx.theme.get()];
    const { key, timetable } = parseReplayRoute(ctx.params);
    this.key = key;
    if (timetable) this.fold = this.foldTarget = 1;
    this.buildDom(key);
    this.offs.push(
      ctx.theme.subscribe((t) => {
        this.pal = PALETTES[t];
        this.box.dataset['theme'] = t;
        this.relayout();
      }),
    );
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    // window's capture phase runs before the x-ray's own (document) listener, which stops the event there
    window.addEventListener('pointerdown', this.onPressStart, { capture: true });
    window.addEventListener('pointermove', this.onPressMove, { capture: true });
    for (const t of ['pointerup', 'pointercancel'] as const) window.addEventListener(t, this.onPressEnd, { capture: true });
    this.offs.push(() => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      window.removeEventListener('pointerdown', this.onPressStart, { capture: true });
      window.removeEventListener('pointermove', this.onPressMove, { capture: true });
      for (const t of ['pointerup', 'pointercancel'] as const) window.removeEventListener(t, this.onPressEnd, { capture: true });
    });
    const ro = new ResizeObserver(() => this.relayout());
    ro.observe(this.box);
    this.offs.push(() => ro.disconnect());
    this.offs.push(this.ctx.clock.onFrame(() => this.frame()));
    // the faces the labels use, fetched and decoded while the storm loads (their first layout is then cheap)
    const faces = ['500 28px "Archivo"', '700 28px "Archivo"', '400 11px "JetBrains Mono"'];
    this.fontsIn = document.fonts?.load ? Promise.all(faces.map((f) => document.fonts.load(f).catch(() => []))).then(() => undefined) : Promise.resolve();
    this.startLoad(key);
  }

  /** The hash moved to another route of this scene (a link, back or forward): follow it without a reload. */
  route(params: readonly string[]): void {
    if (this.disposed) return;
    const { key, timetable } = parseReplayRoute(params);
    const target = timetable ? 1 : 0;
    if (target !== this.foldTarget) {
      this.foldTarget = target;
      if (this.ctx.reducedMotion) this.fold = target;
    }
    if (key !== this.key) {
      this.key = key;
      this.setVoice(key);
      this.startLoad(key);
    }
  }

  private startLoad(key: ReplayKey): void {
    this.load(key).catch((e: unknown) => {
      if (this.disposed || e instanceof Superseded) return;
      this.box.dataset['ready'] = 'failed';
      document.body.dataset['ready'] = 'failed';
      console.error(e);
    });
  }

  /**
   * The shell holds the scene while an x-ray card is open over it: the storm stops where it is and plays on
   * when the card closes (a paused storm stays paused). The scene also reads the shell's xr-open mark itself.
   */
  hold(held: boolean): void {
    this.heldByShell = held;
  }

  private held(): boolean {
    return this.heldByShell || this.pressing !== null || document.body.classList.contains('xr-open');
  }

  /** A press on a sample's number (or the weir's name): hold the storm until the finger lifts or moves away. */
  private onPressStart = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.live) return;
    const hit = [...this.dom.arrivals, this.dom.weir].some((a) => {
      if (a.style.visibility !== 'visible' || Number(a.style.opacity) <= 0.3) return false;
      const r = a.getBoundingClientRect();
      return e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6;
    });
    if (hit) this.pressing = { x: e.clientX, y: e.clientY };
  };

  private onPressMove = (e: PointerEvent): void => {
    if (this.pressing && Math.hypot(e.clientX - this.pressing.x, e.clientY - this.pressing.y) > 9) this.pressing = null;
  };

  private onPressEnd = (): void => {
    this.pressing = null;
  };

  unmount(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.terrain?.dispose();
    this.audio.dispose();
    for (const id of Object.keys(window.__sayrCanvasWords ?? {})) if (id.startsWith('replay:')) this.ctx.registerCanvasWords(id, null);
    delete (window as { __sayrReplay?: unknown }).__sayrReplay;
    this.box.remove();
  }

  setTime(t: Date): void {
    if (!this.data) return;
    this.takeover = true;
    this.playing = false;
    this.sigma = this.data.sched.tempo.sigmaAt(t.getTime());
  }

  // ---------------------------------------------------------------- DOM

  private buildDom(key: ReplayKey): void {
    const box = el('div', 'rp');
    box.dataset['theme'] = this.ctx.theme.get();
    if (this.ctx.reducedMotion) box.dataset['still'] = 'true';
    this.root.appendChild(box);
    this.box = box;
    this.gl = el('canvas', 'rp-gl', box);
    this.veil = el('div', 'rp-veil', box);
    this.ctxLayer = el('canvas', 'rp-layer', box);
    this.bedLayer = el('canvas', 'rp-layer', box);
    this.cv = el('canvas', 'rp-cv', box);
    this.g = this.cv.getContext('2d')!;
    this.cv.addEventListener('click', (e) => this.onCanvasClick(e));
    const touched = (): void => void (this.touchedAt = this.ctx.clock.seconds());
    box.addEventListener('pointermove', touched);
    box.addEventListener('pointerdown', touched);
    box.addEventListener('focusin', touched);
    const ui = el('div', 'rp-ui', box);
    // the words stay out of layout until the load has their faces: laying them out is a slice of the load, not
    // part of whatever frame comes next (story mode mounts the scene under another one)
    ui.style.display = 'none';
    this.ui = ui;
    // the scene's one line gave way to a quiet key that stays (what is logged, what is modelled) and a dated name
    const voice = el('p', 'rp-voice', ui);
    voice.hidden = true;
    const place = el('div', 'rp-place', ui);
    el('p', 'rp-key', place, 'Logged spills. Modelled travel.');
    el('span', 'rp-river', place);
    const clock = el('span', 'rp-clock', place);
    clock.dataset['time'] = '';
    // the controls are words: "Play" (then "Pause", "Replay") and "Fold" (then "Unfold")
    const ctrls = el('div', 'rp-ctrls', ui);
    const play = el('button', 'rp-btn rp-play', ctrls, 'Play');
    play.type = 'button';
    play.addEventListener('click', () => this.togglePlay());
    const fold = el('button', 'rp-btn rp-fold', ctrls, 'Fold');
    fold.type = 'button';
    fold.title = 'Fold the river into its timetable (T)';
    fold.addEventListener('click', () => this.toggleFold());
    // this scene's own sources, shown beside the shell's credits whenever the viewer opens them
    const credits = el('div', 'rp-credits', ui, 'Spills and samples: Wessex Water, CC BY 4.0 &middot; Flow and rain: Environment Agency, OGL v3');
    credits.hidden = true;
    const weir = el('div', 'rp-weir', ui, 'Warleigh Weir');
    const unit = el('div', 'rp-unit', ui, 'E. coli/100 ml');
    unit.dataset['unit'] = '';
    const proof = el('div', 'rp-proof-text', ui);
    const teachSpill = el('div', 'rp-teach rp-teach-spill', ui, 'overflow');
    const teachWater = el('div', 'rp-teach rp-teach-water', ui, 'overflow water');
    const teachSample = el('div', 'rp-teach rp-teach-sample', ui, 'lab sample');
    const axisTime = el('div', 'rp-axis rp-axis-time', ui, 'time <span class="rp-arrow">&darr;</span>');
    const axisDown = el('div', 'rp-axis rp-axis-down', ui, 'downstream <span class="rp-arrow">&rarr;</span>');
    for (const e of [teachSpill, teachWater, teachSample, axisTime, axisDown, proof]) e.style.visibility = 'hidden';
    this.dom = { voice, place, clock, play, fold, teachSpill, teachWater, teachSample, axisTime, axisDown, weir, unit, deps: new Map(), arrivals: [], ticks: [], proof, credits };
    this.setVoice(key);
    window.addEventListener('keydown', this.onKey);
    this.offs.push(() => window.removeEventListener('keydown', this.onKey));
  }

  /** The replay's dated name, in the river name's place: "2024 replay" (the clock beside it says the day). */
  private setVoice(key: ReplayKey): void {
    const river = this.dom.place.querySelector<HTMLElement>('.rp-river')!;
    river.replaceChildren();
    const when = el('span', '', river, key.slice(0, 4));
    when.dataset['time'] = '';
    river.append(' replay');
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === 't' || e.key === 'T') this.toggleFold();
  };

  private onCanvasClick(e: MouseEvent): void {
    // tapping the river folds it (the city scene's gesture); tapping anywhere in the timetable unfolds
    if (!this.lay) return;
    if (this.foldTarget === 1) return this.toggleFold();
    const r = this.box.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const P = this.mapNodes;
    for (let i = 0; i < P.length; i += 2) if (Math.abs(P[i]! - x) < 14 && Math.abs(P[i + 1]! - y) < 14) return this.toggleFold();
  }

  private togglePlay(): void {
    const d = this.data;
    if (!d) return;
    const dur = d.sched.tempo.duration;
    if (!this.takeover && this.driven()) {
      this.takeover = true;
      this.sigma = d.sched.tempo.sigmaAt(this.ctx.clock.ms());
    }
    this.takeover = true;
    if (this.sigma >= dur - 1e-6) this.sigma = 0;
    this.playing = !this.playing;
  }

  private toggleFold(): void {
    this.foldTarget = this.foldTarget ? 0 : 1;
    if (this.ctx.reducedMotion) this.fold = this.foldTarget;
    // the fold lives in the hash, so a link can open folded and back unfolds (story mode drives the scene itself)
    if (!this.ctx.story) this.ctx.navigate(replayHash({ key: this.key, timetable: this.foldTarget === 1 }));
  }

  private driven(): boolean {
    const d = this.data;
    if (!d || this.takeover) return false;
    const t = this.ctx.clock.ms();
    return t >= d.sched.windowStartMs && t <= d.sched.windowEndMs;
  }

  // ---------------------------------------------------------------- data

  private loadShared(): Promise<Shared> {
    const D = this.ctx.data;
    const fetchOk = async (url: string): Promise<Response> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
      return r;
    };
    // shared by every storm this scene loads: only the unmount stops it
    const pause = async (): Promise<void> => {
      await nextTask();
      if (this.disposed) throw new Superseded();
    };
    this.shared ??= (async () => {
      const [numbers, backtest, warleigh, portable, demBuf, ways] = await Promise.all([
        D.numbers(),
        D.backtest(),
        D.model('warleigh'),
        D.model('portable'),
        fetchOk(terrainUrl).then((r) => r.arrayBuffer()),
        fetchOk(waterwaysUrl).then((r) => r.json() as Promise<Waterways>),
      ]);
      await pause();
      const dem = await decodeDemSliced(demBuf, pause);
      const wayCum = ways.ways.map((way) => {
        const cum = new Float64Array(way.c.length);
        for (let i = 1; i < way.c.length; i++) cum[i] = cum[i - 1]! + distM({ lon: way.c[i]![0], lat: way.c[i]![1] }, { lon: way.c[i - 1]![0], lat: way.c[i - 1]![1] });
        return cum;
      });
      await pause();
      const wayZ = ways.ways.map((way) => Float64Array.from(way.c, (c) => elevationAt(dem, c[0], c[1]) * EXAGGERATION + LIFT));
      await pause();
      return { numbers, backtest, warleigh, portable, dem, ways, wayCum, wayZ };
    })();
    this.shared.catch(() => (this.shared = null));
    return this.shared;
  }

  /**
   * One storm, built in slices with a yield to the browser between them (no slice holds the main thread for long
   * on a phone), then shown whole: nothing draws until every part is in, so frames and films are unchanged.
   */
  private async load(key: ReplayKey): Promise<void> {
    const token = ++this.loadToken;
    const pause = async (): Promise<void> => {
      await nextTask();
      if (this.disposed || token !== this.loadToken) throw new Superseded();
    };
    const [pack, shared] = await Promise.all([this.ctx.data.replay(key), this.loadShared()]);
    await pause();
    const { numbers, backtest, warleigh, portable, dem, ways, wayCum, wayZ } = shared;
    const tl = buildTimeline(pack);
    await pause();
    const sched = buildSchedule(key, pack, tl);
    await pause();
    const tr = buildTransport(tl, avonAssumptions(gaugeMedianFlow(warleigh, portable)));
    await pause();
    const net = await buildNetworkSliced(pack, pause);
    await pause();

    const dmax = Math.max(...pack.overflows.map((o) => o.distance_to_weir_m ?? 0)) * 1.03;
    const rowStartMs = Math.floor(sched.windowStartMs / HOUR) * HOUR;
    const rows = Math.ceil((sched.windowEndMs - rowStartMs) / ROW_MS) + 1;
    const field = new Float32Array(rows * NB);
    for (let r = 0; r < rows; r++) {
      const t = rowStartMs + r * ROW_MS;
      if (t >= tr.startMs && t <= tr.endMs) binPulses(pulsesAt(tr, t), dmax, field, r * NB);
      if (r % 48 === 47) await pause();
    }
    await pause();
    let maxIndex = 0;
    let step = 0;
    for (let t = tr.startMs; t <= tr.endMs; t += 10 * 60_000) {
      maxIndex = Math.max(maxIndex, weirIndex(tr, t));
      if (++step % 90 === 0) await pause();
    }
    await pause();

    // visual flow travel as a function of story time: integrate a 3-hour smoothed river velocity
    const n = Math.ceil(sched.tempo.duration / PHASE_STEP) + 2;
    const phaseTable = new Float64Array(n);
    const vAt = (tMs: number): number => {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += velocityAt(tr, clamp(tMs + k * 0.5 * HOUR, tr.startMs, tr.endMs));
      return s / 7;
    };
    for (let i = 1; i < n; i++) phaseTable[i] = phaseTable[i - 1]! + PHASE_STEP * VISUAL_FLOW * vAt(sched.tempo.timeAt(i * PHASE_STEP));
    await pause();

    const heads: HeadPath[] = [];
    const heroStart = sched.heroDeparture?.startMs ?? NaN;
    for (const track of tr.tracks)
      for (const iv of track.intervals) {
        const hero = track.overflow.key === sched.heroDeparture?.overflow && iv.startMs === heroStart;
        if (!hero && iv.stopMs - iv.startMs < HOUR) continue;
        const L = track.distanceM;
        for (const tail of [false, true]) {
          const t0 = tail ? iv.stopMs : iv.startMs;
          if (tail && t0 >= tr.endMs) continue;
          const d0 = distanceAt(tr.clock, t0);
          const n = 16;
          const m = new Float64Array(n + 1);
          const t = new Float64Array(n + 1);
          for (let i = 0; i <= n; i++) {
            const s = (L * i) / n;
            m[i] = L - s;
            t[i] = timeAtDistance(tr.clock, d0 + s) ?? t0;
          }
          heads.push({ m, t, hero, tail });
        }
      }
    heads.sort((a, b) => Number(a.hero) - Number(b.hero) || Number(b.tail) - Number(a.tail));
    await pause();

    // the replay river's lines as node indices, each oriented downstream (toward the weir); camera-independent
    const netIds = net.lines.map((line) => {
      const ids = net.nodes[line[0]!]!.toWeirM < net.nodes[line[line.length - 1]!]!.toWeirM ? line.slice().reverse() : line;
      const cum = new Float64Array(ids.length);
      for (let i = 1; i < ids.length; i++) cum[i] = cum[i - 1]! + distM(net.nodes[ids[i - 1]!]!, net.nodes[ids[i]!]!);
      return { ids, cum };
    });
    const water = waterWord(tr, sched);
    const nodeZ = Float64Array.from(net.nodes, (nd) => elevationAt(dem, nd.lon, nd.lat) * EXAGGERATION + LIFT);
    const pipeZ = Float64Array.from([...pack.overflows.map((o) => [o.lon, o.lat] as const), [pack.site.lon, pack.site.lat] as const], ([lon, lat]) => elevationAt(dem, lon, lat) * EXAGGERATION + LIFT);
    await pause();

    this.terrainP ??= TerrainRenderer.create(this.gl, dem, async () => {
      await nextTask();
      if (this.disposed) throw new Superseded();
    });
    const terrain = await this.terrainP;
    await pause();

    // another storm in place of the one on screen: its labels go, and its story starts from the calm again
    this.live = false;
    this.clearLabels();
    this.takeover = false;
    this.playing = false;
    this.resumeAfterHold = false;
    this.sigma = 0;
    this.lastT = NaN;
    this.foldDoneSigma = null;
    this.data = { key, pack, tl, sched, tr, net, dem, numbers, backtest, ways, wayCum, wayZ, nodeZ, pipeZ, field, rowStartMs, rows, dmax, maxIndex, phaseTable, heads, netIds, water };
    this.box.dataset['storm'] = key;
    this.overflowIndex = new Map(pack.overflows.map((o, i) => [o.overflow, i]));
    this.terrain = terrain;
    await this.fontsIn;
    await pause();
    if (this.ui.style.display === 'none') {
      const late = [this.dom.voice, this.dom.place];
      for (const e of late) e.style.display = 'none';
      this.ui.style.display = '';
      void this.box.offsetWidth;
      await pause();
      for (const e of late) e.style.display = '';
      void this.box.offsetWidth;
      await pause();
    }
    for (const _ of this.labelSteps()) {
      void this.box.offsetWidth; // this part's layout, here rather than all at once in a later frame
      await pause();
    }
    this.project(false, false);
    await pause();
    this.projectPoints();
    await pause();
    this.projectWays();
    await pause();
    const dpr = this.cv.width / this.lay!.W;
    terrain.render(this.lay!.cam, dpr, this.terrainPalette());
    await pause();
    this.renderWays(dpr);
    await pause();
    this.renderBed(dpr);
    await pause();
    (window as { __sayrReplay?: unknown }).__sayrReplay = {
      /** Story seconds of the full replay. */
      duration: sched.tempo.duration,
      /** The storm instant (ISO, UTC) at a story second: step this for a film paced like the play control. */
      timeAt: (s: number): string => new Date(sched.tempo.timeAt(s)).toISOString(),
      sigmaAt: (iso: string): number => sched.tempo.sigmaAt(Date.parse(iso)),
      /** Story second at which "overflow water" is taught (null when no plume stays long enough). */
      waterAt: water?.sigma ?? null,
    };
    this.live = true;
    this.lastSec = this.ctx.clock.seconds();
    this.frame();
    this.box.dataset['ready'] = 'true';
    document.body.dataset['ready'] = 'true';
  }

  /** Removes one storm's labels (departures, arrivals, time ticks) before another's are built. */
  private clearLabels(): void {
    const dom = this.dom;
    for (const e of [...dom.deps.values(), ...dom.arrivals, ...dom.ticks]) e.remove();
    dom.deps.clear();
    dom.arrivals = [];
    dom.ticks = [];
    dom.proof.replaceChildren();
  }

  /**
   * The storm's labels, a part at a time (the load lays each part out before the next, so the first layout of
   * their words never lands in one long task on a phone). Each starts hidden until the first frame places it.
   */
  private *labelSteps(): Generator<void> {
    const d = this.data!;
    const ui = this.ui;
    const hidden = (e: HTMLElement): HTMLElement => ((e.style.visibility = 'hidden'), e);
    for (const [i, dep] of d.sched.departures.entries()) {
      if (!(dep.first || dep.hero)) continue;
      // a few labels per slice: each part is laid out before the next goes in
      if (this.dom.deps.size && this.dom.deps.size % 9 === 0) yield;
      const lab = hidden(el('div', `rp-dep${dep.hero ? ' rp-dep-hero' : ''}`, ui));
      const tm = el('span', 'rp-dep-t', lab, dep.label);
      tm.dataset['time'] = '';
      if (dep.hero) {
        el('span', 'rp-dep-n', lab, 'Freshford');
        const km = el('span', 'rp-dep-km', lab);
        const k = 'warleigh.freshford_distance_km';
        const entry = d.numbers[k];
        if (!entry || typeof entry.value !== 'number') throw new Error(`numbers.json has no ${k}`);
        const v = el('span', '', km, formatNumber(entry.value, 'fixed:2'));
        v.dataset['num'] = k;
        v.dataset['fmt'] = 'fixed:2';
        km.append(' km');
      }
      this.dom.deps.set(i, lab);
    }
    yield;
    for (const s of d.sched.samples) {
      const a = hidden(el('div', `rp-arr${s.hero ? ' rp-arr-hero' : ''}${s.over900 ? ' rp-over' : ''}`, ui, formatNumber(s.value, 'int')));
      a.dataset['src'] = s.src;
      this.dom.arrivals.push(a);
    }
    yield;
    for (let i = 0; i < 5; i++) {
      const t = hidden(el('div', 'rp-tick', ui));
      t.dataset['time'] = '';
      this.dom.ticks.push(t);
    }
    yield;
    // the proof: two lines and two counts, every number bound to its source. It stays on screen with the way
    // on beneath it, so its words are few: each count reads "43 of 44" (the "of" small and quiet), and the whole
    // end screen, "Now see Coimbra" and the wordmark included, keeps to the 25-word budget.
    const P = this.dom.proof;
    const num = (key: string, cls = ''): string => {
      const e = d.numbers[key];
      if (!e || typeof e.value !== 'number') throw new Error(`numbers.json has no ${key}`);
      return `<span class="${cls}" data-num="${key}">${formatNumber(e.value, 'int')}</span>`;
    };
    const rule = 'warleigh.rule.freshford';
    const of = ' <span class="rp-of">of</span> ';
    // the counts' years, before the counts: the proof is the 2021-2025 record, not the 2024 storm just replayed
    // (read from the count's own description in numbers.json)
    const counted = (d.numbers[`${rule}.warned`] as { counts?: string } | undefined)?.counts ?? '';
    const span = /(\d{4})-(\d{4})/.exec(counted);
    if (!span) throw new Error(`numbers.json ${rule}.warned has no year range in its counts`);
    P.innerHTML =
      `<p class="rp-pl"><span data-time>${span[1]}–${span[2]}</span>: within ${num('warleigh.window_hours')} hours after Freshford spilled</p>` +
      `<p class="rp-pn rp-hi">${num(`${rule}.warned_exceed`)}${of}${num(`${rule}.warned`, 'rp-den')}</p>`;
    yield;
    P.insertAdjacentHTML(
      'beforeend',
      `<p class="rp-pl">Otherwise</p>` +
        `<p class="rp-pn">${num(`${rule}.not_warned_exceed`)}${of}${num(`${rule}.not_warned`, 'rp-den')}</p>` +
        `<p class="rp-pnote">samples over ${num('thresholds.ecoli_flag_per_100ml')} <span data-unit>E. coli/100 ml</span> <span class="rp-nw">(single-sample flag)</span></p>` +
        // where the shell puts "Now see Coimbra" (it reads .rp-proof): an empty line under the proof
        '<div class="rp-proof" aria-hidden="true"></div>',
    );
    yield;
  }

  // ---------------------------------------------------------------- layout

  /** A data attribute on the scene's box, written only when it changes (read by the shell and the tests). */
  private mark(name: string, value: string): void {
    if (this.box.dataset[name] !== value) this.box.dataset[name] = value;
  }

  private relayout(): void {
    if (!this.data || !this.terrain) return;
    this.project(true, true);
    this.paintLayers();
    this.frame();
  }

  /**
   * The camera for this size, then every static point projected through it (unless `points` is false) and the
   * waterways (unless `ways` is false): the load runs the three in separate slices.
   */
  private project(points: boolean, ways: boolean): void {
    const d = this.data!;
    const W = Math.max(1, this.box.clientWidth);
    const H = Math.max(1, this.box.clientHeight);
    const phone = W < 700;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.round(W * dpr);
    this.cv.height = Math.round(H * dpr);

    // frame the river and every overflow
    const pts: number[] = [];
    d.net.nodes.forEach((n, i) => {
      if (i % 4 === 0) pts.push(toX(n.lon), toY(n.lat), d.nodeZ[i]! - LIFT);
    });
    d.pack.overflows.forEach((o, i) => pts.push(toX(o.lon), toY(o.lat), d.pipeZ[i]! - LIFT));
    const base = phone ? { bearing: 350, pitch: 30, fov: 32, tz: 60 } : { bearing: 292, pitch: 55, fov: 28, tz: 60 };
    const rect = phone ? { left: -6, right: W + 6, top: 200, bottom: H - 190 } : { left: 90, right: W - 250, top: 150, bottom: H - 110 };
    const pose = fitPose(base, Float64Array.from(pts), W, H, rect);
    const cam = makeCamera(pose, W, H);

    const xL = phone ? 22 : Math.round(clamp(W * 0.085, 96, 160));
    const xR = phone ? W - 70 : W - Math.round(clamp(W * 0.085, 96, 160)) - 90;
    const yTop = phone ? 118 : 104;
    const yBottom = phone ? H - 150 : H - 118;
    this.lay = { W, H, phone, cam, xL, xR, yTop, yBottom, pxH: (yBottom - yTop) / STRIP_HOURS };
    if (points) this.projectPoints();
    if (ways) this.projectWays();
  }

  /** The river's vertices, the pipes, the weir, the lines and paths, and the place of "overflow water". */
  private projectPoints(): void {
    const d = this.data!;
    const cam = this.lay!.cam;

    // project the static geometry (heights are cached per vertex; only the camera changes here)
    this.mapNodes = new Float64Array(d.net.nodes.length * 2);
    d.net.nodes.forEach((n, i) => project(cam, toX(n.lon), toY(n.lat), d.nodeZ[i]!, this.mapNodes, 2 * i));
    this.curNodes = new Float64Array(this.mapNodes.length);
    this.nodeSum = new Float32Array(d.net.nodes.length);
    this.mapPipes = new Float64Array(d.pack.overflows.length * 2);
    d.pack.overflows.forEach((o, i) => project(cam, toX(o.lon), toY(o.lat), d.pipeZ[i]!, this.mapPipes, 2 * i));
    const w = new Float64Array(2);
    project(cam, toX(d.pack.site.lon), toY(d.pack.site.lat), d.pipeZ[d.pack.overflows.length]!, w, 0);
    this.mapWeir = [w[0]!, w[1]!];

    // the replay river's lines, each oriented downstream (toward the weir)
    this.netLines = d.netIds.map(({ ids, cum }) => ({ nodes: ids, t: { P: new Float64Array(ids.length * 2), cum, L: cum[cum.length - 1]! } }));
    this.pathTracks = new Map();
    for (const o of d.pack.overflows) {
      const p = d.net.paths.get(o.overflow)!;
      this.pathTracks.set(o.overflow, {
        nodes: p.nodes,
        t: { P: new Float64Array(p.nodes.length * 2), cum: p.cum, L: p.lengthM },
        scale: p.lengthM / (o.distance_to_weir_m ?? p.lengthM),
      });
    }

    // "overflow water": its place just above the first long plume's path
    this.waterXY = null;
    const wv = d.water;
    const wp = wv ? d.net.paths.get(wv.overflow) : undefined;
    if (wv && wp) {
      const P = new Float64Array(wp.nodes.length * 2);
      wp.nodes.forEach((nd, k) => {
        P[2 * k] = this.mapNodes[2 * nd]!;
        P[2 * k + 1] = this.mapNodes[2 * nd + 1]!;
      });
      const t: Track = { P, cum: wp.cum, L: wp.lengthM };
      const a = [0, 0];
      const b = [0, 0];
      const m = wv.frac * wp.lengthM;
      posAlong(t, m, a);
      posAlong(t, Math.min(wp.lengthM, m + 250), b);
      // the normal that points up the screen: the words sit above the water, on the side it turns away from
      let nx = -(b[1]! - a[1]!);
      let ny = b[0]! - a[0]!;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      if (Number.isFinite(a[0]! + a[1]!)) this.waterXY = [a[0]! + nx * 12, a[1]! + ny * 12, nx < -0.2];
    }
  }

  /** Every waterway of the map through the current camera. */
  private projectWays(): void {
    const d = this.data!;
    const cam = this.lay!.cam;
    this.ctxTracks = d.ways.ways.map((way, k) => {
      const P = new Float64Array(way.c.length * 2);
      const Z = d.wayZ[k]!;
      way.c.forEach((c, i) => project(cam, toX(c[0]), toY(c[1]), Z[i]!, P, 2 * i));
      const cum = d.wayCum[k]!;
      return { t: { P, cum, L: cum[cum.length - 1]! }, k: way.k };
    });
  }

  /** The terrain and the cached beds for the current camera and theme. */
  private paintLayers(): void {
    const dpr = this.cv.width / this.lay!.W;
    this.terrain!.render(this.lay!.cam, dpr, this.terrainPalette());
    this.renderStatic(dpr);
  }

  private terrainPalette(): { low: [number, number, number]; high: [number, number, number]; bg: [number, number, number]; gamma: number } {
    return { low: n01(this.pal.terrainLow), high: n01(this.pal.terrainHigh), bg: n01(this.pal.bg), gamma: this.pal.terrainGamma };
  }

  /** The faint bed of every waterway and the replay river, cached until the camera changes. */
  private renderStatic(dpr: number): void {
    this.renderWays(dpr);
    this.renderBed(dpr);
  }

  /** The faint bed of every waterway of the map. */
  private renderWays(dpr: number): void {
    const lay = this.lay!;
    const c = this.ctxLayer;
    c.width = Math.round(lay.W * dpr);
    c.height = Math.round(lay.H * dpr);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const pal = this.pal;
    const minor = this.ctxTracks.filter((w) => w.k === 'minor').map((w) => w.t);
    const streams = this.ctxTracks.filter((w) => w.k === 'stream').map((w) => w.t);
    const rivers = this.ctxTracks.filter((w) => w.k === 'river').map((w) => w.t);
    strokeTracks(g, minor, [[0.6, pal.night ? 0.06 : 0.12]], pal.river, 1, dpr, pal);
    strokeTracks(g, streams, pal.night ? [[4, 0.025], [0.8, 0.11]] : [[0.9, 0.3]], pal.river, 1, dpr, pal);
    strokeTracks(g, rivers, pal.night ? [[10, 0.03], [4, 0.05], [1.2, 0.2]] : [[1.4, 0.55]], pal.river, 1, dpr, pal);
  }

  /** The replay river's own bed of light. */
  private renderBed(dpr: number): void {
    const pal = this.pal;
    const c = this.ctxLayer;
    const nets = this.netLines.map((l) => {
      const P = new Float64Array(l.nodes.length * 2);
      l.nodes.forEach((n, k) => {
        P[2 * k] = this.mapNodes[2 * n]!;
        P[2 * k + 1] = this.mapNodes[2 * n + 1]!;
      });
      return { ...l.t, P };
    });
    const b = this.bedLayer;
    b.width = c.width;
    b.height = c.height;
    const bg = b.getContext('2d')!;
    bg.clearRect(0, 0, b.width, b.height);
    strokeTracks(bg, nets, pal.night ? NET_BED : NET_BED_DAY, pal.usual, 1, dpr, pal);
    this.layersReady = true;
  }

  // ---------------------------------------------------------------- frame

  private frame(): void {
    const d = this.data;
    const lay = this.lay;
    if (!d || !lay || this.disposed || !this.live) return;
    const clock = this.ctx.clock;
    const tempo = d.sched.tempo;
    const now = clock.seconds();
    const dt = clamp(now - this.lastSec, 0, 2); // a film step may advance animation time by seconds at once
    this.lastSec = now;
    const reduced = this.ctx.reducedMotion;

    // an x-ray card open, or a finger resting on a number: the storm stops where it is, then plays on
    const held = this.held();
    if (held && !this.wasHeld) {
      if (this.driven() && !clock.pinned) {
        this.takeover = true;
        this.sigma = tempo.sigmaAt(clamp(clock.ms(), d.sched.windowStartMs, d.sched.windowEndMs));
        this.resumeAfterHold = true;
      } else this.resumeAfterHold = this.playing;
      this.playing = false;
    } else if (!held && this.wasHeld) {
      if (this.resumeAfterHold && this.sigma < tempo.duration) this.playing = true;
      this.resumeAfterHold = false;
    }
    this.wasHeld = held;
    this.mark('held', String(held));

    let T: number;
    if (this.driven()) {
      T = clamp(clock.ms(), d.sched.windowStartMs, d.sched.windowEndMs);
      this.sigma = tempo.sigmaAt(T);
    } else {
      if (this.playing) {
        this.sigma = Math.min(tempo.duration, this.sigma + dt);
        if (this.sigma >= tempo.duration) this.playing = false;
      }
      T = tempo.timeAt(this.sigma);
    }
    const sigma = this.sigma;
    const pinned = clock.pinned;
    const anim = reduced ? 0 : pinned ? sigma : now;
    if (pinned) {
      const f = sigma / PHASE_STEP;
      const i = Math.min(d.phaseTable.length - 2, Math.floor(f));
      this.flowPhase = d.phaseTable[i]! + (d.phaseTable[i + 1]! - d.phaseTable[i]!) * (f - i);
    } else if (!reduced) {
      const v = T >= d.tr.startMs && T <= d.tr.endMs ? velocityAt(d.tr, T) : 0.3;
      this.flowPhase += dt * VISUAL_FLOW * v;
    }
    if (this.fold !== this.foldTarget) {
      const step = reduced ? 1 : dt / FOLD_SECONDS;
      this.fold = this.foldTarget > this.fold ? Math.min(1, this.fold + step) : Math.max(0, this.fold - step);
    }
    if (this.fold >= 1) this.foldDoneSigma ??= this.sigma;
    else this.foldDoneSigma = null;

    // a fully transparent layer (story mode mounts the replay underneath the dark hours) draws nothing
    const layerOpacity = this.root.style.opacity;
    if (layerOpacity !== '' && Number(layerOpacity) < 0.004) {
      this.mark('sigma', sigma.toFixed(2));
      this.mark('drawn', 'false');
      if (this.audio.ready) this.audio.rain(0);
      this.lastT = T;
      return;
    }
    this.mark('drawn', 'true');
    this.sound(T, sigma);
    this.draw(T, sigma, anim);
    this.lastT = T;
  }

  private sound(T: number, sigma: number): void {
    const d = this.data!;
    const a = this.audio;
    if (!a.ready) return;
    const hero = d.sched.heroSample;
    const silent = hero !== null && sigma >= d.sched.tempo.sigmaAt(hero.tMs) - 1.9 && sigma < d.sched.tempo.sigmaAt(hero.tMs);
    const proofE = sstep(d.sched.tempo.sigmaAt(d.sched.proofMs), d.sched.tempo.sigmaAt(d.sched.proofMs) + 1.2, sigma);
    const rain = dailyAt(d.tl.rain, T)?.value ?? 0;
    a.rain(silent ? 0 : Math.sqrt(rain / 30) * (1 - proofE) * (1 - 0.6 * this.fold));
    const prev = this.lastT;
    if (!(T > prev) || T - prev > 6 * HOUR) return;
    const lay = this.lay!;
    if (!silent) {
      const cl = d.sched.clicks;
      let lo = 0;
      let hi = cl.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cl[mid]!.tMs <= prev) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < cl.length && cl[i]!.tMs <= T; i++) {
        const k = this.overflowIndex.get(cl[i]!.overflow)!;
        const x = this.mapPipes[2 * k]!;
        a.click(cl[i]!.kind === 'on', ((Number.isFinite(x) ? x : lay.W / 2) / lay.W) * 2 - 1);
      }
    }
    for (const s of d.sched.samples) if (s.tMs > prev && s.tMs <= T) a.arrive(s.hero);
  }

  private draw(T: number, sigma: number, anim: number): void {
    const d = this.data!;
    const lay = this.lay!;
    const g = this.g;
    const pal = this.pal;
    const dpr = this.cv.width / lay.W;
    const tempo = d.sched.tempo;
    const inDomain = T >= d.tr.startMs && T <= d.tr.endMs;
    const pulses: Pulse[] = inDomain ? pulsesAt(d.tr, T) : [];
    const idx = pulses.reduce((sum, p) => sum + (p.weirSurvival ?? 0), 0); // the engine's weirIndex, from the same pulses
    const share = d.maxIndex > 0 ? Math.sqrt(idx / d.maxIndex) : 0;

    const sp = d.sched.tempo.sigmaAt(d.sched.proofMs);
    const F = this.fold;
    // the proof holds the map's screen from its moment on; folding into the timetable moves it aside (it would
    // sit on the rows) and brings the timetable's own words back, and unfolding brings the proof back
    const proofDue = sstep(sp, sp + 1.4, sigma);
    const proofE = proofDue * (1 - sstep(0, 0.5, F));
    const E = sstep(0, 0.7, F); // the line straightening
    const unroll = sstep(0.5, 1, F);
    const mapA = 1 - sstep(0, 0.45, F);

    // timetable geometry: distance across (weir at the right), time down; the river is the "now" row
    const hoursIn = (T - d.sched.windowStartMs) / HOUR;
    const yLine = lay.yTop + Math.min(STRIP_HOURS, hoursIn) * lay.pxH;
    const xOf = (m: number): number => lay.xR - (m / d.dmax) * (lay.xR - lay.xL);
    const yOf = (t: number): number => yLine - ((T - t) / HOUR) * lay.pxH;

    // morph every river vertex from the map to the timetable line, the weir end first
    const N = d.net.nodes.length;
    const cur = this.curNodes;
    const M = this.mapNodes;
    for (let i = 0; i < N; i++) {
      const n = d.net.nodes[i]!;
      if (E <= 0) {
        cur[2 * i] = M[2 * i]!;
        cur[2 * i + 1] = M[2 * i + 1]!;
        continue;
      }
      const e = ease(clamp(E * 1.45 - 0.45 * (n.toWeirM / d.dmax), 0, 1));
      const mx = Number.isFinite(M[2 * i]!) ? M[2 * i]! : xOf(n.toWeirM);
      const my = Number.isFinite(M[2 * i + 1]!) ? M[2 * i + 1]! : yLine;
      cur[2 * i] = mx + (xOf(n.toWeirM) - mx) * e;
      cur[2 * i + 1] = my + (yLine - my) * e - 46 * Math.sin(Math.PI * e) * (1 - F * 0.4);
    }
    for (const l of this.netLines) for (let k = 0; k < l.nodes.length; k++) {
      l.t.P[2 * k] = cur[2 * l.nodes[k]!]!;
      l.t.P[2 * k + 1] = cur[2 * l.nodes[k]! + 1]!;
    }

    // veil over the terrain: the fold and the proof dim the land
    this.veil.style.opacity = String(Math.max(0.86 * sstep(0, 0.6, F), 0.78 * proofE));

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    // the beat of silence before the largest sample: the river dims, then comes back when it lands
    const hs = d.sched.heroSample ? tempo.sigmaAt(d.sched.heroSample.tMs) : NaN;
    const hush = Number.isFinite(hs) ? sstep(hs - 1.9, hs - 0.6, sigma) * (1 - sstep(hs, hs + 0.8, sigma)) : 0;
    const dim = (1 - (lay.phone ? 0.85 : 0.75) * proofE) * (1 - 0.3 * hush);

    // --- the map layer
    this.ctxLayer.style.opacity = (mapA * dim).toFixed(3);
    this.bedLayer.style.opacity = E <= 0 && this.layersReady ? (dim * (1 - 0.35 * proofE)).toFixed(3) : '0';
    if (mapA > 0.01) {
      const rivers = this.ctxTracks.filter((w) => w.k !== 'minor');
      drawFlow(
        g,
        rivers.map((w) => w.t),
        (i) => (rivers[i]!.k === 'river' ? RIVER_FLOW : STREAM_FLOW)(pal),
        this.flowPhase / VISUAL_FLOW,
        mapA * dim,
        dpr,
        pal,
        7,
      );
      this.drawRain(T, anim, mapA * (1 - proofE), dpr);
    }

    // --- the timetable rows (history above the line)
    if (unroll > 0.01) this.drawRows(T, yLine, xOf, yOf, unroll, dpr);

    // --- the plume field: at every river vertex, the surviving share of each plume covering it
    const sum = this.nodeSum;
    sum.fill(0);
    const heads: { x: number; y: number; s: number }[] = [];
    for (const p of pulses) {
      const pt = this.pathTracks.get(p.overflow);
      if (!pt) continue;
      const a = p.tailKmFromOverflow * 1000 * pt.scale;
      const b = p.headKmFromOverflow * 1000 * pt.scale;
      const c = pt.t.cum;
      for (let k = 0; k < pt.nodes.length; k++) {
        const m = c[k]!;
        if (m < a) continue;
        if (m > b) break;
        sum[pt.nodes[k]!]! += p.tailSurvival + (p.headSurvival - p.tailSurvival) * ((m - a) / Math.max(1, b - a));
      }
      if (p.headKmToWeir > 0.05 && b - a > 20) {
        for (let k = 0; k < pt.nodes.length; k++) {
          pt.t.P[2 * k] = cur[2 * pt.nodes[k]!]!;
          pt.t.P[2 * k + 1] = cur[2 * pt.nodes[k]! + 1]!;
        }
        const h = [0, 0];
        posAlong(pt.t, b, h);
        heads.push({ x: h[0]!, y: h[1]!, s: p.headSurvival });
      }
    }

    // --- the replay river: its bed of light, the plumes, the water moving
    const nets = this.netLines.map((l) => l.t);
    if (E > 0 || !this.layersReady) strokeTracks(g, nets, pal.night ? NET_BED : NET_BED_DAY, pal.usual, dim * (1 - 0.35 * proofE), dpr, pal);
    drawField(g, this.netLines, sum, dim, dpr, pal);
    const lineOf = this.netLines;
    drawFlow(g, nets, () => NET_FLOW(pal), this.flowPhase / VISUAL_FLOW, dim * (1 - 0.35 * E), dpr, pal, 3, (w, v) => {
      const lv = plumeLevel(sum[lineOf[w]!.nodes[v]!]!);
      return lv > 0 ? plumeColour(pal, lv) : null;
    });
    if (pal.night) {
      g.globalCompositeOperation = 'lighter';
      for (const h of heads) {
        if (!Number.isFinite(h.x + h.y)) continue;
        const r = (18 + 14 * h.s) * dpr;
        g.globalAlpha = 0.75 * clamp(h.s, 0.3, 1) * dim;
        g.drawImage(glowSprite(plumeColour(pal, 0.45)), h.x * dpr - r / 2, h.y * dpr - r / 2, r, r);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    // --- overflow lamps and their pour into the river
    const ovs = d.pack.overflows;
    const trackOf = new Map(d.tl.overflows.map((o) => [o.key, o]));
    for (let i = 0; i < ovs.length; i++) {
      const o = ovs[i]!;
      const pt = this.pathTracks.get(o.overflow)!;
      const s0 = pt.nodes[0]!;
      const e0 = E > 0 ? ease(clamp(E * 1.45 - 0.45 * (d.net.nodes[s0]!.toWeirM / d.dmax), 0, 1)) : 0;
      const px = lerp(this.mapPipes[2 * i]!, cur[2 * s0]!, e0);
      const py = lerp(this.mapPipes[2 * i + 1]!, cur[2 * s0 + 1]!, e0);
      const track = trackOf.get(o.overflow)!;
      const iv = activeInterval(track, T);
      const lastOn = lastStartBefore(track.intervals, T);
      const flash = lastOn === null ? 0 : 1 - sstep(0, 0.7, sigma - tempo.sigmaAt(lastOn));
      if (iv) {
        // the pour: brown light from the pipe to the river
        const rx = cur[2 * s0]!;
        const ry = cur[2 * s0 + 1]!;
        const len = Math.hypot(rx - px, ry - py);
        if (len > 3 && Number.isFinite(len)) {
          g.globalCompositeOperation = pal.comp;
          g.strokeStyle = rgba(pal.plume, 0.5 * dim);
          g.lineWidth = 1.4 * dpr;
          g.setLineDash([2 * dpr, 3 * dpr]);
          g.lineDashOffset = -anim * 18 * dpr;
          g.beginPath();
          g.moveTo(px * dpr, py * dpr);
          g.lineTo(rx * dpr, ry * dpr);
          g.stroke();
          g.setLineDash([]);
          g.globalCompositeOperation = 'source-over';
        }
        drawLamp(g, px, py, 2.6, mixCore(pal, flash), pal.plume, 26 + 34 * flash, dim, dpr, pal);
      } else {
        drawLamp(g, px, py, 1.7, pal.lampOff, null, 0, 0.9 * dim, dpr, pal);
      }
    }

    // --- the weir lamp
    const eW = E > 0 ? ease(clamp(E * 1.45, 0, 1)) : 0;
    const wx = lerp(this.mapWeir[0]!, xOf(0), eW);
    const wy = lerp(this.mapWeir[1]!, yLine, eW) - 46 * Math.sin(Math.PI * eW) * (1 - F * 0.4);
    const wc = weirColour(pal, share);
    const breathe = 1 + 0.06 * Math.sin(anim * 2.2);
    drawLamp(g, wx, wy, 4.2, pal.night ? [255, 255, 255] : pal.core, wc, (46 + 120 * share) * breathe, 1, dpr, pal);
    if (pal.night && share > 0.02) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.35 * share;
      const s = (160 + 200 * share) * dpr;
      g.drawImage(glowSprite(wc), wx * dpr - s / 2, wy * dpr - s / 2, s, s);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    // each lab sample falls onto the weir as a line of light and lands with a soft burst
    g.globalCompositeOperation = pal.comp;
    for (const s of d.sched.samples) {
      const si = tempo.sigmaAt(s.tMs);
      const fall = s.hero ? 0.9 : 0.45;
      const age = sigma - si;
      if (age < -fall || age > 1) continue;
      const col = s.over900 ? (s.hero ? pal.high : pal.higher) : pal.usual;
      if (age < 0) {
        const p = 1 - -age / fall;
        const drop = (s.hero ? 260 : 150) * (lay.phone ? 0.7 : 1);
        const head = wy - drop * (1 - p * p);
        const tail = Math.max(wy - drop, head - (s.hero ? 90 : 50));
        const gr = g.createLinearGradient(0, tail * dpr, 0, head * dpr);
        gr.addColorStop(0, rgba(col, 0));
        gr.addColorStop(1, rgba(col, 0.95));
        g.strokeStyle = gr;
        g.lineWidth = (s.hero ? 2 : 1.4) * dpr;
        g.beginPath();
        g.moveTo(wx * dpr, tail * dpr);
        g.lineTo(wx * dpr, head * dpr);
        g.stroke();
      } else {
        const r = ((s.hero ? 90 : 46) + (s.hero ? 260 : 90) * sstep(0, 1, age)) * dpr;
        g.globalAlpha = (1 - sstep(0, 1, age)) * (s.hero ? 0.9 : 0.6);
        g.drawImage(glowSprite(col), wx * dpr - r / 2, wy * dpr - r / 2, r, r);
        g.globalAlpha = 1;
      }
    }
    g.globalCompositeOperation = 'source-over';

    this.updateDom(T, sigma, { wx, wy, yLine, xOf, yOf, unroll, mapA, proofE, proofDue, F });
  }

  private drawRain(T: number, anim: number, alpha: number, dpr: number): void {
    const d = this.data!;
    const lay = this.lay!;
    const mm = dailyAt(d.tl.rain, T)?.value ?? 0;
    if (mm <= 0.5 || alpha < 0.02) return;
    const g = this.g;
    const n = Math.round((lay.phone ? 90 : 220) * Math.sqrt(Math.min(mm, 40) / 30));
    g.strokeStyle = rgba(this.pal.night ? [200, 220, 230] : [60, 80, 90], 0.07 * alpha);
    g.lineWidth = 1 * dpr;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const h1 = hash(i * 7.3 + 1);
      const h2 = hash(i * 3.1 + 2);
      const sp = 0.9 + 0.5 * hash(i * 1.7);
      const y = ((h2 + anim * sp * 0.9) % 1) * (lay.H + 60) - 30;
      const x = h1 * (lay.W + 80) - 40 - y * 0.12;
      const len = 14 + 10 * h1;
      g.moveTo(x * dpr, y * dpr);
      g.lineTo((x - len * 0.12) * dpr, (y + len) * dpr);
    }
    g.stroke();
  }

  private drawRows(T: number, yLine: number, xOf: (m: number) => number, yOf: (t: number) => number, unroll: number, dpr: number): void {
    const d = this.data!;
    const lay = this.lay!;
    const g = this.g;
    const pal = this.pal;
    const x0 = xOf(d.dmax);
    const x1 = xOf(0);
    const reveal = unroll * (yLine - lay.yTop + 4);
    const tMin = Math.max(d.sched.windowStartMs, T - STRIP_HOURS * HOUR);
    const visibleT = (t: number): boolean => t >= tMin && t <= T && yLine - yOf(t) <= reveal;
    const binW = (x1 - x0) / NB;
    g.globalCompositeOperation = pal.comp;
    g.lineCap = 'butt';
    const first = Math.max(0, Math.ceil((tMin - d.rowStartMs) / ROW_MS));
    const last = Math.min(d.rows - 1, Math.floor((T - d.rowStartMs) / ROW_MS));
    // runs of equal level, grouped per level so each level is one stroke
    const levels = 12;
    const byLevel: number[][] = Array.from({ length: levels + 1 }, () => []);
    const base: number[] = [];
    const marks: number[] = [];
    for (let r = first; r <= last; r++) {
      const t = d.rowStartMs + r * ROW_MS;
      if (!visibleT(t)) continue;
      const yy = Math.round(yOf(t) * dpr) + 0.5;
      base.push(yy);
      let runL = -1;
      let runStart = 0;
      const row = r * NB;
      for (let j = 0; j <= NB; j++) {
        const v = j < NB ? d.field[row + (NB - 1 - j)]! : 0; // bins count metres from the weir; x runs from upstream to the weir
        const lv = Math.round(plumeLevel(v) * levels);
        if (lv !== runL) {
          if (runL > 0) byLevel[runL]!.push(x0 + runStart * binW, x0 + j * binW, yy);
          runL = lv;
          runStart = j;
        }
      }
    }
    // tick marks at 00, 06, 12 and 18 Bath time on the left edge
    for (let t = Math.ceil(tMin / HOUR) * HOUR; t <= T; t += HOUR) {
      const lp = localParts(t, BATH_ZONE);
      if (lp.hour % 6 === 0 && visibleT(t)) marks.push(Math.round(yOf(t) * dpr) + 0.5, lp.hour === 0 ? 1 : 0);
    }
    g.lineWidth = 1 * dpr;
    g.strokeStyle = rgba(pal.usual, (pal.night ? 0.05 : 0.1) * unroll);
    g.beginPath();
    for (const yy of base) {
      g.moveTo(x0 * dpr, yy);
      g.lineTo(x1 * dpr, yy);
    }
    g.stroke();
    g.strokeStyle = rgba(pal.usual, (pal.night ? 0.2 : 0.3) * unroll);
    g.beginPath();
    for (let i = 0; i < marks.length; i += 2) {
      g.moveTo((x0 - (marks[i + 1] ? 16 : 8)) * dpr, marks[i]!);
      g.lineTo((x0 - 3) * dpr, marks[i]!);
    }
    g.stroke();
    for (let lv = 1; lv <= levels; lv++) {
      const seg = byLevel[lv]!;
      if (!seg.length) continue;
      // the plume under each row is a quiet ground: desaturated, thin, low; the spill edges above carry the motion
      const f = lv / levels;
      const col = mixRGB(pal.night ? [118, 104, 92] : [150, 140, 128], plumeColour(pal, f), 0.4 + 0.25 * f);
      const w = 1;
      g.strokeStyle = rgba(col, (pal.night ? 0.1 + 0.26 * f : 0.18 + 0.3 * f) * unroll);
      g.lineWidth = w * dpr;
      g.beginPath();
      for (let i = 0; i < seg.length; i += 3) {
        g.moveTo(seg[i]! * dpr, seg[i + 2]!);
        g.lineTo(seg[i + 1]! * dpr, seg[i + 2]!);
      }
      g.stroke();
    }

    // departures: the first water of each spill, a slanted path from its overflow down to the weir
    const yCut = yLine - reveal;
    const drawPath = (p: HeadPath, width: number, col: RGB, alpha: number): void => {
      g.strokeStyle = rgba(col, alpha * unroll);
      g.lineWidth = width * dpr;
      g.beginPath();
      let pen = false;
      for (let i = 0; i < p.t.length; i++) {
        let t = p.t[i]!;
        let m = p.m[i]!;
        if (t > T) {
          if (i === 0) break;
          const f = (T - p.t[i - 1]!) / (t - p.t[i - 1]!);
          m = p.m[i - 1]! + (m - p.m[i - 1]!) * f;
          t = T;
        }
        const y = yOf(t);
        if (t < tMin || y < yCut) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(xOf(m) * dpr, y * dpr);
        else g.moveTo(xOf(m) * dpr, y * dpr);
        pen = true;
        if (t >= T) break;
      }
      g.stroke();
    };
    const edge: RGB = pal.night ? [255, 200, 128] : [168, 92, 20];
    const heroEdge: RGB = pal.night ? [255, 238, 205] : [120, 50, 0];
    for (const p of d.heads) {
      if (p.t[0]! > T || p.t[p.t.length - 1]! < tMin) continue;
      if (p.hero) {
        if (pal.night) drawPath(p, 14, pal.higher, p.tail ? 0.06 : 0.16);
        drawPath(p, p.tail ? 1.6 : 3, heroEdge, p.tail ? 0.6 : 1);
      } else {
        if (pal.night && !p.tail) drawPath(p, 6, edge, 0.1);
        drawPath(p, p.tail ? 1 : 1.5, edge, p.tail ? (pal.night ? 0.32 : 0.45) : pal.night ? 0.88 : 0.9);
      }
      // the departure itself: a mark where the overflow opened
      if (!p.tail && visibleT(p.t[0]!)) {
        g.fillStyle = rgba(p.hero ? heroEdge : edge, unroll);
        g.beginPath();
        g.arc(xOf(p.m[0]!) * dpr, yOf(p.t[0]!) * dpr, (p.hero ? 3 : 1.8) * dpr, 0, 7);
        g.fill();
      }
    }

    // the weir column and the arrivals on it
    g.strokeStyle = rgba(pal.usual, 0.16 * unroll);
    g.lineWidth = 1 * dpr;
    g.beginPath();
    g.moveTo(x1 * dpr + 0.5, Math.max(lay.yTop, yCut) * dpr);
    g.lineTo(x1 * dpr + 0.5, yLine * dpr);
    g.stroke();
    g.globalCompositeOperation = 'source-over';
    for (const s of d.sched.samples) {
      if (!visibleT(s.tMs)) continue;
      drawLamp(g, x1, yOf(s.tMs), s.hero ? 4.6 : 2.6, s.over900 ? pal.high : pal.usual, s.over900 ? pal.high : null, s.hero ? 90 : 26, unroll, dpr, pal);
    }
  }

  // ---------------------------------------------------------------- DOM per frame

  private updateDom(
    T: number,
    sigma: number,
    k: { wx: number; wy: number; yLine: number; xOf: (m: number) => number; yOf: (t: number) => number; unroll: number; mapA: number; proofE: number; proofDue: number; F: number },
  ): void {
    const d = this.data!;
    const lay = this.lay!;
    const tempo = d.sched.tempo;
    const dom = this.dom;
    const show = (e: HTMLElement, a: number): void => {
      const v = a > 0.1 ? a : 0;
      e.style.opacity = v.toFixed(3);
      e.style.visibility = v > 0 ? 'visible' : 'hidden';
    };
    const place = (e: HTMLElement, x: number, y: number): void => {
      e.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    };
    // the proof arrives after the map's words have left, so the two never share the screen
    const base = 1 - sstep(0, 0.4, k.proofE);

    dom.clock.textContent = clockLabel(T);
    show(dom.place, base);
    // the one line leaves before the first sample lands, so "lab sample" never shares the screen with it
    const firstSample = d.sched.samples.length ? tempo.sigmaAt(d.sched.samples[0]!.tMs) : Infinity;
    const voiceOut = Math.min(3.1, firstSample - 0.05);
    show(dom.voice, (1 - sstep(voiceOut - 0.8, voiceOut, sigma)) * base * (1 - k.F));

    // the controls say what they do
    const ended = this.sigma >= tempo.duration - 1e-6;
    const playWord = this.playing ? 'Pause' : ended ? 'Replay' : 'Play';
    if (dom.play.textContent !== playWord) dom.play.textContent = playWord;
    // folded once the proof is due, the way back to it says so
    const backToProof = this.foldTarget === 1 && k.proofDue > 0.5;
    const foldWord = this.foldTarget ? (backToProof ? 'Proof' : 'Unfold') : 'Fold';
    if (dom.fold.textContent !== foldWord) {
      dom.fold.textContent = foldWord;
      dom.fold.title = this.foldTarget ? `Unfold the timetable back into the map${backToProof ? ' and the proof' : ''} (T)` : 'Fold the river into its timetable (T)';
    }
    // the controls step aside while the proof holds the screen (with "Now see Coimbra" beneath it, it fills the
    // word budget) and come back at once when the viewer moves the pointer, touches the screen or tabs to them
    const touched = this.ctx.clock.seconds() - this.touchedAt < 3;
    const ctrls = dom.play.parentElement!;
    const ca = touched ? 1 : 1 - sstep(0.2, 0.5, k.proofE);
    ctrls.style.opacity = ca.toFixed(3);
    ctrls.style.visibility = ca > 0.1 ? 'visible' : 'hidden';
    this.box.dataset['fold'] = this.fold >= 1 ? 'timetable' : this.fold <= 0 ? 'map' : 'folding';
    this.box.dataset['sigma'] = sigma.toFixed(2);

    // the weir's name
    const right = k.wx < lay.W * 0.7;
    dom.weir.classList.toggle('rp-left', !right);
    place(dom.weir, k.wx + (right ? 14 : -14), k.wy + 10);
    show(dom.weir, base);

    // "overflow", once, beside the first overflow to spill: it stays while its lamp is new, then fades
    const firstDep = d.sched.departures.findIndex((dep) => dep.first);
    const spill = firstDep < 0 ? null : d.sched.departures[firstDep]!;
    let aSpill = 0;
    if (spill) {
      const age = sigma - tempo.sigmaAt(spill.startMs);
      const oi = d.pack.overflows.findIndex((o) => o.overflow === spill.overflow);
      const x = this.mapPipes[2 * oi]!;
      const y = this.mapPipes[2 * oi + 1]!;
      aSpill = age < 0 || !Number.isFinite(x + y) ? 0 : sstep(0, 0.25, age) * (1 - sstep(TEACH_HOLD, TEACH_HOLD + TEACH_FADE, age)) * k.mapA * base;
      // under its time label, which sits above-right of the lamp
      if (aSpill > 0) place(dom.teachSpill, x + 8, y - 4);
    }
    show(dom.teachSpill, aSpill);

    // "overflow water", once, beside the first plume whose light stays long enough to read: it comes as that
    // plume's first water reaches its place, stays while the light runs past, then fades
    let aWater = 0;
    if (d.water && this.waterXY) {
      const age = sigma - d.water.sigma;
      aWater = age < 0 ? 0 : sstep(0, 0.3, age) * (1 - sstep(TEACH_HOLD, TEACH_HOLD + TEACH_FADE, age)) * k.mapA * base;
      if (aWater > 0) {
        const [x, y, leftSide] = this.waterXY;
        dom.teachWater.classList.toggle('rp-left', leftSide);
        place(dom.teachWater, x, y);
      }
    }
    show(dom.teachWater, aWater);

    // departures: each overflow's first logged minute beside its lamp, Freshford's with its name
    for (const [i, lab] of dom.deps) {
      const dep = d.sched.departures[i]!;
      const s0 = tempo.sigmaAt(dep.startMs);
      // the first spill's time stays as long as its word does
      const life = dep.hero ? 5.5 : i === firstDep ? TEACH_HOLD + TEACH_FADE : 1.8;
      const age = sigma - s0;
      const a = age < 0 ? 0 : sstep(0, 0.15, age) * (1 - sstep(life - 0.6, life, age));
      // a time in its own fade in or out is marked so (the contrast check reads it at full strength)
      lab.toggleAttribute('data-fading', a > 0 && a < 1);
      const oi = d.pack.overflows.findIndex((o) => o.overflow === dep.overflow);
      const x = this.mapPipes[2 * oi]!;
      const y = this.mapPipes[2 * oi + 1]!;
      const aMap = a * k.mapA * (Number.isFinite(x + y) ? 1 : 0);
      if (!dep.hero) {
        show(lab, aMap * base);
        if (aMap > 0) place(lab, x + 8, y - 20);
        continue;
      }
      // Freshford's label rides from its pipe on the map to the start of its path in the timetable
      const L = d.pack.overflows[oi]!.distance_to_weir_m ?? 0;
      const sy = k.yOf(dep.startMs);
      const inStrip = dep.startMs <= T && dep.startMs >= T - STRIP_HOURS * HOUR && k.yLine - sy <= k.unroll * (k.yLine - lay.yTop + 4);
      const aStrip = inStrip ? k.unroll : 0;
      show(lab, Math.max(aMap, aStrip) * base);
      lab.classList.toggle('rp-left', k.unroll > 0.5);
      // in the timetable the distance is the label's own place on the axis, so the km line steps aside
      (lab.querySelector('.rp-dep-km') as HTMLElement).style.opacity = (1 - sstep(0, 0.4, k.unroll)).toFixed(3);
      // on a phone the river runs under the label's right-hand side, so the label sits above its lamp
      lab.classList.toggle('rp-above', lay.phone && k.unroll <= 0.5);
      if (aMap > 0 || aStrip > 0) place(lab, lerp(x + (lay.phone ? 10 : 14), k.xOf(L) - 10, k.unroll), lerp(y - (lay.phone ? 12 : 14), sy - 10, k.unroll));
    }

    // arrivals: numbers dropping onto the weir (map) or sitting on their timetable row (strip)
    const S = d.sched.samples;
    const sig = S.map((s) => tempo.sigmaAt(s.tMs));
    const visible: { i: number; a: number; drop: number }[] = [];
    for (let i = 0; i < S.length; i++) {
      const s = S[i]!;
      const age = sigma - sig[i]!;
      const next = i + 1 < S.length ? sig[i + 1]! - sig[i]! : Infinity;
      const life = s.hero ? Math.max(5, Math.min(next + 0.4, 9)) : Math.min(2.6, next + 0.6);
      const appear = s.hero ? sstep(0, 0.35, age) : sstep(0, 0.2, age);
      const aMap = age < 0 ? 0 : appear * (1 - sstep(life - 0.7, life, age));
      const drop = age < 0 ? 0 : 1 - easeOutBack(clamp(age / (s.hero ? 0.9 : 0.5), 0, 1));
      visible.push({ i, a: aMap, drop });
    }
    const phoneScale = lay.phone ? 0.62 : 1;
    let stack = 0;
    let newest: number | null = null;
    // map position: a pile on the weir, oldest at the bottom. A new number falls onto the top of the pile, so no
    // number moves while it can be pressed, and an incoming number never passes over an outgoing one (a long
    // press turns over the number under the finger). A slot closes only once its number has faded below the
    // x-ray's reach (opacity 0.3).
    for (let v = 0; v < visible.length; v++) {
      const { i, a, drop } = visible[v]!;
      const s = S[i]!;
      const e = dom.arrivals[i]!;
      const hMap = (s.hero ? 100 : 40) * (lay.phone ? 0.75 : 1);
      const ax = k.wx + (right ? 18 : -18);
      const ay = k.wy - 22 * phoneScale - stack - drop * 34;
      // strip position: on its own row, right of the weir column; the number shrinks to the row's size
      const inStrip = s.tMs <= T && s.tMs >= T - STRIP_HOURS * HOUR && k.yLine - k.yOf(s.tMs) <= k.unroll * (k.yLine - lay.yTop + 4);
      const sx = k.xOf(0) + (s.hero ? 16 : 12);
      const sy = k.yOf(s.tMs) + (s.hero ? 10 : 6) * phoneScale;
      // the numbers leave the map as the fold begins, move while unseen, and return on their own rows
      const f = sstep(0.15, 0.35, k.F);
      const alpha = (a * (1 - sstep(0, 0.25, k.F)) + (inStrip ? k.unroll : 0)) * base;
      const left = !right && f < 0.5;
      const scale = lerp(1, lay.phone ? (s.hero ? 20 / 54 : 13 / 21) : s.hero ? 30 / 84 : 15 / 28, f);
      show(e, alpha);
      if (alpha > 0) e.style.transform = `translate(${Math.round(lerp(ax, sx, f))}px,${Math.round(lerp(ay, sy, f))}px) scale(${scale.toFixed(3)}) translate(${left ? '-100%' : '0'},-100%)`;
      if (a > 0) {
        stack += hMap * sstep(0, 0.3, a);
        if (a > 0.1) newest = i;
      }
    }
    const nu = newest === null ? 0 : visible[newest]!.a * (1 - sstep(0, 0.25, k.F)) * base;
    show(dom.unit, nu);
    dom.unit.classList.toggle('rp-left', !right);
    if (nu > 0) place(dom.unit, k.wx + (right ? 18 : -18), k.wy - 6 * phoneScale);

    // "lab sample", once, above the first sample's number as it lands at the weir, then it fades
    const first = S.length ? visible[0]! : null;
    let aSample = 0;
    if (first) {
      const age = sigma - sig[0]!;
      aSample = age < 0 ? 0 : first.a * (1 - sstep(TEACH_HOLD, TEACH_HOLD + TEACH_FADE, age)) * (1 - sstep(0, 0.25, k.F)) * base;
      if (aSample > 0) {
        const e = dom.arrivals[0]!;
        // the number's box (it is drawn up from its anchor): the word sits just above it, same side of the weir
        const top = e.getBoundingClientRect().top - this.box.getBoundingClientRect().top;
        dom.teachSample.classList.toggle('rp-left', !right);
        place(dom.teachSample, k.wx + (right ? 18 : -18), top - 4);
      }
    }
    show(dom.teachSample, aSample);

    // time ticks on the timetable's left edge: the weekday at midnight, the hour at 06, 12 and 18
    let ti = 0;
    if (k.unroll > 0.05) {
      const tMin = Math.max(d.sched.windowStartMs, T - STRIP_HOURS * HOUR);
      for (let t = Math.ceil(tMin / HOUR) * HOUR; t <= T && ti < dom.ticks.length; t += HOUR) {
        const lp = localParts(t, BATH_ZONE);
        if (lp.hour % 6 !== 0) continue;
        const y = k.yOf(t);
        if (k.yLine - y > k.unroll * (k.yLine - lay.yTop + 4) || k.yLine - y < 10) continue;
        const e = dom.ticks[ti++]!;
        e.textContent = lp.hour === 0 ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][lp.weekday]! : `${String(lp.hour).padStart(2, '0')}:00`;
        e.classList.toggle('rp-tick-day', lp.hour === 0);
        place(e, k.xOf(d.dmax) - (lay.phone ? 0 : 22), y - (lay.phone ? 13 : 6));
        e.classList.toggle('rp-tick-in', lay.phone);
        show(e, k.unroll * base);
      }
    }
    for (; ti < dom.ticks.length; ti++) show(dom.ticks[ti]!, 0);

    // the timetable's two axes in words: time runs down the rows, the water runs right to the weir; they
    // fade after the viewer has had a few story seconds with them (paused, they stay), and once the storm has
    // played to its end the timetable keeps them
    const axisAge = this.foldDoneSigma === null || ended ? 0 : sigma - this.foldDoneSigma;
    const aAxis = sstep(0.6, 1, k.unroll) * (1 - sstep(TEACH_HOLD + 1, TEACH_HOLD + 1 + TEACH_FADE, axisAge)) * base;
    show(dom.axisTime, aAxis);
    show(dom.axisDown, aAxis);
    if (aAxis > 0) {
      const yAxis = lay.yTop - (lay.phone ? 30 : 34);
      place(dom.axisTime, k.xOf(d.dmax) - (lay.phone ? 0 : 22), yAxis);
      dom.axisTime.classList.toggle('rp-axis-in', lay.phone);
      place(dom.axisDown, k.xOf(0), yAxis);
    }

    show(dom.proof, sstep(0.5, 1, k.proofE));
    const shellCredits = document.querySelector<HTMLElement>('.credits');
    const open = shellCredits !== null && !shellCredits.hidden;
    dom.credits.hidden = !open;
    if (open) dom.credits.style.bottom = `${Math.round(lay.H - shellCredits.getBoundingClientRect().top + 6)}px`;
    this.box.dataset['beat'] = k.proofE > 0.5 ? 'proof' : sigma < 1 ? 'start' : 'storm';
  }
}

const RIVER_FLOW = (p: Palette): FlowStyle => ({ gap: 320, speed: 1, trail: 190, width: 0.9, alpha: p.night ? 0.3 : 0.4, colour: p.river, glow: true });
const STREAM_FLOW = (p: Palette): FlowStyle => ({ gap: 520, speed: 0.8, trail: 120, width: 0.7, alpha: p.night ? 0.16 : 0.28, colour: p.river, glow: false });
const NET_BED: readonly (readonly [number, number])[] = [
  [12, 0.035],
  [4.5, 0.08],
  [1.4, 0.5],
];
const NET_BED_DAY: readonly (readonly [number, number])[] = [[2.2, 0.8]];
const NET_FLOW = (p: Palette): FlowStyle => ({ gap: 210, speed: 1.15, trail: 170, width: 1.15, alpha: p.night ? 0.95 : 1, colour: p.usual, glow: true });

function binPulses(ps: readonly Pulse[], dmax: number, out: Float32Array, off: number): void {
  for (const p of ps) {
    const h = p.headKmToWeir * 1000;
    const t = p.tailKmToWeir * 1000;
    if (t <= h) continue;
    const j0 = Math.max(0, Math.floor((h / dmax) * NB));
    const j1 = Math.min(NB - 1, Math.floor((t / dmax) * NB));
    for (let j = j0; j <= j1; j++) {
      const m = ((j + 0.5) / NB) * dmax;
      const f = clamp((m - h) / (t - h), 0, 1);
      out[off + j] = out[off + j]! + p.headSurvival + (p.tailSurvival - p.headSurvival) * f;
    }
  }
}

/**
 * Where "overflow water" is taught: the first spill in the window whose water keeps lighting one place on its way
 * to the weir for WATER_LIFE story seconds or more (from its first water arriving there to its last water passing),
 * so the word sits beside moving light for as long as it is read. The place is WATER_AT of the way down that
 * overflow's path; the word comes when the spill's first water gets there.
 */
function waterWord(tr: TransportReplay, sched: Schedule): WaterWord | null {
  const T = sched.tempo;
  let best: { at: number; overflow: string } | null = null;
  for (const track of tr.tracks)
    for (const iv of track.intervals) {
      if (iv.startClipped) continue;
      const spot = WATER_AT * track.distanceM;
      const headAt = timeAtDistance(tr.clock, distanceAt(tr.clock, iv.startMs) + spot);
      const tailAt = timeAtDistance(tr.clock, distanceAt(tr.clock, iv.stopMs) + spot);
      if (headAt === null || tailAt === null || headAt > tr.endMs) continue;
      if (T.sigmaAt(Math.min(tailAt, tr.endMs)) - T.sigmaAt(headAt) < WATER_LIFE) continue;
      if (!best || headAt < best.at || (headAt === best.at && track.overflow.key < best.overflow)) best = { at: headAt, overflow: track.overflow.key };
    }
  return best ? { overflow: best.overflow, frac: WATER_AT, sigma: T.sigmaAt(best.at) } : null;
}

function lastStartBefore(ivs: readonly { startMs: number }[], T: number): number | null {
  let lo = 0;
  let hi = ivs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ivs[mid]!.startMs <= T) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? ivs[lo - 1]!.startMs : null;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutBack = (t: number): number => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
const n01 = (c: RGB): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];
const mixCore = (p: Palette, flash: number): RGB => (p.night ? [255, Math.round(236 - 30 * (1 - flash)), Math.round(214 - 60 * (1 - flash))] : p.core);

export default function createScene(): Scene {
  return new ReplayScene();
}
