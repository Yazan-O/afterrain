// The logistic model exported by sayr/pipeline (model.py `export`), reproduced exactly:
//   p = 1 / (1 + exp(-(intercept + sum_i coef_i * (transform_i(x_i) - mean_i) / std_i)))
// A raw input may be null, which uses the model's own fill_if_missing (the training median, as the
// pipeline does); an input that is absent altogether is an error.
import type { ModelFile, TransformKind } from '../data/schemas';

export type ModelInputs = Readonly<Record<string, number | null>>;

export function transform(kind: TransformKind, x: number): number {
  switch (kind) {
    case 'identity':
      return x;
    case 'log1p':
      return Math.log1p(Math.max(x, 0));
    case 'log':
      return Math.log(Math.max(x, 0.001));
    case 'sin':
      return Math.sin((2 * Math.PI * x) / 365.25);
    case 'cos':
      return Math.cos((2 * Math.PI * x) / 365.25);
  }
}

/** The inputs a model needs, in feature order, without duplicates. */
export const requiredInputs = (m: ModelFile): string[] => [...new Set(m.features.map((f) => f.input))];

/** The linear predictor (log-odds) before the logistic link. */
export function logit(m: ModelFile, inputs: ModelInputs): number {
  let z = m.intercept;
  for (const f of m.features) {
    if (!(f.input in inputs)) throw new Error(`model ${m.site}: input "${f.input}" is missing (needed by ${f.name})`);
    const raw = inputs[f.input];
    if (raw !== null && (raw === undefined || !Number.isFinite(raw))) throw new Error(`model input "${f.input}" is not a finite number: ${String(raw)}`);
    const x = raw === null ? f.fill_if_missing : raw;
    z += (f.coef * (transform(f.transform, x) - f.mean)) / f.std;
  }
  return z;
}

/** P(E. coli > 900 per 100 ml in a single sample). Numerically stable for large |z|. */
export function probability(m: ModelFile, inputs: ModelInputs): number {
  const z = logit(m, inputs);
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** True when the probability reaches the model's warning cut (fixed on 2021-2024 in the pipeline). */
export const warns = (m: ModelFile, p: number): boolean => p >= m.threshold;
