// Story mode's DOM: mounts the scenes the sequencer (./story.ts) names, each in its own layer, drives them, shows
// the narration (./narration.ts) one sentence at a time, and hands the city over to free exploration at the end.
// Scenes are reached only through the Scene contract:
//   storm  setTime(): each beat holds or moves through its own stretch of the 2024 storm (STORM_KEYS below), at
//          the replay's own tempo between them; the replay's words give way to the narration
//   dark   a chapter clock whose seconds() is the story's local time for it (0 until the scene has loaded)
//   city   cue('key'), cue('human'), then cue('opening'), cue('kit'), cue('test') (the example test reading's
//          comparison) and cue('fold'); narrate('human' | 'ask') gives the city's two data-driven lines; a link
//          into the comparison's later beats mounts it with params [city, 'opening', 'held'] (its test taken)
// Keys: space, the right arrow or Page Down skip ahead; Escape leaves for the city. The skip control is an arrow
// whose word shows on hover and focus. The link follows the beat on screen (#/story/<beat>, without a history
// entry), so a reload resumes there. window.__sayrStory reports the state for tests and film renders.
import type { CityId } from '../data/schemas';
import { buildTimeline } from '../engine/replay';
import { buildSchedule, type Schedule } from '../scenes/replay/schedule';
import type { Scene, SceneClock, SceneContext, SceneFactory } from '../scenes/types';
import type { CameraLike } from '../city/mapStyle';
import { createGeoView, GEO_TIMES, type GeoMove, type GeoView } from './geoView';
import { storyLine, type Line, type SayData } from './narration';
import { CITY_BEATS, STORM_BEATS, StoryMachine, storyChapters, type ChapterId, type StoryChapter, type StoryCommand } from './story';

export const TAGLINE = ['Your stream is measured on dry days.', 'AfterRain watches the storms.'] as const;
const STORY_CITY: CityId = 'CO';

export interface StoryHost {
  scene(name: 'dark-hours' | 'replay'): Promise<SceneFactory>;
  /** The city scene (the shell's own). */
  city(id: CityId): Scene & { route?(params: readonly string[]): void };
  /** The chapter on screen changed ('title' for the tagline, null once the story has handed over). */
  onChapter(id: ChapterId | 'title' | null): void;
  /** "Now see Coimbra": the change's progress (0 is the proof, 1 the line), the storm layer's opacity, and where the proof sat. */
  onward(progress: number, layer: number, at: DOMRect | null): void;
  /**
   * The story is over: the city scene becomes the shell's current scene at `hash`; `beat` is the first beat of the
   * chapter it hands over from (#/story/<beat> plays that chapter again).
   */
  handOver(scene: Scene & { route?(params: readonly string[]): void }, hash: string, beat: string): void;
  /** True while an x-ray card is open: the story holds. */
  held(): boolean;
}

export interface StoryState {
  readonly chapter: ChapterId | 'title';
  /** The chapter's place in the story (two chapters are the city). */
  readonly index: number;
  readonly beat: string;
  /** Story seconds played (holds excluded). */
  readonly t: number;
  readonly local: number;
  readonly waiting: boolean;
  readonly ended: boolean;
  readonly beats: readonly { chapter: ChapterId; id: string; at: number }[];
}

declare global {
  interface Window {
    __sayrStory?: StoryState;
  }
}

interface Mounted {
  readonly index: number;
  readonly id: ChapterId;
  readonly layer: HTMLDivElement;
  scene: (Scene & { route?(p: readonly string[]): void }) | null;
  gone: boolean;
}

export function createStory(host: StoryHost): Scene & { advance(): void; route(params: readonly string[]): void; hold(held: boolean): void } {
  let ctx!: SceneContext;
  let root!: HTMLDivElement;
  let machine: StoryMachine | null = null;
  const chapters: StoryChapter[] = storyChapters();
  let sched: Schedule | null = null;
  /** The storm chapter's local seconds and the replay's tempo seconds they show (piecewise linear between). */
  let stormKeys: readonly (readonly [number, number])[] = [];
  /** What the narration needs: numbers.json, the replay file and its schedule (null until loaded). */
  let say: SayData | null = null;
  let sayEl!: HTMLDivElement;
  /** The line on screen: its beat, the clock second it came up, and whether it has content. */
  let sayBeat = '';
  let sayFrom = 0;
  let sayHas = false;
  /** The one city scene of the first and last chapters, kept (hidden) between them. */
  let city: { layer: HTMLDivElement; scene: Scene & { route?(p: readonly string[]): void } } | null = null;
  let title!: HTMLParagraphElement;
  let skip!: HTMLButtonElement;
  let photo: HTMLElement | null = null;
  const mounted = new Map<number, Mounted>();
  const offs: (() => void)[] = [];
  let lastSec = 0;
  let alive = false;
  let handedOver = false;
  /** Cues the city is still playing: a navigate it asks for meanwhile is its own (remembered for the hand-over). */
  let cueing = 0;
  let wantHash: string | null = null;
  let lastChapter: string | null = null;
  let startBeat: string | undefined;
  /** The hash the story last wrote (or started from): a hash the viewer changed is never overwritten. */
  let ownHash = '';
  /** Where the places are (./geoView.ts): over the storm's first beat and the city's first two. */
  let geo: GeoView | null = null;
  /** Real ms when each move's first view was put in place: a slow tile host holds a chapter's start at most GEO_WAIT_MS. */
  const geoAsked: Partial<Record<GeoMove, number>> = {};
  const GEO_WAIT_MS = 4000;
  /** The move a chapter opens with, while its local time is still inside it. */
  const geoMoveOf = (id: ChapterId, local: number): GeoMove | null =>
    id === 'storm' && local < STORM_BEATS.weir - 1e-6 ? 'bath' : id === 'city' && local < CITY_BEATS.forecast - 1e-6 ? 'europe' : null;
  const geoPrepare = (move: GeoMove): void => {
    if (!geo) return;
    geo.prepare(move);
    geoAsked[move] ??= performance.now();
  };

  /** A fresh sequencer from the top (the opening, cut straight in), or from a beat (#/story/<beat>). */
  function start(beat: string | undefined): void {
    startBeat = beat;
    wantHash = null;
    const deep = beat && beat !== 'title' ? StoryMachine.find(chapters, beat) : null;
    if (beat && beat !== 'title' && !deep) console.warn(`story: no beat "${beat}"; starting from the top`);
    machine = new StoryMachine(chapters, deep ?? { chapter: 0, local: 0 }, { cut: !deep });
    ownHash = location.hash;
    lastSec = ctx.clock.seconds();
    run(machine.drain());
    drive();
  }

  const ready = (i: number): boolean => {
    const m = mounted.get(i);
    if (!m || !m.scene) return false;
    if (m.id === 'storm' && !sched) return false;
    // a chapter that opens on the map of its places waits for that map's tiles (never long)
    const move = machine ? geoMoveOf(m.id, machine.localOf(i)) : null;
    if (move && geo && !geo.ready(move) && performance.now() - (geoAsked[move] ?? performance.now()) < GEO_WAIT_MS) {
      geoPrepare(move);
      return false;
    }
    return m.layer.dataset['ready'] === 'true' || m.layer.querySelector('[data-ready="true"]') !== null;
  };

  const chapterClock = (index: number, script: boolean): SceneClock => ({
    now: () => ctx.clock.now(),
    ms: () => ctx.clock.ms(),
    // the dark hours reads its scene time from seconds(): the story's local time once its scene has loaded
    seconds: () => (script ? (ready(index) && machine ? machine.localOf(index) : 0) : ctx.clock.seconds()),
    get pinned() {
      return ctx.clock.pinned;
    },
    onFrame: (fn) => ctx.clock.onFrame(fn),
  });

  /** The story was started by a link to a beat after the example test reading (its comparison is built held). */
  const startsHeld = (): boolean => startBeat === 'changes' || startBeat === 'close';

  const sceneContext = (index: number, id: ChapterId): SceneContext => ({
    data: ctx.data,
    clock: chapterClock(index, id === 'dark'),
    theme: ctx.theme,
    registerCanvasWords: (k, e) => ctx.registerCanvasWords(k, e),
    reducedMotion: ctx.reducedMotion,
    city: STORY_CITY,
    // the story's city plans the example test reading (the opening) and starts at rest; a link straight into the
    // comparison's later beats (a reload at #/story/changes or close) opens on it as the story left it, its test taken
    params: id === 'city' ? (startsHeld() ? [STORY_CITY, 'opening', 'held'] : [STORY_CITY, 'opening']) : [],
    navigate: (hash) => {
      if (handedOver) {
        if (location.hash !== hash) location.hash = hash;
      } else if (cueing > 0) wantHash = hash;
      else if (id === 'city') {
        // the viewer acted in the city: the story hands over and the scene goes where it asked
        wantHash = hash;
        machine?.exit();
        run(machine?.drain() ?? []);
      }
    },
    get story() {
      return !handedOver;
    },
  });

  async function mountChapter(index: number): Promise<void> {
    const id = chapters[index]!.id;
    if (id === 'city' && city) {
      // the story's return to the city: the same scene, shown again
      mounted.set(index, { index, id, layer: city.layer, scene: city.scene, gone: false });
      return;
    }
    const layer = document.createElement('div');
    layer.className = 'story-layer';
    layer.dataset['ch'] = id;
    layer.style.opacity = '0';
    root.insertBefore(layer, title);
    const m: Mounted = { index, id, layer, scene: null, gone: false };
    mounted.set(index, m);
    const scene = id === 'city' ? host.city(STORY_CITY) : (await host.scene(id === 'dark' ? 'dark-hours' : 'replay'))();
    if (m.gone || !alive) return;
    m.scene = scene;
    if (id === 'city') {
      city = { layer, scene };
      // the viewer's first touch in the city ends the story there
      layer.addEventListener('pointerdown', () => {
        if (!handedOver && machine && !machine.ended && chapters[machine.chapter]!.id === 'city' && machine.alpha(machine.chapter) > 0.99) {
          machine.exit();
          run(machine.drain());
        }
      }, { capture: true });
    }
    scene.mount(layer, sceneContext(index, id));
  }

  function unmountChapter(index: number, all = false): void {
    const m = mounted.get(index);
    if (!m) return;
    m.gone = true;
    mounted.delete(index);
    if (m.id === 'city' && city && m.layer === city.layer && !all) {
      // kept for the story's return: hidden (it draws nothing and its map renders small while hidden)
      m.layer.style.opacity = '0';
      return;
    }
    if (city && m.layer === city.layer) city = null;
    m.scene?.unmount();
    m.layer.remove();
  }

  /**
   * Cues that have played, handed to the sequencer right after its next tick: the time of the frame a cue lands in
   * passed while the scene played it, so the story resumes from the cue's beat however the cue's promise and the
   * frame interleave (the film clock draws the same frame on every load).
   */
  const landed: { asked: StoryMachine; index: number }[] = [];
  const land = (asked: StoryMachine | null, index: number): void => {
    if (asked && machine === asked) landed.push({ asked, index });
  };

  function cue(index: number, name: string): void {
    const m = mounted.get(index);
    const scene = m?.scene;
    if (!scene?.cue) {
      machine?.cueDone(index);
      return;
    }
    cueing++;
    let p: Promise<boolean>;
    try {
      p = scene.cue(name);
    } catch (e) {
      p = Promise.reject(e);
    }
    const asked = machine; // a restart (#/story/<beat>) makes a new sequencer: this cue is not its business
    p.then(
      () => {
        cueing--;
        land(asked, index);
      },
      (e: unknown) => {
        cueing--;
        console.error(`story: the ${m!.id} scene could not play "${name}"`, e);
        land(asked, index);
      },
    );
  }

  function run(cmds: readonly StoryCommand[]): void {
    for (const c of cmds) {
      if (c.kind === 'mount') void mountChapter(c.chapter).catch((e: unknown) => console.error(e));
      else if (c.kind === 'unmount') unmountChapter(c.chapter);
      else if (c.kind === 'cue') cue(c.chapter, c.cue);
      else if (c.kind === 'finish') handOverCity();
    }
  }

  function handOverCity(): void {
    // the city on screen (the first or the last chapter: the same scene)
    const m = [...mounted.values()].find((x) => x.id === 'city' && x.scene);
    if (!m?.scene || handedOver) return;
    handedOver = true;
    m.layer.style.opacity = '1';
    mounted.delete(m.index);
    city = null;
    release(false);
    host.onChapter(null);
    host.handOver(m.scene, wantHash ?? `#/city/${STORY_CITY}`, chapters[m.index]!.beats[0]!.id);
  }

  /** Removes the story's own listeners and DOM; the chapters too unless they were handed over. */
  function release(all: boolean): void {
    alive = all ? false : alive;
    for (const off of offs.splice(0)) off();
    for (const i of [...mounted.keys()]) unmountChapter(i, true);
    if (city) {
      city.scene.unmount();
      city.layer.remove();
      city = null;
    }
    title.remove();
    skip.remove();
    sayEl.remove();
    geo?.destroy();
    geo = null;
    host.onward(0, 0, null);
    delete window.__sayrStory;
    delete document.body.dataset['story'];
    delete document.body.dataset['storyBeat'];
  }

  const HOUR = 3.6e6;
  /**
   * The storm's moments by beat (Bath time; the replay's tempo between them): the weir in the calm of the rain's
   * morning, held; the rain up to Freshford's logged spill; the spill and its modelled travel into the night; the
   * night to the morning (the river dimmed: nothing showed); the 31,000 landing at the weir and held; the proof
   * over the held frame.
   */
  function stormKeysOf(sc: Schedule): (readonly [number, number])[] {
    const T = sc.tempo;
    const spill = sc.heroDeparture?.startMs ?? sc.windowStartMs + 72 * HOUR;
    const sample = sc.heroSample?.tMs ?? spill + 24 * HOUR;
    const S = STORM_BEATS;
    const keys: [number, number][] = [
      [0, T.sigmaAt(spill - 5 * HOUR)],
      [S.rain, T.sigmaAt(spill - 5 * HOUR)],
      [S.spill - 0.2, T.sigmaAt(spill - 0.25 * HOUR)],
      [S.still - 0.2, T.sigmaAt(spill + 10 * HOUR)],
      [S.sample, T.sigmaAt(sample - 1.5 * HOUR)],
      [S.sample + 3.4, T.sigmaAt(sample + 0.5 * HOUR)],
      [S.proof + 30, T.sigmaAt(sample + 0.5 * HOUR)],
    ];
    // the tempo's seconds never run backwards
    for (let i = 1; i < keys.length; i++) keys[i]![1] = Math.max(keys[i]![1], keys[i - 1]![1]);
    return keys;
  }
  const stormSigma = (local: number): number => {
    const k = stormKeys;
    if (!k.length) return 0;
    if (local <= k[0]![0]) return k[0]![1];
    for (let i = 1; i < k.length; i++) {
      const [t1, s1] = k[i]!;
      const [t0, s0] = k[i - 1]!;
      if (local <= t1) return s0 + ((s1 - s0) * (local - t0)) / (t1 - t0);
    }
    return k[k.length - 1]![1];
  };
  /** The quiet beats dim their scene under the line: the still river, and the proof over the held storm. */
  const DIM: Record<string, number> = { still: 0.32, proof: 0.22, cities: 1, gap: 1 };
  const dimOf = (mm: Mounted, beat: string): number => (mm.id === 'storm' && chapters[machine!.chapter]!.id === 'storm' ? (DIM[beat] ?? 1) : 1);

  /** The line for a beat: the story's own, or the city's data-driven one. */
  function lineOf(beat: string): Line | null {
    if (beat === 'human' || beat === 'ask') {
      const c = [...mounted.values()].find((x) => x.id === 'city')?.scene;
      const main = c?.narrate?.(beat) ?? null;
      return main ? { main } : null;
    }
    return storyLine(beat, say);
  }
  /** One sentence at a time: a new beat's line replaces the last, fading in on the clock (at once under reduced motion). */
  function narrate(m: StoryMachine): void {
    const beat = m.beat === 'title' ? '' : m.beat;
    if (beat !== sayBeat || !sayHas) {
      const line = beat ? lineOf(beat) : null;
      const same = !!line && sayHas && sayEl.querySelector('.say-main')?.textContent === line.main.map((n) => n.textContent).join('') && !line.small;
      if (same) sayBeat = beat;
      else if (beat !== sayBeat || line) {
        sayBeat = beat;
        sayHas = line !== null;
        sayFrom = ctx.clock.seconds();
        const main = document.createElement('p');
        main.className = 'say-main';
        if (line) main.append(...line.main);
        const kids: HTMLElement[] = [main];
        if (line?.small) {
          const sm = document.createElement('p');
          sm.className = 'say-small';
          sm.append(...line.small);
          kids.push(sm);
        }
        sayEl.replaceChildren(...kids);
        sayEl.dataset['beat'] = beat;
        sayEl.hidden = !line;
      }
    }
    const a = ctx.reducedMotion ? 1 : Math.min(1, Math.max(0, (ctx.clock.seconds() - sayFrom) / 0.5));
    const e = a * a * (3 - 2 * a);
    sayEl.style.opacity = e.toFixed(3);
    sayEl.style.transform = ctx.reducedMotion ? '' : `translateY(${((1 - e) * 8).toFixed(2)}px)`;
    if (e < 1) sayEl.dataset['fading'] = '';
    else delete sayEl.dataset['fading'];
  }

  function driveGeo(m: StoryMachine): void {
    if (!geo) return;
    const id = chapters[m.chapter]!.id;
    const local = m.localOf(m.chapter);
    const move = m.beat === 'title' ? null : geoMoveOf(id, local);
    // the city's own camera and river, for the flight into it
    const c = city?.scene as { view?(): { cam: CameraLike; river: [number, number] | null } | null } | undefined;
    if (move === 'europe' && c?.view) {
      const v = c.view();
      if (v) geo.land(v.cam, v.river);
    }
    geo.set(move, local, move ? m.alpha(m.chapter) : 0);
    // the next move's first view loads while the chapters before it play
    if (id === 'storm' && local >= GEO_TIMES.bath.end) geoPrepare('europe');
  }

  function drive(): void {
    const m = machine!;
    // the replay plays its own tempo, set by the story
    for (const mm of mounted.values()) {
      if (mm.id !== 'storm' || !mm.scene?.setTime || !sched || !ready(mm.index)) continue;
      mm.scene.setTime(new Date(sched.tempo.timeAt(stormSigma(m.localOf(mm.index)))));
    }
    const beatOn = m.beat;
    for (const mm of mounted.values()) {
      const dim = dimOf(mm, beatOn);
      mm.layer.style.opacity = (m.alpha(mm.index) * dim).toFixed(3);
      // a dimmed scene keeps its picture, not its words (the narration speaks)
      if (dim < 1) mm.layer.dataset['dim'] = '';
      else delete mm.layer.dataset['dim'];
    }
    narrate(m);
    driveGeo(m);
    const ta = m.titleAlpha;
    title.style.opacity = ta.toFixed(3);
    title.style.visibility = ta > 0.02 ? 'visible' : 'hidden';

    const id = m.beat === 'title' ? 'title' : chapters[m.chapter]!.id;
    if (id !== lastChapter) {
      lastChapter = id;
      host.onChapter(id);
    }
    document.body.dataset['story'] = id;
    document.body.dataset['storyBeat'] = m.beat;
    root.dataset['beat'] = m.beat;
    if (photo) photo.dataset['on'] = String(m.beat === 'weir');
    // the link follows the beat (no history entry): a reload resumes at the beat on screen
    const want = m.beat === 'title' ? '#/story' : `#/story/${m.beat}`;
    // only a hash the story itself set: a link the viewer just followed waits for its hashchange (route())
    if (m.total > 0.05 && location.hash === ownHash && location.hash !== want) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}${want}`);
      ownHash = want;
      startBeat = m.beat === 'title' ? undefined : m.beat;
    }

    host.onward(0, 0, null);

    if (m.chapter === 0 || m.beat !== 'title') {
      if (ready(m.chapter) && document.body.dataset['ready'] !== 'true') document.body.dataset['ready'] = 'true';
    }
    window.__sayrStory = {
      chapter: id,
      index: m.chapter,
      beat: m.beat,
      t: m.total,
      local: m.local,
      waiting: m.waiting,
      ended: m.ended,
      beats: chapters.flatMap((c) => c.beats.map((b) => ({ chapter: c.id, id: b.id, at: b.at }))),
    };
  }

  function tick(): void {
    if (!alive || !machine || handedOver) return;
    const now = ctx.clock.seconds();
    const dt = Math.max(0, now - lastSec);
    lastSec = now;
    run(machine.tick(dt, ready, host.held()));
    for (const l of landed.splice(0)) if (machine === l.asked) l.asked.cueDone(l.index);
    if (machine) run(machine.drain());
    if (handedOver || !alive) return;
    drive();
  }

  function advance(): void {
    if (!machine || handedOver) return;
    machine.advance();
    run(machine.drain());
  }

  const onKey = (e: KeyboardEvent): void => {
    if (!machine || handedOver || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    const field = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    // space on a focused button or link presses it (the skip control included); the arrow always moves on
    const presses = e.key === ' ' && (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement);
    if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'PageDown') {
      if (field || presses) return;
      e.preventDefault();
      e.stopPropagation();
      machine.advance();
      run(machine.drain());
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      e.stopPropagation(); // the scenes' own beat keys stay quiet: the story owns time here
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      machine.exit();
      run(machine.drain());
    }
  };

  return {
    mount(r, c) {
      ctx = c;
      alive = true;
      root = document.createElement('div');
      root.className = 'story';
      root.dataset['ready'] = 'true'; // the tagline is up at once: the shell may cross into the story now
      r.append(root);
      title = document.createElement('p');
      title.className = 'story-title';
      title.innerHTML = TAGLINE.map((l) => `<span>${l}</span>`).join(' ');
      skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'story-skip';
      skip.setAttribute('aria-label', 'Skip ahead (space). Escape leaves the story.');
      skip.innerHTML = '<span class="w">skip</span><span class="g" aria-hidden="true">&rarr;</span>';
      skip.addEventListener('click', () => advance());
      // the real place under the opening line: Warleigh Weir (data/LICENSE-DATA.md, Photographs); left out under the
      // film clock (?clock=manual), whose frames must not depend on a photo's load and fade
      photo = new URLSearchParams(location.search).get('clock') === 'manual' ? null : document.createElement('figure');
      if (photo) {
        photo.className = 'story-photo';
        photo.innerHTML =
          `<img src="${import.meta.env.BASE_URL}photos/warleigh-weir.jpg" alt="Warleigh Weir on the River Avon near Bath: water pouring over the curved weir between green trees" />` +
          '<figcaption>Photo: <a href="https://commons.wikimedia.org/wiki/File:Warleigh_Weir,_from_north.jpg" target="_blank" rel="noopener">Rwendland</a>, Wikimedia Commons, <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA</a></figcaption>';
      }
      root.append(title, skip);
      if (photo) root.append(photo);
      document.body.dataset['story'] = 'title';
      window.addEventListener('keydown', onKey, { capture: true });
      offs.push(() => window.removeEventListener('keydown', onKey, { capture: true }));
      lastSec = c.clock.seconds();
      offs.push(c.clock.onFrame(tick));
      sayEl = document.createElement('div');
      sayEl.className = 'story-say';
      sayEl.setAttribute('aria-live', 'polite');
      root.insertBefore(sayEl, skip);
      geo = createGeoView(root, () => c.theme.get());
      const beat = c.params[0];
      const at = beat && beat !== 'title' ? StoryMachine.find(chapters, beat) : null;
      geoPrepare(!at || (at.chapter === 0 && at.local < STORM_BEATS.weir) ? 'bath' : 'europe');
      start(beat === 'title' ? undefined : beat);
      // what the narration and the storm chapter need: the replay's schedule (it maps the storm's beats to its
      // moments) and numbers.json; the first line needs neither
      void Promise.all([c.data.replay('2024-09-23'), c.data.numbers()])
        .then(([pack, nums]) => {
          if (!alive) return;
          sched = buildSchedule('2024-09-23', pack, buildTimeline(pack));
          stormKeys = stormKeysOf(sched);
          say = { numbers: nums, replay: pack, sched };
          sayBeat = '';
        })
        .catch((e: unknown) => console.error('story: could not load the replay and the numbers', e));
    },
    advance,
    // an x-ray card over the story: the story itself holds (host.held), and each chapter's scene is told too
    hold(held) {
      for (const mm of mounted.values()) mm.scene?.hold?.(held);
    },
    route(params) {
      // another beat of the same story (#/story/<beat>): start again there
      if (!machine) return;
      if (handedOver || params[0] === startBeat) return;
      for (const i of [...mounted.keys()]) unmountChapter(i);
      lastChapter = null;
      start(params[0]);
    },
    unmount() {
      if (handedOver) return;
      release(true);
      root.remove();
      host.onChapter(null);
    },
  };
}
