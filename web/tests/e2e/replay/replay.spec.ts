// W3 Replay the storm through the real shell (#/replay): every beat at 1440x900 and 390x844 through
// expectScreenQuality, the word budget at every moment of the story, contrast, reduced motion, the play
// control, the 2023 storm, and film readiness (the same ?t= draws the same pixels).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { collectText, wordsIn } from '../harness/collect';
import { shown } from '../harness/numbers';
import { expect, expectContrastAA, expectScreenQuality, expectStillUnderReducedMotion, test, VIEWPORTS } from '../harness/test';

const SHOTS = resolve(process.env['SHOTS_RUN'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'screens', 'replay'));
mkdirSync(SHOTS, { recursive: true });

/** The beats, each a storm instant (UTC) the clock is pinned to. */
const BEATS = {
  start: null,
  departure: '2024-09-23T09:40:00Z', // 10:40 Bath time, twelve minutes after Freshford opened
  arrival: '2024-09-24T08:30:00Z', // 09:30 Bath time, twenty minutes after the 31,000 landed
  timetable: '2024-09-24T08:30:00Z',
  proof: '2024-09-27T20:30:00Z',
} as const;
type Beat = keyof typeof BEATS;

interface ReplayHook {
  duration: number;
  timeAt(s: number): string;
}

const frames = (page: Page, n = 2): Promise<void> =>
  page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = (): void => { if (++i >= k) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);

async function open(page: Page, query: string, hash = ''): Promise<void> {
  await page.goto(`/?theme=night${query}#/replay${hash}`);
  await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await frames(page, 3);
}

/** Folds the river into the timetable; under a manual (film) clock the fold's animation time is stepped. */
async function fold(page: Page, manual = false): Promise<void> {
  await page.locator('.rp-fold').click();
  if (manual) await page.evaluate(() => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(2000));
  await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
  await frames(page, 2);
}

/** The brief's rule: at most 25 words on screen, numbers and times not counted. */
async function expectBriefWordBudget(page: Page): Promise<void> {
  const t = await collectText(page);
  const words = t.visible.filter((r) => !r.time).flatMap((r) => wordsIn(r.text)).filter((w) => !/^[\d,.:()]+$/.test(w));
  expect(words.length, words.join(' ')).toBeLessThanOrEqual(25);
}

const clockText = (page: Page): Promise<string> => page.locator('.rp-clock').innerText();

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const beat of Object.keys(BEATS) as Beat[]) {
      test(`beat: ${beat}`, async ({ page }) => {
        const t = BEATS[beat];
        await open(page, t ? `&t=${t}` : '');
        if (beat === 'timetable') await fold(page);
        await expectScreenQuality(page, 'strip');
        await expectBriefWordBudget(page);
        await expectContrastAA(page);
        await page.screenshot({ path: `${SHOTS}/${beat}-${size}.png` });

        if (beat === 'start') {
          expect(await clockText(page)).toBe('Thu 19 Sep 00:00');
          // a quiet key that stays: what is logged and what is modelled, and the replay's dated name
          await expect(page.locator('.rp-key')).toHaveText('Logged spills. Modelled travel.');
          await expect(page.locator('.rp-river')).toHaveText('2024 replay');
          await expect(page.locator('.rp-voice')).toBeHidden();
        }
        if (beat === 'departure') {
          expect(await clockText(page)).toBe('Mon 23 Sep 10:40');
          const hero = page.locator('.rp-dep-hero');
          await expect(hero).toBeVisible();
          await expect(hero.locator('.rp-dep-t')).toHaveText('10:28');
          await expect(hero.locator('[data-num="warleigh.freshford_distance_km"]')).toHaveText('4.55');
        }
        if (beat === 'arrival') {
          expect(await clockText(page)).toBe('Tue 24 Sep 09:30');
          const n = page.locator('.rp-arr-hero');
          await expect(n).toBeVisible();
          await expect(n).toHaveText('31,000');
          await expect(n).toHaveAttribute('data-src', 'replay_2024-09-23.json#/samples/3/ecoli_per_100ml');
          await expect(page.locator('.rp-unit')).toHaveText('E. coli/100 ml');
          for (const sel of ['.rp-arr-hero', '.rp-clock']) expect(await page.locator(sel).evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Archivo/);
        }
        if (beat === 'timetable') {
          await expect(page.locator('.rp-arr-hero')).toBeVisible();
          await expect(page.locator('.rp-dep-hero')).toBeVisible();
          await expect(page.locator('.rp-key')).toBeVisible();
        }
        if (beat === 'proof') {
          const p = page.locator('.rp-proof-text');
          await expect(p).toBeVisible();
          for (const k of ['warned_exceed', 'warned', 'not_warned_exceed', 'not_warned']) await expect(p.locator(`[data-num="warleigh.rule.freshford.${k}"]`)).toHaveText(shown(`warleigh.rule.freshford.${k}`));
          await expect(p.locator('.rp-pnote')).toContainText('single-sample flag');
          await expect(p.locator('[data-num="thresholds.ecoli_flag_per_100ml"]')).toHaveText('900');
          // the window of the rule is bound to numbers.json like every other number of the proof
          await expect(p.locator('[data-num="warleigh.window_hours"]')).toHaveText('48');
          // the years come first: "43 of 44" is read against 2021–2025
          await expect(p.locator('.rp-pl').first()).toHaveText('2021–2025: within 48 hours after Freshford spilled');
          await expect(p.locator('.rp-pl').first().locator('[data-time]')).toHaveText('2021–2025');
          // the counts read "43 of 44" on screen and to a screen reader alike
          await expect(p.locator('.rp-pn').first()).toHaveText(`${shown('warleigh.rule.freshford.warned_exceed')} of ${shown('warleigh.rule.freshford.warned')}`);
          // figures in Archivo, the house face
          for (const sel of ['.rp-pn', '.rp-pnote']) expect(await p.locator(sel).first().evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Archivo/);
          await expect(page.locator('.rp-clock')).toBeHidden();
        }
      });
    }

    test('the word budget holds at every moment of the story, on the map and in the timetable', async ({ page }) => {
      test.setTimeout(480_000); // about 150 full checks: slow on a busy machine
      await open(page, '&clock=manual&t=2024-09-18T23:00:00Z');
      const hook = await page.evaluate(() => {
        const h = (window as unknown as { __sayrReplay: ReplayHook }).__sayrReplay;
        return { duration: h.duration, times: Array.from({ length: Math.ceil(h.duration / 0.4) + 1 }, (_, i) => h.timeAt(i * 0.4)) };
      });
      expect(hook.duration).toBeGreaterThan(40);
      const check = async (every: number): Promise<void> => {
        for (let i = 0; i < hook.times.length; i += every) {
          await page.evaluate((iso) => (window as unknown as { __sayrClock: { set(d: string): void } }).__sayrClock.set(iso), hook.times[i]!);
          await frames(page, 1);
          await expectScreenQuality(page, 'strip');
          await expectBriefWordBudget(page);
        }
      };
      await check(1);
      // fold with the T key: a click is a touch, which brings the controls back over the proof on purpose
      await page.keyboard.press('t');
      await page.evaluate(() => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(2000));
      await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
      await check(3);
    });
  });
}

test.describe('the storm, beat by beat', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('the 20 Sep readings appear in their time: 1,100 at 15:00, then 200 at 16:00', async ({ page }) => {
    await open(page, '&t=2024-09-20T14:05:00Z');
    await expect(page.locator('.rp-arr', { hasText: /^1,100$/ })).toBeVisible();
    await expect(page.locator('.rp-arr', { hasText: /^200$/ })).toBeHidden();
    await page.screenshot({ path: `${SHOTS}/sep20-desktop.png` });
    await open(page, '&t=2024-09-20T15:05:00Z');
    await expect(page.locator('.rp-arr', { hasText: /^200$/ })).toBeVisible();
    await expect(page.locator('[data-src="replay_2024-09-23.json#/samples/2/ecoli_per_100ml"]')).toHaveText('200');
  });

  test('the 31,000 lands after a beat of silence: nothing before 09:10, the number from 09:10', async ({ page }) => {
    await open(page, '&t=2024-09-24T08:09:00Z');
    await expect(page.locator('.rp-arr-hero')).toBeHidden();
    await page.screenshot({ path: `${SHOTS}/silence-desktop.png` });
    await open(page, '&t=2024-09-24T08:14:00Z');
    await expect(page.locator('.rp-arr-hero')).toBeVisible();
  });

  test('play runs the storm forward from the calm start, and pause holds it', async ({ page }) => {
    await open(page, '');
    expect(await clockText(page)).toBe('Thu 19 Sep 00:00');
    await page.locator('.rp-play').click();
    await page.waitForTimeout(1500);
    const s1 = Number(await page.locator('.rp').getAttribute('data-sigma'));
    expect(s1).toBeGreaterThan(0.8);
    expect(await clockText(page)).not.toBe('Thu 19 Sep 00:00');
    await page.locator('.rp-play').click();
    const held = await page.locator('.rp').getAttribute('data-sigma');
    await page.waitForTimeout(600);
    expect(await page.locator('.rp').getAttribute('data-sigma')).toBe(held);
  });

  test('the day theme keeps every check', async ({ page }) => {
    await page.goto('/?theme=day&t=2024-09-24T08:30:00Z#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => document.fonts.ready);
    await frames(page, 3);
    await expectScreenQuality(page, 'strip');
    await expectContrastAA(page);
    await page.screenshot({ path: `${SHOTS}/arrival-desktop-day.png` });
  });

  test('the 2023 storm replays at #/replay/2023-07-10: 3,100 at 09:00 on 11 Jul', async ({ page }) => {
    await open(page, '&t=2023-07-11T08:25:00Z', '/2023-07-10');
    await expect(page.locator('.rp-voice')).toBeHidden();
    const n = page.locator('.rp-arr-hero');
    await expect(n).toHaveText('3,100');
    await expect(n).toHaveAttribute('data-src', 'replay_2023-07-10.json#/samples/0/ecoli_per_100ml');
    expect(await clockText(page)).toBe('Tue 11 Jul 09:25');
    await expectScreenQuality(page, 'strip');
    await page.screenshot({ path: `${SHOTS}/storm2023-desktop.png` });
  });
});

/** Marks the page so a reload (which would drop the mark) can be told apart from a change in place. */
const markPage = (page: Page): Promise<void> => page.evaluate(() => ((window as unknown as { __kept: number }).__kept = 1, document.querySelector('.rp')!.setAttribute('data-kept', '1')));
const stillSamePage = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept), 'the page reloaded').toBe(1);
  await expect(page.locator('.rp[data-kept="1"]'), 'the scene was mounted again').toHaveCount(1);
};

test.describe('routes inside the page', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('#/replay/timetable, #/replay/2023-07-10, back and forward: the scene follows without a reload', async ({ page }) => {
    await open(page, '');
    await markPage(page);
    await expect(page.locator('.rp')).toHaveAttribute('data-storm', '2024-09-23');
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'map');

    await page.evaluate(() => (location.hash = '#/replay/timetable'));
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
    await stillSamePage(page);

    await page.evaluate(() => (location.hash = '#/replay/2023-07-10'));
    await expect(page.locator('.rp')).toHaveAttribute('data-storm', '2023-07-10');
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'map');
    await expect(page.locator('.rp-river')).toHaveText('2023 replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-sigma', '0.00');
    await stillSamePage(page);

    await page.goBack();
    await expect(page).toHaveURL(/#\/replay\/timetable$/);
    await expect(page.locator('.rp')).toHaveAttribute('data-storm', '2024-09-23');
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
    await expect(page.locator('.rp-river')).toHaveText('2024 replay');
    await page.goBack();
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'map');
    await page.goForward();
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
    await stillSamePage(page);
    await expectScreenQuality(page, 'strip');
  });

  test('the 2023 storm loaded in place shows its own samples, bound to its own file', async ({ page }) => {
    await open(page, '&t=2023-07-11T08:25:00Z');
    await page.evaluate(() => (location.hash = '#/replay/2023-07-10'));
    await expect(page.locator('.rp')).toHaveAttribute('data-storm', '2023-07-10');
    const n = page.locator('.rp-arr-hero');
    await expect(n).toHaveText('3,100');
    await expect(n).toHaveAttribute('data-src', 'replay_2023-07-10.json#/samples/0/ecoli_per_100ml');
    // the 2024 storm's labels are gone, not hidden underneath
    await expect(page.locator('.rp-arr', { hasText: /^31,000$/ })).toHaveCount(0);
    await expectScreenQuality(page, 'strip');
  });

  test('Fold writes the timetable into the hash, and back unfolds it', async ({ page }) => {
    await open(page, '');
    await page.locator('.rp-fold').click();
    await expect(page).toHaveURL(/#\/replay\/timetable$/);
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
    await expect(page.locator('.rp-fold')).toHaveText('Unfold');
    await page.goBack();
    await expect(page).toHaveURL(/#\/replay$/);
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'map');
    await expect(page.locator('.rp-fold')).toHaveText('Fold');
  });
});

test.describe('words the scene teaches', () => {
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    test.describe(size, () => {
      test.use({ viewport });

      test('the controls are words with hit areas of at least 44 by 44 px', async ({ page }) => {
        await open(page, '');
        await expect(page.locator('.rp-play')).toHaveText('Play');
        await expect(page.locator('.rp-fold')).toHaveText('Fold');
        for (const sel of ['.rp-play', '.rp-fold']) {
          const b = (await page.locator(sel).boundingBox())!;
          expect(b.width, sel).toBeGreaterThanOrEqual(44);
          expect(b.height, sel).toBeGreaterThanOrEqual(44);
          expect(b.x + b.width, sel).toBeLessThanOrEqual(viewport.width);
        }
        // they never sit on the shell's credit mark
        const c = (await page.locator('.credit').boundingBox())!;
        const f = (await page.locator('.rp-fold').boundingBox())!;
        expect(f.x + f.width).toBeLessThanOrEqual(c.x);
        await page.locator('.rp-play').click();
        await expect(page.locator('.rp-play')).toHaveText('Pause');
      });

      test('over the proof the controls step aside, and a pointer move or touch brings them back', async ({ page }) => {
        await open(page, '&t=2024-09-27T20:30:00Z');
        await expect(page.locator('.rp-proof-text')).toBeVisible();
        await page.mouse.move(5, 5); // outside the scene's controls: the harness pointer starts off the page
        await page.waitForTimeout(3200);
        await expect(page.locator('.rp-ctrls')).toBeHidden();
        await expectScreenQuality(page, 'strip');
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        await page.mouse.move(viewport.width / 2 + 20, viewport.height / 2 + 10);
        await expect(page.locator('.rp-ctrls')).toBeVisible();
        await expect(page.locator('.rp-play')).toHaveText('Play');
      });

      test('"overflow" beside the first spill, once, then it fades', async ({ page }) => {
        await open(page, '&t=2024-09-20T16:00:00Z'); // 45 minutes after the first overflow opened (15:15 UTC)
        const w = page.locator('.rp-teach-spill');
        await expect(w).toHaveText('overflow');
        await expect(w).toBeVisible();
        await expectScreenQuality(page, 'strip');
        await page.screenshot({ path: `${SHOTS}/teach-overflow-${size}.png` });
        await open(page, '&t=2024-09-23T09:40:00Z'); // Freshford, later spills: the word has gone
        await expect(page.locator('.rp-teach-spill')).toBeHidden();
      });

      test('"lab sample" above the first sample as it lands, once, then it fades', async ({ page }) => {
        await open(page, '&t=2024-09-19T17:00:00Z'); // the 660 of 19 Sep, landed at 16:50 Bath time
        const w = page.locator('.rp-teach-sample');
        await expect(w).toHaveText('lab sample');
        await expect(w).toBeVisible();
        await expect(page.locator('.rp-arr', { hasText: /^660$/ })).toBeVisible();
        // the word sits just above its number
        const wb = (await w.boundingBox())!;
        const nb = (await page.locator('.rp-arr', { hasText: /^660$/ }).boundingBox())!;
        expect(wb.y + wb.height).toBeLessThanOrEqual(nb.y + 2);
        expect(nb.y - (wb.y + wb.height)).toBeLessThan(24);
        await expectScreenQuality(page, 'strip');
        await page.screenshot({ path: `${SHOTS}/teach-sample-${size}.png` });
        await open(page, '&t=2024-09-24T08:30:00Z'); // the 31,000: the word is not taught again
        await expect(page.locator('.rp-teach-sample')).toBeHidden();
      });

      test('the timetable names its axes: time runs down, the water runs downstream to the weir', async ({ page }) => {
        await open(page, '&t=2024-09-24T08:30:00Z', '/timetable');
        await expect(page.locator('.rp-axis-time')).toHaveText('time \u2193');
        await expect(page.locator('.rp-axis-down')).toHaveText('downstream \u2192');
        await expect(page.locator('.rp-axis-time')).toBeVisible();
        await expect(page.locator('.rp-axis-down')).toBeVisible();
        await expectScreenQuality(page, 'strip');
        await expectContrastAA(page);
        await page.screenshot({ path: `${SHOTS}/teach-axes-${size}.png` });
      });
    });
  }
});

test.describe('the shell', () => {
  test.use({ viewport: VIEWPORTS.desktop });
  test('the scene unmounts cleanly and mounts again through the router', async ({ page }) => {
    await open(page, '&t=2024-09-24T08:30:00Z');
    await page.evaluate(() => (location.hash = '#/dark-hours'));
    await expect(page.locator('.rp')).toHaveCount(0);
    await page.evaluate(() => (location.hash = '#/replay'));
    await expect(page.locator('.rp')).toHaveCount(1);
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.rp-arr-hero')).toHaveText('31,000');
  });
});

test.describe('reduced motion', () => {
  test.use({ viewport: VIEWPORTS.desktop });
  test('nothing keeps moving, and every beat still shows its information', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '&t=2024-09-24T08:30:00Z');
    await expectStillUnderReducedMotion(page);
    await expect(page.locator('.rp-arr-hero')).toHaveText('31,000');
    await page.locator('.rp-fold').click();
    await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
    await expectStillUnderReducedMotion(page);
    await expectScreenQuality(page, 'strip');
  });
});

test.describe('film readiness', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  const shotAt = async (page: Page, query: string, hash = ''): Promise<Buffer> => {
    await open(page, query, hash);
    await frames(page, 4);
    return page.screenshot();
  };

  for (const [name, t, hash] of [
    ['mid-storm map', '2024-09-23T12:00:00Z', ''],
    ['the 31,000 in the timetable', '2024-09-24T08:30:00Z', '/timetable'],
  ] as const) {
    test(`the same ?t= draws identical frames: ${name}`, async ({ browser }) => {
      const a = await browser.newPage({ viewport: VIEWPORTS.desktop });
      const b = await browser.newPage({ viewport: VIEWPORTS.desktop });
      const one = await shotAt(a, `&t=${t}`, hash);
      await a.waitForTimeout(700);
      const again = await a.screenshot();
      const two = await shotAt(b, `&t=${t}`, hash);
      expect(Buffer.compare(one, again), 'a pinned frame changed while it stood still').toBe(0);
      expect(Buffer.compare(one, two), 'two loads of the same ?t= differ').toBe(0);
      await a.close();
      await b.close();
    });
  }

  test('__sayrClock.set steps the replay, and returning to a time returns the same frame', async ({ page }) => {
    await open(page, '&clock=manual&t=2024-09-23T09:28:00Z');
    const set = (iso: string): Promise<void> => page.evaluate((d) => (window as unknown as { __sayrClock: { set(x: string): void } }).__sayrClock.set(d), iso);
    await frames(page, 2);
    const a = await page.screenshot();
    expect(await clockText(page)).toBe('Mon 23 Sep 10:28');
    await set('2024-09-24T08:10:00Z');
    await frames(page, 2);
    expect(await clockText(page)).toBe('Tue 24 Sep 09:10');
    await set('2024-09-23T09:28:00Z');
    await frames(page, 2);
    expect(Buffer.compare(a, await page.screenshot())).toBe(0);
  });
});
