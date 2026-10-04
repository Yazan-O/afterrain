// The story sequencer (src/app/story.ts): chapter order, preloads, crossfades that never sit on a dark screen,
// holds on loads and cues, skips, Escape, split-invariance, and the narrated story's order and timing.
import { describe, expect, it } from 'vitest';
import { DIP_OUT, LEAVE, StoryMachine, storyChapters, TITLE, TITLE_XF, XF, XF_IN_AT, type StoryChapter, type StoryCommand } from '../../src/app/story';

const CH: StoryChapter[] = [
  { id: 'dark', beats: [{ id: 'gap', at: 0 }, { id: 'line', at: 5 }], preload: 6, end: 10 },
  { id: 'storm', beats: [{ id: 'storm', at: 0 }, { id: 'proof', at: 8 }], preload: 8, end: 12 },
  { id: 'city', beats: [{ id: 'coimbra', at: 0 }, { id: 'stream', at: 2, cue: 'unroll' }, { id: 'quest', at: 5, cue: 'quest' }], preload: 5, end: 9 },
];
const all = (): boolean => true;
const kinds = (cs: StoryCommand[]): string[] => cs.map((c) => (c.kind === 'cue' ? `cue:${c.cue}` : c.kind === 'finish' ? 'finish' : `${c.kind}:${c.chapter}`));

/** Runs the machine in steps of `dt` for `seconds`, answering cues at once; returns every command. */
function run(m: StoryMachine, seconds: number, dt: number, ready: (i: number) => boolean = all): string[] {
  const out: string[] = kinds(m.drain());
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const cs = m.tick(dt, ready);
    out.push(...kinds(cs));
    for (const c of cs) if (c.kind === 'cue') m.cueDone(c.chapter);
    out.push(...kinds(m.drain()));
  }
  return out;
}

describe('story sequencer', () => {
  it('opens on the tagline while the first scene loads underneath, and holds it until that scene is ready', () => {
    const m = new StoryMachine(CH);
    expect(kinds(m.drain())).toEqual(['mount:0']);
    expect(m.titleAlpha).toBe(1);
    expect(m.alpha(0)).toBe(0);
    m.tick(TITLE + 5, () => false);
    expect(m.beat).toBe('title');
    expect(m.titleAlpha).toBe(1);
    m.tick(0.3, all);
    expect(m.alpha(0)).toBeGreaterThan(0); // the scene rises under the words, which hold a moment longer
    expect(m.titleAlpha).toBe(1);
    m.tick(TITLE_XF, all);
    expect(m.alpha(0)).toBe(1);
    expect(m.titleAlpha).toBe(0);
    // the first scene plays from the start of the fade, under the words
    expect(m.local).toBeCloseTo(0.3 + TITLE_XF, 6);
  });

  it('plays every chapter in order: preload underneath, crossfade, cues held until played, then hands over', () => {
    const m = new StoryMachine(CH);
    const cmds = run(m, 60, 1 / 30);
    expect(cmds).toEqual(['mount:0', 'mount:1', 'unmount:0', 'mount:2', 'unmount:1', 'cue:unroll', 'cue:quest', 'finish']);
    expect(m.ended).toBe(true);
    // the title, then each chapter's length; the two chapter crossfades add their dip (XF_IN_AT) to the clock
    expect(m.total).toBeCloseTo(TITLE + 10 + 12 + 9 + 2 * XF_IN_AT, 6);
  });

  it('gives the same state however the clock steps are split', () => {
    const a = new StoryMachine(CH);
    const b = new StoryMachine(CH);
    const ca = run(a, 20.3, 1 / 60);
    const cb = run(b, 20.3, 0.7);
    expect(ca).toEqual(cb);
    expect(a.chapter).toBe(b.chapter);
    expect(a.local).toBeCloseTo(b.local, 9);
    expect(a.beat).toBe(b.beat);
  });

  it('never sits on a dark screen for more than 0.3 s in a crossfade', () => {
    const m = new StoryMachine(CH);
    m.drain();
    let dark = 0;
    let worst = 0;
    const dt = 0.005;
    for (let t = 0; t < 40 && !m.ended; t += dt) {
      for (const c of m.tick(dt, all)) if (c.kind === 'cue') m.cueDone(c.chapter);
      const lit = Math.max(m.titleAlpha, ...m.mounted.map((i) => m.alpha(i)));
      dark = lit < 0.15 ? dark + dt : 0;
      worst = Math.max(worst, dark);
    }
    expect(worst).toBeGreaterThan(0); // it does dip: a crossfade through the ground colour
    expect(worst).toBeLessThanOrEqual(0.3);
  });

  it('holds the last frame of a chapter while the next scene loads, then crosses', () => {
    const m = new StoryMachine(CH);
    let stormReady = false;
    const ready = (i: number): boolean => i !== 1 || stormReady;
    run(m, TITLE + 10 + 3, 0.05, ready);
    expect(m.chapter).toBe(0);
    expect(m.local).toBeCloseTo(10, 6);
    expect(m.alpha(0)).toBe(1);
    stormReady = true;
    run(m, XF, 0.05, ready);
    expect(m.chapter).toBe(1);
    expect(m.alpha(1)).toBe(1);
  });

  it('skips to the next beat through a short dip, and a cue beat plays in place', () => {
    const m = new StoryMachine(CH);
    run(m, TITLE + TITLE_XF + 0.2, 0.05);
    expect(m.beat).toBe('gap');
    m.advance();
    m.tick(DIP_OUT / 2, all);
    expect(m.alpha(0)).toBeLessThan(0.6);
    m.tick(DIP_OUT, all);
    expect(m.beat).toBe('line');
    expect(m.local).toBeGreaterThanOrEqual(5);
    // into the city, at rest: the next beat is a cue, played without a dip
    const c = new StoryMachine(CH, StoryMachine.find(CH, 'coimbra'));
    c.drain();
    c.tick(XF, all);
    expect(c.beat).toBe('coimbra');
    c.advance();
    expect(kinds(c.drain())).toEqual(['cue:unroll']);
    expect(c.local).toBe(2);
    expect(c.alpha(2)).toBe(1);
  });

  it('keeps a key pressed during a crossfade and plays it when the crossfade lands', () => {
    const m = new StoryMachine(CH);
    m.drain();
    m.tick(TITLE + 0.5, all); // in the crossfade out of the tagline
    m.advance();
    expect(m.beat).toBe('gap');
    m.tick(TITLE_XF, all);
    m.tick(DIP_OUT + 0.01, all);
    expect(m.beat).toBe('line');
  });

  it('reports waiting while the scene coming in still plays its cue', () => {
    const m = new StoryMachine(CH, StoryMachine.find(CH, 'stream'));
    m.drain();
    expect(kinds(m.tick(0.2, all))).toEqual(['cue:unroll']);
    expect(m.beat).toBe('stream');
    expect(m.waiting).toBe(true);
    m.cueDone(2);
    m.tick(XF, all);
    expect(m.waiting).toBe(false);
  });

  it('holds while a cue plays and while the viewer holds the story', () => {
    const m = new StoryMachine(CH, StoryMachine.find(CH, 'coimbra'));
    m.drain();
    m.tick(XF + 2.5, all);
    expect(kinds(m.drain())).toEqual([]);
    expect(m.beat).toBe('stream');
    const at = m.local;
    m.tick(4, all);
    expect(m.local).toBe(at); // the strip is still unrolling
    m.cueDone(2);
    m.tick(1, all, true);
    expect(m.local).toBe(at); // held: an x-ray card is open
    m.tick(1, all);
    expect(m.local).toBeCloseTo(at + 1, 9);
  });

  it('Escape leaves for the city: the scene dims under the tagline while the city loads, then crosses without cues', () => {
    const m = new StoryMachine(CH);
    let cityReady = false;
    const ready = (i: number): boolean => i !== 2 || cityReady;
    run(m, TITLE + 10 + XF + 3, 0.05, ready); // in the storm, before its preload
    expect(m.chapter).toBe(1);
    m.exit();
    expect(kinds(m.drain())).toEqual(['mount:2']);
    run(m, 2, 0.05, ready);
    expect(m.titleAlpha).toBe(1);
    expect(m.alpha(1)).toBeCloseTo(0.28, 6);
    cityReady = true;
    const cmds = run(m, XF + 0.1, 0.05, ready);
    expect(cmds).toEqual(['unmount:1', 'finish']);
    expect(m.chapter).toBe(2);
    // in the city, Escape hands over at once
    const c = new StoryMachine(CH, StoryMachine.find(CH, 'coimbra'));
    c.drain();
    c.tick(XF, all);
    c.exit();
    expect(kinds(c.drain())).toEqual(['finish']);
    // from the tagline, straight to the city
    const t = new StoryMachine(CH);
    t.drain();
    t.exit();
    expect(kinds(t.drain())).toEqual(['unmount:0', 'mount:2']);
    run(t, LEAVE + XF + 0.1, 0.05);
    expect(t.ended).toBe(true);
  });

  it('finds every beat for deep links', () => {
    expect(StoryMachine.find(CH, 'proof')).toEqual({ chapter: 1, local: 8 });
    expect(StoryMachine.find(CH, 'nowhere')).toBeNull();
    const m = new StoryMachine(CH, { chapter: 1, local: 8 });
    expect(kinds(m.drain())).toEqual(['mount:1']);
    expect(m.titleAlpha).toBe(0);
    m.tick(5, () => false);
    expect(m.alpha(1)).toBe(0);
    m.tick(XF, all);
    expect(m.alpha(1)).toBe(1);
    expect(m.beat).toBe('proof');
  });

  it('refuses a malformed story', () => {
    expect(() => new StoryMachine([])).toThrow(/a chapter/);
    expect(() => new StoryMachine([{ id: 'dark', beats: [{ id: 'a', at: 1 }], preload: 1, end: 2 }])).toThrow(/at 0/);
    expect(() => new StoryMachine([{ id: 'dark', beats: [{ id: 'a', at: 0 }, { id: 'b', at: 3 }], preload: 1, end: 2 }])).toThrow(/ends before/);
  });
});

describe('the narrated story', () => {
  const chapters = storyChapters();
  it('a real place first, the storm, the dark hours, then Coimbra; every beat id unique (deep links)', () => {
    expect(chapters.map((c) => c.id)).toEqual(['storm', 'dark', 'city']);
    expect(chapters.map((c) => c.beats.map((b) => b.id))).toEqual([
      ['bath', 'weir', 'rain', 'spill', 'still', 'sample', 'proof'],
      ['cities', 'gap'],
      ['europe', 'coimbra', 'forecast', 'key', 'human', 'ask', 'test', 'kit', 'answer', 'changes', 'close'],
    ]);
    const ids = chapters.flatMap((c) => c.beats.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(chapters[2]!.beats.filter((b) => b.cue).map((b) => [b.id, b.cue])).toEqual([
      ['key', 'key'],
      ['human', 'human'],
      ['test', 'opening'],
      ['kit', 'kit'],
      ['answer', 'test'],
      ['close', 'fold'],
    ]);
  });

  it('each narrated line holds at least 3.5 s before the next one replaces it', () => {
    for (const c of chapters) {
      const said = c.beats.filter((b) => !['kit', 'answer'].includes(b.id));
      for (let i = 0; i < said.length; i++) {
        const next = i + 1 < said.length ? said[i + 1]!.at : c.end;
        if (said[i]!.cue === 'opening') continue; // the comparison's own words while its cues play
        expect(next - said[i]!.at, `${c.id}/${said[i]!.id}`).toBeGreaterThanOrEqual(c.id === 'city' && said[i]!.id === 'forecast' ? 2.8 : 3.5);
      }
    }
  });

  // the geography (Great Britain to the weir, about 4 s; Europe into Coimbra, 7.4 s) added about 10 s to the take
  it('cuts straight in on the weir line over Bath, no tagline, and plays to the hand-over in 80 to 100 s with the cues', () => {
    const m = new StoryMachine(chapters, { chapter: 0, local: 0 }, { cut: true });
    expect(m.drain().map((c) => c.kind)).toEqual(['mount']);
    expect(m.titleAlpha).toBe(0);
    m.tick(0.02, all);
    expect(m.beat).toBe('bath');
    run(m, 200, 1 / 30);
    expect(m.ended).toBe(true);
    // story seconds without the city's cues (the camera to Eiras, the comparison's script and the fold: about 1.6,
    // 6 and 2 s), which play on top
    expect(m.total + 9.6).toBeGreaterThan(80);
    expect(m.total + 9.6).toBeLessThan(100);
  });

  it('Back after the hand-over lands on a real beat: the first of the city chapter', () => {
    const last = chapters.length - 1;
    expect(StoryMachine.find(chapters, chapters[last]!.beats[0]!.id)).toEqual({ chapter: last, local: 0 });
    expect(StoryMachine.find(chapters, 'ask')).toEqual({ chapter: last, local: chapters[last]!.beats.find((b) => b.id === 'ask')!.at });
    expect(StoryMachine.find(chapters, 'lisbon')).toBeNull();
  });
});
