// Reads the pipeline's outputs straight from sayr/data/out, the same bytes `npm run data` serves.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loaders, type JsonSource } from '../../src/data/loaders';

export const DATA_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'out');

export const readOut = (file: string): unknown => JSON.parse(readFileSync(resolve(DATA_OUT, file), 'utf-8'));

export const diskSource: JsonSource = async (file) => readOut(file);

export const disk = loaders(diskSource);
