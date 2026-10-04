// Small numeric helpers shared by the city scene.
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeIO = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
/** A deterministic pseudo-random number in [0, 1) from an integer-ish seed (film renders repeat exactly). */
export const hash = (i: number): number => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Equirectangular metres around a latitude: fine for a city. */
export interface LocalProj {
  readonly kx: number;
  readonly ky: number;
  d(a: readonly [number, number], b: readonly [number, number]): number;
}
export const localProj = (lat0: number): LocalProj => {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return { kx, ky, d: (a, b) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky) };
};

export const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
