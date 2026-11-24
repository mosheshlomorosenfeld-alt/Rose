// Rose — built-in effects. Every effect is plain Web Audio, so it runs live and in offline WAV export.
// Each definition: { name, cat, params:[...], build(ctx, env) -> { input, output, set(id, v), tempo?(bpm), sync?(t), meter?(), dispose() } }

const WORKLET = `
class RoseGate extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[{name:'threshold',defaultValue:-40},{name:'attack',defaultValue:0.002},{name:'release',defaultValue:0.12},{name:'range',defaultValue:-80}]}
  constructor(){super();this.env=0;this.g=1}
  process(i,o,p){const inp=i[0],out=o[0];if(!inp.length)return true;const sr=sampleRate,th=Math.pow(10,p.threshold[0]/20),fl=Math.pow(10,p.range[0]/20);
    const a=Math.exp(-1/(sr*Math.max(p.attack[0],1e-4))),r=Math.exp(-1/(sr*Math.max(p.release[0],1e-3)));
    for(let n=0;n<inp[0].length;n++){let pk=0;for(let c=0;c<inp.length;c++)pk=Math.max(pk,Math.abs(inp[c][n]));this.env=Math.max(pk,this.env*0.9995);
      const tgt=this.env>th?1:fl;this.g=tgt>this.g?a*this.g+(1-a)*tgt:r*this.g+(1-r)*tgt;for(let c=0;c<out.length;c++)out[c][n]=(inp[c]||inp[0])[n]*this.g}
    return true}}
class RoseCrush extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[{name:'bits',defaultValue:8},{name:'down',defaultValue:4}]}
  constructor(){super();this.h=[0,0];this.c=0}
  process(i,o,p){const inp=i[0],out=o[0];if(!inp.length)return true;const st=Math.pow(2,p.bits[0]-1),d=Math.max(1,Math.round(p.down[0]));
    for(let n=0;n<inp[0].length;n++){if(this.c++%d===0)for(let c=0;c<inp.length;c++)this.h[c]=Math.round(inp[c][n]*st)/st;for(let c=0;c<out.length;c++)out[c][n]=this.h[Math.min(c,inp.length-1)]}
    return true}}
class RoseSC extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[{name:'threshold',defaultValue:-24},{name:'ratio',defaultValue:6},{name:'attack',defaultValue:0.003},{name:'release',defaultValue:0.15},{name:'makeup',defaultValue:0}]}
  constructor(){super();this.env=0;this.gr=0;this.port.onmessage=()=>this.port.postMessage(this.gr)}
  process(i,o,p){const inp=i[0],key=i[1],out=o[0];if(!inp.length)return true;const k=key&&key.length?key:inp,sr=sampleRate;
    const a=Math.exp(-1/(sr*Math.max(p.attack[0],1e-4))),r=Math.exp(-1/(sr*Math.max(p.release[0],1e-3))),th=p.threshold[0],ra=Math.max(1,p.ratio[0]),mk=Math.pow(10,p.makeup[0]/20);let mx=0;
    for(let n=0;n<inp[0].length;n++){let pk=0;for(let c=0;c<k.length;c++)pk=Math.max(pk,Math.abs(k[c][n]));this.env=pk>this.env?a*this.env+(1-a)*pk:r*this.env+(1-r)*pk;
      const lv=20*Math.log10(this.env+1e-9),over=lv-th,red=over>0?over*(1-1/ra):0;mx=Math.max(mx,red);const g=Math.pow(10,-red/20)*mk;
      for(let c=0;c<out.length;c++)out[c][n]=(inp[c]||inp[0])[n]*g}
    this.gr=mx;return true}}
registerProcessor('rose-gate',RoseGate);registerProcessor('rose-crush',RoseCrush);registerProcessor('rose-sc',RoseSC);`;

const loaded = new WeakSet();
export async function prepareWorklets(ctx) {
  if (loaded.has(ctx) || !ctx.audioWorklet) return;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    loaded.add(ctx);
  } catch (e) { console.warn('Worklets unavailable; gate and bitcrusher will pass audio through', e); }
}
const worklet = (ctx, name, inputs = 1) => { try { return loaded.has(ctx) ? new AudioWorkletNode(ctx, name, { numberOfInputs: inputs, outputChannelCount: [2] }) : null; } catch { return null; } };

const db = v => Math.pow(10, v / 20);
const R = (id, label, min, max, def, step = 0.01, unit = '', log = false) => ({ id, label, type: 'range', min, max, def, step, unit, log });
const S = (id, label, options, def) => ({ id, label, type: 'select', options, def });
const T = (id, label, def = false) => ({ id, label, type: 'toggle', def });
const SYNC = { '1/1': 4, '1/2': 2, '1/2d': 3, '1/4': 1, '1/4d': 1.5, '1/4t': 2 / 3, '1/8': 0.5, '1/8d': 0.75, '1/8t': 1 / 3, '1/16': 0.25, '1/16t': 1 / 6, '1/32': 0.125 };
// When AT is set (automation / offline export) changes are scheduled at that exact time instead of "now".
let AT = null;
export const setAt = t => { AT = t; };
const smooth = (param, v, ctx) => { if (AT != null) { param.setValueAtTime(v, AT); return; } param.cancelScheduledValues(ctx.currentTime); param.setTargetAtTime(v, ctx.currentTime, 0.015); };

// wet/dry helper: input -> dry -> output, input -> [fx] -> wet -> output
function mixer(ctx) {
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  input.connect(dry).connect(output); wet.connect(output);
  return { input, output, dry, wet, mix(v) { smooth(dry.gain, Math.cos(v * Math.PI / 2), ctx); smooth(wet.gain, Math.sin(v * Math.PI / 2), ctx); } };
}
function lfo(ctx, rate, depth, type = 'sine') {
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = rate; g.gain.value = depth; o.connect(g); o.start();
  return { o, g };
}
function impulse(ctx, secs, damp, pre) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * (secs + pre))), b = ctx.createBuffer(2, len, sr), p0 = Math.floor(sr * pre);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c); let lp = 0;
    for (let i = p0; i < len; i++) {
      const t = (i - p0) / sr, env = Math.pow(1 - t / secs, 2.2) * Math.exp(-t * 1.5);
      const k = 1 - damp * Math.min(1, t / secs) * 0.97; lp = lp + k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.max(0, env);
    }
  }
  return b;
}
function curve(kind, drive) {
  const n = 2048, c = new Float32Array(n), k = drive;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    c[i] = kind === 'hard' ? Math.max(-1, Math.min(1, x * (1 + k / 8)))
      : kind === 'fuzz' ? Math.sign(x) * (1 - Math.exp(-Math.abs(x) * (1 + k)))
      : kind === 'tube' ? (x >= 0 ? Math.tanh(x * (1 + k / 6)) : Math.tanh(x * (1 + k / 10)) * 0.9)
      : Math.tanh(x * (1 + k / 4)) / Math.tanh(1 + k / 4);
  }
  return c;
}

export const EFFECTS = {
  eq: {
    name: 'Parametric EQ', cat: 'EQ & Filter',
    params: [R('hp', 'Low cut', 20, 1000, 20, 1, 'Hz', true), R('lsf', 'Low freq', 40, 500, 120, 1, 'Hz', true), R('lsg', 'Low gain', -18, 18, 0, 0.1, 'dB'),
      R('m1f', 'Mid 1 freq', 100, 4000, 400, 1, 'Hz', true), R('m1g', 'Mid 1 gain', -18, 18, 0, 0.1, 'dB'), R('m1q', 'Mid 1 Q', 0.2, 10, 1, 0.01),
      R('m2f', 'Mid 2 freq', 500, 12000, 2500, 1, 'Hz', true), R('m2g', 'Mid 2 gain', -18, 18, 0, 0.1, 'dB'), R('m2q', 'Mid 2 Q', 0.2, 10, 1, 0.01),
      R('hsf', 'High freq', 2000, 16000, 8000, 1, 'Hz', true), R('hsg', 'High gain', -18, 18, 0, 0.1, 'dB'), R('lp', 'High cut', 1000, 20000, 20000, 1, 'Hz', true)],
    build(ctx) {
      const mk = (type, f) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; return b; };
      const hp = mk('highpass', 20), ls = mk('lowshelf', 120), m1 = mk('peaking', 400), m2 = mk('peaking', 2500), hs = mk('highshelf', 8000), lp = mk('lowpass', 20000);
      hp.Q.value = lp.Q.value = 0.707; const chain = [hp, ls, m1, m2, hs, lp]; chain.reduce((a, b) => (a.connect(b), b));
      const map = { hp: [hp, 'frequency'], lsf: [ls, 'frequency'], lsg: [ls, 'gain'], m1f: [m1, 'frequency'], m1g: [m1, 'gain'], m1q: [m1, 'Q'], m2f: [m2, 'frequency'], m2g: [m2, 'gain'], m2q: [m2, 'Q'], hsf: [hs, 'frequency'], hsg: [hs, 'gain'], lp: [lp, 'frequency'] };
      return {
        input: hp, output: lp, filters: chain,
        set(id, v) { const [n, p] = map[id]; smooth(n[p], v, ctx); },
        dispose() { chain.forEach(n => n.disconnect()); }
      };
    }
  },
  filter: {
    name: 'Auto Filter', cat: 'EQ & Filter',
    params: [S('type', 'Type', ['lowpass', 'highpass', 'bandpass', 'notch'], 'lowpass'), R('freq', 'Cutoff', 40, 20000, 2000, 1, 'Hz', true), R('q', 'Resonance', 0.1, 20, 1, 0.1),
      S('rate', 'LFO rate', ['off', ...Object.keys(SYNC)], 'off'), R('depth', 'LFO depth', 0, 1, 0.5), R('mix', 'Mix', 0, 1, 1)],
    build(ctx) {
      const m = mixer(ctx), f = ctx.createBiquadFilter(), l = lfo(ctx, 1, 0); m.input.connect(f).connect(m.wet); l.g.connect(f.frequency);
      let st = { freq: 2000, depth: 0.5, rate: 'off', bpm: 120 };
      const upd = () => { const on = st.rate !== 'off'; l.o.frequency.value = on ? st.bpm / 60 / (SYNC[st.rate] || 1) : 0.0001; smooth(l.g.gain, on ? st.freq * st.depth * 0.9 : 0, ctx); };
      m.mix(1);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'type') f.type = v; else if (id === 'freq') { st.freq = v; smooth(f.frequency, v, ctx); upd(); } else if (id === 'q') smooth(f.Q, v, ctx); else if (id === 'mix') m.mix(v); else { st[id] = v; upd(); } },
        tempo(b) { st.bpm = b; upd(); },
        dispose() { l.o.stop(); [m.input, m.output, f, l.g].forEach(n => n.disconnect()); }
      };
    }
  },
  comp: {
    name: 'Compressor', cat: 'Dynamics',
    params: [R('threshold', 'Threshold', -60, 0, -18, 0.1, 'dB'), R('ratio', 'Ratio', 1, 20, 4, 0.1, ':1'), R('attack', 'Attack', 0.0005, 0.2, 0.01, 0.0005, 's'),
      R('release', 'Release', 0.01, 1, 0.15, 0.01, 's'), R('knee', 'Knee', 0, 30, 6, 0.5, 'dB'), R('makeup', 'Makeup', 0, 24, 0, 0.1, 'dB'), R('mix', 'Mix (parallel)', 0, 1, 1)],
    build(ctx) {
      const m = mixer(ctx), c = ctx.createDynamicsCompressor(), g = ctx.createGain(); m.input.connect(c).connect(g).connect(m.wet); m.mix(1);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'makeup') smooth(g.gain, db(v), ctx); else if (id === 'mix') m.mix(v); else smooth(c[id], v, ctx); },
        meter: () => c.reduction,
        dispose() { [m.input, m.output, c, g].forEach(n => n.disconnect()); }
      };
    }
  },
  limiter: {
    name: 'Limiter', cat: 'Dynamics',
    params: [R('gain', 'Input gain', 0, 24, 0, 0.1, 'dB'), R('ceiling', 'Ceiling', -12, 0, -0.3, 0.1, 'dB'), R('release', 'Release', 0.01, 0.5, 0.06, 0.01, 's')],
    build(ctx) {
      const pre = ctx.createGain(), c = ctx.createDynamicsCompressor(), out = ctx.createGain();
      c.ratio.value = 20; c.knee.value = 0; c.attack.value = 0.001; c.threshold.value = -0.3; pre.connect(c).connect(out);
      let ceil = -0.3;
      return {
        input: pre, output: out,
        set(id, v) { if (id === 'gain') smooth(pre.gain, db(v), ctx); else if (id === 'ceiling') { ceil = v; smooth(c.threshold, v, ctx); } else smooth(c.release, v, ctx); },
        meter: () => c.reduction,
        dispose() { [pre, c, out].forEach(n => n.disconnect()); }
      };
    }
  },
  sccomp: {
    name: 'Sidechain Compressor', cat: 'Dynamics',
    params: [{ id: 'source', label: 'Key track', type: 'track', def: '' }, R('threshold', 'Threshold', -60, 0, -24, 0.1, 'dB'), R('ratio', 'Ratio', 1, 20, 6, 0.1, ':1'),
      R('attack', 'Attack', 0.0005, 0.1, 0.003, 0.0005, 's'), R('release', 'Release', 0.02, 1, 0.15, 0.01, 's'), R('makeup', 'Makeup', 0, 18, 0, 0.1, 'dB')],
    build(ctx) {
      // ducks this track whenever the key track (e.g. the kick) hits — the real EDM sidechain
      const input = ctx.createGain(), output = ctx.createGain(), w = worklet(ctx, 'rose-sc', 2); let gr = 0;
      if (w) { input.connect(w, 0, 0); w.connect(output); w.port.onmessage = e => gr = e.data; } else input.connect(output);
      return { input, output, keyNode: w, set(id, v) { if (id !== 'source' && w) smooth(w.parameters.get(id), v, ctx); }, meter: () => { w?.port.postMessage(0); return -gr; }, dispose() { [input, output, w].forEach(n => n && n.disconnect()); } };
    }
  },
  analyzer: {
    name: 'Spectrum Analyzer', cat: 'Utility', params: [],
    build(ctx) { const input = ctx.createGain(), an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.8; input.connect(an); return { input, output: input, analyser: an, set() { }, dispose() { input.disconnect(); } }; }
  },
  gate: {
    name: 'Noise Gate', cat: 'Dynamics',
    params: [R('threshold', 'Threshold', -80, 0, -40, 0.5, 'dB'), R('attack', 'Attack', 0.0005, 0.05, 0.002, 0.0005, 's'), R('release', 'Release', 0.01, 1, 0.12, 0.01, 's'), R('range', 'Range', -80, 0, -80, 0.5, 'dB')],
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), w = worklet(ctx, 'rose-gate');
      if (w) input.connect(w).connect(output); else input.connect(output);
      return { input, output, set(id, v) { w && smooth(w.parameters.get(id), v, ctx); }, dispose() { [input, output, w].forEach(n => n && n.disconnect()); } };
    }
  },
  reverb: {
    name: 'Reverb', cat: 'Space',
    params: [R('decay', 'Decay', 0.2, 12, 2.4, 0.1, 's'), R('pre', 'Pre-delay', 0, 0.2, 0.02, 0.001, 's'), R('damp', 'Damping', 0, 1, 0.5), R('lowcut', 'Low cut', 20, 1000, 200, 1, 'Hz', true), R('mix', 'Mix', 0, 1, 0.3)],
    build(ctx) {
      const m = mixer(ctx), cv = ctx.createConvolver(), hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 200;
      m.input.connect(hp).connect(cv).connect(m.wet); let st = { decay: 2.4, pre: 0.02, damp: 0.5 }, t;
      const gen = () => { clearTimeout(t); t = setTimeout(() => { cv.buffer = impulse(ctx, st.decay, st.damp, st.pre); }, ctx instanceof OfflineAudioContext ? 0 : 80); };
      cv.buffer = impulse(ctx, 2.4, 0.5, 0.02); m.mix(0.3);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'mix') m.mix(v); else if (id === 'lowcut') smooth(hp.frequency, v, ctx); else { st[id] = v; if (ctx instanceof OfflineAudioContext) cv.buffer = impulse(ctx, st.decay, st.damp, st.pre); else gen(); } },
        dispose() { [m.input, m.output, cv, hp].forEach(n => n.disconnect()); }
      };
    }
  },
  delay: {
    name: 'Delay', cat: 'Space',
    params: [S('sync', 'Time', ['ms', ...Object.keys(SYNC)], '1/8d'), R('ms', 'Time (ms)', 1, 2000, 375, 1, 'ms'), R('fb', 'Feedback', 0, 0.95, 0.35),
      T('pingpong', 'Ping-pong', true), R('hp', 'Low cut', 20, 2000, 150, 1, 'Hz', true), R('lp', 'High cut', 1000, 20000, 9000, 1, 'Hz', true), R('mix', 'Mix', 0, 1, 0.25)],
    build(ctx) {
      // mono sum -> filters -> L delay -> R delay -> feedback -> L delay. Ping-pong: R repeats after L; straight: R time ~0 so both sides echo together.
      const m = mixer(ctx), mg = ctx.createChannelMerger(2), dl = ctx.createDelay(4), dr = ctx.createDelay(4),
        fb = ctx.createGain(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), sum = ctx.createGain();
      hp.type = 'highpass'; lp.type = 'lowpass'; hp.frequency.value = 150; lp.frequency.value = 9000; sum.gain.value = 0.7;
      m.input.connect(sum).connect(hp).connect(lp).connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl);
      dl.connect(mg, 0, 0); dr.connect(mg, 0, 1); mg.connect(m.wet);
      const s = { sync: '1/8d', ms: 375, bpm: 120, pingpong: true };
      const upd = () => { const t = Math.min(3.9, s.sync === 'ms' ? s.ms / 1000 : 60 / s.bpm * SYNC[s.sync]); smooth(dl.delayTime, t, ctx); smooth(dr.delayTime, s.pingpong ? t : 0.0001, ctx); };
      fb.gain.value = 0.35; upd(); m.mix(0.25);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'fb') smooth(fb.gain, v, ctx); else if (id === 'hp') smooth(hp.frequency, v, ctx); else if (id === 'lp') smooth(lp.frequency, v, ctx); else if (id === 'mix') m.mix(v); else { s[id] = v; upd(); } },
        tempo(b) { s.bpm = b; upd(); },
        dispose() { [m.input, m.output, mg, dl, dr, fb, hp, lp, sum].forEach(n => n.disconnect()); }
      };
    }
  },
  chorus: {
    name: 'Chorus', cat: 'Modulation',
    params: [R('rate', 'Rate', 0.05, 5, 0.8, 0.01, 'Hz'), R('depth', 'Depth', 0, 1, 0.5), R('mix', 'Mix', 0, 1, 0.5)],
    build(ctx) {
      const m = mixer(ctx), mg = ctx.createChannelMerger(2), d1 = ctx.createDelay(0.1), d2 = ctx.createDelay(0.1), l1 = lfo(ctx, 0.8, 0.003), l2 = lfo(ctx, 0.93, 0.003);
      d1.delayTime.value = 0.018; d2.delayTime.value = 0.023; l1.g.connect(d1.delayTime); l2.g.connect(d2.delayTime);
      m.input.connect(d1).connect(mg, 0, 0); m.input.connect(d2).connect(mg, 0, 1); mg.connect(m.wet); m.mix(0.5);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'rate') { l1.o.frequency.value = v; l2.o.frequency.value = v * 1.16; } else if (id === 'depth') { smooth(l1.g.gain, v * 0.006, ctx); smooth(l2.g.gain, v * 0.006, ctx); } else m.mix(v); },
        dispose() { l1.o.stop(); l2.o.stop(); [m.input, m.output, mg, d1, d2, l1.g, l2.g].forEach(n => n.disconnect()); }
      };
    }
  },
  flanger: {
    name: 'Flanger', cat: 'Modulation',
    params: [R('rate', 'Rate', 0.02, 5, 0.25, 0.01, 'Hz'), R('depth', 'Depth', 0, 1, 0.7), R('fb', 'Feedback', -0.95, 0.95, 0.6), R('mix', 'Mix', 0, 1, 0.5)],
    build(ctx) {
      const m = mixer(ctx), d = ctx.createDelay(0.05), fb = ctx.createGain(), l = lfo(ctx, 0.25, 0.002);
      d.delayTime.value = 0.003; l.g.connect(d.delayTime); fb.gain.value = 0.6; m.input.connect(d); d.connect(fb).connect(d); d.connect(m.wet); m.mix(0.5);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'rate') l.o.frequency.value = v; else if (id === 'depth') smooth(l.g.gain, v * 0.0028, ctx); else if (id === 'fb') smooth(fb.gain, v, ctx); else m.mix(v); },
        dispose() { l.o.stop(); [m.input, m.output, d, fb, l.g].forEach(n => n.disconnect()); }
      };
    }
  },
  phaser: {
    name: 'Phaser', cat: 'Modulation',
    params: [R('rate', 'Rate', 0.02, 8, 0.5, 0.01, 'Hz'), R('depth', 'Depth', 0, 1, 0.7), R('freq', 'Center', 200, 4000, 900, 1, 'Hz', true), R('fb', 'Feedback', 0, 0.9, 0.4), R('mix', 'Mix', 0, 1, 0.5)],
    build(ctx) {
      const m = mixer(ctx), stages = [...Array(6)].map(() => { const a = ctx.createBiquadFilter(); a.type = 'allpass'; a.frequency.value = 900; a.Q.value = 0.6; return a; });
      const fb = ctx.createGain(), l = lfo(ctx, 0.5, 600); fb.gain.value = 0.4;
      stages.forEach(s => l.g.connect(s.frequency)); stages.reduce((a, b) => (a.connect(b), b));
      m.input.connect(stages[0]); stages[5].connect(fb).connect(stages[0]); stages[5].connect(m.wet); m.mix(0.5); let st = { freq: 900, depth: 0.7 };
      const upd = () => { stages.forEach(s => smooth(s.frequency, st.freq, ctx)); smooth(l.g.gain, st.freq * st.depth * 0.85, ctx); };
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'rate') l.o.frequency.value = v; else if (id === 'fb') smooth(fb.gain, v, ctx); else if (id === 'mix') m.mix(v); else { st[id] = v; upd(); } },
        dispose() { l.o.stop(); [m.input, m.output, fb, l.g, ...stages].forEach(n => n.disconnect()); }
      };
    }
  },
  tremolo: {
    name: 'Tremolo / Auto-pan', cat: 'Modulation',
    params: [S('rate', 'Rate', Object.keys(SYNC), '1/8'), R('depth', 'Depth', 0, 1, 0.6), T('pan', 'Auto-pan mode', false)],
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), g = ctx.createGain(), p = ctx.createStereoPanner(), l = lfo(ctx, 4, 0.3);
      input.connect(g).connect(p).connect(output); g.gain.value = 0.7; let s = { rate: '1/8', depth: 0.6, pan: false, bpm: 120 };
      const upd = () => { l.o.frequency.value = s.bpm / 60 / SYNC[s.rate]; l.g.disconnect(); if (s.pan) { g.gain.value = 1; l.g.gain.value = s.depth; l.g.connect(p.pan); } else { p.pan.value = 0; g.gain.value = 1 - s.depth / 2; l.g.gain.value = s.depth / 2; l.g.connect(g.gain); } };
      upd();
      return { input, output, set(id, v) { s[id] = v; upd(); }, tempo(b) { s.bpm = b; upd(); }, dispose() { l.o.stop(); [input, output, g, p, l.g].forEach(n => n.disconnect()); } };
    }
  },
  pump: {
    name: 'Sidechain Pump', cat: 'Modulation',
    params: [S('rate', 'Rate', ['1/1', '1/2', '1/4', '1/8', '1/16'], '1/4'), R('depth', 'Depth', 0, 1, 0.8), R('shape', 'Release', 0.05, 0.95, 0.5)],
    build(ctx, env) {
      // volume ducks at every beat division and recovers — the classic EDM "sidechain" pump, locked to the song tempo
      const input = ctx.createGain(), output = ctx.createGain(); input.connect(output);
      let s = { rate: '1/4', depth: 0.8, shape: 0.5, bpm: env?.bpm || 120 }, timer = null, anchor = null;
      const sched = (from, to) => {
        const per = 60 / s.bpm * SYNC[s.rate]; if (anchor == null) return;
        let k = Math.ceil((from - anchor) / per), t = anchor + k * per; const gp = input.gain;
        for (; t < to; t += per) { const lo = 1 - s.depth; gp.setValueAtTime(1, Math.max(0, t - 0.002)); gp.linearRampToValueAtTime(lo, t + 0.004); gp.setTargetAtTime(1, t + 0.01, per * s.shape * 0.35); }
      };
      const loop = () => { if (anchor == null || ctx instanceof OfflineAudioContext) return; const now = ctx.currentTime; sched(now + 0.1, now + 0.35); };
      let last = 0;
      return {
        input, output,
        set(id, v) { s[id] = v; },
        tempo(b) { s.bpm = b; },
        sync(t, playing, end) { input.gain.cancelScheduledValues(0); input.gain.value = 1; anchor = playing ? t : null; clearInterval(timer);
          if (!playing) return; if (ctx instanceof OfflineAudioContext) { sched(t, end); return; } sched(t, ctx.currentTime + 0.35); last = ctx.currentTime + 0.35;
          timer = setInterval(() => { const n = ctx.currentTime + 0.35; sched(last, n); last = n; }, 100); },
        dispose() { clearInterval(timer); input.disconnect(); output.disconnect(); }
      };
    }
  },
  distortion: {
    name: 'Distortion', cat: 'Character',
    params: [S('kind', 'Type', ['soft', 'tube', 'hard', 'fuzz'], 'soft'), R('drive', 'Drive', 0, 40, 6, 0.1), R('tone', 'Tone', 500, 20000, 8000, 1, 'Hz', true), R('out', 'Output', -24, 6, -3, 0.1, 'dB'), R('mix', 'Mix', 0, 1, 1)],
    build(ctx) {
      const m = mixer(ctx), ws = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(), g = ctx.createGain(); ws.oversample = '4x'; lp.type = 'lowpass'; lp.frequency.value = 8000; g.gain.value = db(-3);
      m.input.connect(ws).connect(lp).connect(g).connect(m.wet); m.mix(1); let s = { kind: 'soft', drive: 6 }; ws.curve = curve('soft', 6);
      return {
        input: m.input, output: m.output,
        set(id, v) { if (id === 'tone') smooth(lp.frequency, v, ctx); else if (id === 'out') smooth(g.gain, db(v), ctx); else if (id === 'mix') m.mix(v); else { s[id] = v; ws.curve = curve(s.kind, s.drive); } },
        dispose() { [m.input, m.output, ws, lp, g].forEach(n => n.disconnect()); }
      };
    }
  },
  crusher: {
    name: 'Bitcrusher', cat: 'Character',
    params: [R('bits', 'Bits', 1, 16, 8, 1), R('down', 'Downsample', 1, 40, 4, 1, 'x'), R('mix', 'Mix', 0, 1, 1)],
    build(ctx) {
      const m = mixer(ctx), w = worklet(ctx, 'rose-crush'); if (w) m.input.connect(w).connect(m.wet); else m.input.connect(m.wet); m.mix(1);
      return { input: m.input, output: m.output, set(id, v) { if (id === 'mix') m.mix(v); else w && smooth(w.parameters.get(id), v, ctx); }, dispose() { [m.input, m.output, w].forEach(n => n && n.disconnect()); } };
    }
  },
  width: {
    name: 'Stereo Width', cat: 'Utility',
    params: [R('width', 'Width', 0, 2, 1.3, 0.01, '×'), R('bass', 'Mono below', 20, 300, 20, 1, 'Hz', true)],
    build(ctx) {
      // mid/side: M=(L+R)/2, S=(L-R)/2, out L=M+wS, R=M-wS
      const input = ctx.createGain(), output = ctx.createGain(), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const mid = ctx.createGain(), side = ctx.createGain(), inv = ctx.createGain(), sw = ctx.createGain(), sInv = ctx.createGain(), hp = ctx.createBiquadFilter();
      input.channelCountMode = 'explicit'; input.channelCount = 2; input.connect(sp);
      mid.gain.value = 0.5; inv.gain.value = -1; side.gain.value = 0.5; hp.type = 'highpass'; hp.frequency.value = 20;
      sp.connect(mid, 0); sp.connect(mid, 1); sp.connect(side, 0); sp.connect(inv, 1); inv.connect(side);
      side.connect(hp).connect(sw); sw.gain.value = 1.3; sInv.gain.value = -1; sw.connect(sInv);
      mid.connect(mg, 0, 0); mid.connect(mg, 0, 1); sw.connect(mg, 0, 0); sInv.connect(mg, 0, 1); mg.connect(output);
      return { input, output, set(id, v) { if (id === 'width') smooth(sw.gain, v, ctx); else smooth(hp.frequency, v, ctx); }, dispose() { [input, output, sp, mg, mid, side, inv, sw, sInv, hp].forEach(n => n.disconnect()); } };
    }
  },
  utility: {
    name: 'Utility', cat: 'Utility',
    params: [R('gain', 'Gain', -36, 24, 0, 0.1, 'dB'), T('mono', 'Mono', false), T('invert', 'Invert phase', false)],
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), g = ctx.createGain(); input.connect(g).connect(output); let s = { gain: 0, invert: false };
      const upd = () => smooth(g.gain, db(s.gain) * (s.invert ? -1 : 1), ctx);
      return { input, output, set(id, v) { if (id === 'mono') { g.channelCountMode = 'explicit'; g.channelCount = v ? 1 : 2; g.channelInterpretation = 'speakers'; } else { s[id] = v; upd(); } }, dispose() { [input, output, g].forEach(n => n.disconnect()); } };
    }
  }
};

export const defaultParams = type => Object.fromEntries((EFFECTS[type]?.params || []).map(p => [p.id, p.def]));

// Instantiate an effect on a context and apply stored params
export function createEffect(ctx, slot, env) {
  const def = EFFECTS[slot.type]; if (!def) return null;
  const fx = def.build(ctx, env);
  const p = { ...defaultParams(slot.type), ...slot.params };
  for (const [k, v] of Object.entries(p)) fx.set(k, v);
  if (fx.tempo && env) fx.tempo(env.bpm);
  return fx;
}
