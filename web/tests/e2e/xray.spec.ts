// The FHIR x-ray (spec W8) through the shipped build: each mapping turned over at 1440x900 and 390x844 and put
// through every check (the typeset resource sits in a [data-code] region, exempt from the word budget; each of
// its values is read against the served resource file by data-src). The 31,000 by Alt+click, Warleigh Weir by
// the X key, a Coimbra stream's risk by a long press, the quest by Alt+click; the folded corner on hover; the
// story holds while a card is open.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { CO } from './harness/scenario';
import { expect, expectContrastAA, expectScreenQuality, test, VIEWPORTS } from './harness/test';

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'screens', 'xray');
const T = CO.t;
const SITE = CO.quest.code;
const OAH = 'http://hl7.eu/fhir/ig/oah/StructureDefinition/';

const back = (page: Page): Locator => page.locator('.xr-back');
/** Each typeset line as "<key> <value>". */
const lines = (page: Page): Promise<string[]> =>
  page.locator('.xr-back .xr-l').evaluateAll((els) => els.map((e) => [...e.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' ')));

async function altClick(page: Page, target: Locator): Promise<void> {
  const r = (await target.boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.keyboard.up('Alt');
}

async function opened(page: Page): Promise<void> {
  await expect(back(page)).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
  // the mark reads the served validator summary
  await expect(back(page).locator('.xr-mark')).toHaveText(/^0 errors · HL7 validator · OneAquaHealth guide$/);
}

async function checkAndShoot(page: Page, name: string): Promise<void> {
  await expectScreenQuality(page, 'strip');
  await expectContrastAA(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function turnBack(page: Page, key = 'Escape'): Promise<void> {
  await page.keyboard.press(key);
  await expect(back(page)).toHaveCount(0);
  await expect(page.locator('#scene')).not.toHaveAttribute('style', /opacity: 0/);
}

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${size} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('the 31,000 turns over to its ObservationIndicatorsOah and SpecimenOah; the weir to its LocationOah', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto('/?theme=night&t=2024-09-24T08:30:00Z#/replay');
      await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      const hero = page.locator('.rp-arr-hero');
      await expect(hero).toHaveText('31,000');
      await altClick(page, hero);
      await opened(page);
      const obs = await lines(page);
      expect(obs[0]).toBe(`meta.profile "${OAH}observation-indicators-oah"`);
      expect(obs).toContain('valueQuantity.value 31000');
      expect(obs).toContain('effectiveDateTime "2024-09-24T09:10:00+01:00"');
      expect(obs).toContain('referenceRange.high.value 900');
      expect(obs).toContain('specimen.reference "Specimen/warleigh-water-20240924T0810Z"');
      expect(obs).toContain(`meta.profile "${OAH}specimen-oah"`);
      await expect(hero).toBeHidden(); // the number is on the other side of the card now
      await checkAndShoot(page, `xray-1-sample-${size}`);
      await turnBack(page);
      await expect(hero).toBeVisible();

      await altClick(page, page.locator('.rp-weir'));
      await opened(page);
      const weir = await lines(page);
      expect(weir[0]).toBe(`meta.profile "${OAH}location-oah"`);
      expect(weir).toContain('name "Warleigh Weir, River Avon"');
      expect(weir).toContain('position.latitude 51.37705');
      await checkAndShoot(page, `xray-2-weir-${size}`);
      await turnBack(page, 'x');
      // the X key turns over the element in focus, else the largest on screen
      await page.keyboard.press('x');
      await opened(page);
      expect((await lines(page))[0]).toBe(`meta.profile "${OAH}observation-indicators-oah"`); // the largest: the 31,000
      await page.mouse.click(8, viewport.height / 2); // a tap outside turns it back
      await expect(back(page)).toHaveCount(0);
    });

    test("a Coimbra line turns over to the forecast at its place and hour, then a test estimate; the site's published peak is a separate link", async ({ page }) => {
      test.setTimeout(150_000);
      await page.goto(`/?theme=night&t=${T}#/city/CO/stream/${CO.quest.stream}`);
      await expect(page.locator('body')).toHaveAttribute('data-state', 'strip', { timeout: 90_000 });
      await page.locator('.questbtn').click();
      const voice = page.locator('.voice');
      await expect(voice).toHaveText(/^Sample /);
      await page.waitForTimeout(600);
      // a long press on the line: the strip stays open under it
      const r = (await voice.boundingBox())!;
      await page.mouse.move(r.x + r.width / 3, r.y + r.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(750);
      await page.mouse.up();
      await expect(back(page)).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
      // made in the browser from the strip's own hour: no validator mark, its own heading, every number traced
      await expect(back(page).locator('.xr-head')).toHaveText(`Forecast at ${CO.quest.site}`);
      await expect(back(page).locator('.xr-mark')).toHaveCount(0);
      const fc = await lines(page);
      expect(fc).toContain(`subject.reference "Location/oah-site-${SITE}"`);
      expect(fc).toContain('code.coding.code "ecoli-exceedance-probability"');
      expect(fc).toContain(`derivedFrom.reference "Observation/oah-risk-dog-owners-${SITE}"`);
      expect(fc.join(' ')).not.toMatch(/warleigh/i);
      await expect(page.locator('body')).toHaveAttribute('data-state', 'strip');
      await checkAndShoot(page, `xray-3-forecast-${size}`);
      // the published peak, served and validated, one tap away
      await back(page).locator('.xr-link').click();
      await opened(page);
      const peak = await lines(page);
      expect(peak[0]).toBe(`meta.profile "${OAH}observation-health-measure-oah"`);
      expect(peak).toContain(`subject.reference "Location/oah-site-${SITE}"`);
      expect(peak).toContain('focus.reference "Group/cohort-dog-owners"');
      expect(peak.findIndex((l) => l.startsWith('code.coding.display'))).toBe(peak.findIndex((l) => l.startsWith('code.coding.code')) + 1);
      await checkAndShoot(page, `xray-4-published-peak-${size}`);
      await turnBack(page);
      await expect(page.locator('body')).toHaveAttribute('data-state', 'strip');

      // after a test reading the line is the browser's recomputed estimate, marked as a test
      await page.locator('.questui .add').click();
      await page.getByRole('button', { name: /or less/ }).click();
      // on the forecast curve the result's line is the reading itself, marked as a test
      await expect(voice).toHaveText(/^Test reading · 900 or less · /, { timeout: 5000 });
      await altClick(page, voice);
      await expect(back(page)).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
      await expect(back(page).locator('.xr-head')).toHaveText(`Test estimate at ${CO.quest.site}`);
      await expect(back(page).locator('.xr-mark')).toHaveCount(0);
      const te = await lines(page);
      expect(te).toContain('meta.tag.code "test-reading"');
      expect(te).toContain('status "preliminary"');
      expect(te).toContain('component.valueBoolean false');
      expect(te).toContain(`subject.reference "Location/oah-site-${SITE}"`);
      await checkAndShoot(page, `xray-5-test-estimate-${size}`);
      await turnBack(page);
      await expect(page.locator('.questui')).toBeVisible();
    });
  });
}

test.describe('discovery and the story (1440x900)', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test("the validator's mark is read from the served summary: errors show as errors, with a cross", async ({ page }) => {
    test.setTimeout(120_000);
    await page.route('**/data/fhir/sayr.summary.json', async (r) => {
      const res = await r.fetch();
      const j = (await res.json()) as { counts: Record<string, number> };
      j.counts['error'] = 3;
      await r.fulfill({ response: res, json: j });
    });
    await page.goto('/?theme=night&t=2024-09-24T08:30:00Z#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await altClick(page, page.locator('.rp-weir'));
    await expect(back(page)).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
    await expect(back(page).locator('.xr-mark')).toHaveText(/^3 errors · HL7 validator · OneAquaHealth guide$/);
    await expect(back(page).locator('.xr-mark')).toHaveClass(/xr-bad/);
  });

  test('the Observation card shows what its code means beside the code', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?theme=night&t=2024-09-24T08:30:00Z#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await altClick(page, page.locator('.rp-arr-hero'));
    await opened(page);
    const l = await lines(page);
    const i = l.findIndex((x) => x.startsWith('code.coding.code'));
    expect(l[i + 1]).toMatch(/^code\.(text|coding\.display) /);
  });

  test('a folded corner appears on hover, only on what turns over, and turns it', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?theme=night&t=2024-09-24T08:30:00Z#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    const ear = page.locator('.xr-ear');
    await page.mouse.move(300, 600);
    await expect(ear).toBeHidden();
    const r = (await page.locator('.rp-arr-hero').boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await expect(ear).toBeVisible();
    const e = (await ear.boundingBox())!;
    expect(e.width).toBeGreaterThanOrEqual(44);
    expect(Math.abs(e.x + e.width / 2 - (r.x + r.width))).toBeLessThan(2); // on the number's top right corner
    await page.screenshot({ path: join(SHOTS, 'xray-0-corner-desktop.png') });
    await ear.click();
    await opened(page);
    await turnBack(page);
  });

  test("a folded corner appears on hover over a city stream's line, whose record is made in the browser", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/?theme=night&t=${T}#/city/CO/stream/${CO.quest.stream}`);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'strip', { timeout: 90_000 });
    const voice = page.locator('.voice');
    await expect(voice).toHaveAttribute('data-fhir', /^forecast:/);
    const ear = page.locator('.xr-ear');
    await page.mouse.move(5, 450);
    await expect(ear).toBeHidden();
    const r = (await voice.boundingBox())!;
    await page.mouse.move(r.x + r.width / 3, r.y + r.height / 2);
    await expect(ear).toBeVisible({ timeout: 5000 });
    await ear.click();
    await expect(back(page)).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
    await expect(back(page).locator('.xr-head')).toHaveText(`Forecast at ${CO.quest.site}`);
    await turnBack(page);
  });

  test('a card shows the resource of the key it was asked for, even when the element moves on while the index loads', async ({ page }) => {
    test.setTimeout(120_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/data/fhir/index.json', async (r) => {
      await gate;
      await r.continue();
    });
    await page.goto('/?theme=night&t=2024-09-24T08:30:00Z#/replay');
    await expect(page.locator('.rp')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    const [a, b] = await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'race';
      el.textContent = 'line';
      el.style.cssText = 'position:fixed;left:40px;top:40px;width:120px;height:40px;margin:0;color:#fff;z-index:9';
      el.dataset['fhir'] = 'site:C4';
      document.body.append(el);
      document.dispatchEvent(new CustomEvent('sayr:xray', { detail: { el } }));
      el.dataset['fhir'] = 'site:C17';
      return ['C4', 'C17'];
    });
    release();
    await expect(back(page)).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
    const l = await lines(page);
    expect(l).toContain(`subject.reference "Location/oah-site-${a}"`);
    expect(l.join(' ')).not.toContain(`oah-site-${b}"`);
  });

  test('the story holds while a card is open', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto(`/?theme=night&t=${T}#/story/sample`);
    const story = () => page.evaluate(() => window.__sayrStory!);
    await expect.poll(async () => (await story())?.waiting === false && (await story())?.chapter === 'storm', { timeout: 60_000 }).toBe(true);
    const hero = page.locator('.rp-arr-hero');
    await expect(hero).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    await altClick(page, hero);
    await opened(page);
    const a = (await story()).local;
    await page.waitForTimeout(1500);
    expect((await story()).local).toBe(a);
    await expectScreenQuality(page, 'story');
    await turnBack(page);
    await page.waitForTimeout(800);
    expect((await story()).local).toBeGreaterThan(a);
  });
});
