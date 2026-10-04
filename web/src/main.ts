// The shell: the app clock, the theme, the data loaders, the chrome (wordmark, city switcher, hour, day/night,
// credits, the links to the other scenes), hash routing and the one frame loop. The city scene is the shell's own;
// every other scene is found in src/scenes/<name>/index.ts and mounted at #/<name> (see src/scenes/types.ts).
// Story mode (#/story, the default) chains them (src/app/storyShell.ts); the FHIR x-ray (src/app/xray.ts) turns
// numbers over to their OAH-FHIR resources on every screen.
//
// A route change never passes through a dark screen: the new scene mounts in its own layer under the old one,
// and the two cross-fade once the new one starts to draw. When a city is coming (a first visit, or from the dark
// hours or the replay) and has not started to draw, the tagline holds the screen until its streams do.
import '@fontsource/archivo/500.css';
import '@fontsource/archivo/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { CITIES, CITY_ORDER } from './app/cities';
import { clockOptionsLenient, createClock, type ClockControl } from './app/clock';
import { TERRAIN_CREDITS } from './app/credits';
import { cityHash, parseHash, routeHash, STORY_HASH, type Route } from './app/router';
import { createStory, TAGLINE, type StoryHost } from './app/storyShell';
import { createTheme, themeBySun } from './app/theme';
import { installXray } from './app/xray';
import { createCityScene } from './city/scene';
import { DATA_BASE_URL, httpSource, loaders } from './data/loaders';
import type { CityId } from './data/schemas';
import { formatClock, formatDayTime, localParts } from './engine/timefmt';
import { clearCanvasText, registerCanvasText } from './format/canvasText';
import type { Scene, SceneContext, SceneFactory, Theme } from './scenes/types';

declare global {
  interface Window {
    __sayrClock?: ClockControl;
  }
}

const CROSSFADE = 0.9;
const smooth = (u: number): number => {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
};

const sceneModules = import.meta.glob<{ default: SceneFactory }>('./scenes/*/index.ts');
const sceneNames = Object.keys(sceneModules).map((p) => p.split('/')[2]!);

const q = new URLSearchParams(location.search);
// A mistyped link still opens the app: a bad ?t, ?rate or ?theme is set aside with a warning.
const clockQuery = clockOptionsLenient(location.search);
for (const p of clockQuery.problems) console.warn(`${p}; the clock runs from the real time`);
const clock = createClock(clockQuery.opts, () => Date.now());
window.__sayrClock = clock.control;
const themeQuery = q.get('theme');
const forcedTheme: Theme | null = themeQuery === 'night' || themeQuery === 'day' ? themeQuery : null;
if (themeQuery !== null && forcedTheme === null) console.warn(`?theme=${themeQuery} must be night or day; the theme follows the sun`);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const data = loaders(httpSource(DATA_BASE_URL));

let route: Route = parseHash(location.hash, sceneNames);
let userTheme = false;
/**
 * Story mode plays at night (the storms are light in the dark), and a visit that opened on the story stays at night
 * afterwards until the viewer switches; a link straight to a city or a scene follows the sun there.
 */
let storyNight = route.kind === 'story';
/** The chapter story mode shows ('city' puts Coimbra's name and hour in the chrome). */
let storyChapter: string | null = null;
/** The city whose name and hour the chrome shows, if any. */
const chromeCity = (): CityId | null => (route.kind === 'city' ? route.city : route.kind === 'story' && storyChapter === 'city' ? 'CO' : null);
const sunTheme = (): Theme => {
  if (storyNight || route.kind === 'story') return 'night';
  const c = CITIES[chromeCity() ?? 'CO'];
  return themeBySun(clock.ms(), c.lat, c.lon);
};
const theme = createTheme(forcedTheme ?? sunTheme());

// ----- chrome -----
const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app is missing from index.html');
app.innerHTML = `
  <div id="scene"></div>
  <p class="tagline" aria-hidden="true">${TAGLINE.map((l) => `<span>${l}</span>`).join(' ')}</p>
  <h1 class="mark">Sayr</h1>
  <div class="place">
    <button class="city-btn" type="button" aria-haspopup="true" aria-expanded="false"></button>
    <span class="hour" data-time></span>
    <ul class="cities" hidden></ul>
  </div>
  <nav class="elsewhere" aria-label="The other scenes"><a href="#/dark-hours">dark hours</a><a href="#/replay">storm</a></nav>
  <button class="onward" type="button" hidden>Now see Coimbra</button>
  <button class="mode" type="button"><i></i></button>
  <button class="credit" type="button" aria-label="Map and data credits" aria-expanded="false">&copy;</button>
  <p class="credits" hidden>&copy; OpenStreetMap contributors &middot; OpenFreeMap &middot; OpenMapTiles &middot; Terrain: Terrain Tiles by Mapzen, AWS Open Data, from EU-DEM, produced using Copernicus data and information funded by the European Union; <span data-unit>${TERRAIN_CREDITS[0]}</span>; &copy; Kartverket; <span data-unit>${TERRAIN_CREDITS[1]}</span>; <span data-unit>${TERRAIN_CREDITS[2]}</span>; <span data-unit>${TERRAIN_CREDITS[3]}</span> &middot; Sites: OneAquaHealth &middot; Rain: Open-Meteo, <span data-unit>CC BY 4.0</span></p>`;
const sceneRoot = app.querySelector<HTMLElement>('#scene')!;
const tagline = app.querySelector<HTMLElement>('.tagline')!;
const place = app.querySelector<HTMLElement>('.place')!;
const cityBtn = app.querySelector<HTMLButtonElement>('.city-btn')!;
const hourEl = app.querySelector<HTMLElement>('.hour')!;
const cityList = app.querySelector<HTMLUListElement>('.cities')!;
const elsewhere = app.querySelector<HTMLElement>('.elsewhere')!;
const onwardBtn = app.querySelector<HTMLButtonElement>('button.onward')!;
const modeBtn = app.querySelector<HTMLButtonElement>('.mode')!;
const creditBtn = app.querySelector<HTMLButtonElement>('.credit')!;
const credits = app.querySelector<HTMLElement>('.credits')!;

const setMenu = (open: boolean): void => {
  cityList.hidden = !open;
  cityBtn.setAttribute('aria-expanded', String(open));
  elsewhere.classList.toggle('menu', open);
  if (open) cityList.querySelector('a')?.focus();
};
const setCredits = (open: boolean): void => {
  credits.hidden = !open;
  creditBtn.setAttribute('aria-expanded', String(open));
};
cityBtn.addEventListener('click', () => setMenu(cityList.hidden === true));
creditBtn.addEventListener('click', () => setCredits(credits.hidden === true));
// Escape closes the city menu or the credits first (before a scene hears it); a tap anywhere else closes them too.
addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return;
    if (!cityList.hidden) {
      setMenu(false);
      cityBtn.focus();
      e.stopPropagation();
    } else if (!credits.hidden) {
      setCredits(false);
      creditBtn.focus();
      e.stopPropagation();
    }
  },
  { capture: true },
);
addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target as Node;
    if (!cityList.hidden && !place.contains(t)) setMenu(false);
    if (!credits.hidden && !credits.contains(t) && !creditBtn.contains(t)) setCredits(false);
  },
  { capture: true },
);
const syncModeLabel = (): void => modeBtn.setAttribute('aria-label', theme.get() === 'night' ? 'Switch to day' : 'Switch to night');
modeBtn.addEventListener('click', () => {
  userTheme = true;
  storyNight = false;
  theme.set(theme.get() === 'night' ? 'day' : 'night');
});
theme.subscribe(syncModeLabel);
syncModeLabel();

const SCENE_TITLES: Record<string, string> = { replay: 'Sayr: the storm replayed', 'dark-hours': 'Sayr: the dark hours', darkhours: 'Sayr: the dark hours' };
function renderChrome(): void {
  const id = chromeCity();
  place.hidden = id === null;
  elsewhere.hidden = route.kind !== 'city';
  if (id === null) {
    document.title = route.kind === 'scene' ? (SCENE_TITLES[route.name] ?? 'Sayr') : 'Sayr';
    return;
  }
  cityBtn.textContent = CITIES[id].name;
  cityBtn.setAttribute('aria-label', `${CITIES[id].name}. Choose another city`);
  cityList.innerHTML = CITY_ORDER.filter((c) => c !== id)
    .map((c) => `<li><a href="${cityHash(c)}">${CITIES[c].name}</a></li>`)
    .join('');
  // the city scene adds the open stream's name (src/city/scene.ts)
  document.title = `Sayr: ${CITIES[id].name}`;
}

// ----- the FHIR x-ray -----
// the scene behind an open card holds still (Scene.hold: the replay plays on its own clock otherwise)
const xray = installXray({ clock, reducedMotion, data, base: DATA_BASE_URL, scene: sceneRoot, pause: (on) => current?.scene.hold?.(on) });
// story mode turns a record over itself (the city's 'record' cue) and back ('fold'); such a card does not hold the story
document.addEventListener('sayr:xray', (e) => {
  const d = (e as CustomEvent<{ el: HTMLElement; story?: boolean }>).detail;
  void xray.open(d.el, { story: d.story === true });
});
document.addEventListener('sayr:xray-close', () => xray.close());

// ----- scenes -----
type RoutedScene = Scene & { route?(p: readonly string[]): void; advance?(): void };
interface Live {
  scene: RoutedScene;
  key: string;
  readonly layer: HTMLElement;
  params: readonly string[];
}
let current: Live | null = null;
/** Scenes on their way out: each waits for its successor to be ready, then fades. */
const retiring: { live: Live; next: Live; fadeFrom: number | null; since: number }[] = [];
let showToken = 0;
/** The tagline while a city loads: shown from `from` (clock seconds), fading once its streams draw. */
let firstTagline: { layer: HTMLElement; from: number; drawingAt: number | null } | null = null;

const layerReady = (l: HTMLElement): boolean => l.dataset['ready'] === 'true' || l.querySelector('[data-ready="true"]') !== null;
/** The scene has started to draw (the city sets data-drawing as its map fades in), or is ready. */
const layerDrawing = (l: HTMLElement): boolean => l.dataset['drawing'] === 'true' || l.querySelector('[data-drawing="true"]') !== null || layerReady(l);

function context(params: readonly string[], city: CityId): SceneContext {
  return {
    data,
    clock,
    theme,
    registerCanvasWords: (id, entry) => (entry ? registerCanvasText(id, entry) : clearCanvasText(id)),
    reducedMotion,
    city,
    params,
    navigate: (hash, opts) => {
      if (location.hash === hash) return;
      if (!opts?.replace) {
        location.hash = hash;
        return;
      }
      // a correction (an unknown stream in the link): the link changes, history does not grow, nothing remounts
      history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      route = parseHash(hash, sceneNames);
      if (current) current.params = route.params;
      renderChrome();
    },
  };
}

const storyHost: StoryHost = {
  scene: async (name) => (await sceneModules[`./scenes/${name}/index.ts`]!()).default,
  city: (id) => createCityScene(id),
  onChapter: (id) => {
    storyChapter = id;
    renderChrome();
    if (!userTheme && forcedTheme === null) theme.set(sunTheme());
  },
  onward: (progress, layer, at) => setOnward(progress, layer, at),
  handOver: (scene, hash, beat) => {
    if (!current) return;
    current = { scene, key: 'city:CO', layer: current.layer, params: ['CO'] };
    storyChapter = null;
    // the city gets its own history entry; going back from it replays the city chapter it came from, inside the app
    history.replaceState(null, '', `${location.pathname}${location.search}#/story/${beat}`);
    history.pushState(null, '', `${location.pathname}${location.search}${hash}`);
    void show();
  },
  held: () => xray.holds(),
};

async function show(): Promise<void> {
  const token = ++showToken;
  route = parseHash(location.hash, sceneNames);
  // the link reads what the screen shows: an unknown city, scene or segment is corrected in place
  const canon = routeHash(route);
  if (location.hash && location.hash !== canon && !(route.kind === 'city' && route.params[1] === 'stream')) {
    history.replaceState(null, '', `${location.pathname}${location.search}${canon}`);
  }
  setMenu(false);
  setCredits(false);
  renderChrome();
  const key = route.kind === 'city' ? `city:${route.city}` : route.kind === 'story' ? 'story' : `scene:${route.name}`;
  if (current && current.key === key) {
    const same = current.params.join('/') === route.params.join('/');
    current.params = route.params;
    if (current.scene.route) {
      current.scene.route(route.params);
      return;
    }
    // a scene without route() is mounted afresh for new segments
    if (same) return;
  }
  let scene: RoutedScene;
  if (route.kind === 'city') scene = createCityScene(route.city);
  else if (route.kind === 'story') scene = createStory(storyHost);
  else scene = (await sceneModules[`./scenes/${route.name}/index.ts`]!()).default();
  if (token !== showToken) return;
  const layer = document.createElement('div');
  layer.className = 'scene-layer';
  sceneRoot.append(layer);
  const prev = current;
  current = { scene, key, layer, params: route.params };
  document.body.dataset['ready'] = 'false';
  if (!userTheme && forcedTheme === null) theme.set(sunTheme());
  if (prev) {
    // anything still retiring goes now; the scene just replaced waits for its successor
    for (const r of retiring.splice(0)) dispose(r.live);
    prev.layer.classList.add('leaving');
    layer.style.opacity = '0';
    retiring.push({ live: prev, next: current, fadeFrom: null, since: clock.seconds() });
  }
  // a city on its way: the tagline if its streams are not drawing soon (at once on a first visit); from another
  // city the old map holds the screen instead
  if (route.kind === 'city' && !prev?.key.startsWith('city:')) firstTagline = { layer, from: clock.seconds() + (prev ? 0.6 : 0), drawingAt: null };
  const city = route.kind === 'city' ? route.city : 'CO';
  scene.mount(layer, context(route.params, city));
}

function dispose(l: Live): void {
  l.scene.unmount();
  l.layer.remove();
}

if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}${STORY_HASH}`);
addEventListener('hashchange', () => void show().catch((e: unknown) => console.error(e)));
void show().catch((e: unknown) => console.error(e));

// ----- "Now see Coimbra": after the replay's proof, in the story and in the replay on its own -----
let onwardAt: DOMRect | null = null;
/**
 * `progress` 0..1: the line fades in beneath the proof, which stays (at the replay's empty line .rp-proof, `at`).
 * `layer` scales it (the story's crossfade).
 */
function setOnward(progress: number, layer: number, at: DOMRect | null): void {
  const p = progress <= 0 || layer <= 0 ? 0 : Math.min(1, progress);
  const a = smooth(p) * layer;
  document.body.classList.toggle('onward', p > 0);
  onwardBtn.hidden = a < 0.02;
  onwardBtn.style.opacity = a.toFixed(3);
  if (at && at.width > 0) onwardAt = at;
  if (onwardBtn.hidden) return;
  const W = innerWidth;
  const left = onwardAt ? onwardAt.left : W < 700 ? 18 : Math.round(W * 0.085);
  const top = onwardAt ? onwardAt.top : Math.round(innerHeight * 0.4);
  onwardBtn.style.left = `${Math.round(left)}px`;
  onwardBtn.style.top = `${Math.round(top)}px`;
}
onwardBtn.addEventListener('click', () => {
  if (route.kind === 'story') current?.scene.advance?.();
  else location.hash = cityHash('CO');
});
let replayEndSec = -1;
function freeReplayOnward(): void {
  if (route.kind !== 'scene' || route.name !== 'replay') {
    if (route.kind !== 'story' && document.body.classList.contains('onward')) setOnward(0, 0, null);
    replayEndSec = -1;
    return;
  }
  const box = current?.layer.querySelector<HTMLElement>('.rp');
  const dur = (window as { __sayrReplay?: { duration: number } }).__sayrReplay?.duration;
  const ended = !!box && dur !== undefined && box.dataset['beat'] === 'proof' && Number(box.dataset['sigma']) >= dur - 0.02;
  if (!ended) {
    replayEndSec = -1;
    if (document.body.classList.contains('onward')) setOnward(0, 0, null);
    return;
  }
  const now = clock.seconds();
  if (replayEndSec < 0) {
    replayEndSec = now;
    onwardAt = box.querySelector('.rp-proof')?.getBoundingClientRect() ?? null;
  }
  const u = (now - replayEndSec - 1.4) / 1.0;
  setOnward(reducedMotion ? (u > 0 ? 1 : 0) : u, 1, null);
}

// ----- the one frame loop -----
// Every part of a frame runs on its own: one that throws is reported once and the loop carries on (the clock
// isolates each scene's frame listener the same way, src/app/clock.ts).
const reported = new Set<string>();
const safely = (what: string, fn: () => void): void => {
  try {
    fn();
  } catch (e) {
    const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    if (!reported.has(msg)) {
      reported.add(msg);
      console.error(msg, e);
    }
  }
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let lastHourText = '';
/**
 * The chrome's hour: the clock's time in the city, or, when the city's forecast does not reach the clock's time
 * (the scene marks data-forecast-of), the date of the forecast shown, so an old forecast never reads as now.
 */
function chromeHour(): void {
  const id = chromeCity();
  if (!id) return;
  const layer = current?.layer;
  const cityEl = layer?.classList.contains('city') ? layer : layer?.querySelector<HTMLElement>('.city');
  const of = cityEl?.dataset['forecastOf'];
  let text: string;
  const shown = cityEl?.dataset['shown'];
  if (of) {
    const p = localParts(Date.parse(of), CITIES[id].zone);
    text = `forecast ${p.day} ${MONTHS[p.month - 1]!}`;
  } else if (shown) text = formatDayTime(Date.parse(shown), CITIES[id].zone);
  else text = formatClock(clock.ms(), CITIES[id].zone);
  if (text !== lastHourText) {
    hourEl.textContent = text;
    hourEl.classList.toggle('dated', !!of);
    // a dated corner is never covered: while "tap a stream" shows, the links give way instead (styles.css)
    if (of) document.body.dataset['dated'] = '';
    else delete document.body.dataset['dated'];
    lastHourText = text;
    if (!userTheme && forcedTheme === null) theme.set(sunTheme());
  }
}
const loop = (): void => {
  requestAnimationFrame(loop);
  safely('clock', () => clock.frame(Date.now()));
  safely('hour', chromeHour);
  safely('crossfade', crossfades);
  safely('onward', freeReplayOnward);
};
// ----- the page's first paint (index.html #first): the story's first line, until a chapter's scene is drawing -----
let first = document.querySelector<HTMLElement>('#first');
let firstGone = 0;
function firstPaint(now: number): void {
  if (!first) return;
  const failed = document.body.dataset['ready'] === 'failed';
  if (failed) {
    first.classList.add('failed');
    first.querySelector<HTMLButtonElement>('.retry')?.removeAttribute('hidden');
    return;
  }
  // the live opening is drawing the same stream (the story's city is ready), or another route is on screen
  const drawing = current !== null && (route.kind === 'story' ? current.layer.querySelector('.story-layer[data-ready="true"], .story-layer [data-ready="true"]') !== null : layerDrawing(current.layer));
  if (!drawing) return;
  if (!firstGone) firstGone = now;
  const a = reducedMotion ? 0 : 1 - smooth((now - firstGone) / 0.35);
  first.style.opacity = a.toFixed(3);
  if (a <= 0) {
    first.remove();
    first = null;
  }
}
first?.querySelector<HTMLButtonElement>('.retry')?.addEventListener('click', () => location.reload());

function crossfades(): void {
  const now = clock.seconds();
  firstPaint(now);
  // cross-fades between routes
  for (let i = retiring.length - 1; i >= 0; i--) {
    const r = retiring[i]!;
    if (r.fadeFrom === null && (layerDrawing(r.next.layer) || now - r.since > 15 || reducedMotion)) r.fadeFrom = now;
    if (r.fadeFrom === null) continue;
    const u = reducedMotion ? 1 : smooth((now - r.fadeFrom) / CROSSFADE);
    r.next.layer.style.opacity = u >= 1 ? '' : u.toFixed(3);
    r.live.layer.style.opacity = (1 - u).toFixed(3);
    if (u >= 1) {
      retiring.splice(i, 1);
      dispose(r.live);
    }
  }
  // the tagline on a first visit to a city, until its streams draw in
  if (firstTagline) {
    const ft = firstTagline;
    const shown = now - ft.from;
    if (ft.drawingAt === null && layerDrawing(ft.layer)) ft.drawingAt = shown;
    // never shown when the streams drew first; else it holds 1.2 s so it can be read, then fades as they draw in
    const skipped = ft.drawingAt !== null && ft.drawingAt <= 0;
    // under reduced motion it gives way at once when the streams draw (a still frame, never two at once)
    const a =
      ft.layer !== current?.layer || skipped || (reducedMotion && ft.drawingAt !== null)
        ? 0
        : ft.drawingAt === null
          ? reducedMotion
            ? 1
            : smooth(shown / 0.5)
          : 1 - smooth((shown - Math.max(ft.drawingAt, 1.2)) / 0.7);
    tagline.style.opacity = a.toFixed(3);
    tagline.style.visibility = a > 0.02 ? 'visible' : 'hidden';
    // the city's name and links wait for the tagline to go
    place.style.opacity = elsewhere.style.opacity = (1 - a).toFixed(3);
    if (a <= 0.02 && (ft.drawingAt !== null || ft.layer !== current?.layer)) {
      firstTagline = null;
      place.style.opacity = elsewhere.style.opacity = '';
    }
  }
}
requestAnimationFrame(loop);
