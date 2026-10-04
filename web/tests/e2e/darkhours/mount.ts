// A stand-in shell for the dark-hours scene's own tests, written to the contract in src/scenes/types.ts:
// the shell's clock, the data loaders, the theme, and navigate. The real shell (src/app/) replaces it; the scene code is the same.
import { DATA_BASE_URL, httpSource, loaders } from '../../../src/data/loaders';
import createScene from '../../../src/scenes/darkhours/index';
import { clockOptionsFromQuery, createClock } from '../../../src/app/clock';
import type { SceneContext, Theme } from '../../../src/scenes/types';

const q = new URLSearchParams(location.search);
// The shell's own clock, so ?t=, &rate=, ?clock=manual and window.__sayrClock behave exactly as in the app.
const clock = createClock(clockOptionsFromQuery(location.search), () => Date.now());
(window as unknown as { __sayrClock: unknown }).__sayrClock = clock.control;
const loop = (): void => {
  clock.frame(Date.now());
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

let theme: Theme = q.get('theme') === 'day' ? 'day' : 'night';
const themeSubs = new Set<(t: Theme) => void>();

const root = document.querySelector<HTMLElement>('#app')!;
// ?story=1 stands in for story mode: the scene is told it plays inside the story, and a request to leave is only
// recorded (story mode never hands the dark hours to the city; it crosses into the replay itself)
const story = q.get('story') === '1';
const navigated: string[] = [];
(window as unknown as { __navigated: string[] }).__navigated = navigated;
const params = location.hash.replace(/^#\/?/, '').split('/').slice(1).filter(Boolean);
const scene = createScene();
const ctx: SceneContext = {
  data: loaders(httpSource(DATA_BASE_URL)),
  clock,
  theme: {
    get: () => theme,
    subscribe(fn) {
      themeSubs.add(fn);
      return () => themeSubs.delete(fn);
    },
  },
  registerCanvasWords() {},
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  city: 'CO',
  params,
  navigate(hash) {
    if (story) {
      navigated.push(hash);
      return;
    }
    // As the shell does: the hash changes and the scene is unmounted.
    scene.unmount();
    location.hash = hash;
  },
  story,
};
(window as unknown as { __dhScene: typeof scene }).__dhScene = scene;
(window as unknown as { __setTheme: (t: Theme) => void }).__setTheme = (t) => {
  theme = t;
  for (const fn of themeSubs) fn(t);
};
scene.mount(root, ctx);
