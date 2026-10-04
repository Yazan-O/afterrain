// What the e2e checks expect, read from the data the build serves (public/data), so they follow a forecast refresh:
// a clock inside the forecast (its second hour, when every quest is still to come), each city's quest whose lamp
// shows at rest (the first in the nowcast's order whose site lies on a chained stream), and the forecast's date.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteDisplayName, streamDisplayName } from '../../../src/model/names';
import { slug } from '../../../src/city/util';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'data');
const read = <T>(f: string): T => JSON.parse(readFileSync(resolve(DATA, f), 'utf-8')) as T;

interface Nowcast {
  readonly hours_utc: readonly string[];
  readonly forecast_fetched_utc: string;
  readonly timezone: string;
  readonly quests: readonly { code: string; name: string; after_rain: boolean; best_hour_utc: string; window_start_utc: string; window_end_utc: string }[];
  readonly later_quests?: readonly { from_utc: string; quests: readonly { window_end_utc: string }[] }[];
}
interface Pack {
  readonly streams: readonly { name: string; stations: readonly { code: string; name: string }[] }[];
}

export interface CityScenario {
  readonly id: string;
  /** A clock inside the forecast, with every quest still to come. */
  readonly t: string;
  /** A clock long after the forecast: the city shows it dated. */
  readonly dated: string;
  /** A clock inside the forecast one hour after every saved quest's window has closed (the forecast still live). */
  readonly afterSaved: string;
  /** The forecast's last hour (still live): no saved or later request is open at it. */
  readonly lastHour: string;
  /** Whether a window (saved or later round) is open at `lastHour` (the e2e test needs it closed). */
  readonly openAtLastHour: boolean;
  /** "2 Oct": the forecast's fetch date as the dated corner says it. */
  readonly fetched: string;
  readonly zone: string;
  readonly quest: { readonly code: string; readonly site: string; readonly stream: string; readonly streamName: string; readonly afterRain: boolean; readonly bestUtc: string };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function scenario(id: string): CityScenario {
  const now = read<Nowcast>(`nowcast_${id}.json`);
  const pack = read<Pack>(`streams/${id}.json`);
  const iso = (ms: number): string => new Date(ms).toISOString().replace('.000', '');
  let quest: CityScenario['quest'] | null = null;
  for (const q of now.quests) {
    const st = pack.streams.find((s) => s.stations.some((x) => x.code === q.code));
    if (!st) continue;
    const streamName = streamDisplayName(st.name, st.stations.map((x) => x.name));
    quest = { code: q.code, site: siteDisplayName(q.name, streamName), stream: slug(st.name), streamName, afterRain: q.after_rain, bestUtc: q.best_hour_utc };
    break;
  }
  if (!quest) throw new Error(`nowcast_${id}.json has no quest on a chained stream`);
  const f = new Date(now.forecast_fetched_utc);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: now.timezone, day: 'numeric', month: 'numeric' }).formatToParts(f);
  const day = Number(parts.find((p) => p.type === 'day')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const last = Date.parse(now.hours_utc[now.hours_utc.length - 1]!);
  const savedEnd = Math.max(...now.quests.map((q) => Date.parse(q.window_end_utc)));
  const ends = [...now.quests, ...(now.later_quests ?? []).flatMap((r) => r.quests)].map((q) => Date.parse(q.window_end_utc));
  return {
    id,
    t: iso(Date.parse(now.hours_utc[1]!)),
    dated: iso(last + 7 * 864e5),
    afterSaved: iso(savedEnd + 3.6e6),
    lastHour: iso(last),
    openAtLastHour: ends.some((e) => e > last),
    fetched: `${day} ${MONTHS[month - 1]}`,
    zone: now.timezone,
    quest,
  };
}

export const CO = scenario('CO');
export const GH = scenario('GH');
/** A string matched literally inside a RegExp. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
