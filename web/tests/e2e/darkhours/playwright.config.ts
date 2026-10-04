import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The dark-hours scene's own run: `npx playwright test -c tests/e2e/darkhours`. It serves the Vite dev server
// and mounts the scene through tests/e2e/darkhours/mount.html (a stand-in shell on the SceneContext contract)
// until the app shell routes #/dark-hours; set DARKHOURS_URL=/#/dark-hours with a server of the built app
// to run the same checks through the real shell.
const PORT = 5176;
export default defineConfig({
  testDir: '.',
  // Its own output folder: other runs clean sayr/web/test-results while this one writes traces.
  outputDir: join(tmpdir(), 'sayr-darkhours-results'),
  testMatch: ['darkhours.spec.ts', 'film.spec.ts'],
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 120_000,
  use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: '../../..',
    url: `http://localhost:${PORT}/tests/e2e/darkhours/mount.html`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
