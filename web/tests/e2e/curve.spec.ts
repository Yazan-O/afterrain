// The forecast curve's reading order. In the ask, result, scrub and hold states, at 1440x900
// and 390x844, these marks are on screen ahead of any optional prose: the time axis' first and last dates, 0% and
// 100%, the selected time with its zone (while the quest asks, its window says the day and zone and the axis the
// hour), "Before" / "With test" once a test is on screen, the "Sample" and "Result
// +24 h" ticks, and "single-sample flag" beside 900 in the scale's caption. Each state also passes the screen
// checks (the 34-word budget among them), and no two reserved marks touch.
import type { Page } from '@playwright/test';
import { CO } from './harness/scenario';
import { expect, expectScreenQuality, test, VIEWPORTS } from './harness/test';

const T = CO.t;
const sayr = <R>(page: Page, fn: string, ...args: unknown[]): Promise<R> =>
  page.evaluate(([f, a]) => (window.sayr![f as string] as (...x: unknown[]) => R)(...(a as unknown[])), [fn, args] as const);

interface Mark {
  kind: string;
  text: string;
  rect: { left: number; right: number; top: number; bottom: number };
  end: string | null;
}
interface Reading {
  marks: Mark[];
  /** The slider's own words for the selected hour ("Sunday 4 Oct 08:00"). */
  selected: string;
  /** The day of the month each end of the time axis is on (the end labels' text, shown or not). */
  firstDay: string;
  lastDay: string;
  box: { x0: number; x1: number; y0: number; y1: number };
}

/** The curve's marks a viewer can see now: shown, not given way, inside the screen. */
const reading = (page: Page): Promise<Reading> =>
  page.evaluate(() => {
    const vis = (e: Element): boolean => {
      for (let x: Element | null = e; x && x !== document.body; x = x.parentElement) {
        const cs = getComputedStyle(x);
        if ((x as HTMLElement).hidden || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
      }
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    };
    const kinds: [string, string][] = [
      ['line', '.city .voice'],
      ['win', '.city .questui .win'],
      ['time', '.city .tick.scrub'],
      ['end', '.city .tick.aend'],
      ['scale', '.city .tick.scale'],
      ['caption', '.city .tick.axisp'],
      ['flag', '.city .tick.axisp .ssf'],
      ['name', '.city .tick.cname'],
      ['sample', '.city .tick.resl'],
    ];
    const marks = kinds.flatMap(([kind, sel]) =>
      [...document.querySelectorAll<HTMLElement>(sel)].filter(vis).map((e) => ({ kind, text: (e.textContent ?? '').trim(), rect: e.getBoundingClientRect().toJSON(), end: e.dataset['end'] ?? null })),
    );
    const box = (window.sayr!['readouts'] as () => { box: { x0: number; x1: number; y0: number; y1: number } })().box;
    return {
      marks,
      selected: document.querySelector('.city [role="slider"]')?.getAttribute('aria-valuetext') ?? '',
      firstDay: document.querySelector('.city .tick.aend[data-end="first"]')?.textContent ?? '',
      lastDay: document.querySelector('.city .tick.aend[data-end="last"]')?.textContent ?? '',
      box,
    };
  });

/** Every reserved mark of a state is on screen, and no two of them touch. */
function expectReserved(r: Reading, state: string, names: string[]): void {
  const of = (k: string) => r.marks.filter((m) => m.kind === k);
  const texts = (k: string) => of(k).map((m) => m.text);
  // the axis' first and last dates: a day of the month at each end, or the selected hour's label on that day
  for (const [end, day, x] of [
    ['first', r.firstDay, r.box.x0],
    ['last', r.lastDay, r.box.x1],
  ] as const) {
    expect(day, `${state}: ${end} date`).toMatch(/^\d{1,2}$/);
    const own = of('end').find((m) => m.end === end);
    const time = of('time').find((m) => m.end === end);
    expect(!!own || !!time, `${state}: the axis' ${end} date is on screen`).toBe(true);
    if (own) expect(own.text).toBe(day);
    if (time) expect(time.text.startsWith(`${day} `), `${state}: "${time.text}" carries the ${end} date ${day}`).toBe(true);
    const m = (own ?? time)!;
    const edge = end === 'first' ? m.rect.left : m.rect.right;
    expect(Math.abs(edge - x), `${state}: the ${end} date sits at the axis' ${end} end`).toBeLessThan(end === 'first' && time ? 70 : 3);
  }
  expect(texts('scale').sort(), `${state}: 0% and 100%`).toEqual(['0%', '100%']);
  // the selected time with its zone: on the axis, or in the line while a test or the kit is on screen
  const [, day, hh] = /^\w+ (\d+) \w+ (\d\d):00$/.exec(r.selected) ?? [];
  expect(day, `${state}: the slider says its hour (${r.selected})`).toBeTruthy();
  if (state === 'ask') {
    // the ask's window says the day and the zone; the axis says the hour (with its day when it is another day)
    const win = texts('win');
    expect(win, 'ask: the window').toHaveLength(1);
    expect(win[0], 'ask: the window ends with its zone').toMatch(/ UTC([+-]\d+(:\d\d)?)?$/);
    expect([...win, ...texts('line')].join(' '), `ask: the window or the line says day ${day}`).toMatch(new RegExp(`(^|\\D)${day} \\w{3}`));
    expect(texts('time'), `ask: the selected hour ${r.selected} on the axis`).toHaveLength(1);
    expect(texts('time')[0]).toMatch(new RegExp(`^(\\d+ \\w{3} )?${hh}:00$`));
  } else {
    const said = new RegExp(`(^|\\D)${day} (\\w{3} )?${hh}:00 UTC([+-]\\d+(:\\d\\d)?)?$`);
    expect([...texts('time'), ...texts('line')].some((t) => said.test(t)), `${state}: the selected hour ${r.selected} with its zone, in ${JSON.stringify([...texts('time'), ...texts('line')])}`).toBe(true);
  }
  expect(texts('name').sort(), `${state}: the curves' names`).toEqual([...names].sort());
  expect(texts('sample'), `${state}: the sample's tick`).toContain('Sample');
  expect(texts('sample').some((t) => /^Result \+\d+ h$/.test(t)), `${state}: "Result +24 h"`).toBe(true);
  // the flag's meaning beside its number
  const cap = texts('caption');
  expect(cap.length, `${state}: the scale's caption`).toBe(1);
  expect(cap[0]).toMatch(/^Chance over 900 E\. coli\/100 ml ?·? ?single-sample flag$/);
  expect(texts('flag'), `${state}: "single-sample flag" is shown`).toHaveLength(1);
  // no two reserved marks touch (the line sits far above the curve and is left out)
  const placed = r.marks.filter((m) => !['line', 'win', 'flag'].includes(m.kind));
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!.rect,
        b = placed[j]!.rect;
      const touch = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      expect(touch, `${state}: "${placed[i]!.text}" touches "${placed[j]!.text}"`).toBe(false);
    }
}

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`the curve's reading order, ${size} ${viewport.width}x${viewport.height}`, () => {
    test.use(size === 'phone' ? { viewport, hasTouch: true, isMobile: true } : { viewport });

    test('ask, result, scrub and hold: every reserved mark on screen within the word budget', async ({ page }) => {
      test.setTimeout(150_000);
      await page.goto(`/?t=${T}&theme=night#/city/CO`);
      await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
      await expect(page.locator('.city')).toHaveAttribute('data-camera', 'settled', { timeout: 60_000 });
      await sayr(page, 'open', await sayr<string>(page, 'restQuestStream'), true);
      await expect(page.locator('body')).toHaveAttribute('data-state', 'strip', { timeout: 60_000 });
      await expect(page.locator('.voice')).toHaveText(/^Sample .+/);
      await page.waitForTimeout(600);
      expectReserved(await reading(page), 'ask', []);
      await expectScreenQuality(page, 'strip');

      await page.locator('.questui .add').click();
      await page.locator('.questui button[data-obs="under"]').click();
      await expect(page.locator('.voice')).toHaveText(/^Test reading · 900 or less · \w{3} \d+ \d\d:00 UTC/, { timeout: 8000 });
      await expect.poll(() => sayr<number | null>(page, 'lifting'), { timeout: 15_000 }).toBeNull();
      await page.waitForTimeout(300);
      expectReserved(await reading(page), 'result', ['Before', 'With test']);
      await expectScreenQuality(page, 'strip');

      // scrubbed through the week: every hour keeps the marks; the line says "With test" and the hour
      for (const h of [12, 40, 96, 1e9]) {
        await sayr(page, 'scrub', h);
        await expect(page.locator('.voice')).toHaveText(/^With test · \w{3} \d+ \d\d:00 UTC/);
        expectReserved(await reading(page), `scrub ${h}`, ['Before', 'With test']);
      }
      await sayr(page, 'scrub', 40);
      await expectScreenQuality(page, 'strip');

      await sayr(page, 'hold', true);
      await expect(page.locator('.voice')).toHaveText(/^Before test · \w{3} \d+ \d\d:00 UTC/);
      expectReserved(await reading(page), 'hold', ['Before']);
      await expectScreenQuality(page, 'strip');
      await sayr(page, 'hold', false);
      await expect(page.locator('.voice')).toHaveText(/^With test · /);
    });
  });
}
