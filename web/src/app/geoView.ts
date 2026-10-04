// Where the story's places are: a plain outline map (land, sea, national borders; OpenFreeMap vector tiles,
// OpenStreetMap data) with a few names on it, flown by the story's clock. Two moves:
//   bath    Great Britain, "Bath, England" marked, then down to Warleigh Weir (the replay's own view takes over)
//   europe  Europe with OneAquaHealth's five cities and their countries, then into Coimbra, the city and the
//           Mondego named (the city scene's own view takes over)
// The story shell (./storyShell.ts) drives it: set(move, local seconds, opacity). Nothing renders while it is hidden.
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import type { CameraLike } from '../city/mapStyle';
import type { Theme } from '../scenes/types';
import { CITIES, CITY_ORDER } from './cities';

export type GeoMove = 'bath' | 'europe';

/** The moves' timing in their chapter's local seconds: hold, fly, then hand over to the scene underneath. */
export const GEO_TIMES: Record<GeoMove, { fly: number; land: number; out: number; end: number }> = {
  bath: { fly: 1.0, land: 3.3, out: 3.3, end: 4.0 },
  europe: { fly: 3.9, land: 6.5, out: 6.7, end: 7.4 },
};

/** Warleigh Weir (the replay's site, replay_2024-09-23.json) and the centre of Bath (51°22′51″N 2°21′35″W). */
const WEIR: [number, number] = [-2.300635, 51.37705];
const BATH: [number, number] = [-2.3597, 51.3808];
const GB: [[number, number], [number, number]] = [
  [-8.2, 49.9],
  [1.8, 58.7],
];
const EUROPE: [[number, number], [number, number]] = [
  [-10.2, 37.0],
  [16.8, 61.0],
];

const PAINT: Record<Theme, { land: string; sea: string; border: string }> = {
  night: { land: '#122520', sea: '#04090a', border: '#3a5a4f' },
  day: { land: '#e2ddcf', sea: '#f3f1ea', border: '#bdb6a5' },
};

const style = (t: Theme): maplibregl.StyleSpecification => ({
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'land', type: 'background', paint: { 'background-color': PAINT[t].land } },
    { id: 'sea', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': PAINT[t].sea } },
    {
      id: 'border',
      type: 'line',
      source: 'omt',
      'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': PAINT[t].border, 'line-width': 0.8 },
    },
  ],
});

const ease = (u: number): number => {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
const smooth = (u: number): number => {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

interface Mark {
  readonly el: HTMLDivElement;
  readonly ll: [number, number];
  /** Opacity by the move's local seconds. */
  readonly a: (t: number) => number;
  readonly dot: boolean;
}

export interface GeoView {
  /** The move on screen at its chapter's local seconds `t`, at opacity `a` (null or 0: hidden, nothing renders). */
  set(move: GeoMove | null, t: number, a: number): void;
  /** Puts the move's first view in place (its tiles load while it waits). */
  prepare(move: GeoMove): void;
  /** The move's first view has its tiles. */
  ready(move: GeoMove): boolean;
  /** The camera the europe move lands on (the city scene's own), and a point on the Mondego for its name. */
  land(cam: CameraLike | null, river: [number, number] | null): void;
  destroy(): void;
}

export function createGeoView(parent: HTMLElement, theme: () => Theme): GeoView {
  const el = document.createElement('div');
  el.className = 'geo';
  el.setAttribute('aria-hidden', 'true');
  el.style.visibility = 'hidden';
  const mapEl = document.createElement('div');
  mapEl.className = 'geo-map';
  const marksEl = document.createElement('div');
  marksEl.className = 'geo-marks';
  el.append(mapEl, marksEl);
  parent.append(el);
  let shownTheme = theme();
  const map: MLMap = new maplibregl.Map({
    container: mapEl,
    style: style(shownTheme),
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    center: [-3, 54],
    zoom: 4,
    pixelRatio: Math.min(2, devicePixelRatio || 1),
  });
  let prepared: GeoMove | null = null;
  let idle = false;
  map.on('idle', () => (idle = true));
  let endCam: CameraLike | null = null;
  let river: [number, number] | null = null;

  const mark = (text: string, ll: [number, number], a: (t: number) => number, opts: { dot?: boolean; cls?: string } = {}): Mark => {
    const m = document.createElement('div');
    m.className = `geo-mark${opts.cls ? ` ${opts.cls}` : ''}`;
    if (opts.dot !== false) m.append(Object.assign(document.createElement('i'), { className: 'geo-dot' }));
    m.append(Object.assign(document.createElement('span'), { textContent: text }));
    m.style.opacity = '0';
    marksEl.append(m);
    return { el: m, ll, a, dot: opts.dot !== false };
  };
  const T = GEO_TIMES;
  const marks: Record<GeoMove, Mark[]> = {
    bath: [mark('Bath, England', BATH, (t) => smooth((t - 0.15) / 0.5) * (1 - smooth((t - 2.4) / 0.6)))],
    europe: CITY_ORDER.map((id, i) => {
      const c = CITIES[id];
      // Coimbra stays named into the city; the others step back as the camera leaves for it
      const out = id === 'CO' ? (t: number) => 1 - smooth((t - T.europe.out) / 0.5) : (t: number) => 1 - smooth((t - T.europe.fly) / 0.5);
      return mark(`${c.name}, ${c.country}`, [c.lon, c.lat], (t) => smooth((t - 0.2 - 0.18 * i) / 0.5) * out(t), { cls: id === 'CO' ? 'geo-here' : '' });
    }),
  };
  const riverMark = mark('Mondego', [0, 0], (t) => smooth((t - (T.europe.land - 0.7)) / 0.6) * (1 - smooth((t - T.europe.out) / 0.5)), { dot: false, cls: 'geo-river' });

  /** The first view of a move, framed clear of the narration at the top. */
  const starts = new Map<string, CameraLike>();
  const startCam = (move: GeoMove): CameraLike => {
    const W = mapEl.clientWidth || innerWidth;
    const H = mapEl.clientHeight || innerHeight;
    const key = `${move}:${W}x${H}`;
    const had = starts.get(key);
    if (had) return had;
    const phone = W < 700;
    const top = phone ? Math.round(H * 0.26) : Math.round(H * 0.3);
    const side = phone ? 18 : Math.round(W * 0.12);
    // framed from straight above (the bounds' fit reads the camera's current angle)
    const keep = { pitch: map.getPitch(), bearing: map.getBearing() };
    map.jumpTo({ pitch: 0, bearing: 0 });
    const c = map.cameraForBounds(move === 'bath' ? GB : EUROPE, { padding: { top, bottom: phone ? 40 : 60, left: side, right: side } });
    map.jumpTo(keep);
    const ctr = c?.center ? maplibregl.LngLat.convert(c.center) : new maplibregl.LngLat(-3, 54);
    const cam: CameraLike = { center: [ctr.lng, ctr.lat], zoom: c?.zoom ?? 4, pitch: 0, bearing: 0 };
    starts.set(key, cam);
    return cam;
  };
  const lastCam = (move: GeoMove): CameraLike => {
    if (move === 'bath') return { center: WEIR, zoom: 12.4, pitch: 0, bearing: 0 };
    return endCam ?? { center: [CITIES.CO.lon, CITIES.CO.lat], zoom: 11.6, pitch: 0, bearing: 0 };
  };
  /** Flying in toward a point: the zoom eases, and the centre moves so the destination keeps its screen place. */
  const camAt = (move: GeoMove, t: number): CameraLike => {
    const a = startCam(move);
    const b = lastCam(move);
    const tm = T[move];
    const u = ease((t - tm.fly) / (tm.land - tm.fly));
    const z = lerp(a.zoom, b.zoom, u);
    const dz = b.zoom - a.zoom;
    const w = Math.abs(dz) < 1e-6 ? u : (1 - 2 ** -(z - a.zoom)) / (1 - 2 ** -dz);
    const A = maplibregl.MercatorCoordinate.fromLngLat(a.center);
    const B = maplibregl.MercatorCoordinate.fromLngLat(b.center);
    const ll = new maplibregl.MercatorCoordinate(lerp(A.x, B.x, w), lerp(A.y, B.y, w)).toLngLat();
    // the angle of the scene underneath comes in over the last part of the flight
    const v = smooth((t - lerp(tm.fly, tm.land, 0.45)) / ((tm.land - tm.fly) * 0.55));
    let db = b.bearing - a.bearing;
    while (db > 180) db -= 360;
    while (db < -180) db += 360;
    return { center: [ll.lng, ll.lat], zoom: z, pitch: lerp(a.pitch, b.pitch, v), bearing: a.bearing + db * v };
  };

  let shown = false;
  let lastKey = '';
  return {
    set(move, t, a) {
      const on = move !== null && a > 0.001;
      if (!on) {
        if (shown) {
          shown = false;
          el.style.visibility = 'hidden';
        }
        return;
      }
      if (theme() !== shownTheme) {
        shownTheme = theme();
        const P = PAINT[shownTheme];
        map.setPaintProperty('land', 'background-color', P.land);
        map.setPaintProperty('sea', 'fill-color', P.sea);
        map.setPaintProperty('border', 'line-color', P.border);
      }
      if (!shown) {
        shown = true;
        el.style.visibility = 'visible';
        map.resize();
      }
      const tm = T[move];
      el.style.opacity = (a * (1 - smooth((t - tm.out) / (tm.end - tm.out)))).toFixed(3);
      const cam = camAt(move, t);
      const key = `${cam.center[0].toFixed(7)},${cam.center[1].toFixed(7)},${cam.zoom.toFixed(5)},${cam.pitch.toFixed(3)},${cam.bearing.toFixed(3)}`;
      if (key !== lastKey) {
        lastKey = key;
        map.jumpTo(cam);
        // drawn in this frame, with the names placed on the same camera
        map.redraw();
      }
      const all = [...marks[move], ...(move === 'europe' && river ? [riverMark] : [])];
      for (const k of (Object.keys(marks) as GeoMove[]).filter((m) => m !== move)) for (const m of marks[k]) m.el.style.opacity = '0';
      if (move !== 'europe' || !river) riverMark.el.style.opacity = '0';
      const W = mapEl.clientWidth;
      for (const m of all) {
        const ll = m === riverMark ? river! : m.ll;
        const p = map.project(ll);
        const o = m.a(t);
        m.el.style.opacity = o.toFixed(3);
        if (o <= 0) continue;
        // names sit right of their dot, or left of it near the right edge
        const w = m.el.offsetWidth;
        const left = m.dot && p.x > W - w - 24;
        m.el.classList.toggle('left', left);
        const x = m.dot ? (left ? p.x - w : p.x) : p.x - w / 2;
        m.el.style.transform = `translate(${x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      }
    },
    prepare(move) {
      if (prepared === move) return;
      prepared = move;
      idle = false;
      lastKey = '';
      map.jumpTo(startCam(move));
    },
    ready(move) {
      return prepared === move && idle;
    },
    land(cam, r) {
      endCam = cam;
      river = r;
    },
    destroy() {
      map.remove();
      el.remove();
    },
  };
}
