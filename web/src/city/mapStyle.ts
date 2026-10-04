// The basemap (the night terrain map and its paper-white day twin) and the scene palettes.
// Tiles: OpenFreeMap vector tiles (OpenStreetMap data, ODbL) and the Mapzen terrain tiles on AWS Open Data.
import type { FeatureCollection } from 'geojson';
import type { StyleSpecification, ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import type { Theme } from '../scenes/types';
import { PROBABILITY_STOPS } from './probabilityColour';

export type RGB = readonly [number, number, number];

export interface Palette {
  /** usual, higher, high (best-guess colours), fog */
  readonly c: readonly [RGB, RGB, RGB, RGB];
  readonly comp: GlobalCompositeOperation;
  readonly fog: RGB;
  readonly fogA: number;
  readonly core: string;
  readonly river: RGB;
  readonly bg: string;
  readonly ink: string;
}

export const PAL: Record<Theme, Palette> = {
  night: {
    c: [
      [214, 236, 247],
      [255, 176, 58],
      [255, 88, 30],
      [150, 160, 157],
    ],
    comp: 'lighter',
    fog: [150, 161, 157],
    fogA: 0.6,
    core: '#ffffff',
    river: [180, 208, 222],
    bg: '#04090a',
    ink: '#e7eeea',
  },
  // day colours are drawn at 85% or more, so each is at least 4:1 against the paper
  day: {
    c: [
      [31, 94, 140],
      [156, 94, 0],
      [180, 48, 12],
      [104, 112, 110],
    ],
    comp: 'source-over',
    fog: [168, 175, 173],
    fogA: 0.92,
    core: '#1b2325',
    river: [31, 94, 140],
    bg: '#f3f1ea',
    ink: '#1b2325',
  },
};

const hex = (a: RGB): string => `#${a.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Line colour by the chance of a sample over the flag ("p"), on the one fixed ramp (src/city/probabilityColour.ts):
 * MapLibre's linear interpolation between the same three stops. The fog never changes it (constant opacity).
 */
export const wwColor = (t: Theme): ExpressionSpecification => {
  const [a, b, c] = PROBABILITY_STOPS[t];
  return ['interpolate', ['linear'], ['get', 'p'], 0, hex(a), 0.5, hex(b), 1, hex(c)];
};
/** An opacity faded toward the edge of the city's waterway extract ("e"), so the extract's rectangle never shows. */
const edged = (v: unknown): unknown => ['*', v, ['coalesce', ['get', 'e'], 1]];

type Paint = Record<string, Record<string, unknown>>;
export const PAINT: Record<Theme, Paint> = {
  night: {
    bg: { 'background-color': '#050b0b' },
    land: { 'fill-color': ['match', ['get', 'class'], 'wood', '#07120f', 'grass', '#08110e', 'farmland', '#09120f', '#07100d'] },
    use: { 'fill-color': '#0b1412' },
    hill: { 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#2b463c', 'hillshade-accent-color': '#0a1813' },
    water: { 'fill-color': '#0a1b1c' },
    rmin: { 'line-color': '#131f1b' },
    rmaj: { 'line-color': '#1b2a25' },
    bld: { 'fill-color': '#0e1916' },
    plbl: { 'text-color': '#aebdb7', 'text-halo-color': '#04090a' },
    wlbl: { 'text-color': '#8fb0bc', 'text-halo-color': '#04090a' },
    glow: {
      'line-opacity': edged(['match', ['get', 'k'], 'minor', 0.05, 'river', 0.16, ['interpolate', ['linear'], ['get', 'p'], 0, 0.14, 1, 0.5]]),
    },
    core: {
      'line-opacity': edged(['match', ['get', 'k'], 'minor', 0.14, 'river', 0.22, 0.78]),
      'line-width': ['match', ['get', 'k'], 'river', 1.1, 'stream', ['interpolate', ['linear'], ['get', 'p'], 0, 1.15, 1, 1.7], 0.5],
    },
  },
  day: {
    bg: { 'background-color': '#f3f1ea' },
    land: { 'fill-color': ['match', ['get', 'class'], 'wood', '#e9e8dc', 'grass', '#eeede3', 'farmland', '#efece2', '#efede5'] },
    use: { 'fill-color': '#ebe7dd' },
    hill: { 'hillshade-shadow-color': '#b9b3a4', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#d9d4c6' },
    water: { 'fill-color': '#dde6e8' },
    rmin: { 'line-color': '#e0dbcf' },
    rmaj: { 'line-color': '#d2ccbe' },
    bld: { 'fill-color': '#e4dfd3' },
    plbl: { 'text-color': '#55605d', 'text-halo-color': '#f3f1ea' },
    wlbl: { 'text-color': '#3f6a80', 'text-halo-color': '#f3f1ea' },
    glow: { 'line-opacity': 0 },
    core: {
      'line-opacity': edged(['match', ['get', 'k'], 'minor', 0.4, 'river', 0.6, 1]),
      'line-width': ['match', ['get', 'k'], 'river', 1.5, 'stream', ['interpolate', ['linear'], ['get', 'p'], 0, 2.3, 1, 3], 0.8],
    },
  },
};

/**
 * The basemap's own names, quiet (OpenFreeMap's place and waterway names, OpenStreetMap data, in its Noto Sans
 * glyphs): city, town and neighbourhood names, and the rivers' names along them. `LABEL_OPACITY` is their strength
 * at rest; the opening comparison dims them (scene.ts).
 */
export const LABEL_OPACITY = 0.62;
export const LABEL_OPACITY_DIM = 0.25;
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const labelLayers = (P: Paint): LayerSpecification[] =>
  [
    {
      id: 'wlbl',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'waterway',
      filter: ['all', ['==', ['get', 'class'], 'river'], ['has', 'name']],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 420,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 11, 14, 13],
        'text-letter-spacing': 0.08,
        'text-max-angle': 30,
      },
      paint: { ...P['wlbl'], 'text-halo-width': 1.4, 'text-opacity': LABEL_OPACITY },
    },
    {
      id: 'plbl',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood']]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 10.5],
        'text-letter-spacing': ['match', ['get', 'class'], 'city', 0.02, 0.04],
        'text-transform': ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood'], 'uppercase', 'none'],
        'text-padding': 6,
        'text-max-width': 8,
        'symbol-sort-key': ['match', ['get', 'class'], 'city', 0, 'town', 1, 'village', 2, 3],
      },
      paint: { ...P['plbl'], 'text-halo-width': 1.4, 'text-opacity': LABEL_OPACITY },
    },
  ] as LayerSpecification[];

const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** The terrain's vertical exaggeration once it has risen. */
export const EXAGGERATION = 1.6;
/**
 * The deepest terrain zoom. The tiles are 256 px terrarium PNGs declared as 512 px, so the map asks for one
 * zoom less than it would at 256 (a quarter of the requests); the stream packs bake their elevations at this zoom.
 */
export const DEM_MAXZOOM = 12;

/** A terrain DEM source (the 3D ground and the hillshade each have one). */
export const demSource = (): { type: 'raster-dem'; tiles: string[]; tileSize: number; maxzoom: number; encoding: 'terrarium' } => ({ type: 'raster-dem', tiles: [DEM], tileSize: 512, maxzoom: DEM_MAXZOOM, encoding: 'terrarium' });
/** The hillshade layer (added with the terrain, under the water). */
export const hillLayer = (theme: Theme): LayerSpecification =>
  ({ id: 'hill', type: 'hillshade', source: 'demH', paint: { ...PAINT[theme]['hill'], 'hillshade-exaggeration': 0.75, 'hillshade-illumination-direction': 295 } }) as LayerSpecification;

/**
 * `exaggeration` starts at 0 when the streams carry baked elevations: the land rises once its tiles are in.
 * `terrain: false` leaves the DEM out (no terrain, no hillshade, none of their tiles): the story's opening is a
 * flat map, and the terrain is added after it (scene.ts enableTerrain).
 */
export function mapStyle(theme: Theme, ww: FeatureCollection, exaggeration = EXAGGERATION, terrain = true): StyleSpecification {
  const P = PAINT[theme];
  return {
    version: 8,
    glyphs: GLYPHS,
    transition: { duration: 0, delay: 0 },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      ...(terrain ? { demT: demSource(), demH: demSource() } : {}),
      ww: { type: 'geojson', data: ww },
    },
    ...(terrain ? { terrain: { source: 'demT', exaggeration } } : {}),
    layers: [
      { id: 'bg', type: 'background', paint: P['bg'] },
      { id: 'land', type: 'fill', source: 'omt', 'source-layer': 'landcover', paint: P['land'] },
      { id: 'use', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail']]], paint: P['use'] },
      ...(terrain ? [hillLayer(theme)] : []),
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: P['water'] },
      {
        id: 'rmin',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['tertiary', 'minor', 'service']]],
        paint: { ...P['rmin'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 15, 1.2] },
      },
      {
        id: 'rmaj',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]],
        paint: { ...P['rmaj'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 2.2] },
      },
      { id: 'bld', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: P['bld'] },
      {
        id: 'glow',
        type: 'line',
        source: 'ww',
        // butt caps: where many waterways end at one junction, round caps of the wide blurred glow stack into a blot
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          ...P['glow'],
          'line-color': wwColor(theme),
          // the glow keeps its size on the ground: at the wide city view a river's glow is a hint, not a fuzz
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'k'], 'river', 6, 'stream', 4, 1.5], 13, ['match', ['get', 'k'], 'river', 24, 'stream', 10, 3]],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'k'], 'river', 4, 'stream', 2.5, 1.5], 13, ['match', ['get', 'k'], 'river', 18, 'stream', 7, 3]],
        },
      },
      { id: 'core', type: 'line', source: 'ww', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { ...P['core'], 'line-color': wwColor(theme) } },
      ...labelLayers(P),
    ],
  } as StyleSpecification;
}

export interface CameraLike {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}
