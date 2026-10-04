import { defineConfig, devices } from '@playwright/test';

// Two servers: the production build (what ships) for the app, and the Vite dev server for the fixture
// pages under tests/e2e/fixtures that prove each quality check both passes and fails.
// SAYR_APP_PORT, SAYR_FIXTURE_PORT and SAYR_DIST let two runs share the machine (defaults: 4173, 5174, dist)
const APP_PORT = Number(process.env['SAYR_APP_PORT'] ?? 4173);
const FIXTURE_PORT = Number(process.env['SAYR_FIXTURE_PORT'] ?? 5174);
const DIST = process.env['SAYR_DIST'] ?? 'dist';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list']],
  // The map is WebGL with 3D terrain: use the machine's GPU where there is one (Chromium falls back to software GL).
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure', launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } },
  webServer: [
    {
      command: `npx vite preview --port ${APP_PORT} --strictPort --outDir "${DIST}"`,
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${FIXTURE_PORT} --strictPort`,
      url: `http://localhost:${FIXTURE_PORT}/tests/e2e/fixtures/clean.html`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: 'app', testMatch: ['app.spec.ts', 'city.spec.ts', 'curve.spec.ts', 'quest.spec.ts', 'story.spec.ts', 'story.film.spec.ts', 'xray.spec.ts', 'geosync.spec.ts'], use: { baseURL: `http://localhost:${APP_PORT}` } },
    { name: 'harness', testMatch: 'harness.spec.ts', use: { baseURL: `http://localhost:${FIXTURE_PORT}` } },
  ],
});
