// Story mode (#/story): the scenes chained into one guided take. This file is the pure sequencer (chapters, beats,
// layer opacities), advanced by clock seconds, with no DOM; src/app/storyShell.ts mounts the scenes it names.
//
// The take (about 80 seconds), narrated one sentence at a time: a real place (Warleigh Weir on the Avon), the 2024
// storm that went unseen there, the five-year proof, the dark hours nobody samples, then AfterRain's forecast for Coimbra
// in a person's words, its sampling request and one example test reading; then free exploration.
//
// Time. Each chapter has a local script time in seconds that advances with the clock's animation seconds. It holds
// while a cue plays (the scene animates the moment itself), while the viewer holds the story (an x-ray card is
// open), and at the chapter's end while the next scene is still loading. The next scene is mounted underneath
// early (at the chapter's preload beat), so a chapter change is a crossfade that dips through the ground colour
// for a moment, never a wait on a dark screen. A skip inside a chapter is a short dip. The same ticks and events
// give the same state, however the ticks are split.

export type ChapterId = 'dark' | 'storm' | 'city';

export interface StoryBeat {
  readonly id: string;
  /** Local seconds in its chapter. */
  readonly at: number;
  /** A named moment the scene plays itself (Scene.cue); the story holds until it has played. */
  readonly cue?: string;
}

export interface StoryChapter {
  readonly id: ChapterId;
  /** Sorted by `at`; the first is at 0. */
  readonly beats: readonly StoryBeat[];
  /** Local seconds at which the next chapter is mounted underneath (it loads while this one plays). */
  readonly preload: number;
  /** Local seconds at which the crossfade to the next chapter starts (the last chapter hands over here). */
  readonly end: number;
}

export type StoryCommand =
  | { readonly kind: 'mount'; readonly chapter: number }
  | { readonly kind: 'unmount'; readonly chapter: number }
  | { readonly kind: 'cue'; readonly chapter: number; readonly cue: string }
  /** The story has ended in the last chapter: hand its scene over to free exploration. */
  | { readonly kind: 'finish' };

/** The tagline's hold before the first chapter comes up. */
export const TITLE = 3.8;
/** Chapter crossfade: the old layer is gone at OUT, the new one starts at IN_AT and is full at XF. */
export const XF = 1.5;
export const XF_OUT = 0.9;
export const XF_IN_AT = 0.6;
/** Out of the tagline: the first scene rises at once and plays underneath while the words fade slowly. */
export const TITLE_XF = 1.9;
export const TITLE_IN = 0.8;
export const TITLE_FADE_AT = 0.5;
/** A skip inside a chapter: down in DIP_OUT, the jump, up in DIP_IN. */
export const DIP_OUT = 0.35;
export const DIP_IN = 0.5;
/** Escape: the scene dims under the tagline while the city loads. */
export const LEAVE = 0.4;
export const LEAVE_DIM = 0.28;

const smooth = (u: number): number => {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
};
const EPS = 1e-9;

interface Slot {
  readonly index: number;
  local: number;
  fired: number;
  blocked: boolean;
}

type Mode = 'title' | 'play' | 'xf' | 'dip' | 'leave' | 'over';

export class StoryMachine {
  private cur: Slot | null = null;
  private inc: Slot | null = null;
  private mode: Mode;
  private t = 0;
  private dipTo = 0;
  private wantNext = false;
  private leaving = false;
  /** Hand over as soon as the last chapter is on screen (Escape): its cues are skipped. */
  private exploring = false;
  private deep = false;
  private queued = false;
  private outbox: StoryCommand[] = [];
  /** Story seconds played (holds excluded). */
  total = 0;

  /** A start that cuts straight in: the first chapter is at full strength the moment it is ready (no fade). */
  private cut = false;

  constructor(
    readonly chapters: readonly StoryChapter[],
    start: { chapter: number; local: number } | null = null,
    opts: { cut?: boolean } = {},
  ) {
    if (!chapters.length) throw new Error('a story needs a chapter');
    for (const c of chapters) {
      if (!c.beats.length || c.beats[0]!.at !== 0) throw new Error(`chapter ${c.id}: the first beat must be at 0`);
      for (let i = 1; i < c.beats.length; i++) if (!(c.beats[i]!.at > c.beats[i - 1]!.at)) throw new Error(`chapter ${c.id}: beats out of order`);
      if (!(c.end > c.beats[c.beats.length - 1]!.at)) throw new Error(`chapter ${c.id}: ends before its last beat`);
      if (!(c.preload <= c.end)) throw new Error(`chapter ${c.id}: preloads after its end`);
    }
    if (start) {
      // a deep link: straight into a chapter at a beat, no tagline
      this.mode = 'xf';
      this.t = XF_IN_AT;
      this.deep = true;
      this.inc = this.slot(start.chapter, start.local);
      this.cut = opts.cut === true;
    } else {
      this.mode = 'title';
      this.inc = this.slot(0, 0);
    }
  }

  /** The chapter and local time of a beat, for deep links (#/story/<beat>); "title" is the top (null). */
  static find(chapters: readonly StoryChapter[], beatId: string): { chapter: number; local: number } | null {
    for (let c = 0; c < chapters.length; c++) {
      const b = chapters[c]!.beats.find((x) => x.id === beatId);
      if (b) return { chapter: c, local: b.at };
    }
    return null;
  }

  get ended(): boolean {
    return this.mode === 'over';
  }
  /** The chapter on screen (the incoming one once a crossfade is past its middle). */
  get chapter(): number {
    const s = this.mode === 'xf' && this.t >= XF_IN_AT && this.inc ? this.inc : (this.cur ?? this.inc);
    return s!.index;
  }
  get local(): number {
    return this.slotOf(this.chapter)?.local ?? 0;
  }
  /** Local seconds of a mounted chapter (0 when it is not mounted). */
  localOf(index: number): number {
    return this.slotOf(index)?.local ?? 0;
  }
  /** The latest beat that has played in the chapter on screen ("title" before the first). */
  get beat(): string {
    if (this.mode === 'title') return 'title';
    const s = this.slotOf(this.chapter)!;
    const b = this.chapters[s.index]!.beats;
    if (s.fired > 0) return b[s.fired - 1]!.id;
    // a link into a chapter that has not fired yet (its crossfade): the beat it starts at
    let k = 0;
    for (let i = 0; i < b.length; i++) if (b[i]!.at <= s.local + EPS) k = i;
    return b[k]!.id;
  }
  /** The crossfade out of the tagline (the story's opening), which has its own pacing. */
  private get fromTitle(): boolean {
    return this.mode === 'xf' && this.cur === null && !this.deep && !this.leaving;
  }
  /** Waiting on a load or a cue. */
  get waiting(): boolean {
    const s = this.mode === 'title' ? null : this.slotOf(this.chapter);
    return this.mode === 'title' || !!s?.blocked || (this.mode === 'play' && this.cur !== null && this.cur.local >= this.chapters[this.cur.index]!.end - EPS);
  }
  /** Mounted chapters, in mount order. */
  get mounted(): number[] {
    return [this.cur, this.inc].filter((s): s is Slot => s !== null).map((s) => s.index);
  }

  /** Opacity of a chapter's layer. */
  alpha(index: number): number {
    const inCur = this.cur?.index === index;
    const inInc = this.inc?.index === index;
    if (!inCur && !inInc) return 0;
    switch (this.mode) {
      case 'title':
        return 0;
      case 'play':
      case 'over':
        return inCur ? 1 : 0;
      case 'dip':
        return this.t < DIP_OUT ? 1 - smooth(this.t / DIP_OUT) : smooth((this.t - DIP_OUT) / DIP_IN);
      case 'leave':
        return inCur ? 1 - (1 - LEAVE_DIM) * smooth(this.t / LEAVE) : 0;
      case 'xf': {
        if (this.fromTitle) return smooth(this.t / TITLE_IN);
        // the page's first paint already shows this chapter's first frame: the live scene takes its place at once
        if (this.cut && this.cur === null && inInc) return 1;
        const from = this.leaving ? LEAVE_DIM : 1;
        return inCur ? from * (1 - smooth(this.t / XF_OUT)) : smooth((this.t - XF_IN_AT) / (XF - XF_IN_AT));
      }
    }
  }

  /** Opacity of the tagline. */
  get titleAlpha(): number {
    if (this.mode === 'title') return 1;
    if (this.mode === 'leave') return smooth(this.t / LEAVE);
    if (this.fromTitle) return 1 - smooth((this.t - TITLE_FADE_AT) / (TITLE_XF - TITLE_FADE_AT));
    if (this.mode === 'xf' && this.leaving) return 1 - smooth(this.t / XF_OUT);
    return 0;
  }

  drain(): StoryCommand[] {
    return this.outbox.splice(0);
  }

  /**
   * Advances by `dt` clock seconds. `ready(i)`: chapter i's scene has loaded. `held`: the viewer holds the story.
   */
  tick(dt: number, ready: (chapter: number) => boolean, held = false): StoryCommand[] {
    if (!(dt >= 0)) throw new Error(`story tick: dt must be 0 or more, got ${dt}`);
    if (held) return this.drain();
    let left = dt;
    for (let guard = 0; guard < 64 && this.mode !== 'over'; guard++) {
      const before = left;
      const mode = this.mode;
      left = this.step(left, ready);
      if (left === before && this.mode === mode) break; // nothing can move until a load or a cue lands
    }
    return this.drain();
  }

  /** Space, the right arrow or the skip control: the next beat. */
  advance(): void {
    if (this.mode === 'over' || this.mode === 'leave' || this.exploring) return;
    if (this.mode === 'title') {
      this.t = Math.max(this.t, TITLE);
      return;
    }
    if (this.mode !== 'play' || !this.cur || this.cur.blocked) {
      this.queued = true; // played once the crossfade, the dip or the cue is done
      return;
    }
    const c = this.chapters[this.cur.index]!;
    const next = c.beats[this.cur.fired];
    if (next && next.cue !== undefined) {
      // a cue beat plays in place: the scene animates it itself
      this.cur.local = next.at;
      this.fireDue(this.cur);
    } else if (next && next.at < c.end) {
      this.mode = 'dip';
      this.t = 0;
      this.dipTo = next.at;
    } else if (this.cur.index === this.chapters.length - 1) this.finish();
    else {
      this.wantNext = true;
      this.ensureNext();
    }
  }

  /** The cue the scene was playing is on screen. */
  cueDone(chapter: number): void {
    const s = this.slotOf(chapter);
    if (!s || !s.blocked) return;
    s.blocked = false;
    this.fireDue(s);
    if (s === this.cur) this.flushQueued();
  }

  private flushQueued(): void {
    if (!this.queued || this.mode !== 'play' || !this.cur || this.cur.blocked) return;
    this.queued = false;
    this.advance();
  }

  /** Escape: leave for free exploration in the city (the last chapter), without its cues. */
  exit(): void {
    if (this.mode === 'over' || this.exploring) return;
    const last = this.chapters.length - 1;
    // in the city (the story's first and last chapters are the one city scene): hand it over as it is
    if (this.cur && this.chapters[this.cur.index]!.id === this.chapters[last]!.id && this.mode !== 'xf') return this.finish();
    this.exploring = true;
    if (this.inc && this.inc.index !== last) {
      this.outbox.push({ kind: 'unmount', chapter: this.inc.index });
      this.inc = null;
    }
    const crossing = this.mode === 'xf' && this.inc !== null;
    if (!this.inc) this.inc = this.slot(last, 0);
    this.inc.fired = this.chapters[last]!.beats.length; // no cues: the city as it is
    this.inc.blocked = false;
    if (crossing) return; // already crossing into the city: hand over when it is on
    this.leaving = true;
    this.mode = 'leave';
    this.t = this.cur ? 0 : LEAVE;
  }

  // ----- internals -----

  private slot(index: number, local: number): Slot {
    this.outbox.push({ kind: 'mount', chapter: index });
    return { index, local, fired: 0, blocked: false };
  }

  private slotOf(index: number): Slot | null {
    return this.cur?.index === index ? this.cur : this.inc?.index === index ? this.inc : null;
  }

  private ensureNext(): void {
    if (this.inc || !this.cur) return;
    const n = this.cur.index + 1;
    if (n < this.chapters.length) this.inc = this.slot(n, 0);
  }

  private finish(): void {
    this.mode = 'over';
    if (this.inc) {
      this.outbox.push({ kind: 'unmount', chapter: this.inc.index });
      this.inc = null;
    }
    this.outbox.push({ kind: 'finish' });
  }

  private fireDue(s: Slot): void {
    const b = this.chapters[s.index]!.beats;
    while (!s.blocked && s.fired < b.length && b[s.fired]!.at <= s.local + EPS) {
      const beat = b[s.fired++]!;
      if (beat.cue !== undefined) {
        s.blocked = true;
        this.outbox.push({ kind: 'cue', chapter: s.index, cue: beat.cue });
      }
    }
  }

  /** Plays a slot's script for up to `dt` seconds (to its next beat, preload or end); returns the time used. */
  private play(s: Slot, dt: number, stopAtEnd: boolean): number {
    if (s.blocked) return 0;
    const c = this.chapters[s.index]!;
    const next = c.beats[s.fired];
    const marks = [next ? next.at : Infinity, stopAtEnd ? c.end : Infinity];
    if (s === this.cur && !this.inc && s.index + 1 < this.chapters.length) marks.push(c.preload);
    const room = Math.min(...marks.map((m) => (m > s.local + EPS ? m - s.local : Infinity)));
    const used = Math.max(0, Math.min(dt, room));
    s.local += used;
    this.fireDue(s);
    if (s === this.cur && !this.inc && s.local >= c.preload - EPS) this.ensureNext();
    return used;
  }

  private step(left: number, ready: (i: number) => boolean): number {
    switch (this.mode) {
      case 'title': {
        const used = Math.min(left, Math.max(0, TITLE - this.t));
        this.t += used;
        this.total += used;
        if (this.t >= TITLE - EPS && this.inc && ready(this.inc.index)) {
          this.mode = 'xf';
          this.t = 0;
        }
        return left - used;
      }
      case 'leave': {
        const used = Math.min(left, Math.max(0, LEAVE - this.t));
        this.t += used;
        if (this.cur) this.play(this.cur, used, true);
        if (this.t >= LEAVE - EPS && this.inc && ready(this.inc.index)) {
          this.mode = 'xf';
          this.t = 0;
        }
        return left - used;
      }
      case 'xf': {
        if (this.inc && !ready(this.inc.index) && this.t <= XF_IN_AT + EPS) return left; // a deep link: hold until its scene is ready
        const title = this.fromTitle;
        const dur = title ? TITLE_XF : XF;
        const inAt = title ? 0 : XF_IN_AT;
        const used = Math.min(left, dur - this.t);
        this.t += used;
        this.total += used;
        if (this.cur) this.play(this.cur, used, true);
        if (this.inc && this.t > inAt) this.play(this.inc, Math.min(used, this.t - inAt), false);
        if (this.t >= dur - EPS) {
          if (this.cur) this.outbox.push({ kind: 'unmount', chapter: this.cur.index });
          this.cur = this.inc;
          this.inc = null;
          this.t = 0;
          this.wantNext = false;
          this.leaving = false;
          this.cut = false;
          if (this.exploring) this.finish();
          else {
            this.mode = 'play';
            this.fireDue(this.cur!);
            this.flushQueued();
          }
        }
        return left - used;
      }
      case 'dip': {
        const cur = this.cur!;
        const total = DIP_OUT + DIP_IN;
        const toJump = DIP_OUT - this.t;
        let used: number;
        if (toJump > EPS) {
          used = Math.min(left, toJump);
          this.t += used;
          this.play(cur, used, true);
          if (this.t >= DIP_OUT - EPS) {
            cur.local = this.dipTo;
            this.fireDue(cur);
          }
        } else {
          used = Math.min(left, total - this.t);
          this.t += used;
          this.play(cur, used, true);
          if (this.t >= total - EPS) {
            this.mode = 'play';
            this.t = 0;
            this.flushQueued();
          }
        }
        this.total += used;
        return left - used;
      }
      case 'play': {
        const cur = this.cur!;
        const c = this.chapters[cur.index]!;
        const last = cur.index === this.chapters.length - 1;
        if ((this.wantNext || cur.local >= c.end - EPS) && !last) {
          this.ensureNext();
          if (this.inc && ready(this.inc.index)) {
            this.mode = 'xf';
            this.t = 0;
            return left;
          }
          if (cur.local >= c.end - EPS) return left; // hold the chapter's last frame until the next scene is ready
        }
        if (last && cur.local >= c.end - EPS && !cur.blocked) {
          this.finish();
          return left;
        }
        const used = this.play(cur, left, true);
        this.total += used;
        return left - used;
      }
      case 'over':
        return 0;
    }
  }
}

// ----- the chapters -----
// One narrated sentence on screen at a time (src/app/narration.ts), each held long enough to read (about 3.5 s
// for a short sentence, more for a long one). Beats are local seconds in their chapter.
//   storm  Great Britain and Bath, then down to the weir (src/app/geoView.ts); the Avon replay (src/app/storyShell.ts
//          maps each beat to a moment of the 2024 storm): the weir, the rain,
//          Freshford's logged spill, the morning, the 31,000, the five-year proof
//   dark   the dark hours: OneAquaHealth's samples fall to the dry side; the wet side stays dark
//   city   Europe and OneAquaHealth's five cities, then into Coimbra (src/app/geoView.ts); "AfterRain forecasts those hours.", the map's key on the map itself, the person's sentence at Eiras, the
//          sampling request, the example test reading and its comparison, the close; then free exploration

/** Local seconds of the storm chapter's beats (the replay moments they show are set in storyShell.ts). */
export const STORM_BEATS = { bath: 0, weir: 4.0, rain: 8.2, spill: 12.6, still: 18.0, sample: 22.2, proof: 28.6 } as const;
export const STORM_END = 35.4;
/** The dark hours: the line about the dry-day samples while they fall, then the dark wet side. */
export const DARK_BEATS = { cities: 0, gap: 6.2 } as const;
export const DARK_END = 10.4;
/** The city: its beats, and the cues it plays (the comparison's three hold the story while they run). */
export const CITY_BEATS = { europe: 0, coimbra: 3.8, forecast: 7.4, key: 10.3, human: 17.0, ask: 22.8, test: 28.4, changes: 29.8, close: 34.0 } as const;
export const CITY_END = 38.8;

export function storyChapters(): StoryChapter[] {
  const S = STORM_BEATS;
  const D = DARK_BEATS;
  const C = CITY_BEATS;
  return [
    {
      id: 'storm',
      beats: [
        { id: 'bath', at: S.bath },
        { id: 'weir', at: S.weir },
        { id: 'rain', at: S.rain },
        { id: 'spill', at: S.spill },
        { id: 'still', at: S.still },
        { id: 'sample', at: S.sample },
        { id: 'proof', at: S.proof },
      ],
      preload: S.proof,
      end: STORM_END,
    },
    {
      id: 'dark',
      beats: [
        { id: 'cities', at: D.cities },
        { id: 'gap', at: D.gap },
      ],
      preload: D.gap,
      end: DARK_END,
    },
    {
      id: 'city',
      beats: [
        { id: 'europe', at: C.europe },
        { id: 'coimbra', at: C.coimbra },
        { id: 'forecast', at: C.forecast },
        { id: 'key', at: C.key, cue: 'key' },
        { id: 'human', at: C.human, cue: 'human' },
        { id: 'ask', at: C.ask },
        { id: 'test', at: C.test, cue: 'opening' },
        { id: 'kit', at: C.test + 0.05, cue: 'kit' },
        { id: 'answer', at: C.test + 0.1, cue: 'test' },
        { id: 'changes', at: C.changes },
        { id: 'close', at: C.close, cue: 'fold' },
      ],
      preload: C.close,
      end: CITY_END,
    },
  ];
}
