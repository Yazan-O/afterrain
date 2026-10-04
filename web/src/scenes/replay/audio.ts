// The replay's sound, synthesized in code (no files): a relay click when an overflow switches on (a softer
// one when it switches off), a rain bed that follows the day's gauge total, and a low tone when a lab sample
// arrives. Browsers only start audio after a gesture, so nothing is created until unlock() runs inside one.

export class ReplayAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastClick = 0;

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Call from a user gesture handler. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    this.master = master;
    // two seconds of seeded noise, shared by the clicks and the rain
    const n = Math.round(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 1234567;
    let brown = 0;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = seed / 2 ** 31 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      d[i] = white * 0.35 + brown * 2.6;
    }
    this.noise = buf;
    const rain = ctx.createBufferSource();
    rain.buffer = buf;
    rain.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.value = 0;
    rain.connect(hp).connect(lp).connect(g).connect(master);
    rain.start();
    this.rainGain = g;
  }

  /** A relay switching: `on` is the sharp pull-in, otherwise the softer release. pan in -1..1. */
  click(on: boolean, pan: number, strength = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const t = Math.max(now + 0.005, this.lastClick + 0.034);
    if (t - now > 0.12) return; // too many switches in one moment: the rest are dropped, not queued
    this.lastClick = t;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-0.9, Math.min(0.9, pan));
    out.connect(this.master);
    const peak = (on ? 0.5 : 0.18) * strength;
    // contact: a bandpassed noise tick, then the armature's bounce 11 ms later
    for (const [dt, amp, f] of [
      [0, 1, on ? 3200 : 2400],
      [0.011, 0.35, on ? 2600 : 2000],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(peak * amp, t + dt + 0.0006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.018);
      src.connect(bp).connect(g).connect(out);
      src.start(t + dt, (t * 7.31) % 1.5, 0.03);
    }
    // body: a short low knock
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(on ? 190 : 150, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.03);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(peak * 0.55, t + 0.001);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** A lab sample arriving: a low, soft tone. */
  arrive(hero: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.01;
    for (const [f, a, d] of [
      [hero ? 73 : 98, hero ? 0.55 : 0.28, hero ? 1.6 : 0.7],
      [hero ? 146 : 196, hero ? 0.12 : 0.07, hero ? 1.1 : 0.5],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + d + 0.05);
    }
  }

  /** Rain loudness 0..1 (already shaped by the caller). */
  rain(level: number): void {
    if (!this.ctx || !this.rainGain) return;
    this.rainGain.gain.setTargetAtTime(0.16 * Math.max(0, Math.min(1, level)), this.ctx.currentTime, 0.35);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
