// One continuous colour for the predictive chance of a sample over the single-sample flag (900 E. coli/100 ml),
// shared by the map, the line, the strip's hours and the opening's ribbons. The stops are fixed: the ramp is never
// rescaled per city or frame, so equal chances are equal colours everywhere. Night: 0% #D6ECF7, 50% #FFB03A,
// 100% #FF581E. Day keeps the same ramp in the day palette's ink-strength colours, so it reads on paper.
import type { Theme } from '../scenes/types';

export type RGB = readonly [number, number, number];

export const PROBABILITY_STOPS: Record<Theme, readonly [RGB, RGB, RGB]> = {
  night: [
    [214, 236, 247],
    [255, 176, 58],
    [255, 88, 30],
  ],
  day: [
    [31, 94, 140],
    [156, 94, 0],
    [180, 48, 12],
  ],
};

export function probabilityColour(p: number, theme: Theme = 'night'): [number, number, number] {
  const x = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  const s = PROBABILITY_STOPS[theme];
  const lo = x <= 0.5 ? s[0] : s[1];
  const hi = x <= 0.5 ? s[1] : s[2];
  const t = x <= 0.5 ? x / 0.5 : (x - 0.5) / 0.5;
  return [0, 1, 2].map((k) => Math.round(lo[k]! + (hi[k]! - lo[k]!) * t)) as [number, number, number];
}

export const probabilityCss = (p: number, theme: Theme = 'night'): string => `rgb(${probabilityColour(p, theme).join(',')})`;
const hex2 = (v: number): string => v.toString(16).padStart(2, '0');
export const rgbHex = (c: RGB): string => `#${c.map(hex2).join('')}`;
