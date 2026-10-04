// The contract every scene implements. The shell (src/app/) owns routing, the clock, the theme and the data;
// a scene owns only the DOM under the root it is given.
//
// Adding a scene: create src/scenes/<route>/index.ts with `export default function createScene(): Scene`.
// The shell finds it with import.meta.glob and mounts it at `#/<route>` (for example `#/replay`,
// `#/dark-hours`); nothing else needs editing. The map scene (`#/city/<id>`, `#/city/<id>/stream/<id>`)
// is the shell's own.
//
// Stability: this file only grows. New SceneContext members are optional or additive; nothing is renamed.
import type { Loaders } from '../data/loaders';
import type { CityId } from '../data/schemas';
import type { CanvasText } from '../format/canvasText';

export type Theme = 'night' | 'day';

/**
 * The one app clock. Every animation and every "now" in scene logic reads it; no raw Date.now(),
 * performance.now() or rAF timestamps. `?t=<ISO>` pins it, `?t=<ISO>&rate=<x>` runs it from there at x
 * times real speed, and `window.__sayrClock.set(date)` / `.step(ms)` drive it frame by frame for film renders.
 */
export interface SceneClock {
  /** The current app time. */
  now(): Date;
  /** The current app time in epoch milliseconds (same instant as now()). */
  ms(): number;
  /** Seconds of animation time since the app started; use it for loops (flow, fog drift, pulses). */
  seconds(): number;
  /** True when the clock does not advance on its own (a `?t=` without rate, or a film render). */
  readonly pinned: boolean;
  /** Called on every app frame with the clock time; returns an unsubscribe function. Use it instead of rAF. */
  onFrame(fn: (t: Date) => void): () => void;
}

export interface ThemeHandle {
  get(): Theme;
  /** Called when the theme changes; returns an unsubscribe function. */
  subscribe(fn: (theme: Theme) => void): () => void;
}

export interface SceneContext {
  /** Typed, schema-checked loaders for every file in sayr/data/out (served from /data/). */
  readonly data: Loaders;
  readonly clock: SceneClock;
  readonly theme: ThemeHandle;
  /**
   * Registers words drawn on a canvas for the word budget and number provenance checks
   * (`{ text, num?, fmt?, time?, src? }`); pass null to clear the id when the text leaves the screen.
   * `src` is a `<file>#<json pointer>` reference, for example `replay_2024-09-23.json#/samples/3/ecoli_per_100ml`.
   */
  registerCanvasWords(id: string, entry: CanvasText | null): void;
  /** True under prefers-reduced-motion: draw still frames that carry the same information. */
  readonly reducedMotion: boolean;
  /** The city currently selected in the shell (Coimbra by default). */
  readonly city: CityId;
  /** Route segments after the scene name, for example `#/replay/2023-07-10` gives ['2023-07-10']. */
  readonly params: readonly string[];
  /**
   * Navigates to another route, for example ctx.navigate('#/city/CO'). `replace` corrects the link in place
   * (no history entry, no remount): for a link the scene cannot show, such as an unknown stream.
   */
  navigate(hash: string, opts?: { readonly replace?: boolean }): void;
  /**
   * Optional: true while the scene plays inside story mode (#/story), where the story drives it. It turns false
   * when the story hands the scene over to free exploration, so read it when you need it.
   */
  readonly story?: boolean;
}

export interface Scene {
  mount(root: HTMLElement, ctx: SceneContext): void;
  unmount(): void;
  /** Optional: jump the scene to a clock time (film renders and scrubbing call it). */
  setTime?(t: Date): void;
  /**
   * Optional: plays a named moment of the scene's own script and resolves once it is on screen (story mode calls
   * it; the city knows 'unroll' and 'quest'). Resolves false when the scene cannot play that moment now.
   */
  cue?(name: string): Promise<boolean>;
  /**
   * Optional: the hash changed to another route of this same scene while it is mounted (a link, back or
   * forward), for example #/replay to #/replay/timetable; `params` are the new route segments after the
   * scene's name. Without it the scene stays as it is. The shell calls it instead of mounting the scene again.
   */
  route?(params: readonly string[]): void;
  /**
   * Optional: the viewer holds the scene (true while an FHIR x-ray card is open over it, false when it closes).
   * A scene that plays on its own clock stops where it is and plays on after, so the card and the thing it turned
   * over stay in step; a scene that was paused stays paused. The replay implements it.
   */
  hold?(held: boolean): void;
  /**
   * Optional: the narration story mode shows on one of its beats when the line comes from the scene's own data
   * (the city's person's sentence and its sampling request), as DOM with every number bound to its source; null
   * when the scene has nothing to say there yet.
   */
  narrate?(beat: string): Node[] | null;
}

export type SceneFactory = () => Scene;
