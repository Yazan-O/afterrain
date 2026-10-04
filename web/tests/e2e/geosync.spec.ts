// The streams sit on the map's own ground: at fixed cameras (rest, pitched, and every sampled frame of a flight under
// the real clock and under the film clock), each probed stream vertex where the overlay drew it lies within 2 px of
// where the map's last render put the same ground (map.project with the live terrain), and the overlay was drawn
// with the camera the map rendered (no frame of lag). Kills: baked elevations off the live terrain, a frame of lag.
import type { Page } from '@playwright/test';
import { CO } from './harness/scenario';
import { expect, test, VIEWPORTS } from './harness/test';

const TOL = 2;
type Err = { n: number; max: number; mean: number; lag: boolean };
type Cam = { center: [number, number]; zoom: number; pitch: number; bearing: number };

const sayr = <R>(page: Page, fn: string, ...args: unknown[]): Promise<R> =>
  page.evaluate(([f, a]) => (window.sayr![f as string] as (...x: unknown[]) => R)(...(a as unknown[])), [fn, args] as const);

/** The probe's error after each of the next `n` painted frames (read once every frame callback has run). */
const sampleFrames = (page: Page, n: number, stepMs = 0): Promise<Err[]> =>
  page.evaluate(
    ([n, stepMs]) =>
      new Promise<Err[]>((res) => {
        const out: Err[] = [];
        const tick = (): void => {
          setTimeout(() => {
            out.push((window.sayr!['syncError'] as () => Err)());
            if (out.length >= n) return res(out);
            if (stepMs) (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(stepMs);
            requestAnimationFrame(tick);
          }, 0);
        };
        if (stepMs) (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(stepMs);
        requestAnimationFrame(tick);
      }),
    [n, stepMs] as const,
  );

const worst = (e: Err[]): { max: number; lagFrames: number; n: number } => ({ max: Math.max(...e.map((x) => x.max)), lagFrames: e.filter((x) => x.lag).length, n: Math.min(...e.map((x) => x.n)) });

for (const [size, viewport] of Object.entries(VIEWPORTS))
  test.describe(`geo sync ${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('the streams sit on the map at rest, pitched, and through a flight (real and film clock)', async ({ page }, info) => {
      test.setTimeout(300_000);
      await page.goto(`/?t=${CO.t}&theme=night#/city/CO`);
      await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
      await expect(page.locator('.city')).toHaveAttribute('data-map', 'idle', { timeout: 60_000 });
      await expect(page.locator('.city')).toHaveAttribute('data-camera', 'settled', { timeout: 30_000 });
      await sayr(page, 'syncProbe', true);
      const rest = await sayr<Cam>(page, 'camera');
      const report: Record<string, unknown> = {};

      const settle = async (): Promise<void> => {
        await page.waitForTimeout(300);
        await page.waitForFunction(() => (window.sayr!['mapIdle'] as () => boolean)(), null, { timeout: 60_000 });
      };
      // rest
      await settle();
      report['rest'] = worst(await sampleFrames(page, 6));
      // pitched, rotated, a little closer
      const pitched: Cam = { center: rest.center, zoom: rest.zoom + 0.6, pitch: 64, bearing: rest.bearing + 25 };
      await sayr(page, 'jump', pitched);
      await settle();
      report['pitched'] = worst(await sampleFrames(page, 6));
      // a flight under the real clock, every frame sampled
      void sayr(page, 'fly', rest, 2500);
      report['flight'] = worst(await sampleFrames(page, 60));
      await settle();
      // a flight under the film clock: one 30 fps step per frame
      void sayr(page, 'fly', pitched, 2000);
      report['film'] = worst(await sampleFrames(page, 50, 1000 / 30));

      info.annotations.push({ type: 'geosync', description: JSON.stringify(report) });
      console.log(`geosync ${size}: ${JSON.stringify(report)}`);
      for (const [k, r] of Object.entries(report) as [string, { max: number; lagFrames: number; n: number }][]) {
        expect(r.n, `${k}: probed vertices on screen`).toBeGreaterThan(20);
        expect(r.max, `${k}: largest offset (px)`).toBeLessThanOrEqual(TOL);
        expect(r.lagFrames, `${k}: frames drawn with another camera than the map's`).toBe(0);
      }
    });
  });
