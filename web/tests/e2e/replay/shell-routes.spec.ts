// The dark hours through the real shell (this config serves the production build): a hash change moves the
// mounted scene to its beat, back after the hand-off lands on the Garonne, and the scene's own frames stay fog,
// never dark, from its request for the city until the shell has cross-faded it away (measured frame by frame).
import type { Page } from '@playwright/test';
import { BEAT_START, NAVIGATE_AT, RETURN_BEAT } from '../../../src/scenes/darkhours/timeline';
import { expect, test, VIEWPORTS } from '../harness/test';

test.use({ viewport: VIEWPORTS.desktop });

const openDark = async (page: Page, query: string, beat = ''): Promise<void> => {
  await page.goto(`/?theme=night${query}#/dark-hours${beat}`);
  await expect(page.locator('.dh')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
};

test('a hash change moves the dark hours to that beat in place, without mounting it again', async ({ page }) => {
  await openDark(page, '&clock=manual');
  await page.evaluate(() => document.querySelector('.dh')!.setAttribute('data-kept', '1'));
  await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'fall');
  await page.evaluate(() => (location.hash = '#/dark-hours/cities'));
  await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'cities');
  await expect(page.locator('.dh')).toHaveAttribute('data-t', BEAT_START.cities.toFixed(2));
  await page.evaluate(() => (location.hash = '#/dark-hours/storm'));
  await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'storm');
  await page.goBack();
  await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'cities');
  await page.goBack();
  await expect(page.locator('.dh')).toHaveAttribute('data-beat', 'fall');
  await expect(page.locator('.dh[data-kept="1"]')).toHaveCount(1);
});

test('the dark hours never goes dark during its hand-off: from the request for the city until its layer is gone, its frames are fog', async ({ page }) => {
  test.setTimeout(120_000);
  await openDark(page, '&clock=manual', '/end');
  const step = (ms: number): Promise<void> => page.evaluate((m) => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(m), ms);
  const T = async (): Promise<number> => Number(await page.locator('.dh').getAttribute('data-t'));
  await step(Math.round((NAVIGATE_AT + 0.05 - (await T())) * 1000));
  await expect(page).toHaveURL(/#\/city\/CO$/);
  // share of the dark hours' own canvas that is lit (fog, drops), frame by frame while its layer is still up
  const litCanvas = (): Promise<number | null> =>
    page.evaluate(() => {
      const src = document.querySelector<HTMLCanvasElement>('.dh-canvas');
      if (!src) return null;
      const c = document.createElement('canvas');
      c.width = 360;
      c.height = 225;
      const g = c.getContext('2d')!;
      g.drawImage(src, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]! > 8 + 12) n++;
      return n / (d.length / 4);
    });
  const shares: number[] = [];
  for (let k = 0; k < 80; k++) {
    const v = await litCanvas();
    if (v === null) break;
    shares.push(v);
    await step(100);
  }
  test.info().annotations.push({ type: 'lit share of the dark hours per 0.1 s', description: shares.map((v) => v.toFixed(2)).join(' ') });
  expect(shares.length, 'the dark hours left before its fog could show').toBeGreaterThan(0);
  expect(Math.min(...shares), `a dark frame: ${shares.map((v) => v.toFixed(2)).join(' ')}`).toBeGreaterThan(0.3);
});

test('back after the hand-off lands on the Garonne, not the whole scene again', async ({ page }) => {
  test.setTimeout(120_000);
  await openDark(page, '', '/end');
  await expect(page).toHaveURL(/#\/city\/CO$/, { timeout: 20_000 });
  await expect(page.locator('.dh')).toHaveCount(0, { timeout: 60_000 });
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/dark-hours/${RETURN_BEAT}$`));
  await expect(page.locator('.dh')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.dh')).toHaveAttribute('data-beat', RETURN_BEAT);
  expect(Number(await page.locator('.dh').getAttribute('data-t'))).toBeLessThan(BEAT_START.storm + 5);
});
