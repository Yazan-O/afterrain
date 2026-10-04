import { describe, expect, it } from 'vitest';
import { hourSentence, MAX_WORDS, sampledOf, streamMoment, streamSentence, WET_MM, whenPhrase, type Moment, type Sampled } from '../../src/model/sentence';
import type { FogState } from '../../src/engine/fog';
import type { Guess } from '../../src/model/alongStream';

const Z = 'Europe/Lisbon';
// Monday 28 Sep 2026 08:00 in Lisbon (UTC+1)
const NOW = Date.parse('2026-09-28T07:00:00Z');
const H = 3.6e6;
const WET = 12;
const DRY = 0;

/** A 72 h timeline where hours [from, to) have the given guess, state and rain; the rest are usual guesses, dry. */
function timeline(parts: { from: number; to: number; guess: Guess; state: FogState; rainMm?: number }[], rest: FogState = 'unknown'): Moment[] {
  return Array.from({ length: 72 }, (_, h) => {
    const p = parts.find((x) => h >= x.from && h < x.to);
    return { ms: NOW + h * H, guess: p?.guess ?? 'usual', state: p?.state ?? rest, rainMm: p ? (p.rainMm ?? WET) : DRY };
  });
}
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const DRY_ONLY = { sampled: 'dry-only' } as const;

describe('when phrases in the local zone of the place', () => {
  it('names the part of the day relative to now', () => {
    expect(whenPhrase(NOW + 6 * H, NOW, Z)).toBe('this afternoon'); // 14:00
    expect(whenPhrase(NOW + 11 * H, NOW, Z)).toBe('this evening'); // 19:00
    expect(whenPhrase(NOW + 15 * H, NOW, Z)).toBe('tonight'); // 23:00
    expect(whenPhrase(NOW + 18 * H, NOW, Z)).toBe('tonight'); // 02:00 Tuesday belongs to Monday night
    expect(whenPhrase(NOW + 24 * H, NOW, Z)).toBe('tomorrow morning');
    expect(whenPhrase(NOW + 48 * H, NOW, Z)).toBe('Wednesday morning');
  });

  it('a dated forecast (it no longer reaches the clock) names the day, never "tonight" or "tomorrow"', () => {
    expect(whenPhrase(NOW + 15 * H, NOW, Z, true)).toBe('Monday night');
    expect(whenPhrase(NOW + 24 * H, NOW, Z, true)).toBe('Tuesday morning');
  });
});

describe('the stream sentence', () => {
  it('unmeasured, rain coming: says when and asks for a sample', () => {
    const s = streamSentence(timeline([{ from: 49, to: 72, guess: 'high', state: 'unknown' }]), Z, DRY_ONLY);
    expect(s).toBe('Rain reaches me Wednesday morning. Nobody has measured me after rain. Can you?');
  });

  it('unmeasured, dry: best guess only, still asks', () => {
    expect(streamSentence(timeline([]), Z, DRY_ONLY)).toBe('Probably my usual self. Nobody has measured me after rain. Can you?');
  });

  it('unmeasured while the best guess is raised now, with rain', () => {
    expect(streamSentence(timeline([{ from: 0, to: 10, guess: 'higher', state: 'unknown' }]), Z, DRY_ONLY)).toMatch(/^I may be carrying rain\. Nobody has measured me/);
  });

  it('measured and raised: keeps dogs out until the guess falls', () => {
    const s = streamSentence(timeline([{ from: 0, to: 30, guess: 'high', state: 'high' }], 'usual'), Z, DRY_ONLY);
    expect(s).toBe("I'm carrying rain. Keep dogs out until tomorrow afternoon.");
  });

  it('measured and raised past the horizon: until at least the last day shown', () => {
    const s = streamSentence(timeline([{ from: 0, to: 72, guess: 'high', state: 'high' }], 'usual'), Z, DRY_ONLY);
    expect(s).toBe("I'm carrying rain. Keep dogs out until at least Thursday.");
  });

  it('measured usual with unmeasured rain ahead says both', () => {
    const s = streamSentence(timeline([{ from: 49, to: 72, guess: 'high', state: 'unknown' }], 'usual'), Z, DRY_ONLY);
    expect(s).toBe('Usual for now. Rain reaches me Wednesday morning. Nobody has measured that.');
  });

  it('measured usual and dry', () => {
    expect(streamSentence(timeline([], 'usual'), Z, DRY_ONLY)).toBe("I'm my usual self.");
  });

  it('a dated forecast names days instead of "tonight" and "tomorrow"', () => {
    const s = streamSentence(timeline([{ from: 24, to: 40, guess: 'high', state: 'unknown' }]), Z, { sampled: 'dry-only', dated: true });
    expect(s).toBe('Rain reaches me Tuesday morning. Nobody has measured me after rain. Can you?');
  });
});

describe('truth: what OneAquaHealth measured', () => {
  it('"Nobody has measured me after rain" only when no site of the stream was sampled after rain', () => {
    const tl = timeline([{ from: 49, to: 72, guess: 'high', state: 'unknown' }]);
    expect(streamSentence(tl, Z, { sampled: 'dry-only' })).toMatch(/Nobody has measured me after rain/);
    for (const sampled of ['after-rain', 'never'] as Sampled[]) expect(streamSentence(tl, Z, { sampled })).not.toMatch(/after rain/);
    expect(streamSentence(tl, Z, { sampled: 'after-rain' })).toBe('Rain reaches me Wednesday morning. Too few rain samples to tell. Can you?');
    expect(streamSentence(tl, Z, { sampled: 'never' })).toBe('Rain reaches me Wednesday morning. Nobody has measured me yet. Can you?');
  });

  it('a stream is sampled after rain when any one of its sites was (Benevento, Coimbra C19 and C20)', () => {
    expect(sampledOf([false, true])).toBe('after-rain');
    expect(sampledOf([false, null])).toBe('dry-only');
    expect(sampledOf([null, undefined])).toBe('never');
    expect(sampledOf([])).toBe('never');
  });
});

describe('truth: never "carrying rain" without rain', () => {
  it('after an "over 900" test sample on a dry day the raised guess is said without rain', () => {
    // the sample raises every hour's guess; the rain forecast stays at 0 mm
    const dry = timeline([{ from: 0, to: 72, guess: 'high', state: 'unknown', rainMm: 0 }]);
    const s = streamSentence(dry, Z, DRY_ONLY);
    expect(s).toBe('I may be running high, even without rain. Can you check?');
    expect(s).not.toMatch(/carrying rain|Rain reaches/i);
    const known = timeline([{ from: 0, to: 20, guess: 'higher', state: 'higher', rainMm: 0 }], 'usual');
    expect(streamSentence(known, Z, DRY_ONLY)).toBe("I'm running high, even without rain. Keep dogs out until tonight.");
  });

  it('rain under WET_MM is not rain; at WET_MM it is', () => {
    const at = (rainMm: number) => streamSentence(timeline([{ from: 0, to: 72, guess: 'high', state: 'unknown', rainMm }]), Z, DRY_ONLY);
    expect(at(WET_MM - 0.01)).toBe('I may be running high, even without rain. Can you check?');
    expect(at(WET_MM)).toMatch(/^I may be carrying rain\./);
  });

  it('never says "safe", never shows a digit, keeps to the word budget, and never claims rain at 0 mm, in every case', () => {
    const guesses: Guess[] = ['usual', 'higher', 'high'];
    const states: FogState[] = ['usual', 'higher', 'high', 'unknown'];
    const sampled: Sampled[] = ['after-rain', 'dry-only', 'never'];
    let n = 0;
    for (const g0 of guesses)
      for (const s0 of states)
        for (const g1 of guesses)
          for (const s1 of states)
            for (const rain of [0, WET])
              for (const sm of sampled)
                for (const dated of [false, true])
                  for (const at of [1, 13, 30, 60, 71]) {
                    const tl = timeline(
                      [
                        { from: 0, to: at, guess: g0, state: s0, rainMm: rain },
                        { from: at, to: 72, guess: g1, state: s1, rainMm: rain },
                      ],
                      'usual',
                    );
                    const s = streamSentence(tl, Z, { sampled: sm, dated });
                    expect(s).not.toMatch(/\bsafe\b/i);
                    expect(s).not.toMatch(/\d/);
                    expect(words(s)).toBeLessThanOrEqual(MAX_WORDS);
                    if (rain === 0) expect(s).not.toMatch(/carrying rain|Rain reaches|Rain is|rain is/i);
                    if (sm !== 'dry-only') expect(s).not.toMatch(/measured me after rain/);
                    n++;
                  }
    expect(n).toBe(3 * 4 * 3 * 4 * 2 * 3 * 2 * 5);
  }, 60_000);

  it('stream moments: the worst guess leads; the wettest rain counts; a raised station still unknown keeps the stream unknown', () => {
    expect(streamMoment(0, [{ state: 'unknown', guess: 'high', rainMm: 3 }, { state: 'unknown', guess: 'usual', rainMm: 9 }])).toEqual({ ms: 0, state: 'unknown', guess: 'high', rainMm: 9 });
    // an unknown station that guesses higher than every known one: the stream cannot say it knows its state
    expect(streamMoment(0, [{ state: 'unknown', guess: 'high', rainMm: 0 }, { state: 'usual', guess: 'usual', rainMm: 0 }])).toEqual({ ms: 0, state: 'unknown', guess: 'high', rainMm: 0 });
    expect(streamMoment(0, [{ state: 'unknown', guess: 'higher', rainMm: 0 }, { state: 'high', guess: 'high', rainMm: 0 }])).toEqual({ ms: 0, state: 'high', guess: 'high', rainMm: 0 });
    // an unknown station whose guess is no worse than the known worst state does not hide that state
    expect(streamMoment(0, [{ state: 'unknown', guess: 'usual', rainMm: 0 }, { state: 'usual', guess: 'usual', rainMm: 0 }])).toEqual({ ms: 0, state: 'usual', guess: 'usual', rainMm: 0 });
    expect(() => streamSentence([], Z, DRY_ONLY)).toThrow();
  });

  it('a low reading at one station never makes the stream "my usual self" while another station is unknown and raised', () => {
    // Eiras read low (usual, known); Escravote is still unknown with a "higher" guess, every hour
    const tl = Array.from({ length: 72 }, (_, h) =>
      streamMoment(NOW + h * H, [
        { state: 'usual', guess: 'usual', rainMm: DRY },
        { state: 'unknown', guess: 'higher', rainMm: DRY },
      ]),
    );
    const s = streamSentence(tl, Z, DRY_ONLY);
    expect(s).not.toBe("I'm my usual self.");
    expect(s).not.toMatch(/^Usual for now/);
  });
});

describe("the scrubbed hour, in the stream's voice", () => {
  const m = (state: FogState, guess: Guess, rainMm: number, h = 0): Moment => ({ ms: Date.parse('2026-09-30T17:00:00Z') + h * H, state, guess, rainMm });

  it('names the local day and hour, and says what the water is doing and what it means for a dog walker', () => {
    expect(hourSentence(m('high', 'high', WET), Z, m('high', 'high', WET, -6))).toEqual({ when: 'Wednesday 18:00', text: 'Rain is running through me. Keep dogs out.' });
    expect(hourSentence(m('higher', 'higher', WET), Z, m('higher', 'higher', WET, -6)).text).toBe('Rain is running through me. Keep dogs on the bank.');
    expect(hourSentence(m('unknown', 'high', WET), Z, m('unknown', 'high', WET, -6)).text).toBe('Rain may be running through me. Keep dogs out.');
    expect(hourSentence(m('usual', 'usual', 0), Z, m('usual', 'usual', 0, -6)).text).toBe('My usual self.');
    expect(hourSentence(m('unknown', 'usual', 0), Z).text).toBe('Probably my usual self.');
  });

  it('the hour the rain arrives, and the hour it clears', () => {
    expect(hourSentence(m('unknown', 'high', WET), Z, m('unknown', 'usual', 0.4, -6)).text).toBe('The rain may be arriving. Keep dogs out.');
    expect(hourSentence(m('high', 'high', WET), Z, m('usual', 'usual', 0.4, -6)).text).toBe('The rain is arriving. Keep dogs out.');
    expect(hourSentence(m('unknown', 'usual', WET), Z, m('unknown', 'high', WET, -6)).text).toBe("I'm clearing. Probably my usual self again.");
    expect(hourSentence(m('usual', 'usual', WET), Z, m('high', 'high', WET, -6)).text).toBe("I'm clearing. My usual self again.");
  });

  it('never claims rain at 0 mm, never shows a digit outside the time, and keeps to the word budget', () => {
    const states: FogState[] = ['usual', 'higher', 'high', 'unknown'];
    const guesses: Guess[] = ['usual', 'higher', 'high'];
    for (const state of states)
      for (const guess of guesses)
        for (const rain of [0, WET])
          for (const prev of [undefined, ...guesses.map((g) => m('unknown', g, rain, -6))]) {
            const { when, text } = hourSentence(m(state, guess, rain), Z, prev);
            expect(text).not.toMatch(/\d|\bsafe\b/i);
            if (rain === 0) expect(text).not.toMatch(/rain/i);
            if (state === 'unknown') expect(text).toMatch(/may|Probably|clearing\. Probably/);
            expect(words(`${when}. ${text}`)).toBeLessThanOrEqual(MAX_WORDS);
          }
  });
});
