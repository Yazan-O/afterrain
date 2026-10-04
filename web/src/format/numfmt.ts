// The one way a numbers.json value becomes text. The app renders with it and the provenance test checks
// with it, so a number on screen matches its source key character for character.
//   data-fmt absent or "int": an integer value, digits grouped in threes ("31,000")
//   "fixed:N": N decimals, grouped ("0.94", "4.55")
//   "pct:N":   value x 100 with N decimals and a percent sign ("94%")
//   "raw":     the number exactly as JSON writes it ("31000", "0.43858465667811375"): code, never prose

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fixed = (x: number, decimals: number): string => {
  const [whole, frac] = Math.abs(x).toFixed(decimals).split('.');
  const sign = x < 0 && Number(Math.abs(x).toFixed(decimals)) !== 0 ? '-' : '';
  return `${sign}${group(whole!)}${frac === undefined ? '' : `.${frac}`}`;
};

const decimalsOf = (fmt: string, prefix: string): number => {
  const n = Number(fmt.slice(prefix.length));
  if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error(`bad number format ${JSON.stringify(fmt)}`);
  return n;
};

export function formatNumber(value: number | string, fmt: string | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`only finite numbers can be formatted, got ${JSON.stringify(value)}; mark dates with data-time`);
  }
  if (fmt === null || fmt === undefined || fmt === '' || fmt === 'int') {
    if (!Number.isInteger(value)) throw new Error(`${value} is not an integer; give it data-fmt="fixed:N" or "pct:N"`);
    return fixed(value, 0);
  }
  if (fmt.startsWith('fixed:')) return fixed(value, decimalsOf(fmt, 'fixed:'));
  if (fmt.startsWith('pct:')) return `${fixed(value * 100, decimalsOf(fmt, 'pct:'))}%`;
  if (fmt === 'raw') return JSON.stringify(value);
  throw new Error(`unknown number format ${JSON.stringify(fmt)}`);
}
