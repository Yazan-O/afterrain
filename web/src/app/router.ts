// Hash routes: #/story[/<beat>] (the default: an empty hash opens the story), #/city/<id>,
// #/city/<id>/stream/<slug> (the shell's city scene), and #/<scene>[/...] for every scene in
// src/scenes/<scene>/index.ts (for example #/replay, #/dark-hours). Anything else goes to Coimbra.
// A malformed escape (%E0%A4%A) never throws: the segment is kept as written.
import { CITY_IDS, type CityId } from '../data/schemas';
import { BEATS } from '../scenes/darkhours/timeline';
import { parseReplayRoute, replayHash } from '../scenes/replay/route';

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * The route segments each scene reads, through the scene's own parser (src/scenes/replay/route.ts, the dark
 * hours' BEATS). Anything else in the link is dropped, so the link shows what the screen does.
 */
export const SCENE_PARAMS: Readonly<Record<string, (params: readonly string[]) => string[]>> = {
  replay: (p) => replayHash(parseReplayRoute(p)).split('/').slice(2),
  'dark-hours': (p) => (p[0] && (BEATS as readonly string[]).includes(p[0]) ? [p[0]] : []),
};

export const DEFAULT_CITY: CityId = 'CO';

export type Route =
  | { readonly kind: 'city'; readonly city: CityId; readonly params: readonly string[] }
  | { readonly kind: 'scene'; readonly name: string; readonly params: readonly string[] }
  | { readonly kind: 'story'; readonly params: readonly string[] };

export function parseHash(hash: string, scenes: readonly string[]): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decode);
  const [head, ...rest] = parts;
  if (head === undefined || head === 'story') return { kind: 'story', params: rest };
  if (head === 'city') {
    const id = (rest[0] ?? '').toUpperCase();
    if ((CITY_IDS as readonly string[]).includes(id)) return { kind: 'city', city: id as CityId, params: [id, ...rest.slice(1)] };
  } else if (head && scenes.includes(head)) {
    const clean = SCENE_PARAMS[head];
    return { kind: 'scene', name: head, params: clean ? clean(rest) : rest };
  }
  return { kind: 'city', city: DEFAULT_CITY, params: [DEFAULT_CITY] };
}

export const STORY_HASH = '#/story';

export const cityHash = (id: CityId, stream?: string): string => `#/city/${id}${stream ? `/stream/${stream}` : ''}`;

/** The canonical hash of a route (what the link should read for what the screen shows). */
export function routeHash(r: Route): string {
  if (r.kind === 'story') return `#/story${r.params.length ? `/${r.params.join('/')}` : ''}`;
  if (r.kind === 'city') return cityHash(r.city, r.params[1] === 'stream' ? r.params[2] : undefined);
  return `#/${r.name}${r.params.length ? `/${r.params.join('/')}` : ''}`;
}
