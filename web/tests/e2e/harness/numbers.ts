// The pipeline's numbers as the build serves them (public/data/numbers.json), formatted the way the screen shows
// them: a check reads a headline number from the data, never pins it, so it follows a pipeline recompute.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatNumber } from '../../../src/format/numfmt';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'data', 'numbers.json');
const numbers = JSON.parse(readFileSync(FILE, 'utf-8')) as Record<string, { value: number | string }>;

/** The value of a numbers.json key; a missing key is an error. */
export const value = (key: string): number => {
  const e = numbers[key];
  if (!e || typeof e.value !== 'number') throw new Error(`numbers.json has no number "${key}"`);
  return e.value;
};
/** The key's value as the screen shows it (src/format/numfmt.ts). */
export const shown = (key: string, fmt: string | null = null): string => formatNumber(value(key), fmt);
