// Every word the scene shows, built as DOM so each number carries its numbers.json key (data-num) and each
// date its data-time mark. A key the scene needs and numbers.json lacks is an error, never a guess.
import type { NumbersFile } from '../../data/schemas';
import { formatNumber } from '../../format/numfmt';
import { CITY_ROWS } from './layout';

/** The numbers the scene shows, by what they count. */
export const KEYS = {
  dry: 'darkhours.oneaquahealth.dry',
  n: 'darkhours.oneaquahealth.n',
  city: Object.fromEntries(CITY_ROWS.map((c) => [c.id, { dry: `oah.${c.id}.dry`, n: `oah.${c.id}.samples` }])) as Record<string, { dry: string; n: string }>,
  /** Thresholds: dry = under 1 mm in the 3 days before; the Toulouse split at 5 mm in the 2 days before; the 900 flag. */
  dryMm: 'thresholds.dry_mm_3d',
  wetMm: 'thresholds.wet_mm_2d',
  flag: 'thresholds.ecoli_flag_per_100ml',
  wetExceed: 'toulouse.wet_2d_5mm.exceed',
  wetN: 'toulouse.wet_2d_5mm.n',
  elseExceed: 'toulouse.otherwise.exceed',
  elseN: 'toulouse.otherwise.n',
  dryExceed: 'toulouse.dry_3d_1mm.exceed',
  dryN: 'toulouse.dry_3d_1mm.n',
} as const;

export const numberOf = (numbers: NumbersFile, key: string): number => {
  const e = numbers[key];
  if (!e) throw new Error(`dark hours: numbers.json has no key "${key}"`);
  if (typeof e.value !== 'number') throw new Error(`dark hours: numbers.json "${key}" is not a number`);
  return e.value;
};

type Child = Node | string;
const h = (tag: string, cls: string | null, ...kids: Child[]): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) el.append(k);
  return el;
};

export interface Copy {
  readonly line: HTMLElement;
  /** Axis marks at 1 mm (the 3-day axis) and 5 mm (the Garonne's 2-day axis), and the rain values they stand at. */
  readonly markDry: HTMLElement;
  readonly markWet: HTMLElement;
  /** What each axis counts, in words: the rain in the three days before (OneAquaHealth), in the two days before (the Garonne). */
  readonly axis3: HTMLElement;
  readonly axis2: HTMLElement;
  /**
   * What each side of the axis means, in words, under the ground: "dry side" left of the 1 mm edge and "storm
   * side" under the fog at the wet end (OneAquaHealth's three-day axis); "less rain" left of 5 mm and "storm side"
   * again on the Garonne's two-day axis, where "Less rain: 4 of 88." counts that left side.
   */
  readonly sideDry: HTMLElement;
  readonly sideStorm: HTMLElement;
  readonly sideLess: HTMLElement;
  readonly sideStorm2: HTMLElement;
  readonly dryMm: number;
  readonly wetMm: number;
  readonly cities: HTMLElement[];
  readonly river: HTMLElement;
  readonly flag: HTMLElement;
  readonly nums: HTMLElement[];
  readonly tip: HTMLElement;
  readonly tipName: HTMLElement;
  readonly tipDate: HTMLElement;
  /** The scene's own sources, shown beside the shell's credits when the viewer opens them. */
  readonly credits: HTMLElement;
}

export function buildCopy(numbers: NumbersFile): Copy {
  const num = (key: string, cls = 'dh-n'): HTMLElement => {
    const el = h('span', cls, formatNumber(numberOf(numbers, key), null));
    el.dataset['num'] = key;
    return el;
  };
  /** "none" when the count is 0, else the count itself, bound to its key. */
  const none = (key: string): Child => (numberOf(numbers, key) === 0 ? 'none' : num(key));
  const unit = (): HTMLElement => {
    const el = h('span', null, 'E. coli per 100 ml');
    el.dataset['unit'] = '';
    return el;
  };

  const line = h(
    'p',
    'dh-say',
    num(KEYS.dry),
    ' of ',
    num(KEYS.n),
    ' OneAquaHealth samples came after dry days.',
  );
  // the first row says what its count counts; the rows under it read the same way
  const cities = CITY_ROWS.map((c, k) =>
    h(
      'p',
      'dh-city',
      h('span', 'dh-cname', c.name),
      ' ',
      h('span', 'dh-ccount', num(KEYS.city[c.id]!.dry), ' of ', num(KEYS.city[c.id]!.n), ...(k === 0 ? [' ', h('span', 'dh-cwhat', 'samples after dry days')] : [])),
    ),
  );
  const nums = [
    h('p', 'dh-say dh-numline', 'After three dry days: ', none(KEYS.dryExceed), ' of ', num(KEYS.dryN), ' over ', num(KEYS.flag), '.'),
    h('p', 'dh-say dh-numline', 'After ', num(KEYS.wetMm), ' mm of rain in two days: ', num(KEYS.wetExceed), ' of ', num(KEYS.wetN), '.'),
    h('p', 'dh-say dh-numline', 'Less rain: ', num(KEYS.elseExceed), ' of ', num(KEYS.elseN), '.'),
  ];
  const tipName = h('span', 'dh-tip-name');
  const tipDate = h('time', 'dh-tip-date');
  tipDate.dataset['time'] = '';
  return {
    line,
    markDry: h('span', 'dh-mark', num(KEYS.dryMm, 'dh-mn'), ' mm'),
    markWet: h('span', 'dh-mark', num(KEYS.wetMm, 'dh-mn'), ' mm'),
    axis3: h('span', 'dh-axis', 'rain in the three days before ', h('span', 'dh-arrow', '→')),
    axis2: h('span', 'dh-axis', 'rain in the two days before ', h('span', 'dh-arrow', '→')),
    sideDry: h('span', 'dh-side', 'dry side'),
    sideStorm: h('span', 'dh-side dh-side-storm', 'storm side'),
    sideLess: h('span', 'dh-side', 'less rain'),
    sideStorm2: h('span', 'dh-side dh-side-storm', 'storm side'),
    dryMm: numberOf(numbers, KEYS.dryMm),
    wetMm: numberOf(numbers, KEYS.wetMm),
    cities,
    river: h('p', 'dh-river', 'the Garonne, Toulouse'),
    flag: h('p', 'dh-flag', 'over ', num(KEYS.flag), ' ', unit(), h('span', 'dh-flag-note', 'single-sample flag')),
    nums,
    tip: h('p', 'dh-tip', tipName, ' ', tipDate),
    tipName,
    tipDate,
    credits: h(
      'p',
      'dh-credits',
      "Garonne samples: Hub'Eau / eaufrance, Licence Ouverte 2.0 · Toulouse rain: Open-Meteo.com, CC BY 4.0 · Samples and their rain: OneAquaHealth",
    ),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2023-06-28" -> "28 Jun 2023" (a calendar date, no time zone involved). */
export const formatDay = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
