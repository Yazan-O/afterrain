// Proves each quality check on tiny fixture pages: it passes on a page that follows the rule and fails,
// with a message naming the problem, on a page that breaks it.
import type { Page } from '@playwright/test';
import {
  assertContrast,
  assertNoBannedWords,
  assertNoHorizontalScroll,
  assertNumbersTraced,
  assertStill,
  assertWordBudget,
  countWords,
  findBannedWords,
  findContrastProblems,
  findProvenanceProblems,
  measureHorizontalOverflow,
  referencedFiles,
  resolvePointer,
  runningAnimations,
} from './harness/checks';
import { collectText } from './harness/collect';
import { assertNoPageErrors, expect, expectScreenQuality, isCancelledTile, servedDataFiles, servedNumbers, test, VIEWPORTS } from './harness/test';

const open = async (page: Page, name: string): Promise<void> => {
  await page.goto(`/tests/e2e/fixtures/${name}.html`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
};

test.describe('error guard', () => {
  test('passes a page with no errors (the guard runs on every test by default)', async ({ page, pageErrors }) => {
    await open(page, 'clean');
    expect(pageErrors).toEqual([]);
  });

  test.describe('catches', () => {
    test.use({ failOnPageErrors: false });
    const cases = [
      ['console-error', /console\.error: boom from console\.error/],
      ['page-error', /uncaught: boom from an uncaught throw/],
      ['unhandled-rejection', /unhandled rejection: Error: lost promise/],
      ['missing-resource', /HTTP 404: .*no_such_file\.json/],
    ] as const;
    for (const [fixture, message] of cases) {
      test(fixture, async ({ page, pageErrors }) => {
        await page.goto(`/tests/e2e/fixtures/${fixture}.html`);
        await expect.poll(() => pageErrors.join('\n')).toMatch(message);
        expect(() => assertNoPageErrors(pageErrors)).toThrow(message);
      });
    }
  });
});

test.describe('horizontal scroll', () => {
  test('passes a page that fits at 1440 x 900 and 390 x 844', async ({ page }) => {
    for (const vp of Object.values(VIEWPORTS)) {
      await page.setViewportSize(vp);
      await open(page, 'clean');
      assertNoHorizontalScroll(await measureHorizontalOverflow(page));
    }
  });

  test('fails a page wider than the desktop viewport, naming the element', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await open(page, 'wide');
    const r = await measureHorizontalOverflow(page);
    expect(() => assertNoHorizontalScroll(r)).toThrow(/page is 1600 px wide in a 1440 px viewport; <div#too-wide> right edge 1600 px/);
  });

  test('fails a page that fits on desktop but not on a phone', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await open(page, 'wide-phone');
    assertNoHorizontalScroll(await measureHorizontalOverflow(page));
    await page.setViewportSize(VIEWPORTS.phone);
    const r = await measureHorizontalOverflow(page);
    expect(() => assertNoHorizontalScroll(r)).toThrow(/600 px wide in a 390 px viewport; <div#fixed-600>/);
  });
});

test.describe('word budget', () => {
  test('counts only what a viewer can read, plus canvas words', async ({ page }) => {
    await open(page, 'clean');
    const words = countWords(await collectText(page));
    expect(words.words).toEqual(['Sayr', 'within', '48', 'hours', '09:10', 'usual']);
    assertWordBudget(await collectText(page), 'rest');
  });

  test('fails nine words at rest (budget 8)', async ({ page }) => {
    await open(page, 'words-over');
    const text = await collectText(page);
    expect(() => assertWordBudget(text, 'rest')).toThrow(/9 words visible in state "rest", budget 8/);
  });

  test('counts words registered by canvas drawing code', async ({ page }) => {
    await open(page, 'canvas-words-over');
    const text = await collectText(page);
    expect(countWords(text).count).toBe(9);
    expect(() => assertWordBudget(text, 'rest')).toThrow(/9 words visible .* seven eight nine/);
  });

  test('applies the budget of the state: 22 words pass the strip (30) and fail rest (8)', async ({ page }) => {
    await open(page, 'strip');
    const text = await collectText(page);
    expect(countWords(text).count).toBe(22);
    assertWordBudget(text, 'strip');
    expect(() => assertWordBudget(text, 'rest')).toThrow(/22 words visible in state "rest", budget 8/);
  });

  test('skips the code in a [data-code] region (the x-ray), while every digit there still needs its source', async ({ page }) => {
    await open(page, 'code-region');
    const text = await collectText(page);
    expect(countWords(text).words).toEqual(['Sayr', 'checked', 'by', 'the', 'validator']);
    assertWordBudget(text, 'rest');
    assertNumbersTraced(text, await servedNumbers(page), await servedDataFiles(page, referencedFiles(text)));
    await open(page, 'code-stray');
    const stray = await collectText(page);
    expect(countWords(stray).count).toBe(0);
    expect(findProvenanceProblems(stray, await servedNumbers(page))).toEqual([
      expect.objectContaining({ problem: 'digits outside any [data-num] or [data-time] element' }),
    ]);
  });
});

test.describe('number provenance', () => {
  test('passes numbers that match numbers.json, times, allowed units and canvas numbers', async ({ page }) => {
    for (const fixture of ['clean', 'strip']) {
      await open(page, fixture);
      assertNumbersTraced(await collectText(page), await servedNumbers(page));
    }
  });

  const failing = [
    ['num-stray', /<p> "Rain 12 mm": digits outside any \[data-num\] or \[data-time\] element/],
    ['num-mismatch', /data-num="warleigh\.window_hours" shows "47" but numbers\.json formats to "48"/],
    ['num-unknown', /data-num="warleigh\.no_such_key" is not a key in numbers\.json/],
    ['num-needs-fmt', /4\.55 is not an integer; give it data-fmt/],
    ['num-extra-words', /shows "48 hours" but numbers\.json formats to "48"/],
    ['num-canvas-stray', /canvas entry "peak" "31,000": digits outside/],
    ['num-unit-abuse', /data-unit "900 per 100 ml" is not in the unit allowlist/],
  ] as const;
  for (const [fixture, message] of failing) {
    test(`fails ${fixture}`, async ({ page }) => {
      await open(page, fixture);
      const text = await collectText(page);
      const numbers = await servedNumbers(page);
      expect(findProvenanceProblems(text, numbers)).toHaveLength(1);
      expect(() => assertNumbersTraced(text, numbers)).toThrow(message);
    });
  }
});

test.describe('number provenance by data-src ("<file>#<json pointer>")', () => {
  test('resolves JSON pointers, escapes included', () => {
    const doc = { a: [{ b: 3 }], 'x/y': { '~z': 'ok' } };
    expect(resolvePointer(doc, '/a/0/b')).toBe(3);
    expect(resolvePointer(doc, '/x~1y/~0z')).toBe('ok');
    expect(resolvePointer(doc, '/a/1/b')).toBeUndefined();
    expect(resolvePointer(doc, '/a/01')).toBeUndefined();
    expect(resolvePointer(doc, 'a')).toBeUndefined();
  });

  test('passes DOM and canvas values that match their data file, numbers formatted and strings as is', async ({ page }) => {
    await open(page, 'num-src');
    const text = await collectText(page);
    expect(referencedFiles(text).sort()).toEqual(['nowcast_CO.json', 'replay_2024-09-23.json', 'warleigh_backtest.json']);
    const files = await servedDataFiles(page, referencedFiles(text));
    expect(findProvenanceProblems(text, await servedNumbers(page), files)).toEqual([]);
    await expectScreenQuality(page, 'rest');
  });

  const failing = [
    ['num-src-mismatch', /data-src="warleigh_backtest\.json#\/threshold": shows "1,000" but warleigh_backtest\.json formats to "900"/],
    ['num-src-pointer', /no value at \/samples\/9999\/ecoli_per_100ml in replay_2024-09-23\.json/],
    ['num-src-file', /data file no_such_file\.json could not be loaded/],
  ] as const;
  for (const [fixture, message] of failing) {
    test(`fails ${fixture}`, async ({ page }) => {
      await open(page, fixture);
      const text = await collectText(page);
      const numbers = await servedNumbers(page);
      const files = await servedDataFiles(page, referencedFiles(text));
      expect(findProvenanceProblems(text, numbers, files)).toHaveLength(1);
      expect(() => assertNumbersTraced(text, numbers, files)).toThrow(message);
    });
  }
});

test.describe('contrast', () => {
  test('passes the clean page and fails faint text, naming it', async ({ page }) => {
    await open(page, 'num-src');
    assertContrast(await findContrastProblems(page));
    await open(page, 'contrast-low');
    expect(() => assertContrast([])).not.toThrow();
    const problems = await findContrastProblems(page);
    expect(problems.map((p) => p.text)).toEqual(['faint words']);
    expect(() => assertContrast(problems)).toThrow(/"faint words": [\d.]+:1, needs 4\.5:1/);
  });
});

test.describe('cancelled map tiles', () => {
  test('only an aborted request to a tile host is forgiven', () => {
    expect(isCancelledTile('https://tiles.openfreemap.org/planet/1/2/3.pbf', 'net::ERR_ABORTED')).toBe(true);
    expect(isCancelledTile('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/1/2/3.png', 'net::ERR_ABORTED')).toBe(true);
    expect(isCancelledTile('https://tiles.openfreemap.org/planet/1/2/3.pbf', 'net::ERR_FAILED')).toBe(false);
    expect(isCancelledTile('http://localhost:4173/data/numbers.json', 'net::ERR_ABORTED')).toBe(false);
  });
});

test.describe('banned words', () => {
  test('passes a page without "safe" (hidden "unsafe hours" is not the banned word)', async ({ page }) => {
    await open(page, 'clean');
    const text = await collectText(page);
    expect(text.everything.join(' ')).toContain('unsafe hours');
    assertNoBannedWords(text);
  });

  test('fails "safe" in visible text', async ({ page }) => {
    await open(page, 'safe');
    const text = await collectText(page);
    expect(() => assertNoBannedWords(text)).toThrow(/banned word "safe" .*"The stream is safe today\."/);
  });

  test('fails "safe" in an aria-label and in hidden text, in any case', async ({ page }) => {
    await open(page, 'safe-hidden');
    expect(findBannedWords(await collectText(page))).toEqual(['SAFE', 'Safe to swim']);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('passes a page whose animation is inside a no-preference media query', async ({ page }) => {
    await open(page, 'motion-guarded');
    assertStill(await runningAnimations(page));
  });

  test('fails a page that animates regardless of the preference', async ({ page }) => {
    await open(page, 'motion');
    const running = await runningAnimations(page);
    expect(() => assertStill(running)).toThrow(/1 animation\(s\) still running: drift on <div>/);
  });
});

test.describe('all checks together', () => {
  test('expectScreenQuality passes the clean page at rest and the strip page in the strip state', async ({ page }) => {
    await open(page, 'clean');
    await expectScreenQuality(page, 'rest');
    await open(page, 'strip');
    await expectScreenQuality(page, 'strip');
  });

  test('expectScreenQuality fails the strip page at rest', async ({ page }) => {
    await open(page, 'strip');
    await expect(expectScreenQuality(page, 'rest')).rejects.toThrow(/word budget: 22 words/);
  });
});
