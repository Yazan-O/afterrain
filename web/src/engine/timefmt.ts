// Every time is held as a UTC instant (epoch milliseconds) and shown in the local zone of its place.
// Wall-clock fields come from Intl with an explicit IANA zone; the display strings are assembled here,
// so they do not depend on the browser's locale or ICU punctuation.

export const PLACE_ZONES = {
  CO: 'Europe/Lisbon', // Coimbra
  TO: 'Europe/Paris', // Toulouse
  GH: 'Europe/Brussels', // Ghent
  OS: 'Europe/Oslo', // Oslo
  BE: 'Europe/Rome', // Benevento
  AVON: 'Europe/London', // Warleigh Weir and the River Avon near Bath
} as const;
export type PlaceId = keyof typeof PLACE_ZONES;
export type Zone = (typeof PLACE_ZONES)[PlaceId];

/** Parses an ISO instant that states UTC ("Z" or "+00:00"); anything else is an error. */
export function parseUtc(iso: string): number {
  if (!/(Z|\+00:00)$/.test(iso)) throw new Error(`not a UTC instant: ${JSON.stringify(iso)}`);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`unparseable instant: ${JSON.stringify(iso)}`);
  return t;
}

/** Parses a zone-less "YYYY-MM-DDTHH:MM[:SS]" that its file declares to be UTC (e.g. the forecast hours). */
export function parseNaiveUtc(s: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) throw new Error(`not a naive date-time: ${JSON.stringify(s)}`);
  return parseUtc(`${s.length === 16 ? `${s}:00` : s}Z`);
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (zone: string): Intl.DateTimeFormat => {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(zone, f);
  }
  return f;
};

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function localParts(utcMs: number, zone: string): LocalParts {
  if (!Number.isFinite(utcMs)) throw new Error(`not a finite instant: ${utcMs}`);
  const parts = formatterFor(zone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl did not return ${type} for zone ${zone}`);
    return p.value;
  };
  const weekday = WEEKDAYS_SHORT.indexOf(get('weekday'));
  if (weekday < 0) throw new Error(`unexpected weekday ${get('weekday')}`);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday,
  };
}

/** Minutes the zone's wall clock is ahead of UTC at that instant (+60 for BST, +120 for CEST). */
export function utcOffsetMinutes(utcMs: number, zone: string): number {
  const p = localParts(utcMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "09:10" */
export const formatClock = (utcMs: number, zone: string): string => {
  const p = localParts(utcMs, zone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

/** "24 Sep" */
export const formatDayMonth = (utcMs: number, zone: string): string => {
  const p = localParts(utcMs, zone);
  return `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
};

/** "Tue 24 Sep 09:10" */
export const formatDayTime = (utcMs: number, zone: string): string => {
  const p = localParts(utcMs, zone);
  return `${WEEKDAYS_SHORT[p.weekday]} ${p.day} ${MONTHS_SHORT[p.month - 1]} ${pad(p.hour)}:${pad(p.minute)}`;
};

/** "UTC+1": the place's offset at that instant, said with the time a test reading is assumed collected at. */
export const formatZone = (utcMs: number, zone: string): string => {
  const m = utcOffsetMinutes(utcMs, zone);
  if (m === 0) return 'UTC';
  const a = Math.abs(m);
  return `UTC${m < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}`;
};

/** "Thursday 18:00", the form the stream's sentence uses. */
export const formatWeekdayClock = (utcMs: number, zone: string): string => {
  const p = localParts(utcMs, zone);
  return `${WEEKDAYS_LONG[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
};

/** "2024-09-24T09:10:00", the zone-less local form the pipeline writes as time_local. */
export const formatLocalIso = (utcMs: number, zone: string): string => {
  const p = localParts(utcMs, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
};
