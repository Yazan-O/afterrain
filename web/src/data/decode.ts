// Runtime schema checks. A decoder either returns a typed value or throws a DataError naming the
// file and the JSON path. There are no defaults: a missing required field is always an error.
// Extra fields are allowed, so the pipeline can add data without breaking the app.

export class DataError extends Error {
  constructor(
    readonly file: string,
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${file}: ${path || '(root)'}: ${problem}`);
    this.name = 'DataError';
  }
}

export interface Ctx {
  readonly file: string;
  readonly path: string;
}

export type Decoder<T> = (value: unknown, ctx: Ctx) => T;

const at = (ctx: Ctx, key: string | number): Ctx => ({
  file: ctx.file,
  path: typeof key === 'number' ? `${ctx.path}[${key}]` : ctx.path ? `${ctx.path}.${key}` : key,
});

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export const fail = (ctx: Ctx, problem: string): never => {
  throw new DataError(ctx.file, ctx.path, problem);
};

export const str: Decoder<string> = (v, ctx) => (typeof v === 'string' ? v : fail(ctx, `expected string, got ${kind(v)}`));

export const num: Decoder<number> = (v, ctx) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(ctx, `expected finite number, got ${kind(v)}`);

export const int: Decoder<number> = (v, ctx) => {
  const n = num(v, ctx);
  return Number.isInteger(n) ? n : fail(ctx, `expected integer, got ${n}`);
};

export const bool: Decoder<boolean> = (v, ctx) => (typeof v === 'boolean' ? v : fail(ctx, `expected boolean, got ${kind(v)}`));

export const literal =
  <const T extends string>(...allowed: T[]): Decoder<T> =>
  (v, ctx) =>
    typeof v === 'string' && (allowed as string[]).includes(v)
      ? (v as T)
      : fail(ctx, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);

/** An ISO-8601 instant that states it is UTC ("Z" or "+00:00"). Returns the string unchanged. */
export const utcInstant: Decoder<string> = (v, ctx) => {
  const s = str(v, ctx);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|\+00:00)$/.test(s) || Number.isNaN(Date.parse(s))) {
    fail(ctx, `expected a UTC ISO instant, got ${JSON.stringify(s)}`);
  }
  return s;
};

/** A zone-less ISO date-time ("2026-09-25T00:00") that the file declares to be in some zone elsewhere. */
export const naiveDateTime: Decoder<string> = (v, ctx) => {
  const s = str(v, ctx);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? s : fail(ctx, `expected YYYY-MM-DDTHH:MM, got ${JSON.stringify(s)}`);
};

/** A local date-time with its UTC offset, as the nowcast writes it ("2026-09-26T02:00+0100"). */
export const offsetDateTime: Decoder<string> = (v, ctx) => {
  const s = str(v, ctx);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:?\d{2}$/.test(s) ? s : fail(ctx, `expected YYYY-MM-DDTHH:MM+HHMM, got ${JSON.stringify(s)}`);
};

export const isoDate: Decoder<string> = (v, ctx) => {
  const s = str(v, ctx);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    ? s
    : fail(ctx, `expected YYYY-MM-DD, got ${JSON.stringify(s)}`);
};

export const nullable =
  <T>(d: Decoder<T>): Decoder<T | null> =>
  (v, ctx) =>
    v === null ? null : d(v, ctx);

export const arr =
  <T>(d: Decoder<T>, opts: { minLength?: number } = {}): Decoder<T[]> =>
  (v, ctx) => {
    if (!Array.isArray(v)) return fail(ctx, `expected array, got ${kind(v)}`);
    if (opts.minLength !== undefined && v.length < opts.minLength) fail(ctx, `expected at least ${opts.minLength} items, got ${v.length}`);
    return v.map((x, i) => d(x, at(ctx, i)));
  };

export const tuple2 =
  <A, B>(a: Decoder<A>, b: Decoder<B>): Decoder<[A, B]> =>
  (v, ctx) => {
    if (!Array.isArray(v) || v.length !== 2) return fail(ctx, `expected a pair, got ${kind(v)}${Array.isArray(v) ? ` of length ${v.length}` : ''}`);
    return [a(v[0], at(ctx, 0)), b(v[1], at(ctx, 1))];
  };

export const record =
  <T>(d: Decoder<T>): Decoder<Record<string, T>> =>
  (v, ctx) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(ctx, `expected object, got ${kind(v)}`);
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) out[k] = d(x, at(ctx, k));
    return out;
  };

const OPTIONAL = Symbol('optional');
/** Marks a field the file may omit entirely (for example a section present for one city only). */
export interface OptionalDecoder<T> {
  readonly [OPTIONAL]: true;
  readonly decoder: Decoder<T>;
}
export const optional = <T>(decoder: Decoder<T>): OptionalDecoder<T> => ({ [OPTIONAL]: true, decoder });

type Field = Decoder<unknown> | OptionalDecoder<unknown>;
type Shape = Record<string, Field>;
type Out<S extends Shape> = {
  [K in keyof S as S[K] extends OptionalDecoder<unknown> ? never : K]: S[K] extends Decoder<infer T> ? T : never;
} & {
  [K in keyof S as S[K] extends OptionalDecoder<unknown> ? K : never]?: S[K] extends OptionalDecoder<infer T> ? T : never;
};

const isOptional = (f: Field): f is OptionalDecoder<unknown> => typeof f === 'object' && OPTIONAL in f;

export const obj =
  <S extends Shape>(shape: S): Decoder<Out<S>> =>
  (v, ctx) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(ctx, `expected object, got ${kind(v)}`);
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(shape)) {
      if (!(k in src)) {
        if (isOptional(f)) continue;
        fail(at(ctx, k), 'missing required field');
      }
      out[k] = isOptional(f) ? f.decoder(src[k], at(ctx, k)) : f(src[k], at(ctx, k));
    }
    return out as Out<S>;
  };

/** Adds a cross-field check to a decoder; `check` returns a problem string or null. */
export const refine =
  <T>(d: Decoder<T>, check: (value: T) => string | null): Decoder<T> =>
  (v, ctx) => {
    const out = d(v, ctx);
    const problem = check(out);
    return problem === null ? out : fail(ctx, problem);
  };

export const decode = <T>(file: string, d: Decoder<T>, value: unknown): T => d(value, { file, path: '' });
