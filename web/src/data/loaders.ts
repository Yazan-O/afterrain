// Typed loaders for every file in sayr/data/out (served from /data/ after `npm run data`).
// Each loader fetches one file and decodes it; any network, parse or schema problem throws.
import { decode, DataError, type Decoder } from './decode';
import {
  backtestFile,
  buildInfoFile,
  cityFile,
  cityModelFile,
  darkHoursFile,
  nowcastFile,
  streamPackFile,
  type StreamPackFile,
  updateSpecFile,
  forecastFile,
  modelFile,
  numbersFile,
  replayFile,
  transferFile,
  type BacktestFile,
  type BuildInfoFile,
  type CityFile,
  type CityModelFile,
  type DarkHoursFile,
  type NowcastFile,
  type UpdateSpecFile,
  type CityId,
  type ForecastFile,
  type ModelFile,
  type ModelKey,
  type NumbersFile,
  type ReplayFile,
  type ReplayKey,
  type TransferFile,
} from './schemas';

/** Reads one file by name and returns its parsed JSON. The browser uses fetch; tests read from disk. */
export type JsonSource = (fileName: string) => Promise<unknown>;

export const httpSource =
  (baseUrl: string): JsonSource =>
  async (fileName) => {
    const url = `${baseUrl}${fileName}`;
    const res = await fetch(url);
    if (!res.ok) throw new DataError(fileName, '', `HTTP ${res.status} fetching ${url}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) throw new DataError(fileName, '', `expected JSON from ${url}, got "${type}"`);
    try {
      return (await res.json()) as unknown;
    } catch (e) {
      throw new DataError(fileName, '', `invalid JSON: ${(e as Error).message}`);
    }
  };

export const DATA_BASE_URL = `${import.meta.env.BASE_URL}data/`;

const load = async <T>(src: JsonSource, file: string, d: Decoder<T>): Promise<T> => decode(file, d, await src(file));

export const loaders = (src: JsonSource) => ({
  numbers: (): Promise<NumbersFile> => load(src, 'numbers.json', numbersFile),
  model: (key: ModelKey): Promise<ModelFile> => load(src, `model_${key}.json`, modelFile),
  replay: (key: ReplayKey): Promise<ReplayFile> => load(src, `replay_${key}.json`, replayFile),
  city: (id: CityId): Promise<CityFile> => load(src, `city_${id}.json`, cityFile(id)),
  forecast: (id: CityId): Promise<ForecastFile> => load(src, `forecast_${id}.json`, forecastFile(id)),
  transfer: (): Promise<TransferFile> => load(src, 'transfer.json', transferFile),
  backtest: (): Promise<BacktestFile> => load(src, 'warleigh_backtest.json', backtestFile),
  buildInfo: (): Promise<BuildInfoFile> => load(src, 'build_info.json', buildInfoFile),
  nowcast: (id: CityId): Promise<NowcastFile> => load(src, `nowcast_${id}.json`, nowcastFile(id)),
  updateSpec: (): Promise<UpdateSpecFile> => load(src, 'update_spec.json', updateSpecFile),
  cityModel: (): Promise<CityModelFile> => load(src, 'city_model.json', cityModelFile),
  darkHours: (): Promise<DarkHoursFile> => load(src, 'dark_hours.json', darkHoursFile),
  streams: (id: CityId): Promise<StreamPackFile> => load(src, `streams/${id}.json`, streamPackFile(id)),
});

export type Loaders = ReturnType<typeof loaders>;
