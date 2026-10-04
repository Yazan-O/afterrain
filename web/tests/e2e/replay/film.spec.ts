// The replay's 45-second take at 1440x900, into the output folder. Two versions of one story (play from the calm
// start, fold into the timetable after the 31,000 lands, unfold, end on the proof with the way on beneath it):
//   real time      Playwright's own video of the play control, as a viewer sees it (REPLAY_FILM=1)
//   frame by frame the shared clock stepped at 30 frames per story second (?clock=manual), one screenshot per
//                  frame, joined by ffmpeg: smooth whatever the machine's speed (REPLAY_FRAMES=1)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from '../harness/test';

const OUTPUT_DIR = resolve(process.env['FILM_RUN'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'screens', 'replay'));
mkdirSync(OUTPUT_DIR, { recursive: true });
const FOLD_AT = 25.5; // story seconds: the 31,000 has landed; its 24 hours reach back to the 10:28 from Freshford
const UNFOLD_AT = 31.5;

const sigma = async (page: Page): Promise<number> => Number(await page.locator('.rp').getAttribute('data-sigma'));
const waitSigma = async (page: Page, s: number): Promise<void> => {
  await expect.poll(() => sigma(page), { timeout: 90_000, intervals: [50] }).toBeGreaterThanOrEqual(s);
};

// no trace: a trace snapshots every action, which makes a 1,400-frame render crawl
test.use({ viewport: { width: 1440, height: 900 }, trace: 'off', video: process.env['REPLAY_FILM'] ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test.describe('real time', () => {
  test('the storm in real time from the play control', async ({ page }) => {
    test.skip(!process.env['REPLAY_FILM'], 'set REPLAY_FILM=1 to record');
    test.setTimeout(180_000);
    await page.goto('/?theme=night#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    await page.locator('.rp-play').click();
    await waitSigma(page, FOLD_AT);
    await page.locator('.rp-fold').click();
    await waitSigma(page, UNFOLD_AT);
    await page.locator('.rp-fold').click();
    const duration = await page.evaluate(() => (window as unknown as { __sayrReplay: { duration: number } }).__sayrReplay.duration);
    await waitSigma(page, duration - 0.02); // data-sigma carries two decimals
    await page.waitForTimeout(1500);
    const video = page.video()!;
    await page.close();
    await video.saveAs(join(OUTPUT_DIR, 'replay_realtime.webm'));
  });
});

test.describe('frame by frame', () => {
  test('the storm stepped at 30 frames a second through the shared clock', async ({ page }) => {
    test.skip(!process.env['REPLAY_FRAMES'], 'set REPLAY_FRAMES=1 to render');
    test.setTimeout(1_800_000);
    const FPS = 30;
    const dir = join(tmpdir(), 'sayr-replay-frames');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await page.goto('/?theme=night&clock=manual&t=2024-09-18T23:00:00Z#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => document.fonts.ready);
    const times = await page.evaluate((fps) => {
      const h = (window as unknown as { __sayrReplay: { duration: number; timeAt(s: number): string } }).__sayrReplay;
      const lead = 1; // one still second on the calm start
      const tail = 3.8; // the proof holds, and "Now see Coimbra" comes in beneath it
      const n = Math.ceil((lead + h.duration + tail) * fps);
      return Array.from({ length: n }, (_, i) => h.timeAt(Math.max(0, i / fps - lead)));
    }, FPS);
    const leadFrames = FPS;
    for (let i = 0; i < times.length; i++) {
      const s = Math.max(0, i / FPS - 1);
      const toggle = (i > leadFrames && Math.abs(s - FOLD_AT) < 0.5 / FPS) || Math.abs(s - UNFOLD_AT) < 0.5 / FPS;
      if (toggle) await page.locator('.rp-fold').click();
      await page.evaluate(
        ([iso, ms]) => {
          const c = (window as unknown as { __sayrClock: { set(d: string): void; step(ms: number): void } }).__sayrClock;
          c.step(ms);
          c.set(iso);
        },
        [times[i]!, 1000 / FPS] as const,
      );
      await page.screenshot({ path: join(dir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
    }
    const out = join(OUTPUT_DIR, 'replay_45s.mp4');
    mkdirSync(join(OUTPUT_DIR, 'screens'), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', out]);
    copyFileSync(join(dir, 'f00000.jpg'), join(OUTPUT_DIR, 'screens', 'film-first-frame.jpg'));
  });
});
