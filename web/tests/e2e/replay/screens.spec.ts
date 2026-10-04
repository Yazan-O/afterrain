// Screens of every beat of the storm replay and the dark hours, at 1440x900 and 390x844, night and day, through
// the real shell, each passing every screen check. SCENE_SCREENS=<folder> turns it on and names the folder.
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FOG_FULL, NAVIGATE_AT, NUM_LINES, OPEN_AT, REGROUP, SETTLED } from '../../../src/scenes/darkhours/timeline';
import { expect, expectScreenQuality, test, VIEWPORTS } from '../harness/test';

const DIR = process.env['SCENE_SCREENS'];
if (DIR) mkdirSync(DIR, { recursive: true });

const frames = (page: Page, n = 3): Promise<void> =>
  page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = (): void => { if (++i >= k) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);

/** The replay's beats: a storm instant (UTC) the clock is pinned to, and the route. */
const REPLAY: readonly (readonly [string, string | null, string])[] = [
  ['1-start', null, ''],
  ['2-first-sample', '2024-09-19T17:00:00Z', ''],
  ['3-first-overflow', '2024-09-20T16:00:00Z', ''],
  ['4-freshford', '2024-09-23T09:40:00Z', ''],
  ['5-the-31000', '2024-09-24T08:30:00Z', ''],
  ['6-timetable', '2024-09-24T08:30:00Z', '/timetable'],
  ['7-proof', '2024-09-27T20:30:00Z', ''],
  ['9-storm-2023', '2023-07-11T08:25:00Z', '/2023-07-10'],
];

/** The dark hours' beats in scene seconds (the Garonne's three lines one by one, then the hand-off's fog). */
const DARK: readonly (readonly [string, number])[] = [
  ['0-first-drops', 1.6],
  ['1-fall', SETTLED.fall],
  ['2-line', SETTLED.line],
  ['3-cities', SETTLED.cities],
  ['4a-garonne-regroup', REGROUP + 1.9],
  ['4-garonne-falls', OPEN_AT + 3.2],
  ['5-dry-days', SETTLED.storm],
  ['6-after-5mm', NUM_LINES[1]![0] + 1.4],
  ['7-less-rain', NUM_LINES[2]![0] + 1.4],
  ['8-end', SETTLED.end],
];

for (const theme of ['night', 'day'] as const)
  for (const [size, viewport] of Object.entries(VIEWPORTS))
    test.describe(`${theme} ${size}`, () => {
      test.use({ viewport });
      test.skip(!DIR, 'set SCENE_SCREENS=<folder> to take the screens');

      test('the storm replay, beat by beat', async ({ page }) => {
        test.setTimeout(240_000);
        for (const [name, t, hash] of REPLAY) {
          await page.goto(`/?theme=${theme}${t ? `&t=${t}` : ''}#/replay${hash}`);
          await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
          await page.evaluate(() => document.fonts.ready);
          await frames(page);
          await expectScreenQuality(page, 'strip');
          await page.screenshot({ path: `${DIR}/replay-${name}-${theme}-${size}.png` });
        }
        // "overflow water": beside the first plume whose light stays long enough to read
        await page.goto(`/?theme=${theme}&clock=manual&t=2024-09-18T23:00:00Z#/replay`);
        await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        const water = await page.evaluate(() => {
          const h = (window as unknown as { __sayrReplay: { waterAt: number; timeAt(s: number): string } }).__sayrReplay;
          return h.timeAt(h.waterAt + 0.8);
        });
        await page.evaluate((d) => (window as unknown as { __sayrClock: { set(x: string): void } }).__sayrClock.set(d), water);
        await frames(page);
        await expectScreenQuality(page, 'strip');
        await page.screenshot({ path: `${DIR}/replay-3b-overflow-water-${theme}-${size}.png` });
        // the end: pinned at the last instant of the 2024 storm, the proof stays and "Now see Coimbra" comes beneath it
        await page.goto(`/?theme=${theme}#/replay`);
        await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
        const end = await page.evaluate(() => {
          const h = (window as unknown as { __sayrReplay: { duration: number; timeAt(s: number): string } }).__sayrReplay;
          return h.timeAt(h.duration);
        });
        await page.goto(`/?theme=${theme}&t=${end}#/replay`);
        await expect(page.locator('button.onward')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(1500);
        // the shell's `.onward` rule also matches the body (class "onward"), which the harness then reads as a 0 px
        // clip hiding every word: scope it to the button here so the words are counted (end-hold.spec.ts)
        await page.addStyleTag({ content: 'body.onward { position: static !important; width: auto !important; }' });
        await expectScreenQuality(page, 'strip');
        await page.screenshot({ path: `${DIR}/replay-8-onward-${theme}-${size}.png` });
        // folded after the end: the timetable keeps its axis words and names the way back to the proof
        await page.keyboard.press('t');
        await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
        await page.waitForTimeout(2200);
        await expectScreenQuality(page, 'strip');
        await page.screenshot({ path: `${DIR}/replay-8b-end-folded-${theme}-${size}.png` });
      });

      test('the dark hours, beat by beat, and the hand-off', async ({ page }) => {
        test.setTimeout(240_000);
        await page.goto(`/?theme=${theme}&clock=manual#/dark-hours`);
        await expect(page.locator('.dh')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        const stepTo = async (T: number): Promise<void> => {
          const now = Number(await page.locator('.dh').getAttribute('data-t'));
          await page.evaluate((ms) => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(ms), Math.round((T - now) * 1000));
          await expect(page.locator('.dh')).toHaveAttribute('data-t', T.toFixed(2));
        };
        for (const [name, T] of DARK) {
          await stepTo(T);
          await frames(page);
          await expectScreenQuality(page, 'strip');
          await page.screenshot({ path: `${DIR}/dark-${name}-${theme}-${size}.png` });
        }
        // past the hand-off the scene keeps drawing under the city while it loads: the fog has filled the screen
        await stepTo(NAVIGATE_AT - 0.05);
        await page.evaluate((ms) => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(ms), Math.round((FOG_FULL + 0.4 - (NAVIGATE_AT - 0.05)) * 1000));
        await expect(page).toHaveURL(/#\/city\/CO$/);
        await frames(page);
        await page.screenshot({ path: `${DIR}/dark-9-handoff-fog-${theme}-${size}.png` });
      });
    });
