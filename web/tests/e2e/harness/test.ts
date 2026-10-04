// The Playwright `test` every Sayr screen uses. It watches each page for console errors, uncaught errors,
// unhandled promise rejections and failed responses, and fails the test at teardown if any occurred.
// `expectScreenQuality` runs every content check in one call.
import { expect, test as base, type Page, type TestInfo } from '@playwright/test';
import { decode } from '../../../src/data/decode';
import { numbersFile, type NumbersFile } from '../../../src/data/schemas';
import {
  assertContrast,
  assertNoBannedWords,
  assertNoHorizontalScroll,
  assertNumbersTraced,
  assertStill,
  assertWordBudget,
  findContrastProblems,
  measureHorizontalOverflow,
  referencedFiles,
  type DataFiles,
  runningAnimations,
  type ScreenState,
} from './checks';
import { collectText } from './collect';

/**
 * The map streams tiles from these hosts and cancels requests for tiles that leave the view while the camera moves
 * (net::ERR_ABORTED). A cancelled tile is not a failure; any other failure from these hosts still is.
 */
export const TILE_HOSTS = ['tiles.openfreemap.org', 's3.amazonaws.com'] as const;
export const isCancelledTile = (url: string, errorText: string): boolean =>
  errorText === 'net::ERR_ABORTED' && (TILE_HOSTS as readonly string[]).includes(new URL(url).hostname);

export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? 'unknown';
    if (!isCancelledTile(r.url(), why)) errors.push(`request failed: ${r.url()} (${why})`);
  });
  return errors;
}

/** Rejections are reported as console errors so they cannot pass silently in any browser. */
const REJECTION_HOOK = `window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error('unhandled rejection: ' + (r && r.stack ? r.stack : String(r)));
});`;

export function assertNoPageErrors(errors: readonly string[]): void {
  if (errors.length) throw new Error(`page reported ${errors.length} error(s):\n  ${errors.join('\n  ')}`);
}

interface Options {
  /** Set false only in harness tests that show the error guard catching something. */
  failOnPageErrors: boolean;
}

export const test = base.extend<Options & { pageErrors: string[] }>({
  failOnPageErrors: [true, { option: true }],
  pageErrors: [
    async ({ page, failOnPageErrors }, use) => {
      await page.addInitScript(REJECTION_HOOK);
      const errors = watchPageErrors(page);
      await use(errors);
      if (failOnPageErrors) assertNoPageErrors(errors);
    },
    { auto: true },
  ],
});
export { expect };

const numbersByOrigin = new Map<string, Promise<NumbersFile>>();
/** numbers.json exactly as the server of the current page serves it. */
export function servedNumbers(page: Page): Promise<NumbersFile> {
  const origin = new URL(page.url()).origin;
  let p = numbersByOrigin.get(origin);
  if (!p) {
    p = page.request.get(`${origin}/data/numbers.json`).then(async (res) => {
      if (!res.ok()) throw new Error(`numbers.json: HTTP ${res.status()} from ${origin}`);
      return decode('numbers.json', numbersFile, await res.json());
    });
    numbersByOrigin.set(origin, p);
  }
  return p;
}

const filesByUrl = new Map<string, Promise<unknown>>();
/** The data files that data-src references name, exactly as the page's server serves them under /data/ (a live: record from the page). */
export async function servedDataFiles(page: Page, files: readonly string[]): Promise<DataFiles> {
  const origin = new URL(page.url()).origin;
  const out: Record<string, unknown> = {};
  for (const f of files) {
    // a record the page made for the hour on screen (src/fhir/liveRecords.ts), read from the page itself
    if (f.startsWith('live:')) {
      const v = await page.evaluate((ref) => window.__sayrLive?.[ref], f.slice(5));
      if (v !== undefined) out[f] = v;
      continue;
    }
    const url = `${origin}/data/${f}`;
    let p = filesByUrl.get(url);
    if (!p) {
      p = page.request.get(url).then(async (res) => (res.ok() ? ((await res.json()) as unknown) : undefined));
      filesByUrl.set(url, p);
    }
    const v = await p;
    if (v !== undefined) out[f] = v;
  }
  return out;
}

/** Every content check a screen must pass in the given state. */
export async function expectScreenQuality(page: Page, state: ScreenState): Promise<void> {
  const text = await collectText(page);
  assertWordBudget(text, state);
  assertNumbersTraced(text, await servedNumbers(page), await servedDataFiles(page, referencedFiles(text)));
  assertNoBannedWords(text);
  assertNoHorizontalScroll(await measureHorizontalOverflow(page));
}

/** WCAG AA contrast for every visible DOM text run against the page ground. */
export async function expectContrastAA(page: Page): Promise<void> {
  assertContrast(await findContrastProblems(page));
}

/** Under prefers-reduced-motion nothing may keep moving. */
export async function expectStillUnderReducedMotion(page: Page): Promise<void> {
  assertStill(await runningAnimations(page));
}

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

/** Saves a screenshot under screens/ (kept between runs) and attaches it to the report. */
export async function snap(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = `screens/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}
