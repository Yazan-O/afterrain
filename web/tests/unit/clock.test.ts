import { describe, expect, it } from 'vitest';
import { clockOptionsFromQuery, createClock } from '../../src/app/clock';

const T = Date.parse('2026-09-28T07:00:00Z');

describe('app clock', () => {
  it('reads ?t, ?rate and ?clock=manual, and rejects malformed values', () => {
    expect(clockOptionsFromQuery('')).toEqual({ startMs: null, rate: 1, manual: false });
    expect(clockOptionsFromQuery('?t=2026-09-28T07:00:00Z')).toEqual({ startMs: T, rate: 0, manual: false });
    expect(clockOptionsFromQuery('?t=2026-09-28T07:00:00Z&rate=3600&clock=manual')).toEqual({ startMs: T, rate: 3600, manual: true });
    expect(() => clockOptionsFromQuery('?t=yesterday')).toThrow(/not an ISO date-time/);
    expect(() => clockOptionsFromQuery('?t=2026-09-28T07:00Z&rate=-2')).toThrow(/rate/);
  });

  it('live: data time follows the real time, animation runs in real time', () => {
    let real = 1_000_000;
    const c = createClock({ startMs: null, rate: 1, manual: false }, () => real);
    real += 200;
    c.frame(real);
    expect(c.ms()).toBe(real);
    expect(c.seconds()).toBeCloseTo(0.2);
    expect(c.pinned).toBe(false);
  });

  it('?t pins the data time but animation keeps running', () => {
    let real = 0;
    const c = createClock({ startMs: T, rate: 0, manual: false }, () => real);
    real += 200;
    c.frame(real);
    expect(c.ms()).toBe(T);
    expect(c.seconds()).toBeCloseTo(0.2);
    expect(c.pinned).toBe(true);
    expect(c.control.mode).toBe('pinned');
  });

  it('?t&rate runs the data time at the rate', () => {
    let real = 0;
    const c = createClock({ startMs: T, rate: 3600, manual: false }, () => real);
    real += 100;
    c.frame(real);
    expect(c.ms()).toBe(T + 360_000);
    expect(c.control.mode).toBe('running');
  });

  it('manual: nothing moves on its own; step and set are exact and notify every listener', () => {
    let real = 0;
    const c = createClock({ startMs: T, rate: 60, manual: false }, () => real);
    const seen: number[] = [];
    const off = c.onFrame((t) => seen.push(t.getTime()));
    c.control.step(1000 / 30);
    expect(c.control.mode).toBe('manual');
    expect(c.seconds()).toBeCloseTo(1 / 30, 12);
    expect(c.ms()).toBeCloseTo(T + 2000, 6);
    real += 5000;
    c.frame(real);
    expect(c.ms()).toBeCloseTo(T + 2000, 6);
    expect(c.seconds()).toBeCloseTo(1 / 30, 12);
    c.control.set('2026-09-30T12:00:00Z');
    expect(c.ms()).toBe(Date.parse('2026-09-30T12:00:00Z'));
    expect(seen.length).toBe(3);
    off();
    c.control.step(10);
    expect(seen.length).toBe(3);
    expect(() => c.control.step(-1)).toThrow();
    expect(() => c.control.set('nope')).toThrow();
  });

  it('caps a long real-time gap (a background tab) instead of jumping the animation', () => {
    let real = 0;
    const c = createClock({ startMs: T, rate: 0, manual: false }, () => real);
    real += 60_000;
    c.frame(real);
    expect(c.seconds()).toBeCloseTo(0.25);
  });
});
