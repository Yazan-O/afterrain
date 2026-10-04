// The stream's one line (spec section 2, "The stream speaks"). A pure function of the stream's state timeline:
// it never invents a number, never says "safe", says so when the stream has not been measured, and stays within
// MAX_WORDS words so the strip keeps to its word budget.
//
// What it may claim, and from what:
//   "rain"             only when the rain forecast for the 48 hours before that hour reaches WET_MM (median of the
//                      ensemble members at the stream's forecast cell): a raised guess on a dry day (after an "over
//                      900" test sample) is said as running high without rain, never as carrying rain.
//   "nobody measured"  from OneAquaHealth's own sampling of the stream's sites (nowcast oah_sampled_after_rain):
//                      "after rain" only when none of its sites was sampled after rain; "yet" only when none was
//                      sampled at all; a stream sampled after rain says that one sample is too few to tell.
//   "now"              relative words (tonight, tomorrow) only when the timeline starts at the real now; a dated
//                      forecast (the forecast no longer reaches the clock) names days.
import { localParts } from '../engine/timefmt';
import type { FogState } from '../engine/fog';
import type { Guess } from './alongStream';

export const MAX_WORDS = 13;
/** Rain (mm over the 48 hours before an hour) from which the stream is said to carry rain. */
export const WET_MM = 1;

export interface Moment {
  /** UTC epoch ms of the hour. */
  readonly ms: number;
  /** What the app can say: usual, higher, high, or unknown when the fog is too thick. */
  readonly state: FogState;
  /** The model's best guess, whatever the fog. */
  readonly guess: Guess;
  /** Rain forecast for the 48 hours before the hour, mm (median over the members; the wettest station). */
  readonly rainMm: number;
}

/** OneAquaHealth's sampling of a stream's sites: some after rain, only in dry weather, or never. */
export type Sampled = 'after-rain' | 'dry-only' | 'never';

/** From the sites' oah_sampled_after_rain flags (true, false, or null for a site with no sample). */
export function sampledOf(flags: readonly (boolean | null | undefined)[]): Sampled {
  if (flags.some((f) => f === true)) return 'after-rain';
  if (flags.some((f) => f === false)) return 'dry-only';
  return 'never';
}

const RANK: Record<Guess, number> = { usual: 0, higher: 1, high: 2 };
const raised = (g: Guess): boolean => RANK[g] >= 1;
const wet = (m: Moment): boolean => m.rainMm >= WET_MM;

/**
 * A stream's timeline from its stations: per hour, the best guess is the worst station guess; the state is the
 * worst state among the stations that are known, unless a station still unknown guesses worse than that (or no
 * station is known): then it is "unknown", so a known calm station never speaks for a raised one nobody measured.
 * The rain is the wettest station's.
 */
export function streamMoment(ms: number, stations: readonly { state: FogState; guess: Guess; rainMm: number }[]): Moment {
  let guess: Guess = 'usual';
  let known: Guess | null = null;
  let unknownGuess = -1;
  let rainMm = 0;
  for (const s of stations) {
    if (RANK[s.guess] > RANK[guess]) guess = s.guess;
    if (s.state !== 'unknown') {
      if (known === null || RANK[s.state] > RANK[known]) known = s.state;
    } else unknownGuess = Math.max(unknownGuess, RANK[s.guess]);
    rainMm = Math.max(rainMm, s.rainMm);
  }
  const state: FogState = known === null || unknownGuess > RANK[known] ? 'unknown' : known;
  return { ms, state, guess, rainMm };
}

type Part = 'morning' | 'afternoon' | 'evening' | 'night';
const partOf = (hour: number): Part => (hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 21 ? 'evening' : 'night');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The local calendar day a moment belongs to: the small hours (before 05:00) belong to the night before. */
function dayKey(ms: number, zone: string): { key: string; weekday: number } {
  const p = localParts(ms, zone);
  const q = p.hour < 5 ? localParts(ms - 6 * 3.6e6, zone) : p;
  return { key: `${q.year}-${q.month}-${q.day}`, weekday: q.weekday };
}

/**
 * "tonight", "this afternoon", "tomorrow morning", "Wednesday evening": when `ms` falls, seen from `nowMs`.
 * `dated` (a forecast that no longer reaches the clock) always names the day: "Saturday night".
 */
export function whenPhrase(ms: number, nowMs: number, zone: string, dated = false): string {
  const part = partOf(localParts(ms, zone).hour);
  const d = dayKey(ms, zone);
  if (!dated) {
    if (d.key === dayKey(nowMs, zone).key) return part === 'night' ? 'tonight' : `this ${part}`;
    if (d.key === dayKey(nowMs + 24 * 3.6e6, zone).key) return `tomorrow ${part}`;
  }
  return `${WEEKDAYS[d.weekday]} ${part}`;
}

const UNMEASURED: Record<Sampled, string> = {
  never: 'Nobody has measured me yet.',
  'dry-only': 'Nobody has measured me after rain.',
  'after-rain': 'Too few rain samples to tell.',
};

export interface SentenceOptions {
  /** OneAquaHealth's sampling of the stream's sites. */
  readonly sampled: Sampled;
  /** The timeline starts at a forecast's own first hour, not at the clock: name days, never "tonight". */
  readonly dated?: boolean;
}

/** The stream's sentence for a timeline that starts at "now" (timeline[0]). */
export function streamSentence(timeline: readonly Moment[], zone: string, opts: SentenceOptions): string {
  const now = timeline[0];
  if (!now) throw new Error('streamSentence needs at least the current hour');
  const firstRaised = timeline.findIndex((m) => raised(m.guess));
  const rainAt = raised(now.guess) ? -1 : timeline.findIndex((m) => raised(m.guess) && wet(m));
  const when = (i: number): string => whenPhrase(timeline[i]!.ms, now.ms, zone, opts.dated);
  const why = UNMEASURED[opts.sampled];

  if (now.state === 'unknown') {
    if (raised(now.guess)) return wet(now) ? `I may be carrying rain. ${why} Can you?` : 'I may be running high, even without rain. Can you check?';
    if (rainAt > 0) return `Rain reaches me ${when(rainAt)}. ${why} Can you?`;
    if (firstRaised > 0) return `Probably my usual self. I may run high ${when(firstRaised)}.`;
    return `Probably my usual self. ${why} Can you?`;
  }
  if (now.state !== 'usual') {
    const end = timeline.findIndex((m, i) => i > 0 && !raised(m.guess));
    const lead = wet(now) ? "I'm carrying rain." : "I'm running high, even without rain.";
    if (end < 0) return `${lead} Keep dogs out until at least ${WEEKDAYS[localParts(timeline[timeline.length - 1]!.ms, zone).weekday]}.`;
    return `${lead} Keep dogs out until ${when(end)}.`;
  }
  if (rainAt > 0) {
    return timeline[rainAt]!.state === 'unknown'
      ? `Usual for now. Rain reaches me ${when(rainAt)}. Nobody has measured that.`
      : `Usual for now. Rain reaches me ${when(rainAt)}.`;
  }
  if (firstRaised > 0) return `Usual for now. I may run high ${when(firstRaised)}.`;
  return "I'm my usual self.";
}

/**
 * The line for one hour of the strip, as the viewer scrubs to it, in the stream's own voice: `when` ("Wednesday
 * 18:00", drawn as a time) and what that hour means ("Rain is running through me. Keep dogs out."). `before` is
 * the moment a few hours earlier: the hour a raised guess falls back is said as clearing, the hour it rises as
 * arriving. "Rain" only with rain at the hour (WET_MM); certainty words follow the state (unknown says "probably"
 * or "may"). Within MAX_WORDS with the when.
 */
export function hourSentence(m: Moment, zone: string, before?: Moment): { when: string; text: string } {
  const p = localParts(m.ms, zone);
  const when = `${WEEKDAYS[p.weekday]} ${String(p.hour).padStart(2, '0')}:00`;
  const sure = m.state !== 'unknown';
  const dogs = m.guess === 'high' ? 'Keep dogs out.' : 'Keep dogs on the bank.';
  let text: string;
  if (raised(m.guess)) {
    const arriving = before !== undefined && !raised(before.guess);
    if (wet(m)) text = sure ? `${arriving ? 'The rain is arriving.' : 'Rain is running through me.'} ${dogs}` : `${arriving ? 'The rain may be arriving.' : 'Rain may be running through me.'} ${dogs}`;
    else text = sure ? `I'm running high. ${dogs}` : `I may be running high. ${dogs}`;
  } else if (before !== undefined && raised(before.guess)) text = sure ? "I'm clearing. My usual self again." : "I'm clearing. Probably my usual self again.";
  else if (sure) text = wet(m) ? 'Some rain in me, still my usual self.' : 'My usual self.';
  else text = wet(m) ? 'Some rain in me. Probably still my usual self.' : 'Probably my usual self.';
  return { when, text };
}

/**
 * The line after a test reading, from the estimate at the tested place and hour before and after
 * the recompute: it falls, rises or holds (a change under half a point), and "Storm hours remain uncertain." while
 * any of the displayed storm hours (after rain, or raised before the test) is still unknown at the place.
 */
export function testResultLine(before: number, after: number, stormUnsure: boolean): string {
  const d = after - before;
  const head = Math.abs(d) < 0.005 ? 'My estimate holds here.' : d < 0 ? 'My estimate falls here.' : 'My estimate rises here.';
  return stormUnsure ? `${head} Storm hours remain uncertain.` : head;
}
