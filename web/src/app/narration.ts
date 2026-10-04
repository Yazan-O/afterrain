// The story's narration: one sentence on screen at a time, plain and large, keyed by the beat on screen
// (src/app/story.ts). Every number is bound to its source (data-num to numbers.json, data-src to a data file,
// data-time for dates and clock times), so the harness checks the narration like any other words.
// The city's two data-driven lines (the person's sentence and the sampling request) come from the city scene
// itself (Scene.narrate), which holds the forecast.
import type { NumbersFile, ReplayFile } from '../data/schemas';
import { formatClock, localParts } from '../engine/timefmt';
import { formatNumber } from '../format/numfmt';
import { BATH_ZONE, type Schedule } from '../scenes/replay/schedule';

/** The first beat's line, also drawn by the page's first paint (scripts/first-paint.ts) before any script runs. */
export const WEIR_LINE = 'Warleigh Weir, near Bath. People swim here. Dogs run straight in.';

export interface Line {
  readonly main: readonly Node[];
  /** Units and qualifiers in small type under the line. */
  readonly small?: readonly Node[];
}

export interface SayData {
  readonly numbers: NumbersFile;
  readonly replay: ReplayFile;
  readonly sched: Schedule;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const text = (s: string): Text => document.createTextNode(s);
const time = (s: string): HTMLElement => {
  const e = document.createElement('span');
  e.dataset['time'] = '';
  e.textContent = s;
  return e;
};
const unit = (s: string): HTMLElement => {
  const e = document.createElement('span');
  e.dataset['unit'] = '';
  e.textContent = s;
  return e;
};

export function numNode(numbers: NumbersFile, key: string, fmt: string | null = null): HTMLElement {
  const v = numbers[key]?.value;
  if (typeof v !== 'number') throw new Error(`narration: numbers.json has no number "${key}"`);
  const e = document.createElement('span');
  e.dataset['num'] = key;
  if (fmt) e.dataset['fmt'] = fmt;
  e.textContent = formatNumber(v, fmt);
  return e;
}

/** The Freshford storm tank's spill the replay lights: its row in the replay file, for its logged duration. */
function heroEvent(d: SayData): { ptr: string; hours: number } {
  const hero = d.sched.heroDeparture;
  if (!hero) throw new Error('narration: the replay has no Freshford storm tank spill');
  for (let i = 0; i < d.replay.overflows.length; i++) {
    const evs = d.replay.overflows[i]!.events;
    for (let j = 0; j < evs.length; j++) if (Date.parse(evs[j]!.start_utc) === hero.startMs) return { ptr: `/overflows/${i}/events/${j}/hours`, hours: evs[j]!.hours };
  }
  throw new Error('narration: the hero spill is not a logged event of the replay file');
}

/** The story's own lines (the storm and the dark hours, and the city's fixed lines); null: no line on this beat. */
export function storyLine(beat: string, d: SayData | null): Line | null {
  switch (beat) {
    case 'bath':
    case 'weir':
      return { main: [text(WEIR_LINE)] };
    case 'europe':
      return { main: [text('OneAquaHealth studies city streams in five European cities.')] };
    case 'coimbra':
      return { main: [text('Coimbra, Portugal.')] };
    case 'forecast':
      return { main: [text('Sayr forecasts those hours.')] };
    case 'changes':
      return { main: [text('One sample changes the answer.')] };
    case 'close':
      return { main: [text('Sayr. Know the water before you go in.')] };
  }
  if (!d) return null;
  const n = d.numbers;
  switch (beat) {
    case 'rain': {
      const hero = d.sched.heroDeparture!;
      const p = localParts(hero.startMs, BATH_ZONE);
      return { main: [text('On '), time(`${p.day} ${MONTHS[p.month - 1]} ${p.year}`), text(' it rained hard all day.')] };
    }
    case 'spill': {
      const hero = d.sched.heroDeparture!;
      const ev = heroEvent(d);
      const hrs = document.createElement('span');
      hrs.dataset['src'] = `replay_${d.sched.key}.json#${ev.ptr}`;
      hrs.dataset['fmt'] = 'fixed:0';
      hrs.textContent = formatNumber(ev.hours, 'fixed:0');
      return { main: [text('Upstream, a storm overflow opened at '), time(formatClock(hero.startMs, BATH_ZONE)), text(' and ran for '), hrs, text(' hours.')] };
    }
    case 'still':
      return { main: [text('By morning the water looked the same as always.')] };
    case 'sample': {
      const s = d.sched.heroSample!;
      return {
        main: [text('At '), time(formatClock(s.tMs, BATH_ZONE)), text(' a lab sample read '), numNode(n, `replay.${d.sched.key}.max_ecoli`), text(' '), unit('E. coli per 100 ml'), text('. The warning line is '), numNode(n, 'thresholds.ecoli_flag_per_100ml'), text('.')],
        small: [text('A single-sample flag')],
      };
    }
    case 'proof':
      return {
        main: [text('Not one bad night. In five years, '), numNode(n, 'warleigh.rule.freshford.warned_exceed'), text(' of '), numNode(n, 'warleigh.rule.freshford.warned'), text(' samples taken after that overflow were over the line.')],
        small: [text('Samples within '), numNode(n, 'warleigh.window_hours'), text(' hours of a spill')],
      };
    case 'cities':
      return { main: [text("In OneAquaHealth's five cities, "), numNode(n, 'darkhours.oneaquahealth.dry'), text(' of '), numNode(n, 'darkhours.oneaquahealth.n'), text(' samples were taken after dry days.')] };
    case 'gap':
      return { main: [text('The hours after rain, when people and dogs are in the water, are the hours nobody measures.')] };
  }
  return null;
}
