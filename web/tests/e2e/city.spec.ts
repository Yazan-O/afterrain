// The city and its strip under what reviewers found: the fog-lift close that once stopped every animation,
// scrubbing the storm, the quest's reachability and its claim, the way back, touch targets, bad links, a dated
// forecast, a missing forecast, and the link and the screen staying in step through animations.
// Every screen passes expectScreenQuality (word budget, provenance, the banned word, no horizontal scroll) and,
// where it is shot, waits for the basemap and terrain to be complete.
import type { Page } from '@playwright/test';
import { CO, escapeRe } from './harness/scenario';
import { expect, expectContrastAA, expectScreenQuality, snap, test, VIEWPORTS } from './harness/test';

// the clock inside the served forecast; the quest's stream from the served nowcast (harness/scenario.ts)
const T = CO.t;
const QS = CO.quest.stream;
const THEMES = ['night', 'day'] as const;

const ready = async (page: Page): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
  await expect(page.locator('.city')).toHaveAttribute('data-map', 'idle', { timeout: 60_000 });
  // the opening glide from the close framing to the quest's has ended (or was not needed)
  await expect(page.locator('.city')).toHaveAttribute('data-camera', 'settled', { timeout: 30_000 });
};
const inState = (page: Page, s: string, timeout = 60_000) => expect(page.locator('body')).toHaveAttribute('data-state', s, { timeout });
const voice = (page: Page) => page.locator('.voice');
const sayr = <R>(page: Page, fn: string, ...args: unknown[]): Promise<R> =>
  page.evaluate(([f, a]) => (window.sayr![f as string] as (...x: unknown[]) => R)(...(a as unknown[])), [fn, args] as const);
const check = async (page: Page, state: 'rest' | 'strip'): Promise<void> => {
  await expectScreenQuality(page, state);
  await expectContrastAA(page);
};

test.describe('the fog lift (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('closing the strip during the fog lift leaves every animation running', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    await sayr(page, 'open', QS);
    await inState(page, 'strip');
    await page.locator('.questbtn').click();
    await page.locator('.questui .add').click();
    await page.getByRole('button', { name: /or less/ }).click();
    await page.waitForTimeout(700); // mid-lift
    await page.keyboard.press('Escape');
    await inState(page, 'rest');
    await expect(page).toHaveURL(/#\/city\/CO$/);
    // the frame loop still turns: the scene counts its frames
    await sayr(page, 'perf');
    await page.waitForTimeout(600);
    expect((await sayr<{ frames: number }>(page, 'perf')).frames).toBeGreaterThan(3);
    // the sample stayed; another stream opens as usual
    expect(await sayr<{ revision: number }>(page, 'info')).toMatchObject({ revision: 1 });
    await sayr(page, 'open', 'ribeira-de-coselhas');
    await inState(page, 'strip');
    await check(page, 'strip');
  });
});

for (const [size, viewport] of Object.entries(VIEWPORTS))
  for (const theme of THEMES)
    test.describe(`${size} ${viewport.width}x${viewport.height}, ${theme}`, () => {
      test.use({ viewport });

      test('scrub the storm: dragging along the forecast curve sets the hour, the value follows clear of the curves, the line and the sentence follow', async ({ page }, info) => {
        test.setTimeout(150_000);
        await page.goto(`/?t=${T}&theme=${theme}#/city/CO`);
        await ready(page);
        await sayr(page, 'open', QS);
        await inState(page, 'strip');
        await page.waitForTimeout(700);
        const f = (await sayr<{ x0: number; x1: number; y0: number; y1: number }>(page, 'field'))!;
        const storm = await sayr<number>(page, 'stormRow');
        expect(storm).toBeGreaterThan(0); // the forecast's storm is inside the strip
        // the whole forecast is on screen: its last hour's point lies inside the curve's box, no scrolling
        const last = (await sayr<[number, number]>(page, 'hourPoint', (await sayr<{ span: number }>(page, 'info')).span))!;
        expect(last[0]).toBeLessThanOrEqual(f.x1 + 0.5);
        expect(last[0]).toBeLessThanOrEqual(viewport.width);
        const [tx] = (await sayr<[number, number]>(page, 'hourPoint', storm + 8))!;
        const y = (f.y0 + f.y1) / 2;
        await page.mouse.move(f.x0 + 4, y);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) await page.mouse.move(f.x0 + 4 + ((tx - f.x0 - 4) * i) / 12, y);
        await page.mouse.up();
        await expect(voice(page)).toHaveText(/^\w+day \d\d:00\. (The rain (may be )?arriving|Rain (may be )?running through me|I('m| may be) running high)\. Keep dogs (out|on the bank)\.$/);
        // the selected hour with its date, and its value beside its dot, never on a curve
        await expect(page.locator('.tick.scrub')).toHaveText(/^\d+ \w{3} \d\d:00 UTC([+-]\d+)?$/);
        await expect(page.locator('.tick.est')).toHaveText(/^\d+\.\d%$/);
        expect((await sayr<{ hitsCurve: boolean }>(page, 'readouts')).hitsCurve).toBe(false);
        await page.waitForTimeout(900);
        await check(page, 'strip');
        await snap(page, info, `city-scrub-${size}-${theme}`);
        // the keys: Home back to now (the stream's own sentence), arrows an hour at a time
        await page.keyboard.press('Home');
        await expect(voice(page)).not.toHaveText(/^\w+day \d\d:00\. /);
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
        await expect(voice(page)).toHaveText(/^\w+day \d\d:00\. /);
        await expect(page.locator('canvas.stripc')).toHaveAttribute('aria-valuenow', '3');
        await check(page, 'strip');
        // "Hours": the same hour on the spatial strip, the arrows still an hour at a time
        await page.locator('.hoursb').click();
        await expect(page.locator('canvas.stripc')).toHaveAttribute('aria-orientation', 'vertical');
        await page.locator('canvas.stripc').focus();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('canvas.stripc')).toHaveAttribute('aria-valuenow', '4');
        await page.waitForTimeout(600);
        await check(page, 'strip');
      });

      test('the quest is one lamp on screen: one tap opens its strip on the quest, whose claim is true', async ({ page }, info) => {
        test.setTimeout(150_000);
        await page.goto(`/?t=${T}&theme=${theme}#/city/CO`);
        await ready(page);
        const W = viewport.width,
          H = viewport.height;
        // after the opening glide, quest #1's lamp is on screen, clear of the corners' words
        const lamps = await sayr<{ rank: number; strip: string | null; x: number; y: number }[]>(page, 'questLamps');
        const first = lamps.find((q) => q.rank === 0)!;
        expect(first.strip).not.toBeNull();
        expect(first.x).toBeGreaterThan(30);
        expect(first.x).toBeLessThan(W - 30);
        expect(first.y).toBeGreaterThan(H * 0.12);
        expect(first.y).toBeLessThan(H - 110);
        expect(await sayr<number>(page, 'questRank')).toBe(0); // the lamp is the city's quest #1
        const [qx, qy] = (await sayr<[number, number]>(page, 'restQuestPoint'))!;
        await page.mouse.click(qx, qy);
        await inState(page, 'strip');
        await expect(page).toHaveURL(new RegExp(`#/city/CO/stream/${QS}$`));
        await expect(voice(page)).toHaveText(new RegExp(`^Sample ${escapeRe(CO.quest.site)}${CO.quest.afterRain ? ' after rain' : ''}$`));
        await expect(page.locator('.questui .add')).toHaveText('Try a test reading');
        await page.waitForTimeout(600);
        await check(page, 'strip');
        await snap(page, info, `city-quest-${size}-${theme}`);
        // every other quest is reachable on its own strip
        for (const l of lamps.filter((q) => q.strip && q.rank > 0)) {
          await page.keyboard.press('Escape');
          await inState(page, 'rest');
          await sayr(page, 'open', l.strip!);
          await inState(page, 'strip');
          await page.locator('.questbtn').click();
          await expect(voice(page)).toHaveText(/^Sample .+$/);
          await check(page, 'strip');
        }
      });

      test('the way back: the stream name with an arrow, 44 px tall, and only the map area folds the strip', async ({ page }) => {
        test.setTimeout(120_000);
        await page.goto(`/?t=${T}&theme=${theme}#/city/CO/stream/${QS}`);
        await ready(page);
        await inState(page, 'strip');
        const back = page.locator('.back');
        await expect(back).toBeVisible();
        await expect(back.locator('.nm')).toHaveText(CO.quest.streamName);
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        // a tap on the hours scrubs; it never closes the strip
        const f = (await sayr<{ x0: number; x1: number; y0: number; y1: number }>(page, 'field'))!;
        await page.mouse.click((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
        await inState(page, 'strip');
        await back.click();
        await inState(page, 'rest');
        await expect(page).toHaveURL(/#\/city\/CO$/);
        await check(page, 'rest');
      });

      test('every control is at least 44 px: day and night, the credits, "Hours"', async ({ page }) => {
        test.setTimeout(120_000);
        await page.goto(`/?t=${T}&theme=${theme}#/city/CO/stream/${QS}`);
        await ready(page);
        await inState(page, 'strip');
        await page.waitForTimeout(700);
        for (const sel of ['.mode', '.credit', '.hoursb']) {
          const b = (await page.locator(sel).boundingBox())!;
          expect(b.width, sel).toBeGreaterThanOrEqual(44);
          expect(b.height, sel).toBeGreaterThanOrEqual(44);
        }
      });
    });

test.describe('links, queries and the forecast (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('bad links and queries open the app with defaults, and the link is corrected to what the screen shows', async ({ page }) => {
    test.setTimeout(240_000);
    for (const [url, hash] of [
      [`/?t=nonsense#/city/CO`, /#\/city\/CO$/],
      [`/?t=${T}&theme=blue#/city/CO`, /#\/city\/CO$/],
      [`/?t=${T}&rate=-5#/city/CO`, /#\/city\/CO$/],
      [`/?t=${T}#/city/CO/stream/nope`, /#\/city\/CO$/],
      [`/?t=${T}#/city/CO/stream/%E0%A4%A`, /#\/city\/CO$/],
      [`/?t=${T}#/city/xx`, /#\/city\/CO$/],
    ] as const) {
      await page.goto(url);
      await ready(page);
      await inState(page, 'rest');
      await expect(page).toHaveURL(hash);
      await check(page, 'rest');
    }
    await page.goto(`/?t=${T}#/replay/1999-01-01`);
    await expect(page).toHaveURL(/#\/replay$/);
    await expect(page).toHaveTitle('AfterRain: the storm replayed');
  });

  test('a ?t without a zone is read as UTC', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T.replace(/(:00)?Z$/, '')}&theme=night#/city/CO`);
    await ready(page);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: CO.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(T));
    await expect(page.locator('.hour')).toHaveText(local);
  });

  test('a forecast that no longer covers the clock is dated in the corner and never shown as now', async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${CO.dated}&theme=night#/city/CO`);
    await ready(page);
    await expect(page.locator('.hour')).toHaveText(`forecast ${CO.fetched}`);
    await check(page, 'rest');
    await snap(page, info, 'city-dated-rest-desktop-night');
    await sayr(page, 'open', QS);
    await inState(page, 'strip');
    // the quest's ask is dated too
    await page.locator('.questbtn').click();
    await expect(voice(page)).toHaveText(new RegExp(`^Forecast of ${CO.fetched}: Sample `));
    await expect(voice(page)).not.toHaveText(/tonight|tomorrow|this (morning|afternoon|evening)/);
    await page.waitForTimeout(600);
    await check(page, 'strip');
    await snap(page, info, 'city-dated-strip-desktop-night');
  });

  test('titles follow the route', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}#/city/CO/stream/${QS}`);
    await ready(page);
    await inState(page, 'strip');
    await expect(page).toHaveTitle(`AfterRain: Coimbra, ${CO.quest.streamName}`);
    await page.keyboard.press('Escape');
    await inState(page, 'rest');
    await expect(page).toHaveTitle('AfterRain: Coimbra');
    await page.evaluate(() => (location.hash = '#/dark-hours'));
    await expect(page).toHaveTitle('AfterRain: the dark hours');
  });

  test('the credits close on Escape and on a tap elsewhere', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}#/city/CO`);
    await ready(page);
    const credits = page.locator('.credits');
    await page.locator('.credit').click();
    await expect(credits).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(credits).toBeHidden();
    await expect(page.locator('.credit')).toBeFocused();
    await page.locator('.credit').click();
    await expect(credits).toBeVisible();
    await page.mouse.click(1220, 110);
    await expect(credits).toBeHidden();
    await inState(page, 'rest'); // the tap that closed the credits opened nothing
  });

  test('the link and the screen stay in step through animations', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    // back during the opening: the strip folds as soon as it has opened, the link already reads the city
    void page.evaluate((slug) => (window.sayr!['open'] as (s: string) => Promise<void>)(slug), QS);
    await expect(page).toHaveURL(new RegExp(`stream/${QS}$`));
    await page.waitForTimeout(300);
    await page.goBack();
    await expect(page).toHaveURL(/#\/city\/CO$/);
    await inState(page, 'rest', 30_000);
    // Escape during the opening does the same
    void page.evaluate(() => (window.sayr!['open'] as (s: string) => Promise<void>)('ribeira-de-coselhas'));
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/city\/CO$/);
    await inState(page, 'rest', 30_000);
    // another stream in the link while a strip is open: the strip changes to it
    await page.evaluate(() => (location.hash = '#/city/CO/stream/vala-real'));
    await inState(page, 'strip');
    await page.evaluate(() => (location.hash = '#/city/CO/stream/ribeira-de-coselhas'));
    await expect(page.locator('.back .nm')).toHaveText('Ribeira de Coselhas', { timeout: 30_000 });
    await inState(page, 'strip');
    await expect(page).toHaveURL(/stream\/ribeira-de-coselhas$/);
    // the streams' own buttons leave the tab order while a strip is open
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.city nav')!.inert)).toBe(true);
    await page.keyboard.press('Escape');
    await inState(page, 'rest');
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.city nav')!.inert)).toBe(false);
    await check(page, 'rest');
  });

  test('the viewer can pan and zoom the city at rest, within its bounds', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    const c0 = await sayr<{ center: [number, number]; zoom: number }>(page, 'camera');
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(560, 380, { steps: 10 });
    await page.mouse.up();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(800);
    const c1 = await sayr<{ center: [number, number]; zoom: number }>(page, 'camera');
    expect(Math.hypot(c1.center[0] - c0.center[0], c1.center[1] - c0.center[1])).toBeGreaterThan(1e-3);
    expect(c1.zoom).toBeGreaterThan(c0.zoom);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 800);
    await page.waitForTimeout(800);
    expect((await sayr<{ zoom: number }>(page, 'camera')).zoom).toBeGreaterThanOrEqual(c0.zoom - 0.71);
    await inState(page, 'rest');
    await check(page, 'rest');
  });
});

test.describe('phone taps (390x844)', () => {
  test.use({ viewport: VIEWPORTS.phone, hasTouch: true });

  test('a tap on a stream line opens that stream, never a neighbour through its site dot', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${T}&theme=night#/city/OS`);
    await ready(page);
    const streams = await sayr<{ slug: string }[]>(page, 'streams');
    let checked = 0;
    for (let ci = 0; ci < streams.length; ci++) {
      const [x, y] = await sayr<[number, number]>(page, 'chainPoint', ci);
      if (!(x > 8 && x < 382 && y > 90 && y < 760)) continue;
      expect(await sayr<{ ci: number }>(page, 'hit', x, y)).toMatchObject({ ci });
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
    // and a real tap
    const [x, y] = await sayr<[number, number]>(page, 'chainPoint', 0);
    await page.touchscreen.tap(x, y);
    await inState(page, 'strip');
    await expect(page).toHaveURL(new RegExp(`stream/${streams[0]!.slug}$`));
  });
});

test.describe('a missing forecast (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop, failOnPageErrors: false });

  test('says so in a few words instead of an empty map', async ({ page }) => {
    test.setTimeout(120_000);
    await page.route('**/data/nowcast_CO.json', (r) => r.fulfill({ status: 404, body: 'not found' }));
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await expect(page.locator('.city .nodata')).toHaveText('Forecast unavailable.', { timeout: 60_000 });
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'failed');
    await expect(page.locator('.tagline')).toHaveCSS('visibility', 'hidden', { timeout: 10_000 });
    await expectScreenQuality(page, 'rest');
  });
});
