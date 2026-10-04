import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The storm replay scene's own run: `npx playwright test -c tests/e2e/replay`. It builds the app into a temporary
// folder (so it never touches dist/) and serves that production build, where the real shell mounts #/replay.
// REPLAY_DEV=1 serves the Vite dev server instead; REPLAY_BASE=<url> points at a server already running.
const PORT = 4393;
const OUT = join(tmpdir(), 'sayr-replay-dist');
const external = process.env['REPLAY_BASE'];
const command = process.env['REPLAY_DEV']
  ? `npx vite --port ${PORT} --strictPort`
  : `npx vite build --outDir "${OUT}" --emptyOutDir --logLevel error && npx vite preview --outDir "${OUT}" --port ${PORT} --strictPort`;
export default defineConfig({
  testDir: '.',
  outputDir: join(tmpdir(), 'sayr-replay-results'),
  testMatch: ['replay.spec.ts', 'end-hold.spec.ts', 'mount-cost.spec.ts', 'shell-routes.spec.ts', 'screens.spec.ts', 'film.spec.ts'],
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 180_000,
  use: { ...devices['Desktop Chrome'], baseURL: external ?? `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  ...(external ? {} : { webServer: { command, cwd: '../../..', url: `http://localhost:${PORT}/`, reuseExistingServer: false, timeout: 180_000 } }),
});
