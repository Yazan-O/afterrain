// The four lives at one stream (spec W4): a child, an adult, a dog and a heron, drawn as ink silhouettes in one
// style (tapered limbs and smooth bodies, one scale: an adult is 60 units tall, feet on y = 0).
// Each has three poses, one per distance from the water, so the posture itself carries the state:
//   0 at the edge   engaged with the water (child crouching to it, adult wading in, dog drinking, heron fishing)
//   1 a step back   upright, watching (child and adult standing, dog sitting, heron upright)
//   2 far back      turned away (child and adult walking off, dog walking off, heron hunched and still)
// "unknown" uses the pose of the best guess, ghosted in fog.
export type FigureKind = 'child' | 'adult' | 'dog' | 'heron';
export type Level = 0 | 1 | 2;
export const FIGURE_KINDS: readonly FigureKind[] = ['child', 'adult', 'dog', 'heron'];

type J = readonly [number, number, number]; // x, y, radius

const f1 = (x: number): string => (Math.round(x * 10) / 10).toString();

/** Convex hull of two circles as a closed path: one tapered segment. */
function capsule(a: J, b: J): string {
  const [x1, y1, r1] = a;
  const [x2, y2, r2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6 || d <= Math.abs(r1 - r2)) return circle(r1 > r2 ? a : b);
  const ang = Math.atan2(dy, dx);
  const off = Math.acos((r1 - r2) / d);
  const p = (x: number, y: number, r: number, t: number): string => `${f1(x + r * Math.cos(t))} ${f1(y + r * Math.sin(t))}`;
  const a1 = ang + off;
  const a2 = ang - off;
  return `M${p(x1, y1, r1, a1)}A${f1(r1)} ${f1(r1)} 0 ${off < Math.PI / 2 ? 0 : 1} 1 ${p(x1, y1, r1, a2)}L${p(x2, y2, r2, a2)}A${f1(r2)} ${f1(r2)} 0 ${off < Math.PI / 2 ? 1 : 0} 1 ${p(x2, y2, r2, a1)}Z`;
}
const circle = ([x, y, r]: J): string => `M${f1(x - r)} ${f1(y)}a${f1(r)} ${f1(r)} 0 1 0 ${f1(2 * r)} 0a${f1(r)} ${f1(r)} 0 1 0 ${f1(-2 * r)} 0Z`;
const limb = (...js: J[]): string[] => js.slice(1).map((j, i) => capsule(js[i]!, j));
function ell(cx: number, cy: number, rx: number, ry: number, rotDeg = 0): string {
  const n = 28;
  const c = Math.cos((rotDeg * Math.PI) / 180);
  const s = Math.sin((rotDeg * Math.PI) / 180);
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    pts.push(`${f1(cx + x * c - y * s)} ${f1(cy + x * s + y * c)}`);
  }
  return `M${pts.join('L')}Z`;
}
/** A smooth closed shape through points (Catmull-Rom to cubic Bezier). */
function blob(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length;
  let d = `M${f1(pts[0]![0])} ${f1(pts[0]![1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return `${d}Z`;
}

interface Pose {
  readonly paths: string[];
  /** Horizontal extent, for layout (min x, max x). */
  readonly x0: number;
  readonly x1: number;
  /** Top (most negative y). */
  readonly top: number;
}
const pose = (paths: string[], x0: number, x1: number, top: number): Pose => ({ paths, x0, x1, top });

// ----- the adult (60 units tall standing) -----
const adultTorso = (lean = 0): string =>
  blob([
    [-6.4 + lean, -45],
    [0 + lean, -46.2],
    [6.4 + lean, -45],
    [5.2 + lean * 0.6, -36],
    [4.4 + lean * 0.3, -29],
    [5.4, -25],
    [0, -24],
    [-5.4, -25],
    [-4.4 + lean * 0.3, -29],
    [-5.2 + lean * 0.6, -36],
  ]);
const ADULT: Record<Level, Pose> = {
  // wading: shins in the water (cut at the water line by the scene), arms out a little for balance
  0: pose(
    [
      ell(0.6, -54.5, 4.1, 4.9),
      ...limb([0.4, -50, 1.7], [0.2, -46, 2.2]),
      adultTorso(0.4),
      ...limb([-5.8, -43.5, 2.1], [-9.6, -35.5, 1.7], [-11.6, -28, 1.35]),
      ...limb([6.2, -43.5, 2.1], [10.2, -35.8, 1.7], [12.4, -28.6, 1.35]),
      ...limb([-2.9, -26, 2.9], [-3.8, -13.5, 2.2], [-4.2, -2, 1.7]),
      ...limb([2.9, -26, 2.9], [4.4, -13.8, 2.2], [5.6, -2.2, 1.7]),
    ],
    -13,
    14,
    -60,
  ),
  // standing at rest, watching
  1: pose(
    [
      ell(0, -54.8, 4.1, 4.9),
      ...limb([0, -50, 1.7], [0, -46, 2.2]),
      adultTorso(),
      ...limb([-6, -43.5, 2.1], [-7.2, -34.8, 1.7], [-7.4, -26, 1.35]),
      ...limb([6, -43.5, 2.1], [7.2, -34.8, 1.7], [7.4, -26, 1.35]),
      ...limb([-2.8, -26, 2.9], [-2.9, -13.5, 2.2], [-3, -1.6, 1.6]),
      ...limb([2.8, -26, 2.9], [2.9, -13.5, 2.2], [3, -1.6, 1.6]),
      ell(-3.6, -0.9, 2.6, 1.1),
      ell(3.6, -0.9, 2.6, 1.1),
    ],
    -9,
    9,
    -60,
  ),
  // walking away up the bank, in profile, mid-stride
  2: pose(
    [
      ell(1.4, -54.6, 3.8, 4.8),
      ...limb([1, -50, 1.7], [0.8, -46, 2.2]),
      blob([
        [-3.4, -45.6],
        [3.4, -46],
        [4.6, -40],
        [3.6, -31],
        [3.8, -25.4],
        [-2.4, -24.6],
        [-3, -31],
        [-4.4, -40],
      ]),
      ...limb([0.4, -43.8, 2.1], [-3.6, -35.4, 1.7], [-6.2, -27.8, 1.35]),
      ...limb([1.2, -43.8, 2.1], [4.4, -35.6, 1.7], [7.6, -29, 1.35]),
      ...limb([0.8, -26, 3], [5.6, -14, 2.2], [8.6, -2, 1.6]),
      ...limb([0.2, -26, 3], [-3.2, -13.8, 2.2], [-6.8, -2.6, 1.6]),
      ell(10.2, -1, 2.8, 1.1),
      ell(-6, -1.4, 2.8, 1.1, -18),
    ],
    -9,
    13,
    -60,
  ),
};

// ----- the child (about 40 units standing) -----
const CHILD: Record<Level, Pose> = {
  // crouching at the edge, one hand reaching into the water
  0: pose(
    [
      ell(3.6, -26.6, 4.6, 4.9),
      blob([
        [-2.2, -21.6],
        [3.8, -21.6],
        [5.4, -15.2],
        [4.6, -9.6],
        [-3.4, -9.4],
        [-4.2, -15],
      ]),
      ...limb([-1.6, -10.6, 2.6], [-6.8, -7.2, 2.1], [-4.6, -1.4, 1.5]),
      ...limb([2.4, -10.6, 2.6], [8.2, -8.6, 2.1], [7.2, -1.4, 1.5]),
      ...limb([3.8, -19.6, 1.6], [8.8, -13.2, 1.3], [12.6, -4.2, 1.1]),
      ...limb([-1.4, -19.6, 1.6], [-4.8, -14, 1.3], [-4, -9.6, 1.1]),
      ell(-3.6, -0.8, 2.3, 1),
      ell(8.2, -0.8, 2.3, 1),
    ],
    -8,
    14,
    -31.6,
  ),
  1: pose(
    [
      ell(0, -35, 4.7, 5),
      blob([
        [-4.4, -29.4],
        [4.4, -29.4],
        [5.2, -22],
        [5.8, -16.4],
        [-5.8, -16.4],
        [-5.2, -22],
      ]),
      ...limb([-4.2, -28.4, 1.6], [-5.4, -22.4, 1.3], [-5.6, -16.6, 1.1]),
      ...limb([4.2, -28.4, 1.6], [5.4, -22.4, 1.3], [5.6, -16.6, 1.1]),
      ...limb([-2.2, -17, 2.1], [-2.3, -8.6, 1.7], [-2.4, -1.4, 1.35]),
      ...limb([2.2, -17, 2.1], [2.3, -8.6, 1.7], [2.4, -1.4, 1.35]),
      ell(-2.8, -0.8, 2.1, 0.95),
      ell(2.8, -0.8, 2.1, 0.95),
    ],
    -7,
    7,
    -40,
  ),
  2: pose(
    [
      ell(1.2, -35, 4.4, 4.9),
      blob([
        [-2.8, -29.8],
        [3.2, -30],
        [4.2, -22.6],
        [3.8, -16.6],
        [-2.8, -16.2],
        [-3.6, -22.6],
      ]),
      ...limb([0.4, -28.4, 1.6], [-3, -22.8, 1.3], [-5, -17.4, 1.1]),
      ...limb([1, -28.4, 1.6], [4.2, -23, 1.3], [6.8, -18.2, 1.1]),
      ...limb([0.8, -17, 2.2], [4.4, -9.2, 1.7], [6.2, -1.6, 1.35]),
      ...limb([0, -17, 2.2], [-2.6, -9, 1.7], [-5, -2, 1.35]),
      ell(7.6, -0.8, 2.2, 0.95),
      ell(-4.4, -1.1, 2.2, 0.95, -16),
    ],
    -7,
    10,
    -40,
  ),
};

// ----- the dog (a medium dog in profile, facing the water on its left; about 24 units tall) -----
const dogBody = (dy = 0): string =>
  blob([
    [-12.8, -16.8 + dy],
    [-4, -18 + dy],
    [6.2, -18.2 + dy],
    [11.2, -16.4 + dy],
    [11.4, -12 + dy],
    [6, -10.6 + dy],
    [-4, -10.8 + dy],
    [-12.4, -11.6 + dy],
  ]);
const DOG: Record<Level, Pose> = {
  // drinking: head down to the water at its left
  0: pose(
    [
      dogBody(),
      ...limb([-11.6, -15.2, 3], [-15.4, -10.4, 2.4], [-17.8, -5.2, 1.9]),
      ell(-19.6, -3.6, 3.4, 2.2, 30),
      ...limb([-17.8, -7, 1.2], [-17.2, -4, 1.2]),
      ...limb([-9.8, -12.6, 2.3], [-10.6, -6.6, 1.7], [-11, -0.8, 1.35]),
      ...limb([-6.8, -12.6, 2.2], [-7, -6.6, 1.6], [-7.4, -0.8, 1.3]),
      ...limb([7.4, -13, 2.9], [9.4, -7, 1.9], [8.6, -0.8, 1.35]),
      ...limb([4.6, -13, 2.6], [5.6, -7, 1.8], [5, -0.8, 1.3]),
      ...limb([11, -16.6, 1.4], [15.2, -19.2, 1.1], [18, -18.2, 0.8]),
    ],
    -23,
    19,
    -19,
  ),
  // sitting, head up, watching
  1: pose(
    [
      blob([
        [-9.2, -22.4],
        [-4.6, -23],
        [-1.6, -17],
        [3.8, -10],
        [5.4, -4],
        [2.4, -0.4],
        [-6.6, -0.6],
        [-8.4, -8],
      ]),
      ...limb([-7.6, -22, 3.3], [-9.4, -26.4, 2.9]),
      ell(-10.6, -28.2, 3.8, 3.2, -8),
      ...limb([-13.2, -27.6, 1.9], [-16.8, -26.4, 1.3]),
      ...limb([-8.4, -30.4, 1.3], [-7.2, -26.6, 1.1]),
      ...limb([-7.4, -14, 1.9], [-8, -7, 1.5], [-8.4, -0.8, 1.25]),
      ...limb([-4.6, -14, 1.8], [-5, -7, 1.45], [-5.4, -0.8, 1.2]),
      ...limb([4.2, -3, 1.3], [8.8, -1.6, 1.1], [12, -2.8, 0.8]),
      ell(1.2, -0.8, 4.6, 1),
    ],
    -17,
    13,
    -32,
  ),
  // walking away (to the right) at an easy trot: diagonal legs paired, head up, tail up
  2: pose(
    [
      blob([
        [-13.4, -16.2],
        [-8, -18],
        [-1, -17.6],
        [6.4, -19.4],
        [11.2, -18.2],
        [13, -14.6],
        [10.4, -10.8],
        [4.2, -11.6],
        [-1.6, -12.6],
        [-7.8, -11.4],
        [-12.8, -12],
      ]),
      ...limb([9.4, -17, 3.3], [12.4, -21.2, 2.6], [13.6, -23.4, 2.4]),
      ell(15.6, -24.2, 3.7, 2.9, -8),
      ...limb([17.8, -24, 2.1], [21.6, -22.8, 1.4]),
      ...limb([14.2, -27, 1.25], [12.6, -24.6, 1]),
      // front legs: one reaching forward, one under the body
      ...limb([10.2, -12.4, 2.3], [13.4, -6.8, 1.55], [15.8, -1, 1.2]),
      ell(16.8, -0.7, 2, 0.85),
      ...limb([7.6, -12.2, 2.2], [7, -6.6, 1.5], [5.2, -1, 1.2]),
      ell(5.8, -0.7, 2, 0.85),
      // hind legs: thigh, hock, paw; one pushing off behind, one stepping under
      ...limb([-9.4, -13.6, 3.4], [-12.6, -8.2, 1.9], [-13.6, -4.6, 1.4], [-16.4, -1, 1.2]),
      ell(-15.8, -0.7, 2, 0.85),
      ...limb([-7.4, -13.2, 3.1], [-5, -8.2, 1.8], [-6, -4.4, 1.35], [-4.4, -1, 1.2]),
      ell(-3.8, -0.7, 2, 0.85),
      // tail, carried up
      ...limb([-13, -15.8, 1.45], [-16.2, -19.4, 1.1], [-17.4, -23, 0.75]),
    ],
    -20,
    24,
    -28,
  ),
};

// ----- the heron (a grey heron in profile, facing the water on its left; about 52 units standing) -----
const heronBody = (dx = 0, dy = 0): string =>
  blob([
    [-7 + dx, -33.6 + dy],
    [0 + dx, -35.4 + dy],
    [7.4 + dx, -32.2 + dy],
    [12.6 + dx, -26.4 + dy],
    [8.2 + dx, -25.4 + dy],
    [0 + dx, -25 + dy],
    [-6.4 + dx, -27.4 + dy],
  ]);
const heronLegs = (): string[] => [
  ...limb([0.6, -26, 0.95], [0.9, -13.8, 0.75], [0.4, -0.8, 0.6]),
  ...limb([3.2, -26, 0.95], [3.8, -13.6, 0.75], [4.4, -0.8, 0.6]),
  ...limb([0.4, -0.8, 0.55], [-3.4, -0.3, 0.4]),
  ...limb([4.4, -0.8, 0.55], [0.8, -0.3, 0.4]),
];
const HERON: Record<Level, Pose> = {
  // fishing: neck stretched forward and down toward the water
  0: pose(
    [
      heronBody(1, 2),
      ...limb([-5.6, -30, 2.2], [-11.4, -30, 1.6], [-16.8, -25, 1.35]),
      ell(-18, -23.4, 2.4, 1.7, 40),
      ...limb([-19, -22.2, 0.9], [-24.4, -15.6, 0.3]),
      ...limb([-18.2, -24.8, 0.35], [-14.6, -26.8, 0.2]),
      ...heronLegs(),
    ],
    -25,
    14,
    -35,
  ),
  // upright, neck in an S, watching
  1: pose(
    [
      heronBody(),
      ...limb([-5.4, -32.6, 2.3], [-5.8, -38.6, 1.6], [-3.6, -43.4, 1.4], [-5.2, -48.4, 1.5]),
      ell(-6, -50, 2.6, 2.1, -6),
      ...limb([-8, -50.2, 0.9], [-15.2, -49.2, 0.3]),
      ...limb([-5.2, -51.4, 0.35], [-0.2, -53, 0.2]),
      ...heronLegs(),
    ],
    -16,
    13,
    -53,
  ),
  // hunched and still, neck folded into the shoulders, far from the water
  2: pose(
    [
      blob([
        [-6.6, -36.6],
        [0, -38.4],
        [7.2, -35],
        [12.6, -26.4],
        [8, -25.2],
        [0, -24.8],
        [-6.2, -28],
      ]),
      ell(-5.4, -38.6, 3, 2.5, -12),
      ...limb([-7.6, -38.8, 1], [-14, -36.6, 0.35]),
      ...heronLegs(),
    ],
    -15,
    13,
    -41.5,
  ),
};

const FIGS: Record<FigureKind, Record<Level, Pose>> = { child: CHILD, adult: ADULT, dog: DOG, heron: HERON };

export const figurePose = (kind: FigureKind, level: Level): Pose => FIGS[kind][level];

/** An SVG element's inner markup for a pose, in a viewBox that holds all three poses of the kind. */
export function figureSvg(kind: FigureKind, level: Level): { viewBox: string; w: number; h: number; paths: string } {
  const all = [0, 1, 2].map((l) => FIGS[kind][l as Level]);
  const x0 = Math.min(...all.map((p) => p.x0)) - 1;
  const x1 = Math.max(...all.map((p) => p.x1)) + 1;
  const top = Math.min(...all.map((p) => p.top)) - 1;
  const w = x1 - x0;
  const h = -top + 1.5;
  return { viewBox: `${f1(x0)} ${f1(top)} ${f1(w)} ${f1(h)}`, w, h, paths: figurePose(kind, level).paths.map((d) => `<path d="${d}"/>`).join('') };
}
