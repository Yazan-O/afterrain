// Story mode (#/story, the default route) through the shipped build: the narrated story (src/app/narration.ts),
// one sentence at a time. Warleigh Weir; the 2024 storm (a replay: logged spills, modelled travel); the 31,000 and
// the five-year proof; the dark hours; then Coimbra: the map's key on the map, the person's sentence at Eiras, its
// sampling request, the example test reading's comparison, the close, and free exploration.
// Every beat at 1440x900 and 390x844 through every check, the whole take end to end in real time, skip, Escape,
// links, and fixed points that draw the same frame on two loads of the shared film clock.
// The clock and the quest come from the served nowcast (harness/scenario.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { StoryState } from '../../src/app/storyShell';
import { countWords } from './harness/checks';
import { collectText } from './harness/collect';
import { CO } from './harness/scenario';
import { expect, expectContrastAA, expectScreenQuality, expectStillUnderReducedMotion, test, VIEWPORTS } from './harness/test';

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'screens', 'story');
const SHOTS = OUTPUT_DIR;
mkdirSync(SHOTS, { recursive: true });
const T = CO.t;

const story = (page: Page): Promise<StoryState | null> => page.evaluate(() => window.__sayrStory ?? null);
const frames = (page: Page, n = 2): Promise<void> =>
  page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = (): void => { if (++i >= k) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);

/**
 * Steps the shared film clock (?clock=manual) until the story shows chapter `index` at local second `local` or
 * later, with nothing loading. Steps land exactly on `local` inside the chapter.
 */
async function stepTo(page: Page, index: number, local: number, timeout = 120_000): Promise<StoryState> {
  const end = Date.now() + timeout;
  for (;;) {
    const s = await story(page);
    if (s && s.index === index && s.chapter !== 'title' && !s.waiting && s.local >= local - 1e-6) return s;
    if (Date.now() > end) throw new Error(`story did not reach chapter ${index} at ${local}: ${JSON.stringify(s)}`);
    const ms = s && s.index === index && !s.waiting ? Math.min(250, Math.max(1, (local - s.local) * 1000)) : 100;
    await page.evaluate((m) => window.__sayrClock!.step(m), ms);
    await page.waitForTimeout(s?.waiting ? 30 : 5);
  }
}

/** The beats, their chapter's place, and how long each is given to settle (local seconds after the beat). */
const BEATS = [
  ['bath', 0, 0.9],
  ['weir', 0, 2.5],
  ['rain', 0, 3.0],
  ['spill', 0, 4.0],
  ['still', 0, 3.0],
  ['sample', 0, 5.5],
  ['proof', 0, 3.0],
  ['cities', 1, 4.5],
  ['gap', 1, 3.0],
  ['europe', 2, 2.6],
  ['coimbra', 2, 2.75],
  ['forecast', 2, 1.8],
  ['key', 2, 5.5],
  ['human', 2, 3.0],
  ['ask', 2, 3.0],
  ['answer', 2, 1.2],
  ['changes', 2, 2.0],
  ['close', 2, 3.0],
] as const;
/** What the narration says on each beat (numbers from numbers.json and the data files, checked by the harness). */
const SAYS: Record<string, RegExp> = {
  bath: /^Warleigh Weir, near Bath\. People swim here\. Dogs run straight in\.$/,
  weir: /^Warleigh Weir, near Bath\. People swim here\. Dogs run straight in\.$/,
  rain: /^On \d+ September 2024 it rained hard all day\.$/,
  spill: /^Upstream, a storm overflow opened at \d\d:\d\d and ran for \d+ hours\.$/,
  still: /^By morning the water looked the same as always\.$/,
  sample: /^At \d\d:\d\d a lab sample read 31,000 E\. coli per 100 ml\. The warning line is 900\.A single-sample flag$/,
  proof: /^Not one bad night\. In five years, \d+ of \d+ samples taken after that overflow were over the line\.Samples within \d+ hours of a spill$/,
  cities: /^In OneAquaHealth's five cities, \d+ of \d+ samples were taken after dry days\.$/,
  gap: /^The hours after rain, when people and dogs are in the water, are the hours nobody measures\.$/,
  europe: /^OneAquaHealth studies city streams in five European cities\.$/,
  coimbra: /^Coimbra, Portugal\.$/,
  forecast: /^Sayr forecasts those hours\.$/,
  human: /^Eiras, (\w+day\. Usual chance today\.|(\w+day|from \w+day \d\d:00): (higher|high) chance (after rain|even without rain)\. Keep dogs out until .+\.)$/,
  ask: /^Nobody has measured Eiras after rain\. Sayr asks for one sample( at .+)?: \w+day, \d\d:00 to \d\d:00\.$/,
  changes: /^One sample changes the answer\.$/,
  close: /^Sayr\. Know the water before you go in\.$/,
};

async function record(page: Page, name: string): Promise<void> {
  const w = countWords(await collectText(page));
  test.info().annotations.push({ type: 'words', description: `${name}: ${w.count} (${w.words.join(' ')})` });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const say = (page: Page) => page.locator('.story > .story-say');

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, ...(size === 'phone' ? { isMobile: true, hasTouch: true } : {}) });

    test('the first paint is the first line of the story, and the live narration takes it over in place', async ({ page }) => {
      test.setTimeout(150_000);
      await page.goto(`/?theme=night&t=${T}`);
      await expect(page).toHaveURL(/#\/story(\/[a-z]+)?$/);
      await expect(page.locator('#first .say-main, .story-say .say-main').first()).toHaveText(SAYS['weir']!, { timeout: 3000 });
      await expect(say(page)).toHaveText(SAYS['weir']!, { timeout: 20_000 });
      await expect(page.locator('.story-layer[data-ch="storm"] .rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
      await expect(page.locator('#first')).toHaveCount(0, { timeout: 10_000 });
    });

    for (const [i, [beat, index, settle]] of BEATS.entries()) {
      test(`beat ${beat}: passes every check`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.goto(`/?theme=night&clock=manual&t=${T}#/story/${beat}`);
        await expect.poll(() => story(page).then((s) => s?.beats.some((b) => b.id === beat) ?? false), { timeout: 60_000 }).toBe(true);
        const all = (await story(page))!.beats;
        const k = all.findIndex((b) => b.id === beat);
        const at = all[k]!.at;
        // settle, but never past the next beat of the chapter
        const nb = all[k + 1];
        const next = nb && nb.chapter === all[k]!.chapter && nb.at > at ? nb.at : Infinity;
        const s = await stepTo(page, index, Math.min(at + settle, next - 0.05));
        expect(s.beat).toBe(beat);
        await page.evaluate(() => document.fonts.ready);
        await frames(page, 3);
        if (SAYS[beat]) await expect(say(page)).toHaveText(SAYS[beat]!);
        // the places named on the map (src/app/geoView.ts): each name fully on screen
        const named = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.story .geo-mark')].filter((e) => Number(e.style.opacity) > 0.95).map((e) => e.textContent ?? ''));
        if (beat === 'bath') expect(await named()).toEqual(['Bath, England']);
        if (beat === 'europe') expect((await named()).sort()).toEqual(['Benevento, Italy', 'Coimbra, Portugal', 'Ghent, Belgium', 'Oslo, Norway', 'Toulouse, France']);
        if (beat === 'coimbra') expect((await named()).sort()).toEqual(['Coimbra, Portugal', 'Mondego']);
        if (beat === 'sample') await expect(page.locator('.rp-arr-hero')).toHaveText('31,000');
        if (beat === 'spill') await expect(page.locator('.rp-key')).toHaveText('Logged spills. Modelled travel.');
        if (beat === 'key') await expect(page.locator('.city .mk-key .mk-t')).toHaveText(['Each line is a stream.', 'Brighter orange: higher chance the water is over the line.', 'Dots: nobody has measured here after rain.']);
        if (beat === 'answer') {
          await expect(page.locator('.city')).toHaveAttribute('data-compare', 'held');
          await expect(page.locator('.questui .cmpk')).toHaveText(/^Example test reading · \d+ \w{3} \d\d:00 UTC(\+\d+)?$/);
        }
        if (beat === 'close') await expect(page.locator('.city .questui .next')).toHaveText(/^Sample \S/);
        await expectScreenQuality(page, beat === 'answer' ? 'compare' : 'story');
        await expectContrastAA(page);
        await record(page, `story-${String(i + 1).padStart(2, '0')}-${beat}-${size}`);
      });
    }
  });
}

// with the clock outside the forecast, the ending keeps the forecast's date in the corner
// through the handover, and the recommendation it opens is the dated forecast's ("Forecast of 2 Oct: Sample ...").
async function expectDatedEnding(page: Page): Promise<void> {
  // the close's line has gone with the story: the ending is free exploration
  await expect(page).toHaveURL(/#\/city\/CO$/, { timeout: 90_000 });
  await expect(page.locator('body')).toHaveAttribute('data-cue', 'next', { timeout: 60_000 });
  await expect(page.locator('body')).toHaveAttribute('data-dated', '');
  await expect(page.locator('.hour')).toHaveText(`forecast ${CO.fetched}`);
  await expect(page.locator('.hour')).toBeVisible();
  await expect(page.locator('.questui .next')).toHaveText(/^Sample \S/);
  await expect(page.locator('.questui .win')).toHaveText(/^(\w{3} )?\d\d:00–.*UTC(\+\d+)?$/);
  await page.waitForTimeout(600);
  await expectScreenQuality(page, 'restDated');
  await page.locator('.questui .next').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'strip', { timeout: 30_000 });
  await expect(page.locator('.voice')).toHaveText(new RegExp(`^Forecast of ${CO.fetched}: Sample `));
  await expect(page.locator('.hour')).toHaveText(`forecast ${CO.fetched}`);
}
for (const [size, viewport] of Object.entries(VIEWPORTS))
  test.describe(`a clock outside the forecast, ${size}`, () => {
    test.use({ viewport, ...(size === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
    test('a direct link to the ending keeps the forecast dated through the handover', async ({ page }) => {
      test.setTimeout(150_000);
      await page.goto(`/?theme=night&t=${CO.dated}#/story/close`);
      await expectDatedEnding(page);
    });
  });

test.describe('the story at 1440x900, a clock outside the forecast', () => {
  test.use({ viewport: VIEWPORTS.desktop });
  test('end to end in real time: the ending and the handover stay dated', async ({ page }) => {
    test.setTimeout(240_000);
    const t0 = Date.now();
    await page.goto(`/?theme=night&t=${CO.dated}`);
    while (!/#\/city\//.test(page.url())) {
      if (Date.now() - t0 > 200_000) throw new Error('the story did not hand over');
      await page.waitForTimeout(250);
    }
    test.info().annotations.push({ type: 'timing', description: `dated clock: handed over after ${((Date.now() - t0) / 1000).toFixed(1)} s` });
    await expectDatedEnding(page);
  });
});

// Review 2026-10-03 [DEFECT] "expired requests": with the forecast still live and every saved request closed, the
// ending still names a sampling request: a later one from the forecast's remaining hours (its window still open at
// the clock), never an empty or hidden control.
async function expectLiveRequest(page: Page, clock: string): Promise<void> {
  await expect(page).toHaveURL(/#\/city\/CO$/, { timeout: 90_000 });
  await expect(page.locator('body')).toHaveAttribute('data-cue', 'next', { timeout: 60_000 });
  await expect(page.locator('body')).not.toHaveAttribute('data-dated', '');
  await expect(page.locator('.questui')).toBeVisible();
  await expect(page.locator('.questui')).toHaveAttribute('data-request', 'later');
  await expect(page.locator('.questui .next')).toBeVisible();
  await expect(page.locator('.questui .next')).toHaveText(/^Sample \S/);
  await expect(page.locator('.questui .win')).toHaveText(/^\w{3} \d+ \w{3} \d\d:00–.*UTC(\+\d+)?$/);
  const end = Number(await page.locator('.questui').getAttribute('data-end-ms'));
  expect(end).toBeGreaterThan(Date.parse(clock));
  await page.waitForTimeout(600);
  await expectScreenQuality(page, 'rest');
  await page.locator('.questui .next').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'strip', { timeout: 30_000 });
}
for (const [size, viewport] of Object.entries(VIEWPORTS))
  test.describe(`a live forecast after every saved request has closed, ${size}`, () => {
    test.use({ viewport, ...(size === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
    test('a direct link to the ending names the next request from the remaining forecast hours', async ({ page }) => {
      test.setTimeout(150_000);
      await page.goto(`/?theme=night&t=${CO.afterSaved}#/story/close`);
      await expectLiveRequest(page, CO.afterSaved);
    });
  });

test.describe('the story at 1440x900, a live forecast after every saved request has closed', () => {
  test.use({ viewport: VIEWPORTS.desktop });
  test('end to end in real time: the default story ends on a request that is still open', async ({ page }) => {
    test.setTimeout(240_000);
    const t0 = Date.now();
    await page.goto(`/?theme=night&t=${CO.afterSaved}`);
    await expect(page).toHaveURL(/#\/story(\/[a-z]+)?$/);
    while (!/#\/city\//.test(page.url())) {
      if (Date.now() - t0 > 200_000) throw new Error('the story did not hand over');
      await page.waitForTimeout(250);
    }
    await expectLiveRequest(page, CO.afterSaved);
  });
  test('at the forecast\'s last hour, with no request left open, the ending shows a dated request that says its date', async ({ page }) => {
    test.setTimeout(150_000);
    expect(CO.openAtLastHour).toBe(false);
    await page.goto(`/?theme=night&t=${CO.lastHour}#/story/close`);
    await expect(page).toHaveURL(/#\/city\/CO$/, { timeout: 90_000 });
    await expect(page.locator('body')).toHaveAttribute('data-cue', 'next', { timeout: 60_000 });
    await expect(page.locator('.questui')).toBeVisible();
    await expect(page.locator('.questui')).toHaveAttribute('data-request', 'dated');
    // the forecast is live (no dated corner): the window says its full date, and it closed before the clock
    await expect(page.locator('.questui .win')).toHaveText(/^\w{3} \d+ \w{3} \d\d:00–.*UTC(\+\d+)?$/);
    expect(Number(await page.locator('.questui').getAttribute('data-end-ms'))).toBeLessThanOrEqual(Date.parse(CO.lastHour));
    await expect(page.locator('.questui .next')).toHaveText(/^Sample \S/);
    await page.waitForTimeout(600);
    await expectScreenQuality(page, 'rest');
  });
});

test.describe('the story at 1440x900', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('end to end in real time: the weir, the storm, the dark hours, Coimbra, then free exploration', async ({ page }) => {
    test.setTimeout(240_000);
    const t0 = Date.now();
    await page.goto(`/?theme=night&t=${T}`);
    await expect(page).toHaveURL(/#\/story(\/[a-z]+)?$/);
    const seen: string[] = [];
    const beats: string[] = [];
    const lines: string[] = [];
    while (!/#\/city\//.test(page.url())) {
      const s = await story(page);
      const ch = s ? `${s.chapter}${s.index}` : '';
      if (s && seen[seen.length - 1] !== ch) seen.push(ch);
      if (s && beats[beats.length - 1] !== s.beat) beats.push(s.beat);
      const l = (await page.evaluate(() => document.querySelector('.story-say')?.textContent ?? '')) ?? '';
      if (l && lines[lines.length - 1] !== l) lines.push(l);
      if (Date.now() - t0 > 200_000) throw new Error(`the story did not hand over: ${seen.join(' ')} / ${beats.join(' ')}`);
      await page.waitForTimeout(150);
    }
    const seconds = (Date.now() - t0) / 1000;
    test.info().annotations.push({ type: 'timing', description: `handed over after ${seconds.toFixed(1)} s: ${beats.join(' > ')}` });
    test.info().annotations.push({ type: 'narration', description: lines.join(' | ') });
    expect(seen).toEqual(['storm0', 'dark1', 'city2']);
    expect(beats).toEqual(['bath', 'weir', 'rain', 'spill', 'still', 'sample', 'proof', 'cities', 'gap', 'europe', 'coimbra', 'forecast', 'key', 'human', 'ask', 'test', 'kit', 'answer', 'changes', 'close']);
    // every narrated line was on screen, in order
    // the weir's line comes up over Bath and stays as the camera lands at the weir (one line on screen)
    const want = ['weir', 'rain', 'spill', 'still', 'sample', 'proof', 'cities', 'gap', 'europe', 'coimbra', 'forecast', 'human', 'ask', 'changes', 'close'];
    let j = 0;
    for (const l of lines) if (j < want.length && SAYS[want[j]!]!.test(l)) j++;
    expect(j, lines.join(' | ')).toBe(want.length);
    expect(seconds).toBeGreaterThan(65);
    expect(seconds).toBeLessThan(125);
    await expect(page).toHaveURL(/#\/city\/CO$/);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'rest');
    // the next eligible sampling site: its name is the control, its window carries the zone
    await expect(page.locator('.questui .next')).toHaveText(/^Sample \S/);
    await expect(page.locator('.questui .win')).toHaveText(/^\w{3} \d+ \w{3} \d\d:00–.*UTC(\+\d+)?$/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
    await expect(page.locator('.story-skip')).toHaveCount(0);
    await expect(page.locator('.story-say')).toHaveCount(0);
    expect(await story(page)).toBeNull();
    await page.waitForTimeout(600);
    await expectScreenQuality(page, 'rest');
    await record(page, 'story-end-explore-desktop');
    // free exploration starts on the recommendation: its stream opens on its quest
    await page.locator('.questui .next').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'strip', { timeout: 20_000 });
    await expect(page.locator('.questui .win')).toBeVisible();
  });

  test('Back from free exploration returns to the story at its city chapter', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?theme=night&t=${T}#/story/close`);
    await expect(page).toHaveURL(/#\/city\/CO$/, { timeout: 90_000 });
    await expect(page.locator('body')).toHaveAttribute('data-state', 'rest', { timeout: 30_000 });
    await page.goBack();
    await expect(page).toHaveURL(/#\/story\/europe$/);
    // the story's own city chapter plays (never the weir, which a missing beat falls back to)
    await expect.poll(async () => { const s = await story(page); return s ? `${s.chapter}${s.index}:${s.beat}` : ''; }, { timeout: 60_000 }).toMatch(/^city2:(europe|coimbra|forecast)$/);
  });

  test('links: a fresh load of #/story/changes builds the comparison with its example test reading taken', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?theme=night&t=${T}#/story/changes`);
    await expect(page.locator('.city')).toHaveAttribute('data-compare', 'held', { timeout: 30_000 });
    await expect(page.locator('.city')).toHaveAttribute('data-tested', 'under');
    const c = await page.evaluate(() => (window.sayr!['compare'] as () => { applied: boolean; code: string; tested: { p: number } })());
    expect(c.applied).toBe(true);
    expect(c.code).toBe('C4');
    await expect(page.locator('.city .cmp .cv').nth(1)).toHaveText(/^\d+\.\d%$/);
    await expect(say(page)).toHaveText(SAYS['changes']!, { timeout: 20_000 });
    await page.reload();
    await expect(page.locator('.city')).toHaveAttribute('data-tested', 'under', { timeout: 30_000 });
  });

  test('links: #/story/spill opens the replay, a reload resumes at its beat', async ({ page }) => {
    test.setTimeout(240_000);
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await page.goto(`/?t=${T}#/story/spill`);
    await expect.poll(async () => (await story(page))?.chapter, { timeout: 60_000 }).toBe('storm');
    expect(warnings.filter((w) => /no beat/.test(w))).toEqual([]);
    await expect(page).toHaveURL(/#\/story\/(spill|still|sample)$/, { timeout: 30_000 });
    await page.reload();
    await expect.poll(async () => (await story(page))?.chapter, { timeout: 60_000 }).toMatch(/^(storm|dark|city)$/);
    expect((await story(page))!.beat).not.toBe('weir');
  });

  test('skip: the right arrow, the skip control and space move on beat by beat', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?theme=night&t=${T}#/story/sample`);
    await expect.poll(async () => { const s = await story(page); return s?.chapter === 'storm' && !s.waiting; }, { timeout: 60_000 }).toBe(true);
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await story(page))?.beat, { timeout: 5_000 }).toBe('proof');
    await page.waitForTimeout(700);
    const skip = page.locator('.story-skip');
    const box = (await skip.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await skip.click();
    await expect.poll(async () => (await story(page))?.chapter, { timeout: 60_000 }).toBe('dark');
    await page.mouse.move(10, 450);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await story(page))?.beat, { timeout: 5_000 }).toBe('gap');
  });

  test('Escape in the storm: the city is handed over, free to explore', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?theme=night&t=${T}#/story/sample`);
    await expect.poll(async () => { const s = await story(page); return s?.chapter === 'storm' && !s.waiting; }, { timeout: 90_000 }).toBe(true);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/city\/CO(\/stream\/[a-z-]+)?$/, { timeout: 90_000 });
    expect(await story(page)).toBeNull();
    await expect(page.locator('.elsewhere a')).toHaveText(['dark hours', 'storm']);
    await page.waitForTimeout(700);
    await expectScreenQuality(page, (await page.locator('body').getAttribute('data-state')) === 'strip' ? 'strip' : 'rest');
    await expectContrastAA(page);
    await record(page, 'explore-after-escape-desktop');
  });

  test('Escape after the answer hands the comparison over as it is: the other reading from the same baseline, then the map', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?theme=night&t=${T}#/story/test`);
    await expect(page.locator('.city')).toHaveAttribute('data-compare', 'held', { timeout: 60_000 });
    const low = await page.evaluate(() => (window.sayr!['compare'] as () => { tested: { p: number } })().tested.p);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/city\/CO$/);
    expect(await story(page)).toBeNull();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'compare');
    // the high reading starts from the same baseline as the low one: the "Before" readout never moves
    const before = await page.locator('.city .cmp .cv').first().textContent();
    await page.getByRole('button', { name: /over nine hundred/ }).click();
    await expect(page.locator('.city')).toHaveAttribute('data-tested', 'over');
    await expect(page.locator('.city')).toHaveAttribute('data-compare', 'held', { timeout: 10_000 });
    const c = await page.evaluate(() => (window.sayr!['compare'] as () => { tested: { p: number } })());
    expect(c.tested.p).toBeGreaterThan(low);
    await expect(page.locator('.city .cmp .cv').first()).toHaveText(before!);
    await expectScreenQuality(page, 'compare');
    // Escape folds the comparison into the map, as it does anywhere in the city
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'rest', { timeout: 15_000 });
  });

  test('free exploration: "What am I looking at?" brings the key back on the map, and it fades after it is read', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?theme=night&t=${T}#/city/CO`);
    await expect(page.locator('.city')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    const btn = page.getByRole('button', { name: 'What am I looking at?' });
    await expect(btn).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(6500);
    await btn.click();
    await expect(page.locator('.city .mk-key .mk-t')).toHaveText(['Each line is a stream.', 'Brighter orange: higher chance the water is over the line.', 'Dots: nobody has measured here after rain.']);
    await page.waitForTimeout(3200);
    await expectScreenQuality(page, 'key');
    await expectContrastAA(page);
    await record(page, 'explore-key-on-demand-desktop');
    // read, then gone: the control comes back
    await expect(page.locator('.city .mk-key')).toHaveCount(0, { timeout: 15_000 });
    await expect(btn).toBeVisible();
  });
});

test.describe('the shared film clock', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  // fixed points of the take: the weir, the 31,000 landed at the weir, the dark hours' wet side
  const POINTS = [
    { name: 'the weir', index: 0, local: (s: StoryState) => s.beats.find((b) => b.id === 'weir')!.at + 2.0, pixels: true },
    { name: 'the 31,000', index: 0, local: (s: StoryState) => s.beats.find((b) => b.id === 'sample')!.at + 5.0, pixels: true },
    { name: 'the gap', index: 1, local: (s: StoryState) => s.beats.find((b) => b.id === 'gap')!.at + 2.0, pixels: true },
  ] as const;

  test('?clock=manual: the same point of the story draws the same frame on two loads', async ({ browser }) => {
    test.setTimeout(720_000);
    const takes: { shots: Buffer[]; states: string[]; words: string[] }[] = [];
    for (let k = 0; k < 2; k++) {
      const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
      await page.goto(`/?theme=night&clock=manual&t=${T}#/story`);
      await expect.poll(() => story(page).then((s) => s?.beats.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
      const take = { shots: [] as Buffer[], states: [] as string[], words: [] as string[] };
      for (const p of POINTS) {
        const s0 = (await story(page))!;
        const s = await stepTo(page, p.index, p.local(s0), 240_000);
        await page.evaluate(() => document.fonts.ready);
        await frames(page, 4);
        take.shots.push(p.pixels ? await page.screenshot() : Buffer.alloc(0));
        take.states.push(`${s.chapter}/${s.beat}/${s.local.toFixed(3)}`);
        take.words.push(countWords(await collectText(page)).words.join(' '));
        if (k === 0) await page.screenshot({ path: join(SHOTS, `film-point-${POINTS.indexOf(p) + 1}.png`) });
      }
      takes.push(take);
      await page.close();
    }
    expect(takes[1]!.states).toEqual(takes[0]!.states);
    expect(takes[1]!.words).toEqual(takes[0]!.words);
    POINTS.forEach((p, i) => {
      if (p.pixels) expect(Buffer.compare(takes[0]!.shots[i]!, takes[1]!.shots[i]!), `${p.name}: two loads differ`).toBe(0);
    });
  });
});

test.describe('prefers-reduced-motion (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop, reducedMotion: 'reduce' });

  test('the story plays in still frames, the x-ray turns without motion, nothing animates', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?theme=night&t=${T}#/story/sample`);
    await expect.poll(async () => { const s = await story(page); return s?.chapter === 'storm' && !s.waiting; }, { timeout: 60_000 }).toBe(true);
    await page.waitForTimeout(3500);
    await expectStillUnderReducedMotion(page);
    await expectScreenQuality(page, 'story');
    const hero = page.locator('.rp-arr-hero');
    await expect(hero).toBeVisible({ timeout: 20_000 });
    const r = (await hero.boundingBox())!;
    await page.keyboard.down('Alt');
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await page.keyboard.up('Alt');
    await expect(page.locator('.xr-back')).toHaveAttribute('data-open', 'true');
    await expect(page.locator('.xr-ghost')).toHaveCount(0);
    await expectStillUnderReducedMotion(page);
    await expectScreenQuality(page, 'story');
    await page.screenshot({ path: join(SHOTS, 'xray-reduced-motion-desktop.png') });
  });
});

// Review 2026-10-03 [DEFECT] "FHIR live-record terms": the records the opening's interaction makes at Eiras (the
// published forecast, then a low and a high test reading, each from the same baseline) are written out as FHIR JSON
// for the HL7 validator (fhir/tests/test_live_records.py validates them against the guide).
const LIVE_EXPORT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fhir', 'build', 'live-export');
test.describe("the opening comparison's live records", () => {
  test.use({ viewport: VIEWPORTS.desktop });
  test('the forecast and the low and high test estimates at Eiras export as FHIR JSON', async ({ page }) => {
    test.setTimeout(180_000);
    type Rec = { resourceType: string; id: string; component?: { valueBoolean?: boolean }[] };
    const grab = (): Promise<Rec[]> => page.evaluate(() => Object.values(window.__sayrLive ?? {}) as Rec[]);
    const reading = (rs: Rec[], over: boolean): Rec | undefined =>
      rs.filter((r) => r.id.startsWith('sayr-test-C4-') && r.component?.some((c) => c.valueBoolean === over)).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).pop();
    await page.goto(`/?theme=night&t=${T}#/story/test`);
    await expect(page.locator('.city')).toHaveAttribute('data-compare', 'held', { timeout: 60_000 });
    const low = reading(await grab(), false);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'compare');
    await page.getByRole('button', { name: /over nine hundred/ }).click();
    await expect(page.locator('.city')).toHaveAttribute('data-tested', 'over');
    await expect(page.locator('.city')).toHaveAttribute('data-compare', 'held', { timeout: 10_000 });
    const all = await grab();
    const high = reading(all, true);
    const forecast = all.find((r) => r.id.startsWith('sayr-forecast-C4-'));
    expect(low, 'the low reading record').toBeTruthy();
    expect(high, 'the high reading record').toBeTruthy();
    expect(forecast, 'the forecast record').toBeTruthy();
    mkdirSync(LIVE_EXPORT, { recursive: true });
    for (const [name, r] of [['forecast', forecast], ['test-low', low], ['test-high', high]] as const) writeFileSync(join(LIVE_EXPORT, `${name}.json`), JSON.stringify(r, null, 1));
  });
});
