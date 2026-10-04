// With a live forecast whose saved requests have all closed, the
// scene still has a request: the later round that starts latest at or before the clock, then later ones;
// -1 (the dated fallback) only when no round has an open window.
// Runs on the served nowcasts too: at a clock one hour after every saved window closes, a request is on offer.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { activeRound, nextQuest, type Round } from '../../src/model/quest';

const H = 3.6e6;
const q = (code: string, endH: number) => ({ code, endMs: endH * H });
const rounds: Round<ReturnType<typeof q>>[] = [
  { fromMs: 0, quests: [q('A', 10), q('B', 12)] },
  { fromMs: 24 * H, quests: [q('C', 40), q('D', 44)] },
  { fromMs: 48 * H, quests: [q('E', 64)] },
];
const all = (): boolean => true;

describe('activeRound', () => {
  it('keeps the saved quests while one is open', () => {
    expect(activeRound(rounds, 11 * H, new Set(), all)).toBe(0);
  });
  it('after the saved windows close on day 0, offers the next round', () => {
    expect(activeRound(rounds, 13 * H, new Set(), all)).toBe(1);
  });
  it('prefers the round that starts latest at or before the clock', () => {
    expect(activeRound(rounds, 50 * H, new Set(), all)).toBe(2);
  });
  it('skips a round whose windows have closed, and one whose quests were sampled on screen', () => {
    expect(activeRound(rounds, 45 * H, new Set(), all)).toBe(2);
    expect(activeRound(rounds, 30 * H, new Set(['C', 'D']), all)).toBe(2);
  });
  it('returns -1 when no round has an open window (the dated fallback)', () => {
    expect(activeRound(rounds, 65 * H, new Set(), all)).toBe(-1);
    expect(activeRound([rounds[0]!], 13 * H, new Set(), all)).toBe(-1);
  });
});

interface Nowcast {
  readonly hours_utc: readonly string[];
  readonly first_hour_utc: string;
  readonly quests: readonly { code: string; window_end_utc: string }[];
  readonly later_quests?: readonly { from_utc: string; quests: readonly { code: string; window_end_utc: string }[] }[];
}
const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data');

describe('the served nowcasts', () => {
  for (const id of ['BE', 'CO', 'GH', 'OS', 'TO']) {
    it(`${id}: one hour after every saved window closes, a request is still open`, () => {
      const n = JSON.parse(readFileSync(resolve(DATA, `nowcast_${id}.json`), 'utf-8')) as Nowcast;
      const conv = (l: Nowcast['quests']) => l.map((x) => ({ code: x.code, endMs: Date.parse(x.window_end_utc) }));
      const rs = [{ fromMs: Date.parse(n.first_hour_utc), quests: conv(n.quests) }, ...(n.later_quests ?? []).map((r) => ({ fromMs: Date.parse(r.from_utc), quests: conv(r.quests) }))];
      const clock = Math.max(...rs[0]!.quests.map((x) => x.endMs)) + H;
      expect(clock).toBeLessThan(Date.parse(n.hours_utc[n.hours_utc.length - 1]!));
      const i = activeRound(rs, clock, new Set(), all);
      expect(i).toBeGreaterThan(0);
      expect(nextQuest(rs[i]!.quests, clock, new Set(), all)!.endMs).toBeGreaterThan(clock);
    });
  }
});
