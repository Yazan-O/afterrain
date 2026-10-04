// The shipped build (vite build + vite preview) through every quality check, in every state of the hero flow
// (rest, morph, strip, figure, quest, fog lift), on Coimbra and Ghent, at both sizes, in night and day, and under
// prefers-reduced-motion; plus keyboard use, the greyscale posture check, the film clock and routing.
// The clock is pinned inside the served forecast (its second hour), when every quest is still to come; the quests
// and their sites come from the served nowcast (tests/e2e/harness/scenario.ts), so a forecast refresh keeps them true.
import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { countWords } from './harness/checks';
import { collectText } from './harness/collect';
import { CO, escapeRe, GH } from './harness/scenario';
import { expect, expectContrastAA, expectScreenQuality, expectStillUnderReducedMotion, snap, test, VIEWPORTS } from './harness/test';

const T = CO.t;
// each city's quest whose lamp shows at rest, on its stream
const CITIES = [
  { id: 'CO', name: 'Coimbra', stream: CO.quest.stream, streamName: CO.quest.streamName, site: CO.quest.site, claim: new RegExp(`^Sample ${escapeRe(CO.quest.site)}${CO.quest.afterRain ? ' after rain' : ''}$`) },
  { id: 'GH', name: 'Ghent', stream: GH.quest.stream, streamName: GH.quest.streamName, site: GH.quest.site, claim: new RegExp(`^Sample ${escapeRe(GH.quest.site)}${GH.quest.afterRain ? ' after rain' : ''}$`) },
] as const;
/** An unmeasured stream says so in its line. */
/** The open stream's first line: the person's sentence (src/model/humanSentence.ts), its fog note when nobody sampled the place after rain. */
const UNMEASURED = /^.+, (\w+day\. Usual chance today\.|(\w+day|from \w+day \d\d:00): (higher|high) chance (after rain|even without rain)\. Keep dogs out until .+\.)( Nobody has measured here after rain\.)?$/;
/**
 * The line after a test reading on the forecast curve: the reading itself, its hour and the place's zone (the
 * dashed and the solid curve say which way the estimate went).
 */
const RESULT = /^Test reading · (900 or less|over 900) · \w{3} \d+ \d\d:00 UTC(\+\d+)?$/;
const THEMES = ['night', 'day'] as const;

const bodyAttr = (page: Page, name: string, value: string, timeout = 60_000) => expect(page.locator('body')).toHaveAttribute(name, value, { timeout });
/** The city is drawn and its basemap and terrain are complete (screenshots wait for this). */
const ready = async (page: Page) => {
  await bodyAttr(page, 'data-ready', 'true', 90_000);
  await expect(page.locator('.city')).toHaveAttribute('data-map', 'idle', { timeout: 60_000 });
  await expect(page.locator('.city')).toHaveAttribute('data-camera', 'settled', { timeout: 30_000 });
};
const inState = (page: Page, s: string) => bodyAttr(page, 'data-state', s);
const voice = (page: Page) => page.locator('.voice');
const sayr = <R>(page: Page, fn: string, ...args: unknown[]): Promise<R> =>
  page.evaluate(([f, a]) => (window.sayr![f as string] as (...x: unknown[]) => R)(...(a as unknown[])), [fn, args] as const);

async function check(page: Page, state: 'rest' | 'strip', label?: string): Promise<void> {
  await expectScreenQuality(page, state);
  await expectContrastAA(page);
  if (label) {
    // the visible word count of each shot, for the record (screens/word-counts.jsonl)
    const w = countWords(await collectText(page));
    mkdirSync('screens', { recursive: true });
    appendFileSync('screens/word-counts.jsonl', `${JSON.stringify({ shot: label, budget: state, words: w.count, text: w.words.join(' ') })}
`);
  }
}

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const city of CITIES)
      for (const theme of THEMES) {
        test(`${city.name}, ${theme}: rest, morph, strip, figure, quest and fog lift pass every check`, async ({ page }, info) => {
          test.setTimeout(180_000);
          const name = (s: string) => `${city.id}-${theme}-${size}-${s}`;
          await page.goto(`/?t=${T}&theme=${theme}#/city/${city.id}`);
          await ready(page);
          await inState(page, 'rest');
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('.city-btn')).toHaveText(city.name);
          await expect(page.locator('.hour')).toHaveText(/^\d\d:00$/);
          await check(page, 'rest', name('1-rest'));
          await snap(page, info, name('1-rest'));

          // morph: the stream lifts off the map and straightens
          await page.evaluate((s) => void (window.sayr!['open'] as (x: string) => Promise<void>)(s), city.stream);
          await page.waitForFunction(() => document.body.dataset['state'] !== 'rest', null, { polling: 'raf' });
          // the morph lasts about a second: a loaded machine may already be past it
          if ((await page.locator('body').getAttribute('data-state')) === 'opening') {
            await page.waitForTimeout(500);
            await check(page, 'strip', name('2-morph'));
            await snap(page, info, name('2-morph'));
          } else info.annotations.push({ type: 'morph', description: 'the morph ended before it could be checked' });

          await inState(page, 'strip');
          await expect(page).toHaveURL(new RegExp(`#/city/${city.id}/stream/${city.stream}$`));
          await expect(voice(page)).toHaveText(UNMEASURED);
          await page.waitForTimeout(900);
          await check(page, 'strip', name('3-strip'));
          await snap(page, info, name('3-strip'));

          // "Hours": the spatial strip in the curve's place, then back to the curve
          await page.locator('.hoursb').click();
          await expect(page.locator('.hoursb')).toHaveAttribute('aria-pressed', 'true');
          await expect(page.locator('canvas.stripc')).toHaveAttribute('aria-orientation', 'vertical');
          await page.waitForTimeout(700);
          await check(page, 'strip', name('4-hours'));
          await snap(page, info, name('4-hours'));
          await page.locator('.hoursb').click();
          await expect(page.locator('.hoursb')).toHaveAttribute('aria-pressed', 'false');

          // the quest's lamp: the site, after rain when it is, its sampling window, and the test it offers
          await page.locator('.questbtn').click();
          await expect(voice(page)).toHaveText(city.claim);
          await expect(page.locator('.questui .win')).toHaveText(/^\w{3} \d+ \w{3} \d\d:00–.* UTC(\+\d+)?$/);
          await expect(page.locator('.questui .add')).toHaveText('Try a test reading');
          await page.waitForTimeout(600);
          await check(page, 'strip', name('5-quest'));
          await snap(page, info, name('5-quest'));
          // then the choices, said as a test, with the hour, the unit and the flag once
          await page.locator('.questui .add').click();
          await expect(voice(page)).toHaveText(`Test reading at ${city.site}`);
          await expect(page.locator('.questui .when')).toHaveText(/^\w{3} \d+ \w{3} \d\d:00 UTC/);
          await expect(page.locator('.questui .unit')).toHaveText('E. coli/100 ml · single-sample flag');
          await page.waitForTimeout(600);
          await check(page, 'strip', name('5b-kit'));
          await snap(page, info, name('5b-kit'));

          // the reading goes through the engine's update: the field changes out from the place, then the line says how
          await page.getByRole('button', { name: /or less/ }).click();
          await expect(page.locator('.questui .tested')).toHaveText(/^Test reading · 900 or less · /);
          await expect(voice(page)).toHaveText(RESULT, { timeout: 5000 });
          // "Test reading" stays on screen: it is not a lab result
          await expect(voice(page)).toBeVisible();
          // the value never sits on a curve
          expect((await sayr<{ hitsCurve: boolean }>(page, 'readouts')).hitsCurve).toBe(false);
          expect(await sayr<{ revision: number }>(page, 'info')).toMatchObject({ revision: 1 });
          await page.waitForTimeout(800);
          await check(page, 'strip', name('6-lifted'));
          await snap(page, info, name('6-lifted'));

          // the line folds back into the map
          await page.keyboard.press('Escape');
          await inState(page, 'rest');
          await expect(page).toHaveURL(new RegExp(`#/city/${city.id}$`));
          await check(page, 'rest');
        });
      }

    test('the day and night switch works at rest and on the strip', async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.goto(`/?t=${T}&theme=night#/city/CO`);
      await ready(page);
      await page.locator('.mode').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
      await expect(page.locator('.mode')).toHaveAttribute('aria-label', 'Switch to night');
      await page.waitForTimeout(800);
      await check(page, 'rest');
      await sayr(page, 'open', CO.quest.stream);
      await inState(page, 'strip');
      await page.locator('.mode').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
      await page.waitForTimeout(600);
      await check(page, 'strip');
      await snap(page, info, `CO-switch-${size}-strip-night`);
    });

    test.describe('prefers-reduced-motion', () => {
      test.use({ reducedMotion: 'reduce' });

      test('rest and strip are still frames that pass every check', async ({ page }, info) => {
        test.setTimeout(120_000);
        await page.goto(`/?t=${T}&theme=night#/city/CO`);
        await ready(page);
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
        await expectStillUnderReducedMotion(page);
        await check(page, 'rest');
        await snap(page, info, `CO-night-${size}-rest-reduced-motion`);
        await sayr(page, 'open', CO.quest.stream);
        await inState(page, 'strip');
        await expect(voice(page)).toHaveText(UNMEASURED);
        await expectStillUnderReducedMotion(page);
        await check(page, 'strip');
        await snap(page, info, `CO-night-${size}-strip-reduced-motion`);
      });
    });

    test('the four at the stream are one fixed scene: the same poses before and after a low and a high test, and none is a control', async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.goto(`/?t=${T}&theme=night#/city/CO`);
      await ready(page);
      await sayr(page, 'open', CO.quest.stream, true);
      await inState(page, 'strip');
      await page.waitForTimeout(900);
      const poses = () => page.locator('.fig').evaluateAll((es) => es.map((e) => e.innerHTML));
      const before = await poses();
      expect(before).toHaveLength(4);
      expect(new Set(before).size).toBe(4);
      await expect(page.locator('.figs')).toHaveAttribute('aria-label', /a child, an adult, a dog and a heron/);
      expect(await page.locator('.figs button, .fig[tabindex], .fig[role="button"]').count()).toBe(0);
      expect(await page.locator('.fig').evaluateAll((es) => es.map((e) => getComputedStyle(e).pointerEvents))).toEqual(['none', 'none', 'none', 'none']);
      for (const over of [false, true]) {
        await sayr(page, 'sample', over);
        await expect(page.locator('.questui .reset')).toBeVisible({ timeout: 10_000 });
        // one scene whatever the reading: no figure takes a pose of its own
        expect(await poses()).toEqual(before);
        if (!over) await page.locator('.questui .reset').click();
      }
      await snap(page, info, `CO-figures-${size}`);
    });

  });
}

test.describe('keyboard and screen readers (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('streams and the quest are reachable by keyboard, with the state words in their labels', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    const nav = page.getByRole('navigation', { name: 'Coimbra streams' });
    await expect(nav.getByRole('button')).toHaveCount(await page.evaluate(() => (window.sayr!['streams'] as () => unknown[])().length));
    const eiras = nav.getByRole('button').nth(await page.evaluate((slug) => (window.sayr!['streams'] as () => { slug: string }[])().findIndex((s) => s.slug === slug), CO.quest.stream));
    const named = escapeRe(CO.quest.streamName);
    await expect(eiras).toHaveAccessibleName(new RegExp(`^${named}: (unknown, best guess (usual|higher|high)|usual|higher|high)\\. Open its hours ahead\\.$`));
    await eiras.focus();
    await page.keyboard.press('Enter');
    await inState(page, 'strip');
    const quest = page.getByRole('button', { name: new RegExp(`^Quest at ${escapeRe(CO.quest.site)}\\. `) });
    await expect(quest).toBeVisible();
    // "Hours" is a control in the tab order
    await page.locator('.hoursb').focus();
    await expect(page.locator('.hoursb')).toBeFocused();
    await quest.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Try a test reading' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Test reading: nine hundred .* or less/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(voice(page)).toHaveText(RESULT, { timeout: 5000 });
    // the buttons that had focus are gone: the result line has it, and the result's controls follow it
    await expect(voice(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'Reset test' })).toBeVisible();
    await page.keyboard.press('Escape');
    await inState(page, 'rest');
    await expect(eiras).toBeFocused();
    await expect(eiras).toHaveAccessibleName(new RegExp(`^${named}: `));
    await check(page, 'rest');
  });

  test('the city switcher opens with the keyboard, stays within the rest budget, and changes city', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    await page.locator('.city-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cities')).toBeVisible();
    await expect(page.locator('.cities a')).toHaveText(['Benevento', 'Ghent', 'Oslo', 'Toulouse']);
    await check(page, 'rest');
    await page.locator('.cities a', { hasText: 'Oslo' }).click();
    await expect(page).toHaveURL(/#\/city\/OS$/);
    await ready(page);
    await expect(page.locator('.city-btn')).toHaveText('Oslo');
    await check(page, 'rest');
  });
});

test.describe('film clock and routing (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('?clock=manual: nothing moves until stepped; set() moves the hour and the stream state with it', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}&theme=night&clock=manual#/city/CO`);
    await expect.poll(() => page.evaluate(() => window.__sayrClock!.mode)).toBe('manual');
    // Anim time only advances by step(): step until the scene is ready
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.__sayrClock!.step(250));
          return page.evaluate(() => document.body.dataset['ready']);
        },
        { timeout: 90_000, intervals: [50] },
      )
      .toBe('true');
    const hour = await page.locator('.hour').textContent();
    await page.waitForTimeout(1000);
    expect(await page.locator('.hour').textContent()).toBe(hour);
    // a day later the hour in the corner says the city's local hour
    const later = new Date(Date.parse(T) + 24 * 3.6e6 + 2 * 3.6e6);
    await page.evaluate((iso) => window.__sayrClock!.set(iso), later.toISOString());
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: CO.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(later);
    await expect(page.locator('.hour')).toHaveText(local);
    const nav = page.getByRole('navigation', { name: 'Coimbra streams' });
    await expect(nav.getByRole('button', { name: new RegExp(`^${escapeRe(CO.quest.streamName)}: `) })).toHaveCount(1);
  });

  test('a deep link opens its stream, and an unknown route falls back to Coimbra', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}&theme=night#/city/GH/stream/zwalmbeek`);
    await ready(page);
    await inState(page, 'strip');
    await expect(page.locator('.back .nm')).toHaveText('Zwalmbeek');
    await check(page, 'strip');
    await page.goto(`/?t=${T}&theme=night#/nowhere`);
    await ready(page);
    await expect(page.locator('.city-btn')).toHaveText('Coimbra');
    await expect(page).toHaveURL(/#\/city\/CO$/);
  });
});
