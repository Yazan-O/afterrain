// W3 round 3 through the real shell: the proof stays with "Now see Coimbra" beneath it (never replaced, never on
// the timetable), the fold after the end keeps its axis words and names the way back to the proof, "overflow water"
// teaches the travelling light, and the storm holds still under an x-ray card and under a finger resting on a number.
import type { Page } from '@playwright/test';
import { collectText, wordsIn } from '../harness/collect';
import { CO } from '../harness/scenario';
import { expect, expectContrastAA, expectScreenQuality, test, VIEWPORTS } from '../harness/test';

interface ReplayHook {
  duration: number;
  timeAt(s: number): string;
  sigmaAt(iso: string): number;
  waterAt: number | null;
}

const END = '2024-09-27T23:00:00Z'; // the last instant of the 2024 replay window

const frames = (page: Page, n = 2): Promise<void> =>
  page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = (): void => { if (++i >= k) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);

async function open(page: Page, query: string, hash = ''): Promise<void> {
  await page.goto(`/?theme=night${query}#/replay${hash}`);
  await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await frames(page, 3);
}

const opacity = (page: Page, sel: string): Promise<number> =>
  page.locator(sel).first().evaluate((e) => {
    let o = getComputedStyle(e).visibility === 'visible' ? 1 : 0;
    for (let x: Element | null = e; x; x = x.parentElement) o *= Number(getComputedStyle(x).opacity);
    return o;
  });


const visibleWords = async (page: Page): Promise<string[]> => (await collectText(page)).visible.flatMap((r) => wordsIn(r.text));
const sigma = async (page: Page): Promise<number> => Number(await page.locator('.rp').getAttribute('data-sigma'));
const hook = (page: Page): Promise<ReplayHook> =>
  page.evaluate(() => {
    const h = (window as unknown as { __sayrReplay: ReplayHook }).__sayrReplay;
    return { duration: h.duration, waterAt: h.waterAt } as ReplayHook;
  });
const timeAt = (page: Page, s: number): Promise<string> => page.evaluate((x) => (window as unknown as { __sayrReplay: ReplayHook }).__sayrReplay.timeAt(x), s);

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('the proof stays on screen after the storm, and "Now see Coimbra" comes beneath it, not in its place', async ({ page }) => {
      test.setTimeout(90_000);
      await open(page, `&t=${END}`);
      const onward = page.locator('button.onward');
      await expect(onward).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1500); // the line's fade in
      const proof = page.locator('.rp-proof-text');
      expect(await opacity(page, '.rp-proof-text')).toBeGreaterThan(0.95);
      const words = await visibleWords(page);
      for (const w of ['2021–2025', 'within', '43', 'of', '44', 'Otherwise', '102', '278', 'Now', 'Coimbra']) expect(words, words.join(' ')).toContain(w);
      // beneath the proof, aligned with it, on the screen
      const pb = (await proof.boundingBox())!;
      const ob = (await onward.boundingBox())!;
      expect(ob.y).toBeGreaterThanOrEqual(pb.y + pb.height - 1);
      expect(Math.abs(ob.x - pb.x)).toBeLessThan(12);
      expect(ob.y + ob.height).toBeLessThanOrEqual(viewport.height - 40);
      await expectScreenQuality(page, 'strip');
      await expectContrastAA(page);
      // round 2's regression: the proof left after six seconds. It is still there well after that.
      await page.waitForTimeout(8000);
      expect(await opacity(page, '.rp-proof-text')).toBeGreaterThan(0.95);
      await expect(onward).toBeVisible();
      await expect(onward).toHaveText('Now see Coimbra');
    });

    test('folded after the end: the timetable keeps its axis words, the way back names the proof, "Now see Coimbra" stays off the chart', async ({ page }) => {
      test.setTimeout(90_000);
      await open(page, `&t=${END}`);
      await expect(page.locator('button.onward')).toBeVisible({ timeout: 20_000 });
      await page.keyboard.press('t');
      await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'timetable');
      await page.waitForTimeout(1200);
      await expect(page.locator('.rp-fold')).toHaveText('Proof');
      await expect(page.locator('button.onward')).toBeHidden();
      expect(await opacity(page, '.rp-proof-text')).toBeLessThan(0.05);
      await expect(page.locator('.rp-axis-time')).toHaveText('time ↓');
      await expect(page.locator('.rp-axis-down')).toHaveText('downstream →');
      await expectScreenQuality(page, 'strip');
      // they stay: the storm has ended, so the timetable is the thing being read
      await page.waitForTimeout(6000);
      expect(await opacity(page, '.rp-axis-time')).toBeGreaterThan(0.9);
      expect(await opacity(page, '.rp-axis-down')).toBeGreaterThan(0.9);
      // the way back: the proof returns, and "Now see Coimbra" with it, beneath
      await page.locator('.rp-fold').click();
      await expect(page.locator('.rp')).toHaveAttribute('data-fold', 'map');
      await expect(page.locator('button.onward')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1200);
      expect(await opacity(page, '.rp-proof-text')).toBeGreaterThan(0.95);
      await expectScreenQuality(page, 'strip');
    });

    test('"overflow water" is taught once, beside the first plume whose light stays long enough to read, then fades', async ({ page }) => {
      await open(page, '&clock=manual&t=2024-09-18T23:00:00Z');
      const h = await hook(page);
      expect(h.waterAt, 'a plume long enough to teach the word').not.toBeNull();
      const w = page.locator('.rp-teach-water');
      await expect(w).toHaveText('overflow water');
      for (const [ds, shown] of [[-0.3, false], [0.5, true], [2.5, true], [5.5, false]] as const) {
        const iso = await timeAt(page, h.waterAt! + ds);
        await page.evaluate((d) => (window as unknown as { __sayrClock: { set(x: string): void } }).__sayrClock.set(d), iso);
        await frames(page, 2);
        if (shown) {
          expect(await opacity(page, '.rp-teach-water'), `at +${ds}`).toBeGreaterThan(0.9);
          // beside the light: the river under the word's anchor is lit in the plume's warm colour
          const b = (await w.boundingBox())!;
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
          await expectScreenQuality(page, 'strip');
        } else expect(await opacity(page, '.rp-teach-water'), `at +${ds}`).toBeLessThan(0.1);
      }
    });
  });
}

test.describe('the storm holds still while it is being turned over', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('an x-ray card pauses the playing storm, and closing it plays on', async ({ page }) => {
    await open(page, '');
    await page.locator('.rp-play').click();
    await page.waitForTimeout(1200);
    await expect(page.locator('.rp-play')).toHaveText('Pause');
    await page.mouse.move(2, 2);
    await page.keyboard.press('x'); // the largest thing on screen that turns over: the weir or a sample
    await expect(page.locator('body')).toHaveClass(/xr-open/, { timeout: 10_000 });
    await expect(page.locator('.rp')).toHaveAttribute('data-held', 'true');
    const s0 = await sigma(page);
    await page.waitForTimeout(1200);
    expect(await sigma(page), 'the storm moved behind the card').toBe(s0);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/xr-open/, { timeout: 10_000 });
    await expect(page.locator('.rp')).toHaveAttribute('data-held', 'false');
    await page.waitForTimeout(1000);
    expect(await sigma(page), 'the storm did not play on').toBeGreaterThan(s0 + 0.3);
  });

  test('a paused storm stays paused after the card closes', async ({ page }) => {
    await open(page, '');
    await page.locator('.rp-play').click();
    await page.waitForTimeout(900);
    await page.locator('.rp-play').click();
    await expect(page.locator('.rp-play')).toHaveText('Play');
    const s0 = await sigma(page);
    expect(s0).toBeGreaterThan(0.3);
    await page.mouse.move(2, 2);
    await page.keyboard.press('x');
    await expect(page.locator('body')).toHaveClass(/xr-open/, { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/xr-open/, { timeout: 10_000 });
    await page.waitForTimeout(800);
    expect(await sigma(page)).toBe(s0);
  });

  test('during a cross-fade the outgoing number keeps its place and the incoming never covers it: a long press turns over the one under the finger', async ({ page }) => {
    await open(page, '&clock=manual&t=2024-09-18T23:00:00Z');
    // the 6,500 fading as the 8,300 lands on the pile above it
    const t = await page.evaluate(async () => {
      const h = (window as unknown as { __sayrReplay: ReplayHook }).__sayrReplay;
      const pack = (await (await fetch('/data/replay_2024-09-23.json')).json()) as { samples: { time_utc: string; ecoli_per_100ml: number }[] };
      const next = pack.samples.find((s) => s.ecoli_per_100ml === 8300)!;
      return h.timeAt(h.sigmaAt(next.time_utc) + 0.15);
    });
    await page.evaluate((d) => (window as unknown as { __sayrClock: { set(x: string): void } }).__sayrClock.set(d), t);
    await frames(page, 3);
    const out = page.locator('.rp-arr', { hasText: /^6,500$/ });
    const inc = page.locator('.rp-arr', { hasText: /^8,300$/ });
    const oOut = await out.evaluate((e) => Number(e.style.opacity));
    const oIn = await inc.evaluate((e) => Number(e.style.opacity));
    expect(oOut, 'the outgoing number can still be turned over').toBeGreaterThan(0.3);
    expect(oIn, 'the incoming number is on screen').toBeGreaterThan(0.3);
    const a = (await out.boundingBox())!;
    const b = (await inc.boundingBox())!;
    // the x-ray's hit area is each box plus 6 px: the two never overlap
    const gap = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
    expect(gap, 'the incoming number sits over the outgoing one').toBeGreaterThan(12);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    // the film clock (?clock=manual) drives the card's turn too: step it through the turn
    await expect(page.locator('body')).toHaveClass(/xr-open/, { timeout: 10_000 });
    for (let k = 0; k < 20; k++) await page.evaluate(() => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(60));
    const card = page.locator('.xr-back');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('.xr-hot')).toContainText('6500');
  });

  test('a finger resting on a number holds the playing storm until it lifts', async ({ page }) => {
    await open(page, '&t=2024-09-24T07:00:00Z&rate=1200'); // the clock runs: the storm moves on its own
    await expect(page.locator('.rp-arr-hero')).toBeVisible({ timeout: 30_000 });
    const box = (await page.locator('.rp-arr-hero').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.locator('.rp')).toHaveAttribute('data-held', 'true');
    const s0 = await sigma(page);
    await page.waitForTimeout(200);
    expect(await sigma(page)).toBe(s0);
    await page.mouse.up();
    // a slow machine may have let the x-ray's long press (480 ms) turn the number over: the card holds it too
    if (await page.evaluate(() => document.body.classList.contains('xr-open'))) {
      expect(await sigma(page)).toBe(s0);
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('.rp')).toHaveAttribute('data-held', 'false');
    await page.waitForTimeout(600);
    expect(await sigma(page)).toBeGreaterThan(s0);
  });
});

test.describe('story mode', () => {
  for (const [size, viewport] of Object.entries(VIEWPORTS))
    test(`${size}: the storm in the story keeps its key and its dated name on screen with the 31,000, within the word budget`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await page.goto(`/?theme=night&clock=manual&t=${CO.t}#/story/sample`);
      const story = (): Promise<{ chapter: string; beat: string; local: number; waiting: boolean; beats: { id: string; at: number }[] } | null> =>
        page.evaluate(() => (window as unknown as { __sayrStory?: never }).__sayrStory ?? null);
      await expect.poll(async () => (await story())?.beats.some((b) => b.id === 'sample') ?? false, { timeout: 60_000 }).toBe(true);
      const at = (await story())!.beats.find((b) => b.id === 'sample')!.at;
      for (let k = 0; k < 2000; k++) {
        const s = await story();
        if (s && s.chapter === 'storm' && !s.waiting && s.local >= at + 3.6) break;
        await page.evaluate((m) => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(m), s && s.chapter === 'storm' && !s.waiting ? 50 : 100);
      }
      await page.evaluate(() => document.fonts.ready);
      await frames(page, 3);
      await expect(page.locator('.rp-arr-hero')).toHaveText('31,000');
      expect(await opacity(page, '.rp-key')).toBeGreaterThan(0.5);
      const words = await visibleWords(page);
      for (const w of ['Logged', 'Modelled', '2024', 'replay']) expect(words, words.join(' ')).toContain(w);
      await expectScreenQuality(page, 'story');
    });
});
