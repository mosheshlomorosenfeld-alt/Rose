// Rose — built-in instruments: Rose Synth (poly subtractive with supersaw unison), Rose Drums (synthesized kit), Rose Sampler.
// API: { output, noteOn(pitch, vel, time), noteOff(pitch, time), allOff(time), set(id, v), dispose() }

const R = (id, label, min, max, def, step = 0.01, unit = '', log = false) => ({ id, label, type: 'range', min, max, def, step, unit, log });
const S = (id, label, options, def) => ({ id, label, type: 'select', options, def });
const hz = p => 440 * Math.pow(2, (p - 69) / 12);
const noiseCache = new WeakMap();
function noise(ctx) {
  if (noiseCache.has(ctx)) return noiseCache.get(ctx);
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, b); return b;
}

export const SYNTH_PRESETS = {
  'Supersaw Lead': { w1: 'sawtooth', w2: 'sawtooth', semi: 12, mix2: 0.35, uni: 7, spread: 28, cutoff: 6500, res: 2, fenv: 2500, a: 0.005, d: 0.25, s: 0.75, r: 0.3, fd: 0.3, vol: 0.5 },
  'Pluck': { w1: 'sawtooth', w2: 'square', semi: 0, mix2: 0.3, uni: 3, spread: 12, cutoff: 600, res: 4, fenv: 6000, a: 0.002, d: 0.22, s: 0, r: 0.18, fd: 0.16, vol: 0.6 },
  'Warm Pad': { w1: 'sawtooth', w2: 'triangle', semi: 7, mix2: 0.4, uni: 5, spread: 18, cutoff: 1800, res: 1, fenv: 600, a: 0.8, d: 1, s: 0.8, r: 1.6, fd: 1.2, vol: 0.45 },
  'Sub Bass': { w1: 'sine', w2: 'triangle', semi: 12, mix2: 0.15, uni: 1, spread: 0, cutoff: 900, res: 0.7, fenv: 300, a: 0.004, d: 0.3, s: 0.9, r: 0.12, fd: 0.2, vol: 0.8 },
  'Reese Bass': { w1: 'sawtooth', w2: 'sawtooth', semi: 0, mix2: 0.5, uni: 3, spread: 22, cutoff: 700, res: 3, fenv: 900, a: 0.01, d: 0.4, s: 0.8, r: 0.2, fd: 0.5, vol: 0.55 },
  'Keys': { w1: 'triangle', w2: 'sine', semi: 12, mix2: 0.3, uni: 1, spread: 0, cutoff: 3500, res: 0.8, fenv: 1500, a: 0.003, d: 0.9, s: 0.3, r: 0.4, fd: 0.6, vol: 0.6 },
  'Chip Square': { w1: 'square', w2: 'square', semi: 12, mix2: 0.2, uni: 1, spread: 0, cutoff: 12000, res: 0.5, fenv: 0, a: 0.001, d: 0.1, s: 0.7, r: 0.05, fd: 0.1, vol: 0.35 },
  'Brass': { w1: 'sawtooth', w2: 'sawtooth', semi: 0, mix2: 0.5, uni: 2, spread: 8, cutoff: 900, res: 1.5, fenv: 2800, a: 0.06, d: 0.35, s: 0.7, r: 0.25, fd: 0.35, vol: 0.5 }
};
const WAVES = ['sawtooth', 'square', 'triangle', 'sine'];

export const INSTRUMENTS = {
  synth: {
    name: 'Rose Synth',
    params: [S('preset', 'Preset', Object.keys(SYNTH_PRESETS), 'Supersaw Lead'), S('w1', 'Osc 1', WAVES, 'sawtooth'), S('w2', 'Osc 2', WAVES, 'sawtooth'),
      R('semi', 'Osc 2 pitch', -24, 24, 12, 1, 'st'), R('mix2', 'Osc 2 level', 0, 1, 0.35), R('uni', 'Unison voices', 1, 7, 7, 1), R('spread', 'Detune', 0, 60, 28, 1, 'ct'),
      R('cutoff', 'Cutoff', 60, 18000, 6500, 1, 'Hz', true), R('res', 'Resonance', 0.1, 18, 2, 0.1), R('fenv', 'Filter env', 0, 10000, 2500, 10, 'Hz'), R('fd', 'Filter decay', 0.01, 3, 0.3, 0.01, 's'),
      R('a', 'Attack', 0.001, 3, 0.005, 0.001, 's'), R('d', 'Decay', 0.01, 3, 0.25, 0.01, 's'), R('s', 'Sustain', 0, 1, 0.75), R('r', 'Release', 0.01, 5, 0.3, 0.01, 's'), R('vol', 'Volume', 0, 1, 0.5)],
    build(ctx) {
      const out = ctx.createGain(); const st = { ...SYNTH_PRESETS['Supersaw Lead'] }; const voices = new Map();
      const kill = (v, t) => { v.amp.gain.cancelScheduledValues(t); v.amp.gain.setValueAtTime(v.amp.gain.value, t); v.amp.gain.setTargetAtTime(0, t, st.r / 4); v.oscs.forEach(o => o.stop(t + st.r * 2 + 0.05)); };
      return {
        output: out,
        noteOn(p, vel = 0.8, t = ctx.currentTime) {
          if (voices.has(p)) kill(voices.get(p), t);
          const amp = ctx.createGain(), f = ctx.createBiquadFilter(), oscs = [], n = Math.max(1, st.uni | 0), lvl = st.vol * vel * 0.32 / Math.sqrt(n);
          f.type = 'lowpass'; f.Q.value = st.res; amp.gain.value = 0;
          const add = (wave, freq, det, g) => { const o = ctx.createOscillator(), og = ctx.createGain(); o.type = wave; o.frequency.value = freq; o.detune.value = det; og.gain.value = g; o.connect(og).connect(f); o.start(t); oscs.push(o); };
          for (let i = 0; i < n; i++) { const det = n === 1 ? 0 : (i / (n - 1) * 2 - 1) * st.spread; add(st.w1, hz(p), det, 1 - st.mix2); if (st.mix2 > 0) add(st.w2, hz(p + st.semi), -det, st.mix2); }
          f.connect(amp).connect(out);
          const fc = f.frequency; fc.setValueAtTime(Math.min(20000, st.cutoff + st.fenv * vel), t); fc.setTargetAtTime(st.cutoff, t + 0.001, st.fd / 3);
          const g = amp.gain; g.setValueAtTime(0, t); g.linearRampToValueAtTime(lvl, t + st.a); g.setTargetAtTime(lvl * st.s, t + st.a, st.d / 3);
          voices.set(p, { amp, oscs });
        },
        noteOff(p, t = ctx.currentTime) { const v = voices.get(p); if (!v) return; voices.delete(p); kill(v, t); },
        allOff(t = ctx.currentTime) { for (const [p] of voices) this.noteOff(p, t); },
        set(id, v) { if (id === 'preset') Object.assign(st, SYNTH_PRESETS[v] || {}); else st[id] = v; },
        dispose() { this.allOff(); setTimeout(() => out.disconnect(), 3000); }
      };
    }
  },
  drums: {
    name: 'Rose Drums',
    params: [R('ktune', 'Kick tune', 35, 80, 50, 1, 'Hz'), R('kdecay', 'Kick decay', 0.1, 1.2, 0.45, 0.01, 's'), R('kpunch', 'Kick punch', 0, 1, 0.7),
      R('stone', 'Snare tone', 120, 300, 190, 1, 'Hz'), R('sdecay', 'Snare decay', 0.05, 0.5, 0.18, 0.01, 's'), R('hdecay', 'Hat decay', 0.02, 0.4, 0.06, 0.005, 's'), R('vol', 'Volume', 0, 1, 0.8)],
    build(ctx) {
      const out = ctx.createGain(), st = { ktune: 50, kdecay: 0.45, kpunch: 0.7, stone: 190, sdecay: 0.18, hdecay: 0.06, vol: 0.8 };
      const env = (g, t, peak, dec, a = 0.001) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); };
      const nz = (t, dur, type, freq, q, peak, dec) => { const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noise(ctx); f.type = type; f.frequency.value = freq; f.Q.value = q; s.connect(f).connect(g).connect(out); env(g, t, peak, dec); s.start(t, Math.random()); s.stop(t + dur); };
      const tone = (t, f0, f1, sweep, peak, dec, type = 'sine') => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + sweep); o.connect(g).connect(out); env(g, t, peak, dec); o.start(t); o.stop(t + dec + 0.05); };
      const hits = {
        36: (t, v) => { tone(t, st.ktune * (3 + st.kpunch * 4), st.ktune, 0.05 + st.kpunch * 0.04, v * st.vol, st.kdecay); nz(t, 0.01, 'highpass', 3000, 0.7, v * st.vol * 0.25 * st.kpunch, 0.008); },
        38: (t, v) => { tone(t, st.stone * 1.6, st.stone, 0.03, v * st.vol * 0.55, st.sdecay * 0.6, 'triangle'); nz(t, st.sdecay + 0.05, 'highpass', 1500, 0.7, v * st.vol * 0.6, st.sdecay); },
        39: (t, v) => { [0, 0.011, 0.022].forEach(o => nz(t + o, 0.02, 'bandpass', 1200, 1.2, v * st.vol * 0.7, 0.012)); nz(t + 0.03, 0.25, 'bandpass', 1200, 1, v * st.vol * 0.7, 0.18); },
        37: (t, v) => { tone(t, 1700, 900, 0.01, v * st.vol * 0.4, 0.04, 'square'); },
        42: (t, v) => nz(t, st.hdecay + 0.05, 'highpass', 7500, 0.8, v * st.vol * 0.45, st.hdecay),
        44: (t, v) => nz(t, st.hdecay + 0.05, 'highpass', 6500, 0.8, v * st.vol * 0.4, st.hdecay * 0.8),
        46: (t, v) => nz(t, 0.6, 'highpass', 7000, 0.8, v * st.vol * 0.4, st.hdecay * 6),
        45: (t, v) => tone(t, 160, 90, 0.2, v * st.vol * 0.8, 0.35),
        48: (t, v) => tone(t, 220, 140, 0.2, v * st.vol * 0.8, 0.3),
        50: (t, v) => tone(t, 300, 200, 0.18, v * st.vol * 0.8, 0.25),
        49: (t, v) => nz(t, 2, 'highpass', 5000, 0.5, v * st.vol * 0.4, 1.6),
        51: (t, v) => nz(t, 1.2, 'bandpass', 8000, 3, v * st.vol * 0.35, 0.9),
        56: (t, v) => { tone(t, 800, 800, 0.01, v * st.vol * 0.3, 0.2, 'square'); tone(t, 540, 540, 0.01, v * st.vol * 0.3, 0.2, 'square'); }
      };
      return {
        output: out,
        noteOn(p, v = 0.8, t = ctx.currentTime) { (hits[p] || hits[36 + ((p - 36) % 12 + 12) % 12] || hits[36])(t, v); },
        noteOff() { }, allOff() { },
        set(id, v) { st[id] = v; },
        dispose() { setTimeout(() => out.disconnect(), 3000); }
      };
    }
  },
  sampler: {
    name: 'Rose Sampler',
    params: [R('root', 'Root note', 24, 96, 60, 1), R('a', 'Attack', 0.001, 2, 0.002, 0.001, 's'), R('r', 'Release', 0.01, 4, 0.2, 0.01, 's'), R('vol', 'Volume', 0, 1.5, 0.9)],
    build(ctx, env) {
      const out = ctx.createGain(), st = { root: 60, a: 0.002, r: 0.2, vol: 0.9, sample: null }, voices = new Map();
      return {
        output: out,
        noteOn(p, v = 0.8, t = ctx.currentTime) {
          const buf = env?.buffer(st.sample); if (!buf) return;
          this.noteOff(p, t); const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = buf; s.playbackRate.value = Math.pow(2, (p - st.root) / 12);
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * st.vol, t + st.a); s.connect(g).connect(out); s.start(t); voices.set(p, { s, g });
        },
        noteOff(p, t = ctx.currentTime) { const v = voices.get(p); if (!v) return; voices.delete(p); v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.setTargetAtTime(0, t, st.r / 4); v.s.stop(t + st.r * 2); },
        allOff(t) { for (const [p] of voices) this.noteOff(p, t); },
        set(id, v) { st[id] = v; },
        dispose() { this.allOff(); setTimeout(() => out.disconnect(), 3000); }
      };
    }
  },
  external: {
    name: 'External MIDI',
    params: [R('ch', 'MIDI channel', 1, 16, 1, 1), R('vel', 'Velocity scale', 0.1, 1.5, 1, 0.01), R('shift', 'Transpose', -24, 24, 0, 1, 'st')],
    build(ctx, env) {
      // Sends notes to a Web MIDI output: SHRUB's browser editor (through a virtual port such as the Mac IAC Driver), an FM-1, or any hardware synth.
      const out = ctx.createGain(), st = { ch: 1, vel: 1, shift: 0, port: '' }, held = new Set();
      const port = () => env?.midiOut?.(st.port);
      const send = (msg, t) => { const o = port(); if (!o) return; try { o.send(msg, env.perfTime(t)); } catch { } };
      return {
        output: out,
        noteOn(p, v = 0.8, t = ctx.currentTime) { const n = Math.max(0, Math.min(127, p + st.shift)); held.add(n); send([0x90 | (st.ch - 1), n, Math.max(1, Math.min(127, Math.round(v * 127 * st.vel)))], t); },
        noteOff(p, t = ctx.currentTime) { const n = Math.max(0, Math.min(127, p + st.shift)); held.delete(n); send([0x80 | (st.ch - 1), n, 0], t); },
        allOff(t = ctx.currentTime) { held.forEach(n => send([0x80 | (st.ch - 1), n, 0], t)); held.clear(); send([0xB0 | (st.ch - 1), 123, 0], t); },
        set(id, v) { st[id] = v; },
        dispose() { this.allOff(); out.disconnect(); }
      };
    }
  }
};

export const DRUM_ROWS = [[36, 'Kick'], [38, 'Snare'], [39, 'Clap'], [37, 'Rim'], [42, 'Closed hat'], [46, 'Open hat'], [45, 'Low tom'], [50, 'High tom'], [49, 'Crash'], [51, 'Ride'], [56, 'Cowbell']];
export const instDefaults = type => Object.fromEntries(INSTRUMENTS[type].params.map(p => [p.id, p.def]));
export function createInstrument(ctx, track, env) {
  const def = INSTRUMENTS[track.inst]; if (!def) return null;
  const inst = def.build(ctx, env); const p = { ...instDefaults(track.inst), ...track.instParams };
  if (p.preset) inst.set('preset', p.preset);
  for (const [k, v] of Object.entries(p)) if (k !== 'preset') inst.set(k, v);
  return inst;
}
