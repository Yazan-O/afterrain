// The tap of a drop landing, synthesized (no sound files). Silent until the viewer touches the page, as
// browsers require; the pitch follows the rain (a dry drop taps high, a storm drop lands low) and a flagged
// sample carries a darker body under the tap.
export class Taps {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private last = 0;
  private readonly unlock = (): void => this.enable();

  constructor() {
    window.addEventListener('pointerdown', this.unlock, { passive: true });
    window.addEventListener('keydown', this.unlock);
  }

  enable(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    this.out.connect(comp).connect(this.ctx.destination);
  }

  /** frac: where on the rain axis the drop landed (0 dry, 1 storm); busy: drops landing in the same beat. */
  tap(frac: number, flagged: boolean, busy: number): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - this.last < 0.028) return;
    this.last = now;
    const level = 0.22 / Math.sqrt(1 + busy);
    const f = 1900 * 2 ** (-2.2 * frac) * (0.97 + 0.06 * ((now * 7919) % 1));
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, now + 0.09);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    o.connect(g).connect(out);
    o.start(now);
    o.stop(now + 0.15);
    if (flagged) {
      const b = ctx.createOscillator();
      const bg = ctx.createGain();
      b.type = 'triangle';
      b.frequency.setValueAtTime(150, now);
      b.frequency.exponentialRampToValueAtTime(70, now + 0.35);
      bg.gain.setValueAtTime(0.0001, now);
      bg.gain.exponentialRampToValueAtTime(level * 1.3, now + 0.008);
      bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      b.connect(bg).connect(out);
      b.start(now);
      b.stop(now + 0.5);
    }
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    void this.ctx?.close();
    this.ctx = null;
    this.out = null;
  }
}
