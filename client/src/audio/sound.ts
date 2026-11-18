// CranCapital's sound: one small Web Audio manager. Every effect is
// synthesized here so the game has sound with no files to download; drop
// real recordings into client/public/sounds/ and list them in
// sounds/manifest.json to replace any of them (see docs/SOUNDS.md).
//
// iPad Safari only allows audio after the first tap, so nothing starts until
// unlock() runs from a touch.
import { useSettings } from '../lib/settings';

export type Fx =
  | 'tap' | 'open' | 'close' | 'sale' | 'chaching' | 'coins' | 'coin' | 'hammer' | 'levelup' | 'tierup' | 'notify'
  | 'chat' | 'buy' | 'sell' | 'error' | 'horn' | 'badge' | 'whoosh' | 'pop' | 'success';

class SoundManager {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private amb!: GainNode;
  private noiseBuf: AudioBuffer | null = null;
  private files = new Map<string, AudioBuffer>();
  private lastSales: number[] = [];
  private ambience: { hum?: GainNode; rain?: GainNode; started: boolean; timer?: number } = { started: false };
  private ambState = { hour: 12, rain: 0, zoom: 16, active: true };
  private lastPlay = new Map<string, number>();

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Call from a touch or click. Safe to call many times.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.fx = this.ctx.createGain();
        this.amb = this.ctx.createGain();
        this.fx.connect(this.master);
        this.amb.connect(this.master);
        this.master.connect(this.ctx.destination);
        this.applyLevels();
        useSettings.subscribe(() => this.applyLevels());
        this.loadFiles();
        document.addEventListener('visibilitychange', () => {
          if (!this.ctx) return;
          if (document.hidden) this.ctx.suspend();
          else this.ctx.resume();
        });
      }
      if (this.ctx.state !== 'running') this.ctx.resume();
    } catch {
      /* no audio on this device */
    }
  }

  private applyLevels() {
    if (!this.ctx) return;
    const s = useSettings.getState().sound;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    this.fx.gain.setTargetAtTime(s.effects, t, 0.05);
    this.updateAmbience();
  }

  private async loadFiles() {
    try {
      const base = import.meta.env.BASE_URL;
      const r = await fetch(`${base}sounds/manifest.json`);
      if (!r.ok) return;
      const list: Record<string, string> = await r.json();
      for (const [name, file] of Object.entries(list)) {
        fetch(`${base}sounds/${file}`)
          .then((x) => x.arrayBuffer())
          .then((b) => this.ctx!.decodeAudioData(b))
          .then((buf) => this.files.set(name, buf))
          .catch(() => {});
      }
    } catch {
      /* no recordings: synthesized sounds it is */
    }
  }

  // ---------- building blocks ----------
  private noise(): AudioBuffer {
    if (!this.noiseBuf) {
      const ctx = this.ctx!;
      const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = b;
    }
    return this.noiseBuf;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(freq: number, t: number, dur: number, peak: number, type: OscillatorType = 'sine', out: AudioNode = this.fx, glideTo?: number, attack = 0.005) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    this.env(g, t, peak, attack, dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  private bell(freq: number, t: number, dur: number, peak: number, out: AudioNode = this.fx) {
    // A warm bell: a few inharmonic partials, the high ones fading first.
    [
      [1, 1, 1],
      [2.0, 0.35, 0.6],
      [2.76, 0.22, 0.4],
      [5.4, 0.08, 0.25],
    ].forEach(([m, a, d]) => this.tone(freq * m, t, dur * d, peak * a, 'sine', out));
  }

  private burst(t: number, dur: number, peak: number, type: BiquadFilterType, freq: number, q = 1, sweepTo?: number, out: AudioNode = this.fx) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, peak, Math.min(0.02, dur / 4), dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + dur + 0.1);
  }

  // ---------- effects ----------
  play(name: Fx, opts: { amount?: number; delay?: number } = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const s = useSettings.getState().sound;
    if (s.muted || s.master <= 0 || s.effects <= 0) return;
    // Don't machine-gun the same sound.
    const now = performance.now();
    const minGap = name === 'tap' ? 40 : name === 'coin' ? 30 : 60;
    if (now - (this.lastPlay.get(name) ?? 0) < minGap) return;
    this.lastPlay.set(name, now);

    const t = this.ctx.currentTime + 0.005 + (opts.delay ?? 0);
    const file = this.files.get(name);
    if (file) {
      const src = this.ctx.createBufferSource();
      src.buffer = file;
      src.connect(this.fx);
      src.start(t);
      return;
    }
    switch (name) {
      case 'tap':
        this.burst(t, 0.03, 0.12, 'bandpass', 2200, 2.5);
        this.tone(1400, t, 0.03, 0.04, 'triangle');
        break;
      case 'open':
        this.burst(t, 0.16, 0.08, 'bandpass', 500, 1.2, 1800);
        this.tone(520, t + 0.02, 0.08, 0.03, 'sine', this.fx, 760);
        break;
      case 'close':
        this.burst(t, 0.14, 0.07, 'bandpass', 1600, 1.2, 450);
        break;
      case 'whoosh':
        this.burst(t, 0.45, 0.1, 'bandpass', 300, 0.8, 2400);
        break;
      case 'pop':
        this.tone(500, t, 0.07, 0.12, 'sine', this.fx, 950);
        break;
      case 'sale': {
        // Pitch rises with the amount; quick sales roll into a cha-ching.
        this.lastSales = this.lastSales.filter((x) => now - x < 1500);
        this.lastSales.push(now);
        if (this.lastSales.length >= 3) {
          this.lastSales = [];
          this.play('chaching');
          return;
        }
        const dollars = (opts.amount ?? 1000) / 1000;
        const step = Math.max(0, Math.min(12, Math.round(Math.log2(1 + dollars / 5) * 2)));
        const f = 880 * Math.pow(2, step / 12);
        this.bell(f, t, 0.7, 0.16);
        this.burst(t, 0.03, 0.08, 'highpass', 3000, 0.7);
        break;
      }
      case 'chaching':
        // Drawer slide, two bright bells, a little coin shower.
        this.burst(t, 0.12, 0.12, 'bandpass', 900, 1.5, 2400);
        this.bell(1318.5, t + 0.08, 0.9, 0.15);
        this.bell(1760, t + 0.2, 1.1, 0.14);
        for (let i = 0; i < 5; i++) this.tone(2600 + Math.random() * 1600, t + 0.28 + i * 0.045 + Math.random() * 0.02, 0.08, 0.05, 'sine');
        break;
      case 'coin':
        this.tone(2400 + Math.random() * 900, t, 0.09, 0.06, 'sine');
        this.tone(4800 + Math.random() * 900, t, 0.05, 0.02, 'sine');
        break;
      case 'coins':
        for (let i = 0; i < 6; i++) {
          const tt = t + i * 0.055 + Math.random() * 0.03;
          this.tone(2300 + Math.random() * 1500, tt, 0.09, 0.05, 'sine');
          this.tone(5200 + Math.random() * 800, tt, 0.04, 0.015, 'sine');
        }
        break;
      case 'hammer':
        for (let i = 0; i < 3; i++) {
          const tt = t + i * 0.32;
          this.tone(150, tt, 0.12, 0.22, 'sine', this.fx, 70);
          this.burst(tt, 0.05, 0.14, 'bandpass', 1400, 2);
        }
        break;
      case 'levelup':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          this.tone(f, t + i * 0.085, 0.35, 0.09, 'triangle');
          this.tone(f * 2, t + i * 0.085, 0.2, 0.025, 'sine');
        });
        break;
      case 'tierup': {
        // A short fanfare: rising arpeggio, then a bright held chord.
        const notes = [392, 523.25, 659.25, 783.99];
        notes.forEach((f, i) => this.brass(f, t + i * 0.12, 0.18, 0.08));
        [523.25, 659.25, 783.99, 1046.5].forEach((f) => this.brass(f, t + 0.55, 1.3, 0.07));
        this.bell(2093, t + 0.55, 1.4, 0.06);
        break;
      }
      case 'badge':
        this.bell(1046.5, t, 0.6, 0.1);
        this.bell(1567.98, t + 0.1, 0.9, 0.1);
        break;
      case 'success':
        this.tone(660, t, 0.12, 0.08, 'triangle');
        this.tone(990, t + 0.09, 0.22, 0.08, 'triangle');
        break;
      case 'notify':
        this.bell(1318.5, t, 0.5, 0.09);
        this.bell(987.77, t + 0.13, 0.7, 0.09);
        break;
      case 'chat':
        this.tone(620, t, 0.06, 0.08, 'sine', this.fx, 980);
        break;
      case 'buy':
        this.burst(t, 0.03, 0.12, 'bandpass', 2000, 3);
        this.tone(660, t + 0.02, 0.09, 0.07, 'triangle', this.fx, 990);
        break;
      case 'sell':
        this.burst(t, 0.03, 0.12, 'bandpass', 2000, 3);
        this.tone(990, t + 0.02, 0.09, 0.07, 'triangle', this.fx, 660);
        break;
      case 'error':
        this.tone(190, t, 0.18, 0.18, 'sine', this.fx, 95);
        break;
      case 'horn': {
        // A ship's horn: two low, slightly detuned reeds.
        const ctx = this.ctx;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 700;
        f.connect(this.fx);
        [110, 110.8, 165].forEach((fr, i) => this.tone(fr, t, 1.4, i === 2 ? 0.03 : 0.07, 'sawtooth', f, undefined, 0.12));
        break;
      }
    }
  }

  private brass(f: number, t: number, dur: number, peak: number) {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.linearRampToValueAtTime(2600, t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(1200, t + dur);
    lp.connect(this.fx);
    this.tone(f, t, dur, peak, 'sawtooth', lp, undefined, 0.02);
    this.tone(f * 1.003, t, dur, peak * 0.6, 'square', lp, undefined, 0.02);
  }

  // ---------- ambience ----------
  // hour: city local hour (0-24); rain: 0..1; zoom: map zoom (quieter when far).
  setAmbience(p: Partial<typeof this.ambState>) {
    Object.assign(this.ambState, p);
    this.updateAmbience();
  }

  private updateAmbience() {
    if (!this.ctx) return;
    const s = useSettings.getState().sound;
    const { hour, rain, zoom, active } = this.ambState;
    const near = Math.max(0, Math.min(1, (zoom - 13.5) / 3));
    const level = active ? s.ambience * near : 0;
    const t = this.ctx.currentTime;
    this.amb.gain.setTargetAtTime(level, t, 0.6);
    if (level > 0 && !this.ambience.started) this.startAmbience();
    if (!this.ambience.started) return;
    const day = hour > 6.5 && hour < 20;
    this.ambience.hum!.gain.setTargetAtTime(day ? 0.16 : 0.08, t, 2);
    this.ambience.rain!.gain.setTargetAtTime(0.22 * rain, t, 2);
  }

  private startAmbience() {
    const ctx = this.ctx!;
    this.ambience.started = true;
    // Brown-ish noise for the distant city hum.
    const len = ctx.sampleRate * 4;
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const hum = ctx.createBufferSource();
    hum.buffer = b;
    hum.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const hg = ctx.createGain();
    hg.gain.value = 0.0001;
    hum.connect(lp).connect(hg).connect(this.amb);
    hum.start();
    // Rain: bright noise, only heard when it's raining.
    const rain = ctx.createBufferSource();
    rain.buffer = this.noise();
    rain.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3200;
    hp.Q.value = 0.4;
    const rg = ctx.createGain();
    rg.gain.value = 0.0001;
    rain.connect(hp).connect(rg).connect(this.amb);
    rain.start();
    this.ambience.hum = hg;
    this.ambience.rain = rg;
    // Occasional birds by day and cars passing.
    const tick = () => {
      if (!this.ctx) return;
      const { hour, rain, active } = this.ambState;
      const day = hour > 6 && hour < 19.5;
      if (active && this.ctx.state === 'running') {
        const t = this.ctx.currentTime + 0.05;
        if (day && rain < 0.3 && Math.random() < 0.55) this.bird(t);
        if (Math.random() < (day ? 0.5 : 0.2)) this.burst(t + Math.random(), 1.6, 0.05, 'bandpass', 350, 0.9, 900, this.amb);
      }
      this.ambience.timer = window.setTimeout(tick, 1800 + Math.random() * 3500);
    };
    tick();
  }

  private bird(t: number) {
    const base = 2400 + Math.random() * 1600;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const tt = t + i * (0.09 + Math.random() * 0.05);
      this.tone(base * (1 + Math.random() * 0.15), tt, 0.07, 0.03, 'sine', this.amb, base * (1.25 + Math.random() * 0.2));
    }
  }
}

export const sound = new SoundManager();

// Unlock on the first touch, click or key, and give every button a soft tap.
export function installSound() {
  const unlock = () => sound.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  window.addEventListener(
    'pointerup',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('button, [role="tab"], .clicky');
      if (el && !(el as HTMLButtonElement).disabled && !el.closest('[data-silent]')) sound.play('tap');
    },
    { capture: true }
  );
}
