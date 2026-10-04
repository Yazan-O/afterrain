// W2 The dark hours through every quality check, at 1440x900 and 390x844, with and without reduced motion,
// driven frame by frame by the shared clock (?clock=manual and window.__sayrClock.step).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { geometry, STORM_SIDE_MM, xOf } from '../../../src/scenes/darkhours/layout';
import { BEATS, BEAT_START, GARONNE_AT, LINE_IN, NAVIGATE_AT, NUM_LINES, OPEN_AT, REGROUP, SETTLED, STILLS, type Beat } from '../../../src/scenes/darkhours/timeline';
import { KEYS } from '../../../src/scenes/darkhours/copy';
import { CITY_ROWS } from '../../../src/scenes/darkhours/layout';
import { shown, value } from '../harness/numbers';
import { expect, expectScreenQuality, expectStillUnderReducedMotion, test, VIEWPORTS } from '../harness/test';

/** Screenshots land in the output folder as well as the report. */
const SHOTS = resolve(process.env['SHOTS_RUN'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'screens', 'darkhours'));
mkdirSync(SHOTS, { recursive: true });

const TARGET = process.env['DARKHOURS_URL'] ?? '/tests/e2e/darkhours/mount.html';

const open = async (page: Page, query = '?clock=manual&theme=night', beat?: Beat | string): Promise<void> => {
  const base = TARGET.replace(/#.*/, '');
  await page.goto(`${base}${query}#/dark-hours${beat ? `/${beat}` : ''}`);
  await expect(page.locator('.dh')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => document.fonts.ready);
};

/** Advances the shared clock to scene second T (from the time the data loaded). */
const stepTo = async (page: Page, T: number): Promise<void> => {
  const now = Number(await page.locator('.dh').getAttribute('data-t'));
  await page.evaluate((ms) => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(ms), Math.round((T - now) * 1000));
  await expect(page.locator('.dh')).toHaveAttribute('data-t', T.toFixed(2));
};

const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('every beat passes every check', async ({ page }) => {
      await open(page);
      for (const beat of BEATS) {
        await stepTo(page, SETTLED[beat]);
        await expect(page.locator('.dh')).toHaveAttribute('data-beat', beat);
        await expectScreenQuality(page, 'strip');
        await shot(page, `${beat}-${size}`);
      }
    });

    test('the word budget (25) holds at every moment, not only at the beats', async ({ page }) => {
      test.setTimeout(360_000); // seventy full checks: slow on a busy machine
      await open(page);
      for (let T = 0.5; T < NAVIGATE_AT; T += 0.5) {
        await stepTo(page, T);
        await expectScreenQuality(page, 'strip');
      }
    });

    test('the sentence and the city counts carry their numbers.json keys', async ({ page }) => {
      await open(page, '?clock=manual&theme=night', 'line');
      await expect(page.locator(`.dh-say [data-num="${KEYS.dry}"]`)).toHaveText(shown(KEYS.dry));
      await expect(page.locator(`.dh-say [data-num="${KEYS.n}"]`)).toHaveText(shown(KEYS.n));
      await expect(page.locator('.dh-say').first()).toHaveText(`${shown(KEYS.dry)} of ${shown(KEYS.n)} OneAquaHealth samples came after dry days.`);
      // the sample distribution only: no claim about how many storms were measured
      await expect(page.locator('.dh')).not.toContainText('unmeasured');
      await expect(page.locator('.dh')).not.toContainText('Calm days');
      const cities = await page.locator('.dh-city').allTextContents();
      // the first row says what the count counts; the rows under it read the same way
      expect(cities).toEqual(CITY_ROWS.map((c, k) => `${c.name} ${shown(KEYS.city[c.id]!.dry)} of ${shown(KEYS.city[c.id]!.n)}${k === 0 ? ' samples after dry days' : ''}`));
      // Every word and figure in Archivo (story-first rebuild: the house face, no serif, no italics): the sentence, the
      // city counts, the axis marks, the flag's words, the hover date; no monospace in the scene.
      for (const sel of ['.dh-say [data-num]', '.dh-ccount', '.dh-ccount [data-num]', '.dh-mark', '.dh-axis', '.dh-flag', '.dh-flag-note', '.dh-tip-date', '.dh-credits'])
        for (const f of await page.locator(sel).evaluateAll((es) => es.map((e) => getComputedStyle(e).fontFamily))) expect(f, sel).toMatch(/^"?Archivo/);
      const mono = await page.locator('.dh *').evaluateAll((es) => es.filter((e) => /Mono|monospace/.test(getComputedStyle(e).fontFamily)).map((e) => e.className));
      expect(mono, 'no monospace anywhere in the scene').toEqual([]);
    });

    test('the axis says what it counts: the three days before under OneAquaHealth, the two days before under the Garonne', async ({ page }) => {
      await open(page);
      await stepTo(page, SETTLED.fall);
      await expect(page.locator('.dh-axis').first()).toHaveText('rain in the three days before \u2192');
      await expect(page.locator('.dh-axis').first()).toBeVisible();
      await expect(page.locator('.dh-axis').nth(1)).toBeHidden();
      await expect(page.locator('.dh-mark').first()).toBeVisible(); // 1 mm, the dry edge
      await expect(page.locator('.dh-mark').nth(1)).toBeHidden();
      await stepTo(page, SETTLED.storm);
      await expect(page.locator('.dh-axis').nth(1)).toHaveText('rain in the two days before \u2192');
      await expect(page.locator('.dh-axis').nth(1)).toBeVisible();
      await expect(page.locator('.dh-axis').first()).toBeHidden();
      await expect(page.locator('.dh-mark').nth(1)).toBeVisible(); // 5 mm, the line's own threshold
      await expect(page.locator('.dh-mark').first()).toBeHidden();
    });

    test('each side of the axis says what it is, with no legend: dry side and storm side, then less rain and storm side for the Garonne', async ({ page }) => {
      await open(page);
      const side = page.locator('.dh-side');
      expect(await side.allTextContents()).toEqual(['dry side', 'storm side', 'less rain', 'storm side']);
      await stepTo(page, SETTLED.fall);
      await expect(side.nth(0)).toBeVisible();
      await expect(side.nth(1)).toBeVisible();
      await expect(side.nth(2)).toBeHidden();
      // the dry side sits left of the 1 mm edge, the storm side under the fog at the wet end
      const edge = (await page.locator('.dh-mark').first().boundingBox())!;
      const dry = (await side.nth(0).boundingBox())!;
      const storm = (await side.nth(1).boundingBox())!;
      expect(dry.x + dry.width).toBeLessThan(edge.x);
      expect(storm.x).toBeGreaterThan(edge.x + edge.width);
      expect(Math.abs(storm.x + storm.width / 2 - xOf(geometry(viewport.width, viewport.height), STORM_SIDE_MM))).toBeLessThan(2);
      await expectScreenQuality(page, 'strip');
      await shot(page, `sides-fall-${size}`);
      // they step aside for the sentence
      await stepTo(page, SETTLED.line);
      await expect(side.nth(0)).toBeHidden();
      await expect(side.nth(1)).toBeHidden();
      // the Garonne's two-day axis while its drops fall, gone before its lines of numbers
      await stepTo(page, OPEN_AT + 3.2);
      await expect(side.nth(2)).toBeVisible();
      await expect(side.nth(3)).toBeVisible();
      await expectScreenQuality(page, 'strip');
      await shot(page, `sides-garonne-${size}`);
      await stepTo(page, NUM_LINES[0]![0] + 0.5);
      await expect(side.nth(2)).toBeHidden();
      await expect(side.nth(3)).toBeHidden();
    });

    test('the hook comes early: "80 of 96" is up about 4 s in, after the fall has landed', async ({ page }) => {
      expect(LINE_IN).toBeLessThanOrEqual(4.2);
      await open(page);
      await stepTo(page, LINE_IN + 0.8);
      await expect(page.locator('.dh-say').first()).toBeVisible();
      await expect(page.locator('.dh-say').first()).toHaveCSS('visibility', 'visible');
      expect(Number(await page.locator('.dh-say').first().evaluate((e) => (e as HTMLElement).style.opacity))).toBeGreaterThan(0.6);
      await expectScreenQuality(page, 'strip');
    });

    test('the Garonne lights the storm side: where its samples land after rain, the fog over them thins', async ({ page }) => {
      await open(page);
      const g = geometry(viewport.width, viewport.height);
      // how much fog there is over the storm-side samples (just above the ground) against the fog higher up, which
      // no sample reaches: the ratio falls once the Garonne's samples have landed there
      const ratio = (): Promise<number> =>
        page.evaluate(
          ({ x0, x1, low0, low1, high0, high1 }) => {
            const c = document.querySelector<HTMLCanvasElement>('.dh-canvas')!;
            const k = c.width / c.getBoundingClientRect().width;
            const lum = (y0: number, y1: number): number => {
              const d = c.getContext('2d')!.getImageData(Math.round(x0 * k), Math.round(y0 * k), Math.round((x1 - x0) * k), Math.round((y1 - y0) * k)).data;
              let s = 0;
              for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
              return s / (d.length / 4);
            };
            return lum(low0, low1) / lum(high0, high1);
          },
          { x0: xOf(g, 9), x1: xOf(g, 30), low0: g.gy1 - 0.2 * g.H, low1: g.gy1 - 0.06 * g.H, high0: 0.2 * g.H, high1: 0.3 * g.H },
        );
      await stepTo(page, OPEN_AT + 0.2);
      const before = await ratio();
      await stepTo(page, SETTLED.storm);
      const after = await ratio();
      test.info().annotations.push({ type: 'fog over the storm side / fog above', description: `${before.toFixed(3)} before the Garonne lands, ${after.toFixed(3)} after` });
      expect(after, `before ${before.toFixed(3)}, after ${after.toFixed(3)}`).toBeLessThan(before * 0.8);
    });

    test('the storm beat: axis marks, the flag and the three lines carry their numbers.json keys', async ({ page }) => {
      await open(page, '?clock=manual&theme=night', 'storm');
      await stepTo(page, SETTLED.storm);
      await expect(page.locator('.dh-mark [data-num="thresholds.dry_mm_3d"]')).toHaveText('1');
      await expect(page.locator('.dh-mark [data-num="thresholds.wet_mm_2d"]')).toHaveText('5');
      expect(await page.locator('.dh-mark').allTextContents()).toEqual(['1 mm', '5 mm']);
      await expect(page.locator('.dh-flag [data-num="thresholds.ecoli_flag_per_100ml"]')).toHaveText('900');
      expect(await page.locator('.dh-numline').allTextContents()).toEqual([
        `After three dry days: ${value(KEYS.dryExceed) === 0 ? 'none' : shown(KEYS.dryExceed)} of ${shown(KEYS.dryN)} over ${shown(KEYS.flag)}.`,
        `After ${shown(KEYS.wetMm)} mm of rain in two days: ${shown(KEYS.wetExceed)} of ${shown(KEYS.wetN)}.`,
        `Less rain: ${shown(KEYS.elseExceed)} of ${shown(KEYS.elseN)}.`,
      ]);
      await expect(page.locator('.dh-river')).toHaveText('the Garonne, Toulouse');
      await expect(page.locator('.dh-river')).toBeVisible();
    });

    test('ends by handing off to the city map, and back returns to the Garonne, not the whole scene', async ({ page }) => {
      await open(page, '?clock=manual&theme=night', 'end');
      await stepTo(page, NAVIGATE_AT - 0.1);
      expect(new URL(page.url()).hash).toBe('#/dark-hours/end');
      // The scene unmounts on navigate, so step the clock directly from here.
      await page.evaluate(() => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(200));
      await expect(page).toHaveURL(/#\/city\/CO$/);
      await expect(page.locator('.dh')).toHaveCount(0);
      // the entry the viewer goes back to is the Garonne's beat
      await page.goBack();
      await expect(page).toHaveURL(/#\/dark-hours\/storm$/);
    });

    test.describe('prefers-reduced-motion', () => {
      test.use({ reducedMotion: 'reduce' });

      test('one still frame per stretch, nothing animating, every check', async ({ page }) => {
        await open(page);
        for (const [k, s] of STILLS.entries()) {
          await stepTo(page, s.from + 0.05);
          await expectStillUnderReducedMotion(page);
          await expectScreenQuality(page, 'strip');
          const a = await page.screenshot();
          // Still: the frame does not change while the clock runs inside the stretch.
          await stepTo(page, s.from + 0.35);
          expect((await page.screenshot()).equals(a), `still ${k} changed while the clock ran`).toBe(true);
          await shot(page, `reduced-${k}-${size}`);
        }
      });
    });
  });
}

test.describe('driven by story mode', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('the story plays the Garonne by its clock or by cue("garonne"), and the scene never leaves for the city itself', async ({ page }) => {
    await open(page, '?clock=manual&theme=night&story=1');
    const cue = (name: string): Promise<boolean> => page.evaluate((n) => (window as unknown as { __dhScene: { cue(n: string): Promise<boolean> } }).__dhScene.cue(n), name);
    // the story's garonne beat sits at the scene's own storm beat
    expect(GARONNE_AT).toBe(BEAT_START.storm);
    expect(GARONNE_AT).toBe(REGROUP);
    expect(await cue('garonne')).toBe(true);
    await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'storm');
    await expect(page.locator('.dh')).toHaveAttribute('data-t', REGROUP.toFixed(2));
    expect(await cue('no-such-beat')).toBe(false);
    // by the clock: the drops land, the numbers come, the fog fills, and nothing asks for the city's page
    await stepTo(page, SETTLED.storm);
    await expect(page.locator('.dh-numline').first()).toBeVisible();
    await stepTo(page, NAVIGATE_AT + 0.5);
    expect(new URL(page.url()).hash).toBe('#/dark-hours');
    await expect(page.locator('.dh')).toHaveCount(1);
  });
});

test.describe('determinism under the shared clock', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('the same scene second draws the same pixels, however the clock got there and whatever ?t= says', async ({ browser }) => {
    const T = 26.5;
    const a = await browser.newPage({ viewport: VIEWPORTS.desktop });
    await open(a);
    await stepTo(a, T);
    const one = await a.screenshot();

    const b = await browser.newPage({ viewport: VIEWPORTS.desktop });
    // The shell sets day or night by the sun at the data time, so the theme is pinned to compare the clock alone.
    await open(b, '?t=2024-09-23T09:00:00Z&clock=manual&theme=night');
    for (let k = 1; k <= 53; k++) await stepTo(b, Math.min(T, k * 0.5));
    const two = await b.screenshot();
    expect(two.equals(one)).toBe(true);
    await a.close();
    await b.close();
  });

  test('a deep link to a beat starts that beat', async ({ page }) => {
    await open(page, '?clock=manual&theme=night', 'cities');
    await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'cities');
    await expect(page.locator('.dh')).toHaveAttribute('data-t', BEAT_START.cities.toFixed(2));
    await stepTo(page, SETTLED.cities);
    await expect(page.locator('.dh-city').first()).toBeVisible();
  });

  test('#/dark-hours/fall lands on the fall from the top, and stays the fall until the line', async ({ page }) => {
    await open(page, '?clock=manual&theme=night', 'fall');
    await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'fall');
    await expect(page.locator('.dh')).toHaveAttribute('data-t', '0.00');
    await stepTo(page, SETTLED.fall);
    await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'fall');
    await expect(page.locator('.dh-say').first()).toBeHidden();
    await stepTo(page, LINE_IN + 1);
    await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'line');
    await expect(page.locator('.dh-say').first()).toBeVisible();
  });
});
