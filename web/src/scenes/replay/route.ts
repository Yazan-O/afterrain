// The replay's routes, both ways: #/replay[/2023-07-10][/timetable] to the storm and the fold, and back.
import type { ReplayKey } from '../../data/schemas';

/** The storm #/replay opens without a date. */
export const DEFAULT_KEY: ReplayKey = '2024-09-23';

export interface ReplayRoute {
  readonly key: ReplayKey;
  /** Open folded into the timetable. */
  readonly timetable: boolean;
}

/** Route segments after "replay" (for example ['2023-07-10', 'timetable']) to the storm and the fold. */
export const parseReplayRoute = (params: readonly string[]): ReplayRoute => ({
  key: params.includes('2023-07-10') ? '2023-07-10' : DEFAULT_KEY,
  timetable: params.includes('timetable'),
});

/** The hash of a storm and fold: the default storm carries no date. */
export const replayHash = (r: ReplayRoute): string => `#/replay${r.key === DEFAULT_KEY ? '' : `/${r.key}`}${r.timetable ? '/timetable' : ''}`;
