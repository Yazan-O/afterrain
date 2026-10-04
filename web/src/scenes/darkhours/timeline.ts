// The scene's script in seconds. Every frame is a pure function of the scene time T, so a film render that
// steps the app clock, a deep link to a beat, and a reload at the same clock all draw the same pixels.

export const BEATS = ['fall', 'line', 'cities', 'storm', 'end'] as const;
export type Beat = (typeof BEATS)[number];

export const AXIS_IN = 0.2;
/**
 * OneAquaHealth's drops start falling: three one by one, then the rest as a shower, all landed by 3.75 s, so the
 * line (the hook) is up about 4 s in (about 8 s into the story, after its tagline).
 */
export const FALL_AT = 0.35;
/** Seconds from the top of the screen to the heap. */
export const FALL_DUR = 0.85;
export const LINE_IN = 4.0;
export const LINE_OUT = 10.3;
export const CITY_GO = 10.6;
export const CITY_LABELS = 11.8;
export const CITY_OUT = 16.8;
export const REGROUP = 17.0;
/** The Garonne's drops start falling. */
export const OPEN_AT = 18.6;
/** The three lines of numbers, one at a time: [in, out]. */
export const NUM_LINES: readonly (readonly [number, number])[] = [
  [25.8, 29.0],
  [29.2, 32.0],
  [32.2, 34.4],
];
export const HANDOFF = 34.6;
/**
 * The scene asks for the city once its last words have gone and the storm side's fog has spread over most of
 * the screen. It keeps drawing while the city loads (the fog fills the screen and holds there, drifting), so the
 * shell's cross-fade always goes from fog to the map, never through a dark screen, however fast the city is.
 */
export const NAVIGATE_AT = HANDOFF + 1.4;
/** The fog push-in: it starts with the hand-off and has filled the screen by FOG_FULL. */
export const FOG_FULL = HANDOFF + 2.2;
/** Glide time of a drop between beats, and the spread of start times that makes the move organic. */
export const GLIDE = 1.35;
export const GLIDE_SPREAD = 0.45;

export const BEAT_START: Record<Beat, number> = { fall: 0, line: LINE_IN - 0.2, cities: CITY_GO, storm: REGROUP, end: HANDOFF };
/** A moment in each beat where everything the beat says is on screen (screenshots and film stills). */
export const SETTLED: Record<Beat, number> = { fall: 3.76, line: 9.0, cities: 14.1, storm: 27.4, end: HANDOFF + 0.35 };
/**
 * Where a deep link (#/dark-hours/<beat>) or an in-page route change starts: the beat's own start, so the
 * viewer sees it happen (#/dark-hours/fall is the fall from the top, never the line that follows it).
 */
export const startOf = (beat: Beat): number => BEAT_START[beat];
/** The beat a viewer lands on when they come back to the scene after its hand-off to the city. */
export const RETURN_BEAT: Beat = 'storm';

/**
 * For story mode's dark chapter (src/app/story.ts): the Garonne beat starts at GARONNE_AT (the scene's 'storm'
 * beat, where the five cities fold back into one ground), its drops land from OPEN_AT, the storm side's fog thins
 * where they land, and the last line of numbers has gone by NUM_LINES[2][1]; the chapter can end at HANDOFF, when
 * the fog starts to fill the screen. The scene also plays cue('garonne') (or any beat name) by jumping there.
 */
export const GARONNE_AT = REGROUP;

export const beatAt = (T: number): Beat => {
  let b: Beat = 'fall';
  for (const k of BEATS) if (T >= BEAT_START[k]) b = k;
  return b;
};

/**
 * Reduced motion: the scene still moves through its beats, but each stretch shows one still frame that
 * carries everything that stretch says (no falling, no gliding, no drift).
 */
export const STILLS: readonly { readonly from: number; readonly at: number }[] = [
  { from: 0, at: SETTLED.fall },
  { from: BEAT_START.line, at: SETTLED.line },
  { from: BEAT_START.cities, at: SETTLED.cities },
  { from: BEAT_START.storm, at: NUM_LINES[0]![0] + 1.4 },
  { from: NUM_LINES[1]![0], at: NUM_LINES[1]![0] + 1.2 },
  { from: NUM_LINES[2]![0], at: NUM_LINES[2]![0] + 1.4 },
  { from: HANDOFF, at: FOG_FULL + 0.3 },
];

export const stillFor = (T: number): number => {
  let at = STILLS[0]!.at;
  for (const s of STILLS) if (T >= s.from) at = s.at;
  return at;
};

/**
 * Start times of a fall: the first `slow` drops one by one, then the gaps shrink geometrically to `floor`
 * (the rush).
 */
export function fallStarts(n: number, t0: number, slow: number, slowGap: number, g0: number, decay: number, floor: number): Float64Array {
  const out = new Float64Array(n);
  let t = t0;
  for (let i = 0; i < n; i++) {
    out[i] = t;
    t += i < slow ? slowGap : Math.max(floor, g0 * decay ** (i - slow));
  }
  return out;
}

export const oahFall = (n: number): Float64Array => fallStarts(n, FALL_AT, 3, 0.33, 0.13, 0.86, 0.009);
export const openFall = (n: number): Float64Array => fallStarts(n, OPEN_AT, 4, 0.5, 0.2, 0.85, 0.025);

// Easing ------------------------------------------------------------------------------------------

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const ramp = (T: number, a: number, b: number): number => clamp01((T - a) / (b - a));
export const smooth = (u: number): number => u * u * (3 - 2 * u);
export const easeInOut = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
/** 0 before `a`, fades in over `dur`, holds, fades out from `b` over `dur`. */
export const window01 = (T: number, a: number, b: number, dur = 0.7): number => smooth(ramp(T, a, a + dur)) * (1 - smooth(ramp(T, b, b + dur)));

/** A stable pseudo-random number in [0, 1) for an integer seed (no Math.random: frames must repeat). */
export const hash01 = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
