// The quest and the test reading: a dated forecast says so and keeps its corner, the change
// runs out from the tested place and the line says how the estimate moved once it has reached the place, the day
// band keeps its contrast under the mist, a finger drag scrubs on a phone, controls are 44 px, the strip is a
// slider with its hour said, and quest #1's lamp stays on screen through a resize, a rotation and an early drag.
// Every screen still passes expectScreenQuality. The clock and the quests come from the served nowcast.
import type { CDPSession, Page } from '@playwright/test';
import { CO, GH } from './harness/scenario';
import { expect, expectContrastAA, expectScreenQuality, snap, test, VIEWPORTS } from './harness/test';

const T = CO.t;
/** The line once a test's change has run, on the forecast curve: the reading itself, its hour and the zone. */
const RESULT = /^Test reading · (900 or less|over 900) · \w{3} \d+ \d\d:00 UTC(\+\d+)?$/;

const ready = async (page: Page): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
  await expect(page.locator('.city')).toHaveAttribute('data-map', 'idle', { timeout: 60_000 });
  await expect(page.locator('.city')).toHaveAttribute('data-camera', 'settled', { timeout: 30_000 });
};
const inState = (page: Page, s: string, timeout = 60_000) => expect(page.locator('body')).toHaveAttribute('data-state', s, { timeout });
const voice = (page: Page) => page.locator('.voice');
const sayr = <R>(page: Page, fn: string, ...args: unknown[]): Promise<R> =>
  page.evaluate(([f, a]) => (window.sayr![f as string] as (...x: unknown[]) => R)(...(a as unknown[])), [fn, args] as const);
/** The curve's readouts (src/city/scene.ts hooks.readouts). */
interface Readouts {
  hitsCurve: boolean;
  gap: number;
  lead: boolean;
  near: number;
  names: Record<'before' | 'with' | 'sample' | 'result', { text: string; rect: { left: number; right: number; top: number; bottom: number } } | null>;
  sampleTiming: { row: number; readyRow: number; turn: number; inForecast: boolean } | null;
}
/** The value sits within 40 px of its point, or a connector joins them. */
const expectNear = (r: Readouts): void => expect(r.gap <= r.near || r.lead, `value ${r.gap.toFixed(1)} px from its point without a connector`).toBe(true);
const firstLamp = async (page: Page): Promise<{ x: number; y: number }> => {
  const lamps = await sayr<{ rank: number; open: boolean; strip: string | null; x: number; y: number }[]>(page, 'questLamps');
  return lamps.find((q) => q.open && q.strip)!;
};
/** The lamp sits well inside the screen, clear of the corners' words. */
const onScreen = (l: { x: number; y: number }, W: number, H: number): boolean => l.x > 30 && l.x < W - 30 && l.y > H * 0.12 && l.y < H - 110;

/**
 * Clicks a button and returns the milliseconds until the line over the strip says what the reading did, and
 * whether the reveal was running before the line came.
 */
async function clickAndTimeResult(page: Page, selector: string): Promise<{ ms: number; revealFirst: boolean }> {
  return page.evaluate(
    (sel) =>
      new Promise<{ ms: number; revealFirst: boolean }>((resolve, reject) => {
        const v = document.querySelector('.voice')!;
        const b = document.querySelector<HTMLButtonElement>(sel)!;
        const t0 = performance.now();
        let revealFirst = false;
        const done = (): boolean => /^Test reading · /.test(v.textContent ?? '');
        const mo = new MutationObserver(() => {
          if (!done()) return;
          mo.disconnect();
          resolve({ ms: performance.now() - t0, revealFirst });
        });
        mo.observe(v, { childList: true, subtree: true, characterData: true });
        setTimeout(() => reject(new Error('no result line within 6 s')), 6000);
        b.click();
        revealFirst = !done() && (window.sayr!['lifting'] as () => number | null)() !== null;
      }),
    selector,
  );
}

test.describe('the quest and the sample (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  for (const [obs, button] of [
    ['900 or less', 'under'],
    ['over 900', 'over'],
  ] as const)
    test(`${obs}: the change runs out from the tested place, and the line says how the estimate moved once it is there`, async ({ page }, info) => {
      test.setTimeout(150_000);
      await page.goto(`/?t=${T}&theme=night#/city/CO`);
      await ready(page);
      await sayr(page, 'open', (await sayr<string>(page, 'restQuestStream')), true);
      await inState(page, 'strip');
      await expect(voice(page)).toHaveText(/^Sample .+/);
      await page.locator('.questui .add').click();
      await expect(page.locator('.questui [data-obs]').first()).toBeVisible();
      const { ms, revealFirst } = await clickAndTimeResult(page, `.questui button[data-obs="${button}"]`);
      info.annotations.push({ type: 'latency', description: `${obs}: ${ms.toFixed(0)} ms` });
      // the reveal starts at the click; the line waits for the change to reach the place, never past the reveal
      expect(revealFirst).toBe(true);
      expect(ms).toBeGreaterThan(300);
      expect(ms).toBeLessThan(4500);
      await expect(voice(page)).toHaveText(RESULT);
      await expect(voice(page)).toHaveText(new RegExp(`^Test reading · ${obs} · `));
      // the recomputed curve with the original beside it, and the value clear of both
      expect((await sayr<{ hitsCurve: boolean }>(page, 'readouts')).hitsCurve).toBe(false);
      await page.waitForTimeout(300);
      await snap(page, info, `quest-reveal-${button}`);
      await expect.poll(() => sayr<number | null>(page, 'lifting'), { timeout: 15_000 }).toBeNull();
      // each curve named beside itself, the value beside its point, the sample and its result a turnaround apart
      const r = await sayr<Readouts>(page, 'readouts');
      expect(r.hitsCurve).toBe(false);
      expectNear(r);
      expect(r.names.with?.text).toBe('With test');
      expect(r.names.before?.text).toBe('Before');
      expect(r.sampleTiming!.readyRow - r.sampleTiming!.row).toBe(r.sampleTiming!.turn);
      expect(r.names.sample?.text).toBe('Sample');
      expect(r.names.result?.text).toBe(`Result +${r.sampleTiming!.turn} h`);
      // the value and the names stay clear and near while the hour moves along the curve
      for (const h of [0, 12, 30, 60, 96, 130, 1e9]) {
        await sayr(page, 'scrub', h);
        const s = await sayr<Readouts>(page, 'readouts');
        expect(s.hitsCurve, `hour ${h}`).toBe(false);
        expectNear(s);
        expect(s.names.sample?.text, `hour ${h}`).toBe('Sample');
      }
      // "Hold before": the line says the state and the selected hour, never an advice sentence; the fog's words are
      // the ones from before the test
      await sayr(page, 'hold', true);
      await expect(voice(page)).toHaveText(/^Before test · \w{3} \d+ \d\d:00 UTC(\+\d+)?$/);
      await expect(page.locator('.tick.fogl')).not.toHaveText('Still uncertain');
      const held = await sayr<Readouts>(page, 'readouts');
      expect(held.names.before?.text).toBe('Before');
      expect(held.names.with).toBeNull();
      // released at an hour other than the test's, the line says the state and that hour; at the test's hour, the reading
      await sayr(page, 'hold', false);
      await expect(voice(page)).toHaveText(/^With test · \w{3} \d+ \d\d:00 UTC(\+\d+)?$/);
      await sayr(page, 'scrub', r.sampleTiming!.row);
      await expect(voice(page)).toHaveText(RESULT);
      await expectScreenQuality(page, 'strip');
      await expectContrastAA(page);
    });

  test('the sample and its result: the turnaround after the hour offered, and a last-hour test has its result after the forecast', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    await sayr(page, 'open', await sayr<string>(page, 'restQuestStream'), true);
    await inState(page, 'strip');
    await expect(voice(page)).toHaveText(/^Sample .+/);
    // the hour the strip offers (the clock has passed the quest's best hour: the strip's first hour), plus the
    // nowcast's turnaround; round 3 drew it one hour early from result_ready_utc
    const r = await sayr<Readouts>(page, 'readouts');
    const st = r.sampleTiming!;
    expect(st.readyRow - st.row).toBe(st.turn);
    expect(st.inForecast).toBe(true);
    expect(st.row).toBe(Math.max(0, (Date.parse(CO.quest.bestUtc) - Date.parse(T)) / 3.6e6));
    // "Sample" ends at its tick, "Result +24 h" starts at its own: their x are the curve's x at those hours
    const [sx] = (await sayr<[number, number]>(page, 'hourPoint', st.row))!;
    const [rx] = (await sayr<[number, number]>(page, 'hourPoint', st.readyRow))!;
    expect(r.names.result?.text).toBe(`Result +${st.turn} h`);
    expect(Math.abs(r.names.result!.rect.left - rx)).toBeLessThan(3);
    expect(Math.min(Math.abs(r.names.sample!.rect.right - sx), Math.abs(r.names.sample!.rect.left - sx))).toBeLessThan(3);
    // a test at the curve's last hour: its result is after the forecast, and no mark sits at the curve's end
    const span = (await sayr<{ span: number }>(page, 'info')).span;
    await sayr(page, 'kitAt', span);
    await page.locator('.questui button[data-obs="under"]').click();
    await expect(voice(page)).toHaveText(RESULT, { timeout: 8000 });
    await expect.poll(() => sayr<number | null>(page, 'lifting'), { timeout: 15_000 }).toBeNull();
    const last = await sayr<Readouts>(page, 'readouts');
    expect(last.sampleTiming!.row).toBe(span);
    expect(last.sampleTiming!.inForecast).toBe(false);
    const said = [last.names.sample?.text, last.names.result?.text].join(' ');
    expect(said).toMatch(/after forecast/);
    expect(said).not.toMatch(/\+\d+ h/);
    await expectScreenQuality(page, 'strip');
  });

  test('a dated forecast: the quest says the forecast date, and "tap a stream" never covers the corner', async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${CO.dated}&theme=night#/city/CO`);
    await ready(page);
    await expect(page.locator('.hour')).toHaveText(`forecast ${CO.fetched}`);
    await expect(page.locator('body')).toHaveAttribute('data-cue', 'tap', { timeout: 20_000 });
    // the corner's date stays; the links to the other scenes give way while the cue shows
    await expect(page.locator('.hour')).toBeVisible();
    await expect(page.locator('.elsewhere')).toBeHidden();
    const cue = (await page.locator('.tapcue').boundingBox())!;
    const hour = (await page.locator('.hour').boundingBox())!;
    expect(cue.y + cue.height < hour.y || cue.x > hour.x + hour.width).toBe(true);
    await page.waitForTimeout(700);
    await expectScreenQuality(page, 'rest');
    await snap(page, info, 'quest-dated-rest');
    await sayr(page, 'open', (await sayr<string>(page, 'restQuestStream')), true);
    await inState(page, 'strip');
    await expect(voice(page)).toHaveText(new RegExp(`^Forecast of ${CO.fetched}: Sample `));
    await page.waitForTimeout(600);
    await expectScreenQuality(page, 'strip');
    await snap(page, info, 'quest-dated-strip');
  });

  test('the "tap a stream" cue sits beside the lamp, never on it, in every city', async ({ page }) => {
    test.setTimeout(240_000);
    for (const id of ['CO', 'GH', 'OS', 'TO']) {
      await page.goto(`/?t=${T}&theme=night#/city/${id}`);
      await ready(page);
      await expect(page.locator('body')).toHaveAttribute('data-cue', 'tap', { timeout: 20_000 });
      await page.waitForTimeout(800);
      const l = await firstLamp(page);
      const c = (await page.locator('.tapcue').boundingBox())!;
      // the lamp's 14 px glow is clear of the words
      const dx = Math.max(c.x - l.x, l.x - (c.x + c.width), 0);
      const dy = Math.max(c.y - l.y, l.y - (c.y + c.height), 0);
      expect(Math.hypot(dx, dy), id).toBeGreaterThan(14);
    }
  });

  test('by day "higher" keeps 3:1 against the paper under the mist, and the quest lamp is an ink ring', async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${GH.t}&theme=day#/city/GH/stream/${GH.quest.stream}`);
    await ready(page);
    await inState(page, 'strip');
    await page.waitForTimeout(1500);
    const cell = await sayr<[number, number] | null>(page, 'higherCell');
    expect(cell).not.toBeNull();
    const shot = await page.screenshot();
    await snap(page, info, 'quest-day-higher');
    const rgb = await page.evaluate(
      async ([png, x, y]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        // the hour's thread: the darkest pixel across the cell (the thread is thinner than the cell)
        const d = g.getImageData(Math.round(x as number) - 2, Math.round(y as number) - 3, 5, 7).data;
        let m = [255, 255, 255];
        for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! < m[0]! + m[1]! + m[2]!) m = [d[i]!, d[i + 1]!, d[i + 2]!];
        return m;
      },
      [shot.toString('base64'), cell![0], cell![1]] as const,
    );
    const lin = (v: number): number => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const L = (c: number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
    const contrast = (L([243, 241, 234]) + 0.05) / (L(rgb) + 0.05);
    info.annotations.push({ type: 'contrast', description: `higher under mist: rgb ${rgb.map((v) => v.toFixed(0)).join(',')}, ${contrast.toFixed(2)}:1` });
    expect(contrast).toBeGreaterThanOrEqual(3);
  });
});

test.describe('phone (390x844)', () => {
  test.use({ viewport: VIEWPORTS.phone, hasTouch: true, isMobile: true });

  test('a finger drag along the forecast curve scrubs the hours (touch-action none); the slider says its hour', async ({ page, context }) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO/stream/${CO.quest.stream}`);
    await ready(page);
    await inState(page, 'strip');
    await page.waitForTimeout(800);
    expect(await page.locator('canvas.stripc').evaluate((e) => getComputedStyle(e).touchAction)).toBe('none');
    const f = (await sayr<{ x0: number; x1: number; y0: number; y1: number }>(page, 'field'))!;
    const y = (f.y0 + f.y1) / 2;
    const cdp: CDPSession = await context.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', f.x0 + 6);
    const seen: number[] = [];
    for (let i = 1; i <= 14; i++) {
      await touch('touchMove', f.x0 + 6 + ((f.x1 - f.x0 - 12) * i) / 14);
      await page.waitForTimeout(40);
      seen.push((await sayr<{ scrub: number }>(page, 'info')).scrub);
    }
    await touch('touchEnd', 0);
    expect(new Set(seen).size).toBeGreaterThan(6); // the hour follows the finger
    // the curve holds the whole forecast across the screen: one drag across covers most of it
    const span = (await sayr<{ span: number }>(page, 'info')).span;
    expect(seen[seen.length - 1]!).toBeGreaterThan(seen[0]! + span * 0.7);
    await inState(page, 'strip');
    const s = page.locator('canvas.stripc');
    await expect(s).toHaveAttribute('role', 'slider');
    await expect(s).toHaveAttribute('tabindex', '0');
    await expect(s).toHaveAttribute('aria-valuenow', String(seen[seen.length - 1]));
    await expect(s).toHaveAttribute('aria-valuetext', /^\w+day \d+ \w{3} \d\d:00$/);
    await expect(s).toHaveAccessibleName('Selected hour: drag, or use the arrow keys');
    expect(await s.getAttribute('aria-hidden')).toBeNull();
  });

  test('the city button and the menu items are 44 px; the quest card keeps the four lives', async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    expect((await page.locator('.city-btn').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.locator('.city-btn').click();
    for (const a of await page.locator('.cities a').all()) expect((await a.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    const l = await firstLamp(page);
    expect(onScreen(l, 390, 844)).toBe(true);
    // away from the screen's edge: at least 48 px from either side
    expect(l.x).toBeGreaterThan(48);
    expect(l.x).toBeLessThan(390 - 48);
    await page.touchscreen.tap(l.x, l.y);
    await inState(page, 'strip');
    await expect(voice(page)).toHaveText(/^Sample /);
    await page.waitForTimeout(900);
    const figs = await page.locator('.fig').evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).opacity)));
    expect(Math.min(...figs)).toBeGreaterThan(0.9);
    // the four lives and the quest's words do not overlap
    const q = (await page.locator('.questui').boundingBox())!;
    for (const fig of await page.locator('.fig').all()) expect((await fig.boundingBox())!.y).toBeGreaterThan(q.y + q.height - 4);
    await expectScreenQuality(page, 'strip');
    await snap(page, info, 'quest-phone-card');
  });
});

test.describe("quest #1's lamp stays on screen", () => {
  test('through a resize to a phone, a rotation, and back', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    for (const [w, h] of [
      [390, 844],
      [844, 390],
      [1024, 768],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(900);
      const l = await firstLamp(page);
      expect(onScreen(l, w, h), `${w}x${h}: ${l.x.toFixed(0)},${l.y.toFixed(0)}`).toBe(true);
    }
  });

  test('after an early drag cuts the opening glide short, once the viewer lets go', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
    // the glide starts two seconds after the basemap is complete: a short drag before it
    await expect(page.locator('.city')).toHaveAttribute('data-map', 'idle', { timeout: 60_000 });
    // a forecast whose quest #1 is already in the opening's framing needs no glide: nothing to cut short
    test.skip((await page.locator('.city').getAttribute('data-camera')) === 'settled', 'the served quest needs no opening glide');
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(640, 420, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.city')).toHaveAttribute('data-camera', 'settled');
    await expect.poll(async () => onScreen(await firstLamp(page), 1440, 900), { timeout: 8000 }).toBe(true);
  });

  test('a resize while a strip is opening lays the strip out for the new size', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    void page.evaluate((slug) => (window.sayr!['open'] as (s: string) => Promise<void>)(slug), CO.quest.stream);
    await inState(page, 'opening');
    await page.setViewportSize({ width: 1024, height: 768 });
    await inState(page, 'strip');
    await page.waitForTimeout(600);
    const f = (await sayr<{ x0: number; x1: number; y0: number; y1: number; lineY: number }>(page, 'field'))!;
    expect(f.x1).toBeLessThanOrEqual(1024);
    expect(f.x1).toBeGreaterThan(1024 * 0.8);
    expect(f.y1).toBeLessThanOrEqual(768);
    expect(f.lineY).toBeCloseTo(Math.round(768 * 0.46), 0);
    await expectScreenQuality(page, 'strip');
  });
});

test.describe('a tested stream closed and opened again (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });
  test('the test stays with Reset on its stream, the record keeps its collection hour, and another site can still be sampled', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    const first = await sayr<string>(page, 'restQuestStream');
    await sayr(page, 'open', first, true);
    await inState(page, 'strip');
    await sayr(page, 'sample', false);
    await expect(voice(page)).toHaveText(RESULT, { timeout: 15_000 });
    const t1 = (await sayr<{ code: string; row: number } | null>(page, 'test'))!;
    // the reading's record says one collection hour, whatever hour the strip is scrubbed to
    const collected = (): Promise<string[]> =>
      page.evaluate((code) => {
        const notes = Object.values(window.__sayrLive ?? {})
          .filter((j) => String((j as { id?: string }).id ?? '').startsWith(`sayr-test-${code}-`))
          .map((j) => JSON.stringify(j).match(/assumed collected ([0-9T:\-]+Z)/)?.[1] ?? '');
        return [...new Set(notes)];
      }, t1.code);
    for (const h of [0, 12, 40]) {
      await sayr(page, 'scrub', h);
      await page.waitForTimeout(100);
    }
    const info = await sayr<{ hb: number }>(page, 'info');
    const hourUtc = await page.evaluate(async (i) => ((await (await fetch('data/nowcast_CO.json')).json()) as { hours_utc: string[] }).hours_utc[i], info.hb + t1.row);
    expect(await collected()).toEqual([hourUtc]);
    // closed and opened again: the test is still on its stream, with its Reset
    await sayr(page, 'close');
    await inState(page, 'rest');
    await expect(page.locator('.questui .reset')).toBeHidden();
    await sayr(page, 'open', first);
    await inState(page, 'strip');
    await expect(page.locator('.questui .reset')).toBeVisible();
    await expect(voice(page)).toHaveText(RESULT);
    expect((await sayr<{ code: string } | null>(page, 'test'))?.code).toBe(t1.code);
    // another eligible site on another stream: its quest asks, and its reading is taken
    await sayr(page, 'close');
    await inState(page, 'rest');
    const lamps = await sayr<{ code: string; open: boolean; strip: string | null }[]>(page, 'questLamps');
    const other = lamps.find((q) => q.open && q.strip && q.strip !== first && q.code !== t1.code);
    expect(other, 'another open quest with a strip').toBeTruthy();
    await sayr(page, 'open', other!.strip!, true);
    await inState(page, 'strip');
    await expect(voice(page)).toHaveText(/Sample .+/);
    await sayr(page, 'sample', true);
    await expect(voice(page)).toHaveText(RESULT, { timeout: 15_000 });
    expect((await sayr<{ code: string } | null>(page, 'test'))?.code).toBe(other!.code);
    // the first site's reading is still in the model when its stream opens again
    await sayr(page, 'close');
    await inState(page, 'rest');
    await sayr(page, 'open', first);
    await inState(page, 'strip');
    expect((await sayr<{ code: string } | null>(page, 'test'))?.code).toBe(t1.code);
    await page.locator('.questui .reset').click();
    expect(await sayr(page, 'test')).toBeNull();
    await expect(voice(page)).toHaveText(/Sample .+/);
  });

  test('after the clock passes the collection hour, the reopened stream keeps the reading and its Reset', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?t=${T}&theme=night#/city/CO`);
    await ready(page);
    const first = await sayr<string>(page, 'restQuestStream');
    await sayr(page, 'open', first, true);
    await inState(page, 'strip');
    await sayr(page, 'sample', false);
    await expect(voice(page)).toHaveText(RESULT, { timeout: 15_000 });
    const t1 = (await sayr<{ code: string; row: number } | null>(page, 'test'))!;
    const { hb } = await sayr<{ hb: number }>(page, 'info');
    const hours = await page.evaluate(async () => ((await (await fetch('data/nowcast_CO.json')).json()) as { hours_utc: string[] }).hours_utc);
    const collectedUtc = hours[hb + t1.row]!;
    await sayr(page, 'close');
    await inState(page, 'rest');
    // the clock moves three hours past the collection hour: the reopened strip starts after it. set() hands the app
    // clock to the test (src/app/clock.ts), so the animation runs on steps from here
    await page.evaluate((iso) => window.__sayrClock!.set(iso), new Date(Date.parse(collectedUtc) + 3 * 3.6e6).toISOString());
    const stepUntil = (pred: () => Promise<boolean>): Promise<void> =>
      expect.poll(async () => {
        await page.evaluate(() => window.__sayrClock!.step(100));
        return pred();
      }, { timeout: 60_000, intervals: [20] }).toBe(true);
    await page.evaluate((f) => void (window.sayr!['open'] as (x: string) => Promise<void>)(f), first);
    await stepUntil(async () => (await page.locator('body').getAttribute('data-state')) === 'strip');
    expect((await sayr<{ hb: number }>(page, 'info')).hb, 'the strip starts after the collection hour').toBeGreaterThan(hb + t1.row);
    const t2 = await sayr<{ code: string; row: number } | null>(page, 'test');
    expect(t2?.code, 'the reading is still on its stream').toBe(t1.code);
    await expect(page.locator('.questui .reset')).toBeVisible();
    await expect(voice(page)).toHaveText(RESULT);
    await page.locator('.questui .reset').click();
    expect(await sayr(page, 'test')).toBeNull();
    await stepUntil(async () => !(await page.locator('.questui .reset').isVisible()));
  });
});
