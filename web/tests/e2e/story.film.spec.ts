// The story's film: 85 seconds at 1440x900, frame by frame at 30 frames a second through the shared clock
// (?clock=manual), joined by ffmpeg into the output folder. Set STORY_FILM=1 (and STORY_FILM_SECONDS to change the
// length); a trace would snapshot every step, so it is off here.
//
// The page's animation frames are gated: requestAnimationFrame callbacks wait until the film releases them, once
// per film frame after the clock step. Every drawing reads the shared clock, so this changes no pixel; it only
// stops a busy machine from redrawing every scene sixty times a second between two screenshots.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { CO } from './harness/scenario';
import { expect, test, VIEWPORTS } from './harness/test';

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'screens', 'story');
const SHOTS = OUTPUT_DIR;
mkdirSync(OUTPUT_DIR, { recursive: true });
const T = CO.t;

declare global {
  interface Window {
    __filmTick?: (n: number) => void;
  }
}

const GATE = `(() => {
  const queue = new Map();
  let next = 1;
  window.requestAnimationFrame = (cb) => { const id = next++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  window.__filmTick = (n) => {
    for (let k = 0; k < n; k++) {
      const due = [...queue.entries()];
      queue.clear();
      const t = performance.now();
      for (const [, cb] of due) cb(t);
    }
  };
})();`;

const tick = (page: Page, n = 1): Promise<void> => page.evaluate((k) => window.__filmTick!(k), n);

test.use({ viewport: VIEWPORTS.desktop, trace: 'off' });

test('the story frame by frame at 30 frames a second through the shared clock (STORY_FILM=1)', async ({ page }) => {
  test.skip(!process.env['STORY_FILM'], 'set STORY_FILM=1 to render the film');
  test.setTimeout(3_600_000);
  const FPS = 30;
  const SECONDS = Number(process.env['STORY_FILM_SECONDS'] ?? 85);
  const dir = join(tmpdir(), 'sayr-story-frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.addInitScript(GATE);
  await page.goto(`/?theme=night&clock=manual&t=${T}#/story`);
  await expect
    .poll(async () => {
      await tick(page, 2);
      return page.evaluate(() => window.__sayrStory?.beats.length ?? 0);
    }, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await page.evaluate(() => document.fonts.ready);
  for (let i = 0; i < SECONDS * FPS; i++) {
    await page.evaluate((ms) => window.__sayrClock!.step(ms), 1000 / FPS);
    await tick(page, 2); // the map and the loop draw what the step set
    await page.screenshot({ path: join(dir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  const out = join(OUTPUT_DIR, `story_${SECONDS}s_1440x900.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', out]);
  copyFileSync(join(dir, 'f00000.jpg'), join(SHOTS, 'film-first-frame.jpg'));
});
