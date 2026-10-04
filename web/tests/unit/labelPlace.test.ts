// The curve's labels: the selected value sits within 40 CSS px of its point or gets a
// connector, and each curve's name sits outside its own curve. The first case is round 3's desktop low-test
// frame: the value at the curve's bottom-left start, the dashed "before" curve just above it; round 3 put "11.7%"
// at the top of the scale, 222.8 px from its point, while its only check (no curve crossed) passed.
import { describe, expect, it } from 'vitest';
import { crossesLine, NEAR, placeNear, placeOnCurve, rect, rectDist, type Rect } from '../../src/city/labelPlace';

// round 3's desktop curve box and the two curves near the tested hour (x, y pairs, CSS px)
const BOX = { x0: 122, x1: 1318, y0: 510, y1: 796 };
const line = (pts: [number, number][]): number[] => pts.flat();
const now = line([[122, 762], [216, 762], [260, 757], [300, 745], [340, 732], [440, 730], [520, 708], [700, 706], [1000, 700], [1318, 728]]);
const before = line([[122, 741], [216, 741], [300, 717], [340, 706], [440, 705], [520, 688], [700, 684], [1000, 676], [1318, 703]]);

const clearOf =
  (taken: Rect[] = []) =>
  (r: Rect): boolean =>
    r.left >= BOX.x0 - 2 && r.right <= BOX.x1 + 2 && r.top >= BOX.y0 - 30 && r.bottom <= BOX.y1 - 2 && !crossesLine(r, now) && !crossesLine(r, before) && !taken.some((t) => t.left < t.right && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top);

describe('the selected value beside its point', () => {
  it("round 3's low-test frame: the value lands within 40 px of the point, clear of both curves", () => {
    const p = placeNear(122, 762, 52, 24, clearOf())!;
    expect(p).not.toBeNull();
    expect(p.dist).toBeLessThanOrEqual(NEAR);
    expect(p.lead).toBe(false);
    const r = rect(p.x, p.y, 52, 24);
    expect(crossesLine(r, now) || crossesLine(r, before)).toBe(false);
    expect(rectDist(122, 762, r)).toBeCloseTo(p.dist, 6);
  });

  it('beyond 40 px it is marked for a connector, and a place that is never clear gives null', () => {
    // everything within 60 px of the point is taken
    const ring = (r: Rect): boolean => rectDist(500, 600, r) > 60;
    const p = placeNear(500, 600, 40, 20, ring)!;
    expect(p.dist).toBeGreaterThan(NEAR);
    expect(p.lead).toBe(true);
    expect(placeNear(500, 600, 40, 20, () => false)).toBeNull();
  });

  it('takes the nearest clear place, not the first in a fixed order', () => {
    const p = placeNear(400, 600, 40, 20, () => true)!;
    expect(p.dist).toBeLessThanOrEqual(6.0001);
  });
});

describe('each curve named beside itself', () => {
  it('"Before" above the dashed curve and "With test" below the solid one when the test lowers the chance', () => {
    const b = placeOnCurve(before, now, 50, 18, BOX.x0, BOX.x1, clearOf())!;
    const w = placeOnCurve(now, before, 70, 18, BOX.x0, BOX.x1, clearOf([rect(b.x, b.y, 50, 18)]))!;
    expect(b).not.toBeNull();
    expect(w).not.toBeNull();
    // "Before" sits above the before-curve and "With test" under the with-test curve, each within 8 px of its own
    const yAt = (xy: number[], x: number): number => {
      for (let k = 0; k < xy.length / 2 - 1; k++)
        if (xy[2 * k]! <= x && xy[2 * k + 2]! >= x) return xy[2 * k + 1]! + ((xy[2 * k + 3]! - xy[2 * k + 1]!) * (x - xy[2 * k]!)) / (xy[2 * k + 2]! - xy[2 * k]!);
      return NaN;
    };
    expect(b.y + 18).toBeLessThanOrEqual(yAt(before, b.x + 25));
    expect(yAt(before, b.x + 25) - (b.y + 18)).toBeLessThan(12);
    expect(w.y).toBeGreaterThanOrEqual(yAt(now, w.x + 35));
    expect(w.y - yAt(now, w.x + 35)).toBeLessThan(12);
    // and neither label crosses a curve
    for (const r of [rect(b.x, b.y, 50, 18), rect(w.x, w.y, 70, 18)]) expect(crossesLine(r, now) || crossesLine(r, before)).toBe(false);
  });

  it('a raised chance swaps the sides: the with-test curve is now the upper one', () => {
    const w = placeOnCurve(before, now, 70, 18, BOX.x0, BOX.x1, clearOf())!;
    // here `before` plays the upper (raised, with test) curve: its name goes above it
    expect(w.y + 18).toBeLessThan(705);
  });
});
