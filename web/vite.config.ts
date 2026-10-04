import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { FIRST_PAINT_CSS, firstPaintHtml } from './scripts/first-paint';

/** The page's first paint: the opening's stream, lamp and request, inline in index.html. */
const firstPaint = (): Plugin => ({
  name: 'sayr-first-paint',
  transformIndexHtml: (html) =>
    html.replace('<!--first-paint-css-->', `<style>${FIRST_PAINT_CSS}\n    </style>`).replace('<!--first-paint-->', firstPaintHtml(resolve(import.meta.dirname, 'public', 'data'))),
});

export default defineConfig({
  // GitHub Pages serves the app under /sayr/ (SAYR_BASE=/sayr/ in the Pages workflow); local dev and e2e keep '/'.
  base: process.env['SAYR_BASE'] ?? '/',
  // No client-side routing, so no single-page fallback: a missing file (a data file above all) is a 404,
  // not index.html with status 200.
  appType: 'mpa',
  build: { target: 'es2022' },
  plugins: [firstPaint()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
