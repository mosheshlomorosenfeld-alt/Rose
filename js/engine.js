// Rose — audio engine: project model, mixer graph, transport/scheduler, recording, MIDI, web plugins, WAV export.
import { createEffect, prepareWorklets } from './effects.js';
import { createInstrument, instDefaults } from './instruments.js';

export const db = v => v <= -60 ? 0 : Math.pow(10, v / 20);
export const uid = () => Math.random().toString(36).slice(2, 9);
const COLORS = ['#ff2d87', '#ffb020', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6', '#f43f5e', '#eab308', '#06b6d4', '#f97316'];

export function newTrack(kind, inst, n = 1) {
  const names = { audio: 'Audio', synth: 'Synth', drums: 'Drums', sampler: 'Sampler', external: 'External' };
  return { id: uid(), name: `${names[inst || kind]} ${n}`, kind, inst: kind === 'audio' ? null : inst, instParams: kind === 'audio' ? {} : instDefaults(inst),
    color: COLORS[(n * 3 + (inst || kind).length) % COLORS.length], vol: -6, pan: 0, mute: false, solo: false, arm: false, inserts: [], sends: { A: 0, B: 0 }, clips: [] };
}
export function newProject() {
  const drums = newTrack('inst', 'drums', 1), lead = newTrack('inst', 'synth', 1), bass = newTrack('inst', 'synth', 2), vox = newTrack('audio', null, 1);
  bass.name = 'Bass'; Object.assign(bass.instParams, { preset: 'Sub Bass', w1: 'sine', w2: 'triangle', semi: 12, mix2: 0.15, uni: 1, spread: 0, cutoff: 900, res: 0.7, fenv: 300, a: 0.004, d: 0.3, s: 0.9, r: 0.12, fd: 0.2, vol: 0.8 });
  lead.name = 'Lead'; vox.name = 'Vocals';
  const four = [0, 1, 2, 3].flatMap(b => [{ p: 36, s: b, l: 0.25, v: 1 }, { p: 42, s: b + 0.5, l: 0.25, v: 0.6 }]).concat([{ p: 39, s: 1, l: 0.25, v: 0.9 }, { p: 39, s: 3, l: 0.25, v: 0.9 }]);
  drums.clips.push({ id: uid(), name: 'Beat', start: 0, len: 4, notes: four }, { id: uid(), name: 'Beat', start: 4, len: 4, notes: four.map(n => ({ ...n })) });
  const chord = (s, ps) => ps.map(p => ({ p, s, l: 1.75, v: 0.7 }));
  lead.clips.push({ id: uid(), name: 'Chords', start: 0, len: 8, notes: [...chord(0, [64, 67, 71]), ...chord(2, [60, 64, 67]), ...chord(4, [62, 66, 69]), ...chord(6, [59, 62, 67])] });
  bass.clips.push({ id: uid(), name: 'Bass', start: 0, len: 8, notes: [[40, 0], [36, 2], [38, 4], [43, 6]].flatMap(([p, s]) => [0, 0.5, 1, 1.5].map(o => ({ p, s: s + o, l: 0.4, v: 0.9 }))) });
  drums.inserts.push({ id: uid(), type: 'comp', params: { threshold: -14, ratio: 4, attack: 0.005, makeup: 3 }, bypass: false });
  lead.inserts.push({ id: uid(), type: 'eq', params: { hp: 180 }, bypass: false }, { id: uid(), type: 'pump', params: {}, bypass: false });
  lead.sends.A = 0.35; lead.sends.B = 0.2; lead.vol = -10;
  return {
    v: 1, name: 'Untitled song', bpm: 126, sig: 4, metronome: false, loop: { on: true, start: 0, end: 8 },
    tracks: [drums, bass, lead, vox],
    returns: [{ id: 'A', name: 'Reverb bus', vol: -4, inserts: [{ id: uid(), type: 'reverb', params: { mix: 1, decay: 2.8 }, bypass: false }] },
      { id: 'B', name: 'Delay bus', vol: -6, inserts: [{ id: uid(), type: 'delay', params: { mix: 1 }, bypass: false }] }],
    master: { vol: -1, inserts: [{ id: uid(), type: 'limiter', params: { ceiling: -0.3 }, bypass: false }] }
  };
}

export class Engine {
  constructor() {
    this.ctx = null; this.p = newProject(); this.buffers = new Map(); this.raw = new Map();
    this.g = null; this.playing = false; this.recording = false; this.segs = []; this.sources = []; this.listeners = new Set();
    this.wamHost = null; this.liveNotes = new Map(); this.recNotes = []; this.monitor = false; this.latency = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { this.listeners.forEach(f => f(type, data)); }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await prepareWorklets(this.ctx);
    await this.rebuild();
  }
  get spb() { return 60 / this.p.bpm; }
  env(ctx) { return { bpm: this.p.bpm, buffer: id => this.buffers.get(id), midiOut: name => ctx === this.ctx ? (this.midiOutputs?.get(name) || [...(this.midiOutputs?.values() || [])][0]) : null, perfTime: t => performance.now() + Math.max(0, t - ctx.currentTime + (ctx.outputLatency || 0)) * 1000 }; }

  // ---------- graph ----------
  async strip(ctx, inserts, dest, live) {
    const input = ctx.createGain(), fader = ctx.createGain(), panner = ctx.createStereoPanner(), meter = ctx.createAnalyser();
    meter.fftSize = 1024; const fx = [];
    for (const slot of inserts) {
      let node = null;
      if (slot.type === 'wam') node = live ? await this.loadWam(ctx, slot) : null;
      else node = createEffect(ctx, slot, this.env(ctx));
      fx.push({ slot, node });
    }
    const wire = () => {
      input.disconnect(); fx.forEach(f => f.node && f.node.output.disconnect());
      let cur = input;
      for (const f of fx) if (f.node && !f.slot.bypass) { cur.connect(f.node.input); cur = f.node.output; }
      cur.connect(panner);
    };
    wire(); panner.connect(fader).connect(meter); fader.connect(dest);
    return { input, fader, panner, meter, fx, wire };
  }
  async build(ctx, live) {
    const p = this.p, g = { tracks: new Map(), returns: new Map() };
    g.master = await this.strip(ctx, p.master.inserts, ctx.destination, live);
    g.master.fader.gain.value = db(p.master.vol);
    g.analyser = ctx.createAnalyser(); g.analyser.fftSize = 4096; g.master.fader.connect(g.analyser);
    for (const r of p.returns) { const s = await this.strip(ctx, r.inserts, g.master.input, live); s.fader.gain.value = db(r.vol); g.returns.set(r.id, s); }
    for (const t of p.tracks) {
      const s = await this.strip(ctx, t.inserts, g.master.input, live);
      s.sends = {}; for (const r of p.returns) { const sg = ctx.createGain(); sg.gain.value = t.sends[r.id] || 0; s.fader.connect(sg).connect(g.returns.get(r.id).input); s.sends[r.id] = sg; }
      if (t.kind === 'inst') { s.inst = createInstrument(ctx, t, this.env(ctx)); s.inst?.output.connect(s.input); }
      s.panner.pan.value = t.pan; g.tracks.set(t.id, s);
    }
    this.applyMix(g);
    return g;
  }
  applyMix(g = this.g) {
    if (!g) return; const solo = this.p.tracks.some(t => t.solo);
    for (const t of this.p.tracks) { const s = g.tracks.get(t.id); if (!s) continue; s.fader.gain.value = t.mute || (solo && !t.solo) ? 0 : db(t.vol); s.panner.pan.value = t.pan; for (const k in s.sends) s.sends[k].gain.value = t.sends[k] || 0; }
    for (const r of this.p.returns) { const s = g.returns.get(r.id); if (s) s.fader.gain.value = db(r.vol); }
    g.master.fader.gain.value = db(this.p.master.vol);
  }
  async rebuild() {
    if (!this.ctx) return; const wasPlaying = this.playing, pos = this.position();
    if (wasPlaying) this.stop(true);
    const old = this.g; this.g = await this.build(this.ctx, true);
    if (old) { old.master.fader.disconnect(); [old.master, ...old.tracks.values(), ...old.returns.values()].forEach(s => { s.fx.forEach(f => f.node?.dispose?.()); s.inst?.dispose(); }); }
    if (wasPlaying) this.play(pos); else this.syncFx(false);
    this.emit('graph');
  }
  stripFor(kind, id) { return !this.g ? null : kind === 'master' ? this.g.master : kind === 'return' ? this.g.returns.get(id) : this.g.tracks.get(id); }
  setFxParam(kind, id, slotId, param, v) {
    const owner = kind === 'master' ? this.p.master : kind === 'return' ? this.p.returns.find(r => r.id === id) : this.p.tracks.find(t => t.id === id);
    const slot = owner.inserts.find(s => s.id === slotId); slot.params[param] = v;
    const f = this.stripFor(kind, id)?.fx.find(f => f.slot === slot); f?.node?.set(param, v);
  }
  setInstParam(trackId, param, v) { const t = this.p.tracks.find(t => t.id === trackId); t.instParams[param] = v; this.g?.tracks.get(trackId)?.inst?.set(param, v); }
  setTempo(bpm) {
    const pos = this.position(); this.p.bpm = Math.max(40, Math.min(240, bpm));
    if (!this.g) return; const all = [this.g.master, ...this.g.tracks.values(), ...this.g.returns.values()];
    all.forEach(s => s.fx.forEach(f => f.node?.tempo?.(this.p.bpm)));
    if (this.playing) { this.stop(true); this.play(pos); }
  }
  syncFx(playing, t = this.ctx?.currentTime || 0, end) {
    if (!this.g) return; [this.g.master, ...this.g.tracks.values(), ...this.g.returns.values()].forEach(s => s.fx.forEach(f => f.node?.sync?.(t, playing, end)));
  }

  // ---------- web plugins (Web Audio Modules 2) ----------
  async loadWam(ctx, slot) {
    try {
      if (!this.wamHost) {
        const { default: initializeWamHost } = await import('https://www.webaudiomodules.com/sdk/2.0.0-alpha.6/src/initializeWamHost.js');
        [this.wamHost] = await initializeWamHost(ctx);
      }
      const { default: WAM } = await import(slot.url);
      const inst = await WAM.createInstance(this.wamHost, ctx);
      if (slot.state) try { await inst.audioNode.setState(slot.state); } catch { }
      const node = inst.audioNode;
      return { input: node, output: node, wam: inst, set() { }, dispose() { try { node.disconnect(); node.destroy?.(); } catch { } } };
    } catch (e) { this.emit('error', `Couldn't load web plugin: ${e.message}`); return null; }
  }

  // ---------- transport ----------
  position() {
    if (!this.playing || !this.ctx) return this.p.cursor || 0;
    const now = this.ctx.currentTime - this.latency; let s = this.segs[0];
    for (const x of this.segs) if (x.t <= now) s = x;
    return s.b + Math.max(0, now - s.t) / this.spb;
  }
  async play(from = this.p.cursor || 0) {
    await this.start(); if (this.playing) return;
    const lp = this.p.loop; if (lp.on && (from >= lp.end || from < lp.start)) from = lp.start;
    this.playing = true; const t0 = this.ctx.currentTime + 0.06;
    this.segs = [{ t: t0, b: from, first: true }]; this.schedBeat = from; this.syncFx(true, t0 - from * this.spb);
    this.tick(); this.timer = setInterval(() => this.tick(), 25); this.emit('transport');
  }
  stop(keep = false) {
    if (!this.playing) { if (!keep) { this.p.cursor = this.p.loop.on ? this.p.loop.start : 0; this.emit('transport'); } return; }
    const pos = this.position(); clearInterval(this.timer); this.playing = false;
    const now = this.ctx.currentTime; this.sources.forEach(s => { try { s.stop(now + 0.01); } catch { } }); this.sources = [];
    this.g?.tracks.forEach(s => s.inst?.allOff(now)); this.syncFx(false);
    if (this.recording && !keep) this.finishRecording(pos);
    this.p.cursor = keep ? pos : pos; this.emit('transport');
  }
  tick() {
    const ahead = this.ctx.currentTime + 0.15, lp = this.p.loop;
    // advance through loop segments
    for (let guard = 0; guard < 8; guard++) {
      const seg = this.segs[this.segs.length - 1];
      const endB = lp.on && !this.recording ? lp.end : Infinity;
      const winEndB = Math.min(endB, seg.b + (ahead - seg.t) / this.spb);
      if (winEndB > this.schedBeat) { this.schedule(this.ctx, seg, this.schedBeat, winEndB, seg.first); seg.first = false; this.schedBeat = winEndB; }
      if (winEndB >= endB) { const t = seg.t + (endB - seg.b) * this.spb; this.segs.push({ t, b: lp.start, first: true }); this.schedBeat = lp.start; this.syncFx(true, t - lp.start * this.spb); if (this.segs.length > 4) this.segs.shift(); }
      else break;
    }
  }
  // schedule everything between beats b0..b1 on a segment (also used by offline export)
  schedule(ctx, seg, b0, b1, first, g = this.g, out = this.sources) {
    const spb = this.spb, T = b => seg.t + (b - seg.b) * spb, solo = this.p.tracks.some(t => t.solo);
    for (const t of this.p.tracks) {
      const s = g.tracks.get(t.id); if (!s) continue;
      for (const c of t.clips) {
        const cEnd = c.start + c.len;
        if (c.notes) {
          if (!s.inst || cEnd <= b0 || c.start >= b1) continue;
          for (const n of c.notes) {
            if (n.s >= c.len) continue; const nb = c.start + n.s;
            if (nb >= b0 && nb < b1) { const end = Math.min(nb + n.l, cEnd); s.inst.noteOn(n.p, n.v, T(nb)); s.inst.noteOff(n.p, T(end)); }
          }
        } else {
          const buf = this.buffers.get(c.sample); if (!buf) continue;
          let startB = null, off = c.offset || 0;
          if (c.start >= b0 && c.start < b1) startB = c.start;
          else if (first && c.start < b0 && cEnd > b0) { startB = b0; off += (b0 - c.start) * spb; }
          if (startB == null) continue;
          const src = ctx.createBufferSource(), gn = ctx.createGain(); src.buffer = buf; gn.gain.value = db(c.gain || 0);
          src.connect(gn).connect(s.input); const dur = (cEnd - startB) * spb; const when = T(startB);
          if (off < buf.duration) { src.start(Math.max(when, ctx.currentTime), off, Math.max(0.001, Math.min(dur, buf.duration - off))); out.push(src); src.onended = () => { const i = out.indexOf(src); if (i >= 0) out.splice(i, 1); }; }
        }
      }
    }
    if (this.p.metronome && ctx === this.ctx) {
      for (let b = Math.ceil(b0 - 1e-9); b < b1; b++) {
        const o = ctx.createOscillator(), gn = ctx.createGain(), t = T(b); o.frequency.value = b % this.p.sig === 0 ? 1760 : 1100;
        gn.gain.setValueAtTime(0.25, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.05); o.connect(gn).connect(ctx.destination); o.start(t); o.stop(t + 0.06);
      }
    }
  }
  seek(b) { b = Math.max(0, b); if (this.playing) { this.stop(true); this.p.cursor = b; this.play(b); } else { this.p.cursor = b; this.emit('transport'); } }

  // ---------- live playing (MIDI keyboard / computer keys) ----------
  liveOn(trackId, p, v = 0.8) {
    const s = this.g?.tracks.get(trackId); if (!s?.inst) return; s.inst.noteOn(p, v, this.ctx.currentTime);
    if (this.recording && this.p.tracks.find(t => t.id === trackId)?.arm) this.liveNotes.set(p, { p, s: this.position(), v, track: trackId });
  }
  liveOff(trackId, p) {
    const s = this.g?.tracks.get(trackId); s?.inst?.noteOff(p, this.ctx.currentTime);
    const n = this.liveNotes.get(p); if (n) { this.liveNotes.delete(p); n.l = Math.max(0.05, this.position() - n.s); this.recNotes.push(n); }
  }

  // ---------- recording ----------
  async record() {
    await this.start(); if (this.recording) return this.stop();
    const armed = this.p.tracks.filter(t => t.arm); if (!armed.length) { this.emit('error', 'Arm a track first (the ● button on a track).'); return; }
    this.recStart = this.p.cursor || 0; this.recNotes = []; this.liveNotes.clear();
    if (armed.some(t => t.kind === 'audio')) {
      try {
        this.stream = this.stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        this.recChunks = []; this.mr = new MediaRecorder(this.stream); this.mr.ondataavailable = e => e.data.size && this.recChunks.push(e.data); this.mr.start();
        if (this.monitor) { this.monNode = this.ctx.createMediaStreamSource(this.stream); this.monNode.connect(this.g.tracks.get(armed.find(t => t.kind === 'audio').id).input); }
      } catch (e) { this.emit('error', 'Microphone access was blocked. Allow it in your browser to record audio.'); return; }
    }
    this.recording = true; this.recT0 = performance.now(); await this.play(this.recStart); this.emit('transport');
  }
  async finishRecording(endBeat) {
    this.recording = false; const armed = this.p.tracks.filter(t => t.arm);
    for (const [, n] of this.liveNotes) { n.l = Math.max(0.05, endBeat - n.s); this.recNotes.push(n); } this.liveNotes.clear();
    for (const t of armed.filter(t => t.kind === 'inst')) {
      const notes = this.recNotes.filter(n => n.track === t.id); if (!notes.length) continue;
      const st = Math.floor(this.recStart), len = Math.max(1, Math.ceil(endBeat - st));
      t.clips.push({ id: uid(), name: 'Recording', start: st, len, notes: notes.map(n => ({ p: n.p, s: n.s - st, l: n.l, v: n.v })) });
    }
    if (this.mr && this.mr.state !== 'inactive') {
      const at = armed.find(t => t.kind === 'audio'); const recStart = this.recStart;
      await new Promise(r => { this.mr.onstop = r; this.mr.stop(); });
      this.monNode?.disconnect(); this.monNode = null;
      const blob = new Blob(this.recChunks, { type: this.mr.mimeType }); const ab = await blob.arrayBuffer();
      const id = await this.addAudio(ab, 'Recording');
      if (id && at) { const buf = this.buffers.get(id), lat = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + 0.06;
        at.clips.push({ id: uid(), name: 'Take ' + (at.clips.length + 1), start: recStart, len: Math.max(0.25, (buf.duration - lat) / this.spb), sample: id, offset: lat, gain: 0 }); }
    }
    this.emit('recorded');
  }

  // ---------- audio files ----------
  async addAudio(arrayBuffer, name) {
    await this.start();
    try {
      const copy = arrayBuffer.slice(0); const buf = await this.ctx.decodeAudioData(arrayBuffer);
      const id = uid(); this.buffers.set(id, buf); this.raw.set(id, copy); this.emit('audio', { id, name }); return id;
    } catch (e) { this.emit('error', `Couldn't read ${name || 'that file'} — try WAV, MP3, M4A or OGG.`); return null; }
  }

  // ---------- export ----------
  songEnd() {
    let end = 0; for (const t of this.p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.len);
    return Math.max(end, 1);
  }
  async renderWav(onProgress) {
    const sr = 44100, endB = this.songEnd(), tail = 3, dur = endB * this.spb + tail;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr); await prepareWorklets(ctx);
    const g = await this.build(ctx, false); const seg = { t: 0, b: 0 };
    [g.master, ...g.tracks.values(), ...g.returns.values()].forEach(s => s.fx.forEach(f => f.node?.sync?.(0, true, dur)));
    this.schedule(ctx, seg, 0, endB, true, g, []);
    onProgress?.('Rendering…'); const buf = await ctx.startRendering();
    const skipped = this.p.tracks.concat(this.p.returns, [this.p.master]).some(o => o.inserts.some(s => s.type === 'wam'));
    return { wav: encodeWav(buf), skipped };
  }
  // ---------- save / load ----------
  async toFile() {
    const audio = {}; for (const [id, ab] of this.raw) audio[id] = b64(ab);
    return JSON.stringify({ rose: 1, project: this.p, audio });
  }
  async fromFile(text) {
    const d = JSON.parse(text); if (!d.project?.tracks) throw new Error('Not a Rose project');
    this.stop(); this.buffers.clear(); this.raw.clear(); await this.start();
    for (const [id, s] of Object.entries(d.audio || {})) { const ab = unb64(s); try { this.buffers.set(id, await this.ctx.decodeAudioData(ab.slice(0))); this.raw.set(id, ab); } catch { } }
    this.p = d.project; await this.rebuild(); this.emit('load');
  }
}

function b64(ab) { let s = ''; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
export function encodeWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate, out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c)); let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}
