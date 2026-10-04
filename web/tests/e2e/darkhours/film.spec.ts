// The dark hours' film at 1440x900, into the output folder (FILM_RUN overrides it). Two takes:
//   real time      Playwright's own video of the scene playing (DARKHOURS_FILM=1)
//   frame by frame the shared clock stepped at 30 frames a second (?clock=manual), one screenshot per frame,
//                  joined by ffmpeg: smooth whatever the machine's speed (DARKHOURS_FRAMES=1). Run it through the
//                  real shell (DARKHOURS_URL=/#/dark-hours) so the take ends on the fog handing over to the city.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOG_FULL, NAVIGATE_AT } from '../../../src/scenes/darkhours/timeline';
import { expect, test } from '../harness/test';

const OUTPUT_DIR = resolve(process.env['FILM_RUN'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'screens', 'darkhours'));
const TARGET = process.env['DARKHOURS_URL'] ?? '/tests/e2e/darkhours/mount.html';

test.use({ viewport: { width: 1440, height: 900 }, trace: 'off', video: process.env['DARKHOURS_FILM'] ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test('film: the whole scene in real time, ending on the hand-off', async ({ page }, info) => {
  test.skip(!process.env['DARKHOURS_FILM'], 'set DARKHOURS_FILM=1 to record');
  test.setTimeout(150_000);
  await page.goto(`${TARGET.replace(/#.*/, '')}?theme=night#/dark-hours`);
  await expect(page).toHaveURL(/#\/city\/CO$/, { timeout: 60_000 });
  // Keep rolling while the city map arrives.
  await page.waitForTimeout(6000);
  await page.close();
  const video = page.video();
  if (!video) throw new Error('no video recorded');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await video.saveAs(`${OUTPUT_DIR}/darkhours_1440x900.webm`);
  await info.attach('film', { path: `${OUTPUT_DIR}/darkhours_1440x900.webm`, contentType: 'video/webm' });
});

test('film: frame by frame through the shared clock, from the first drop to the city', async ({ page }) => {
  test.skip(!process.env['DARKHOURS_FRAMES'], 'set DARKHOURS_FRAMES=1 to render');
  test.setTimeout(1_800_000);
  const FPS = 30;
  const dir = join(tmpdir(), 'sayr-darkhours-frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.goto(`${TARGET.replace(/#.*/, '')}?theme=night&clock=manual#/dark-hours`);
  await expect(page.locator('.dh')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  const step = (ms: number): Promise<void> => page.evaluate((m) => (window as unknown as { __sayrClock: { step(ms: number): void } }).__sayrClock.step(m), ms);
  let i = 0;
  const shoot = async (): Promise<void> => {
    await page.screenshot({ path: join(dir, `f${String(i++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
  };
  // the scene, from its first frame to the fog filling the screen
  const sceneFrames = Math.ceil((FOG_FULL + 0.3) * FPS);
  for (let k = 0; k < sceneFrames; k++) {
    await shoot();
    await step(1000 / FPS);
    if (k / FPS < NAVIGATE_AT && (k + 1) / FPS >= NAVIGATE_AT) await expect(page).toHaveURL(/#\/city\/(CO)$/);
  }
  // the fog holds while the city loads (a viewer sees it drift for as long as that takes; the film waits
  // off camera), then the shell cross-fades to the map and the take holds on the city
  await expect.poll(() => page.evaluate(() => document.querySelector('.scene-layer:not(.leaving) [data-drawing="true"], .scene-layer:not(.leaving)[data-drawing="true"], .scene-layer:not(.leaving) [data-ready="true"]') !== null), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(2500); // the map's tiles, off camera
  for (let k = 0; k < Math.ceil(4.5 * FPS); k++) {
    await shoot();
    await step(1000 / FPS);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const out = join(OUTPUT_DIR, 'darkhours_film.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', out]);
  copyFileSync(join(dir, `f${String(Math.round(26 * FPS)).padStart(5, '0')}.jpg`), join(OUTPUT_DIR, 'darkhours-film-frame-26s.jpg'));
});
