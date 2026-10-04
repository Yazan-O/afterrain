// The stream's first line for a person standing at it (a parent, a dog owner): the place, the day, the chance in
// words, why, and what to do until when. A pure function of one place's forecast hours, so it is unit-tested on
// real nowcast rows (tests/unit/humanSentence.test.ts).
//
//   risk     "usual" / "higher" / "high" from the nowcast's own thresholds on the chance (the best guess, fog or
//            not); never "safe"
//   episode  the first hour at or after the clock whose chance is over the "higher" threshold, to the first hour
//            after it whose chance is back at or below it; its word is the highest it reaches
//   reason   "after rain" when the 48-hour rain forecast before the episode's first hour reaches WET_MM, else "even
//            without rain"
//   action   "Keep dogs out until <first hour back at or below the threshold>"; when it never drops back within the
//            forecast, "until the forecast ends <date>"; no episode at all: "Usual chance today."
//   fog      "Nobody has measured here after rain." when OneAquaHealth never sampled the place after rain
import { formatDayMonth, localParts } from '../engine/timefmt';
import { WET_MM } from './sentence';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 864e5;

export interface HumanInput {
  /** The place's readable name ("Eiras"). */
  readonly place: string;
  readonly zone: string;
  /** The clock (UTC ms). */
  readonly nowMs: number;
  /** The forecast's hours (UTC ms), and per hour the chance over 900 at the place and the 48-hour rain before it (mm). */
  readonly hoursMs: readonly number[];
  readonly p: ArrayLike<number>;
  readonly rainMm: ArrayLike<number>;
  readonly thresholds: { readonly higher: number; readonly high: number };
  /** OneAquaHealth never sampled this place after rain. */
  readonly unmeasuredAfterRain: boolean;
}

/** A run of the sentence; `ms` marks a time (shown as a data-time element). */
export interface Piece {
  readonly text: string;
  readonly ms?: number;
}

export interface Human {
  readonly risk: 'usual' | 'higher' | 'high';
  /** The first sentence (place, day, risk, reason, action). */
  readonly lead: readonly Piece[];
  /** "Nobody has measured here after rain." or nothing. */
  readonly fog: string | null;
  /** Hour indices of the episode: its first hour and the hour it drops back (null: not within the forecast). */
  readonly from: number | null;
  readonly until: number | null;
  /** The whole line as text. */
  readonly text: string;
}

const hh = (ms: number, zone: string): string => `${String(localParts(ms, zone).hour).padStart(2, '0')}:00`;

export function humanSentence(x: HumanInput): Human {
  const n = x.hoursMs.length;
  if (!n || x.p.length < n || x.rainMm.length < n) throw new Error(`humanSentence: ${x.place} needs a chance and a rain value for each of the ${n} hours`);
  const h0 = Math.max(0, Math.min(n - 1, Math.floor((x.nowMs - x.hoursMs[0]!) / 3.6e6)));
  const today = WEEKDAYS[localParts(Math.max(x.nowMs, x.hoursMs[0]!), x.zone).weekday]!;
  /** "Thursday 18:00" (a date instead of the weekday when it is six days or more away, so it is never ambiguous). */
  const when = (h: number): Piece[] => {
    const ms = x.hoursMs[h]!;
    const day = ms - x.nowMs >= 6 * DAY_MS ? formatDayMonth(ms, x.zone) : WEEKDAYS[localParts(ms, x.zone).weekday]!;
    return [{ text: `${day} ${hh(ms, x.zone)}`, ms }];
  };
  const over = (h: number): boolean => x.p[h]! > x.thresholds.higher;
  let from = -1;
  for (let h = h0; h < n; h++)
    if (over(h)) {
      from = h;
      break;
    }
  const fog = x.unmeasuredAfterRain ? 'Nobody has measured here after rain.' : null;
  let lead: Piece[];
  let risk: Human['risk'] = 'usual';
  let until: number | null = null;
  if (from < 0) lead = [{ text: `${x.place}, ${today}. Usual chance today.` }];
  else {
    let end = -1;
    let peak = 0;
    for (let h = from; h < n; h++) {
      if (!over(h)) {
        end = h;
        break;
      }
      peak = Math.max(peak, x.p[h]!);
    }
    risk = peak > x.thresholds.high ? 'high' : 'higher';
    until = end >= 0 ? end : null;
    const why = x.rainMm[from]! >= WET_MM ? 'after rain' : 'even without rain';
    const head: Piece[] = from === h0 ? [{ text: `${x.place}, ${today}: ` }] : [{ text: `${x.place}, from ` }, ...when(from), { text: ': ' }];
    const tail: Piece[] = end >= 0 ? when(end) : [{ text: 'the forecast ends ' }, { text: formatDayMonth(x.hoursMs[n - 1]!, x.zone), ms: x.hoursMs[n - 1]! }];
    lead = [...head, { text: `${risk} chance ${why}. Keep dogs out until ` }, ...tail, { text: '.' }];
  }
  const text = lead.map((q) => q.text).join('') + (fog ? ` ${fog}` : '');
  return { risk, lead, fog, from: from >= 0 ? from : null, until, text };
}
