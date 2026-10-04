// How a site or a stream is named on screen: a readable name, never a raw code.
//
// A site (OneAquaHealth's own names, city_<id>.json / nowcast_<id>.json):
//   1. a trailing code in brackets is dropped: "Zwalm3 (Zw3)" -> "Zwalm3" (one word of at most 5 letters and
//      digits with a digit in it; "Fossé Mère (ou Ruisseau Le Négogousses)" keeps its brackets);
//   2. a name that is a place joined to a sampling number ("Zwalm3", "Serretelle 4", "Gent4") names the place on
//      its stream: "the stream in the place" ("Zwalmbeek in Zwalm", "Lieve in Gent"), or the stream alone when its
//      name already holds the place ("Torrente Serretelle");
//   3. any other name is shown as the site record gives it.
// A stream (OpenStreetMap names chained by build_streams.py): a title joined from several ways with " - "
// ("Ribeira de Bruscos - Ribeira de Condeixa") is shortened to one of them: the one that shares a word with one of
// its sites' names (Condeixa), else the first.

const CODE_IN_BRACKETS = /\s*\((?=[^)]*\d)[\p{L}\p{N}]{1,5}\)$/u;
const PLACE_NUMBER = /^(\p{L}[\p{L}'’-]*)\s?\d+$/u;
const JOIN = /\s+[-–—]\s+/;

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 2);

/** A stream's name as the strip and the titles show it. */
export function streamDisplayName(name: string, siteNames: readonly string[] = []): string {
  const parts = name.split(JOIN).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return name.trim();
  const sites = new Set(siteNames.flatMap(words));
  return parts.find((p) => words(p).some((w) => sites.has(w))) ?? parts[0]!;
}

/** A site's name as the quest, the result line and the labels show it; `stream` is the stream it sits on. */
export function siteDisplayName(name: string, stream?: string): string {
  const bare = name.replace(CODE_IN_BRACKETS, '').trim();
  const m = PLACE_NUMBER.exec(bare);
  if (!m) return bare;
  const place = m[1]!;
  if (!stream) return place;
  return words(stream).includes(place.toLowerCase()) ? stream : `${stream} in ${place}`;
}
