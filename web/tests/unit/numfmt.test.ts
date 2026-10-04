import { describe, expect, it } from 'vitest';
import { formatNumber } from '../../src/format/numfmt';
import { disk } from './disk';

describe('formatNumber', () => {
  it('groups integers in threes by default', () => {
    expect(formatNumber(31000, null)).toBe('31,000');
    expect(formatNumber(25154, 'int')).toBe('25,154');
    expect(formatNumber(43, undefined)).toBe('43');
    expect(formatNumber(1234567, '')).toBe('1,234,567');
  });
  it('shows a fixed number of decimals or a percentage', () => {
    expect(formatNumber(0.9405, 'fixed:2')).toBe('0.94');
    expect(formatNumber(4.55, 'fixed:2')).toBe('4.55');
    expect(formatNumber(0.9405, 'pct:0')).toBe('94%');
    expect(formatNumber(0.2966, 'pct:1')).toBe('29.7%');
    expect(formatNumber(12345.678, 'fixed:1')).toBe('12,345.7');
  });
  it('writes a number exactly as JSON does for code (the FHIR x-ray)', () => {
    expect(formatNumber(31000, 'raw')).toBe('31000');
    expect(formatNumber(-2.300635, 'raw')).toBe('-2.300635');
    expect(formatNumber(0.9999949867925471, 'raw')).toBe('0.9999949867925471');
  });
  it('refuses what it cannot show faithfully', () => {
    expect(() => formatNumber(0.94, null)).toThrow(/not an integer/);
    expect(() => formatNumber('2021-03-19', null)).toThrow(/data-time/);
    expect(() => formatNumber(1, 'sci')).toThrow(/unknown number format/);
    expect(() => formatNumber(1, 'fixed:x')).toThrow(/bad number format/);
    expect(() => formatNumber(Number.NaN, null)).toThrow(/finite/);
  });
  it('formats the headline numbers from numbers.json', async () => {
    const n = await disk.numbers();
    // integers are grouped in threes (31,000), never rounded; the values are the pipeline's, read from numbers.json
    for (const k of ['warleigh.rule.freshford.warned_exceed', 'warleigh.rule.freshford.warned']) {
      const v = n[k]!.value as number;
      expect(Number.isInteger(v)).toBe(true);
      expect(formatNumber(v, null)).toBe(v.toLocaleString('en-GB'));
    }
    expect(formatNumber(n['replay.2024-09-23.max_ecoli']!.value, null)).toBe('31,000');
    // the AUC is shown to 2 decimals of the value numbers.json holds (model.warleigh.test2025.auc), rounded once
    const auc = n['model.warleigh.test2025.auc']!.value as number;
    expect(formatNumber(auc, 'fixed:2')).toBe(auc.toFixed(2));
    expect(formatNumber(n['warleigh.freshford_distance_km']!.value, 'fixed:2')).toBe('4.55');
  });
});
