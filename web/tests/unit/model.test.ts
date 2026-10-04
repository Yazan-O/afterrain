import { describe, expect, it } from 'vitest';
import { MODEL_KEYS } from '../../src/data/schemas';
import { logit, probability, requiredInputs, transform, warns } from '../../src/engine/model';
import { disk } from './disk';

describe.each(MODEL_KEYS)('model_%s.json', (key) => {
  it('reproduces every exported test vector to 1e-9', async () => {
    const m = await disk.model(key);
    expect(m.test_vectors.length).toBeGreaterThanOrEqual(5);
    for (const v of m.test_vectors) {
      const p = probability(m, v.inputs);
      expect(Math.abs(p - v.expected_probability), `vector at ${v.sample_time_utc}`).toBeLessThan(1e-9);
    }
  });

  it('refuses an absent input instead of guessing', async () => {
    const m = await disk.model(key);
    const inputs = { ...m.test_vectors[0]!.inputs };
    const dropped = requiredInputs(m)[0]!;
    delete inputs[dropped];
    expect(() => probability(m, inputs)).toThrow(new RegExp(`input "${dropped}" is missing`));
  });

  it("uses the model file's fill_if_missing for an explicit null, as the pipeline does", async () => {
    const m = await disk.model(key);
    const f = m.features[0]!;
    const withNull = { ...m.test_vectors[0]!.inputs, [f.input]: null };
    const withFill = { ...m.test_vectors[0]!.inputs, [f.input]: f.fill_if_missing };
    expect(probability(m, withNull)).toBe(probability(m, withFill));
  });

  it('rejects a non-finite input', async () => {
    const m = await disk.model(key);
    const f = m.features[0]!;
    expect(() => probability(m, { ...m.test_vectors[0]!.inputs, [f.input]: Number.NaN })).toThrow(/not a finite number/);
  });

  it('warns at and above the fitted threshold (p >= threshold, as pipeline.model.metrics)', async () => {
    const m = await disk.model(key);
    expect(warns(m, m.threshold)).toBe(true);
    expect(warns(m, m.threshold - 1e-12)).toBe(false);
  });
});

describe('transforms match pipeline.model.transform', () => {
  it('guards the log domains and wraps the season on 365.25 days', () => {
    expect(transform('log1p', -5)).toBe(0);
    expect(transform('log', 0)).toBe(Math.log(0.001));
    expect(transform('sin', 365.25)).toBeCloseTo(0, 12);
    expect(transform('cos', 0)).toBe(1);
  });

  it('stays finite for extreme log-odds', async () => {
    const m = await disk.model('warleigh');
    const v = m.test_vectors.at(-1)!;
    expect(logit(m, v.inputs)).toBeGreaterThan(9);
    expect(probability(m, { ...v.inputs, up_count_48h: 1e6 })).toBe(1);
  });
});
