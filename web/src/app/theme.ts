// Night or day: ?theme=night|day forces it; otherwise it follows the sun at the city for the clock's time
// (day while the sun is above -3 degrees), so the screen switches with the hour as the spec asks.
import type { Theme, ThemeHandle } from '../scenes/types';

/** Solar elevation in degrees (a compact NOAA-style approximation; enough to tell dusk from day). */
export function sunElevation(ms: number, lat: number, lon: number): number {
  const d = (ms - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const rad = Math.PI / 180;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 3.6e-7 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  const la = lat * rad;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / rad;
}

export const themeBySun = (ms: number, lat: number, lon: number): Theme => (sunElevation(ms, lat, lon) > -3 ? 'day' : 'night');

export interface AppTheme extends ThemeHandle {
  set(t: Theme): void;
}

export function createTheme(initial: Theme): AppTheme {
  let current = initial;
  const fns = new Set<(t: Theme) => void>();
  const apply = (): void => {
    document.documentElement.dataset['theme'] = current;
  };
  apply();
  return {
    get: () => current,
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    set(t) {
      if (t === current) return;
      current = t;
      apply();
      for (const fn of [...fns]) fn(t);
    },
  };
}
