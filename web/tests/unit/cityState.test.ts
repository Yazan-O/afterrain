// The browser recomputes every site's hours from the stream pack's ensemble rain; at the prior they must equal
// the nowcast the pipeline wrote (rounded to 4 decimals there), for every city, site and hour.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode } from '../../src/data/decode';
import { CITY_IDS, streamPackFile, type CityId } from '../../src/data/schemas';
import { CityState } from '../../src/model/cityState';
import { disk } from './disk';

const PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data', 'streams');
const pack = (id: CityId) => decode(`streams/${id}.json`, streamPackFile(id), JSON.parse(readFileSync(resolve(PACKS, `${id}.json`), 'utf-8')));

describe('city state', () => {
  for (const id of CITY_IDS) {
    it(`${id}: the prior reproduces nowcast_${id}.json at every site and hour`, async () => {
      const [spec, now] = await Promise.all([disk.updateSpec(), disk.nowcast(id)]);
      const cs = new CityState(spec, pack(id), now);
      let worst = 0;
      for (const s of now.sites) {
        const mine = cs.series(s.code);
        for (let h = 0; h < now.hours_utc.length; h++) {
          worst = Math.max(worst, Math.abs(mine.p50[h]! - s.p50[h]!), Math.abs(mine.fog[h]! - s.fog[h]!), Math.abs(mine.p10[h]! - s.p10[h]!));
          expect(mine.state[h]).toBe(s.state[h]);
        }
      }
      expect(worst).toBeLessThan(6e-5);
    });
  }

  it('a test sample at the quest site lowers its fog and makes hours known; undo restores the prior exactly', async () => {
    const [spec, now] = await Promise.all([disk.updateSpec(), disk.nowcast('CO')]);
    const cs = new CityState(spec, pack('CO'), now);
    const q = now.quests[0]!;
    const h = cs.hourOf(Date.parse(q.best_hour_utc));
    const before = cs.series(q.code);
    const r = cs.applyTestSample(q.code, h, { over_900: false });
    expect(r.after.fog[r.hour]!).toBeLessThan(before.fog[r.hour]!);
    // at a storm-hour quest the forecast's own spread keeps the sampled hour unsure; the calm hours become known
    const cleared = before.state.filter((s, k) => s === 'unknown' && r.after.state[k] !== 'unknown').length;
    expect(cleared).toBeGreaterThan(0);
    expect(cs.revision).toBe(1);
    cs.undo(q.code);
    expect(cs.series(q.code).fog[r.hour]).toBe(before.fog[r.hour]);
  });

  it('sites of the same forecast cell at the prior share one computation', async () => {
    const [spec, now] = await Promise.all([disk.updateSpec(), disk.nowcast('CO')]);
    const cs = new CityState(spec, pack('CO'), now);
    expect(cs.series('C1')).toBe(cs.series('C2'));
  });
});
