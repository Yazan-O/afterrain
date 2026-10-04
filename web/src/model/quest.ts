// The quest's ask (spec W5, the tagline "AfterRain watches the storms"): one full sentence that names the site and the
// storm window, from the nowcast's quest fields (pipeline/nowcast.py):
//   when_local            the window as the site's local weekday and part of day ("Wednesday afternoon",
//                         "Wednesday morning to afternoon", "Wednesday daytime" for the whole sampling day)
//   after_rain            that hour follows the forecast rain (the sentence says "after the rain" only then)
//   tied_with             the other sites whose sample would clear exactly as much fog (quest #1 then says it is
//                         one of the samples with the largest expected fog reduction, never the one)
//   window_rain_mm_p50    the rain forecast inside the window (read by the strip, not said)
// "Sample Vale das Flores on Wednesday afternoon, after the rain. Its sample brings the largest expected fog reduction."
// A forecast that no longer reaches the clock is dated ("Forecast of 26 Sep: ...").
import { formatClock, formatDayMonth, formatZone, localParts } from '../engine/timefmt';

export interface QuestFields {
  readonly when_local: string;
  readonly after_rain: boolean;
  readonly tied_with: readonly string[];
  readonly window_rain_mm_p50: number;
}

/** One run of the sentence: plain words, the site's name, or a time (drawn with data-time). */
export interface QuestPart {
  readonly text: string;
  readonly kind: 'text' | 'site' | 'time';
}

export interface QuestAsk {
  readonly site: string;
  /** Its rank in the nowcast: 0 is the city's quest #1. */
  readonly rank: number;
  /** The site code of the city's quest #1 (a quest tied with it clears as much fog). */
  readonly firstCode: string;
  readonly fields: QuestFields;
  readonly zone: string;
  /** The forecast no longer reaches the clock: `forecastMs` is when it was fetched. */
  readonly dated: boolean;
  readonly forecastMs: number;
}

/** What one sample does, by the nowcast's objective (expected fog reduction): the largest for quest #1 and the quests tied with it (said as a tie), else some. */
export function questClaim(q: Pick<QuestAsk, 'rank' | 'firstCode' | 'fields'>): string {
  const most = q.rank === 0 || q.fields.tied_with.includes(q.firstCode);
  return !most ? 'A sample here is expected to reduce the fog.' : q.fields.tied_with.length > 0 ? 'One of the samples with the largest expected fog reduction.' : 'Its sample brings the largest expected fog reduction.';
}

export function questParts(q: QuestAsk): QuestPart[] {
  const w = q.fields.when_local.trim();
  if (!/^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day( |$)/.test(w)) throw new Error(`quest when_local is not a weekday and part of day: ${JSON.stringify(w)}`);
  // the whole sampling day is said as the day itself
  const when = w.replace(/ daytime$/, '');
  const out: QuestPart[] = [];
  if (q.dated) out.push({ text: 'Forecast of ', kind: 'text' }, { text: formatDayMonth(q.forecastMs, q.zone), kind: 'time' }, { text: ': ', kind: 'text' });
  out.push({ text: 'Sample ', kind: 'text' }, { text: q.site, kind: 'site' });
  out.push({ text: ' on ', kind: 'text' }, { text: when, kind: 'time' });
  out.push({ text: q.fields.after_rain ? ', after the rain. ' : '. ', kind: 'text' });
  out.push({ text: questClaim(q), kind: 'text' });
  return out;
}

export const questText = (q: QuestAsk): string => questParts(q).map((p) => p.text).join('');

const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The quest's sampling window in the place's time, with its zone: "Mon 28 Sep 08:00–20:00 UTC+1" (the end's
 * day when it differs: "Mon 28 Sep 20:00–Tue 29 Sep 08:00 UTC+1").
 */
export function windowText(startMs: number, endMs: number, zone: string): string {
  const a = localParts(startMs, zone);
  const b = localParts(endMs, zone);
  const day = (p: typeof a, ms: number): string => `${DAY3[p.weekday]} ${formatDayMonth(ms, zone)}`;
  const same = a.year === b.year && a.month === b.month && a.day === b.day;
  return `${day(a, startMs)} ${formatClock(startMs, zone)}–${same ? '' : `${day(b, endMs)} `}${formatClock(endMs, zone)} ${formatZone(startMs, zone)}`;
}

/**
 * The window for a screen that already shows its date (a dated forecast's corner, "forecast 2 Oct"): the times and
 * the zone alone when the window starts on that day ("15:00–20:00 UTC+1"); within the six days after it, the
 * weekday, the times and the zone ("Sun 08:00–20:00 UTC+1", the end's weekday when it differs: a weekday is unique
 * there, and the rest screen's words stay few); else in full.
 */
export function windowTextAfterDate(startMs: number, endMs: number, zone: string, dayMs: number): string {
  const a = localParts(startMs, zone);
  const d = localParts(dayMs, zone);
  const b = localParts(endMs, zone);
  const sameStart = a.year === d.year && a.month === d.month && a.day === d.day;
  const sameEnd = a.year === b.year && a.month === b.month && a.day === b.day;
  const t = (ms: number): string => formatClock(ms, zone);
  if (sameStart && sameEnd) return `${t(startMs)}–${t(endMs)} ${formatZone(startMs, zone)}`;
  const days = (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(d.year, d.month - 1, d.day)) / 864e5;
  if (days < 1 || days > 6) return windowText(startMs, endMs, zone);
  return `${DAY3[a.weekday]} ${t(startMs)}–${sameEnd ? '' : `${DAY3[b.weekday]} `}${t(endMs)} ${formatZone(startMs, zone)}`;
}

/**
 * When a sample's result is ready: the hour it is collected at (the hour the strip offers, or the one entered),
 * plus the lab's turnaround (pipeline/config.py LAB_TURNAROUND_H, carried in every quest as lab_turnaround_h).
 * `inForecast` is false when that instant lies past the last hour the forecast shows: the screen says "after
 * forecast" and never draws it at the forecast's end.
 */
export function resultTiming(collectMs: number, turnaroundH: number, lastHourMs: number): { readonly readyMs: number; readonly inForecast: boolean } {
  const readyMs = collectMs + turnaroundH * 3.6e6;
  return { readyMs, inForecast: readyMs <= lastHourMs };
}

/**
 * A quest's window is open for sampling while the clock is before its end: just before the end it is still the
 * recommendation, and at the end itself it is gone (the map's lamp and the story's last screen read this).
 */
export const windowOpen = (nowMs: number, endMs: number): boolean => nowMs < endMs;

/**
 * The next eligible sampling site: the first quest in the nowcast's rank order whose window is still open at
 * `nowMs`, that has not been sampled on screen, and that the scene can show (`shown`); null when none is left.
 */
export function nextQuest<Q extends { readonly code: string; readonly endMs: number }>(quests: readonly Q[], nowMs: number, sampled: ReadonlySet<string>, shown: (q: Q) => boolean): Q | null {
  return quests.find((q) => !sampled.has(q.code) && windowOpen(nowMs, q.endMs) && shown(q)) ?? null;
}

/** One round of requests: the saved quests (round 0, from the forecast's first hour) or a later round. */
export interface Round<Q> {
  readonly fromMs: number;
  readonly quests: readonly Q[];
}

/**
 * Which round of requests the scene offers at `nowMs` (pipeline/nowcast.py FOURTH DATED CHANGE): the saved quests
 * while one of them is eligible (window open, not sampled on screen, shown); otherwise the round that starts latest
 * at or before the clock, then the later ones, the first with an eligible quest. -1 when no round has one: the
 * forecast's remaining hours hold no request, and the screen falls back to the saved quests, dated.
 */
export function activeRound<Q extends { readonly code: string; readonly endMs: number }>(
  rounds: readonly Round<Q>[],
  nowMs: number,
  sampled: ReadonlySet<string>,
  shown: (q: Q) => boolean,
): number {
  const ok = (r: Round<Q>): boolean => nextQuest(r.quests, nowMs, sampled, shown) !== null;
  if (rounds.length > 0 && ok(rounds[0]!)) return 0;
  let from = 1;
  for (let i = 1; i < rounds.length; i++) if (rounds[i]!.fromMs <= nowMs) from = i;
  for (let i = from; i < rounds.length; i++) if (ok(rounds[i]!)) return i;
  return -1;
}

/**
 * The hour the story's opening asks for and tests ("Sample me here, after rain"): the quest's own
 * best hour when the pipeline says it follows rain; otherwise, among the strip's hours whose rain over the 48 hours
 * before reaches `wetMm` at the site (the sentence's rain rule), the one with the highest estimate (the earliest of
 * a tie). With no such hour it is the quest's hour, and the opening does not say "after rain".
 */
export function openingHour(o: {
  readonly questHour: number;
  readonly questAfterRain: boolean;
  readonly from: number;
  readonly to: number;
  readonly rainMm: (h: number) => number;
  readonly p50: (h: number) => number;
  readonly wetMm: number;
}): { readonly hour: number; readonly afterRain: boolean; readonly rule: 'quest' | 'after-rain' | 'no-rain' } {
  if (o.questAfterRain) return { hour: o.questHour, afterRain: true, rule: 'quest' };
  let best = -1;
  for (let h = o.from; h <= o.to; h++) if (o.rainMm(h) >= o.wetMm && (best < 0 || o.p50(h) > o.p50(best))) best = h;
  return best >= 0 ? { hour: best, afterRain: true, rule: 'after-rain' } : { hour: o.questHour, afterRain: false, rule: 'no-rain' };
}
