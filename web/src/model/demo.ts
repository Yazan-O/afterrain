// The opening's test demonstration: one labelled test reading at Eiras (C4) on the
// Ribeira das Eiras, at the forecast's hour for Tue 6 Oct 15:00 Lisbon (14:00 UTC, hour 96 of the 2 Oct forecast),
// with the upstream station Escravote (C19) as the unchanged reference. It is a demonstration of what one reading
// does, independent of the operational quest (the nowcast's sampling recommendation).
//
// When a refreshed forecast no longer holds that instant, the nearest forecast hour that tells the same story is
// used: a raised estimate at the site (at least the nowcast's "higher" threshold), so a low reading lowers it.
// Pure: the city scene and its tests plan the same hour from the same data.
export const DEMO = { site: 'C4', upstream: 'C19', instantUtc: '2026-10-06T14:00Z' } as const;

export interface DemoPlan {
  readonly code: string;
  readonly upstream: string;
  /** Hour index into the nowcast. */
  readonly hour: number;
  /** 'fixed': the planned instant; 'nearest': the nearest raised hour (the planned one is outside the forecast). */
  readonly rule: 'fixed' | 'nearest';
}

export function planDemo(hoursMs: readonly number[], p50: (code: string, h: number) => number, higher: number): DemoPlan {
  const target = Date.parse(DEMO.instantUtc);
  const exact = hoursMs.indexOf(target);
  if (exact >= 0) return { code: DEMO.site, upstream: DEMO.upstream, hour: exact, rule: 'fixed' };
  let best = -1;
  let bestD = Infinity;
  let top = 0;
  for (let h = 0; h < hoursMs.length; h++) {
    const p = p50(DEMO.site, h);
    if (p > p50(DEMO.site, top)) top = h;
    const d = Math.abs(hoursMs[h]! - target);
    if (p >= higher && d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return { code: DEMO.site, upstream: DEMO.upstream, hour: best >= 0 ? best : top, rule: 'nearest' };
}
