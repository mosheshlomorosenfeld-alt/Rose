// Rose — UI: arrangement, track headers, piano roll, step sequencer, device rack, mixer, plugins, keyboard & MIDI.
import { Engine, newTrack, newProject, uid, db } from './engine.js';
import { EFFECTS } from './effects.js';
import { INSTRUMENTS, SYNTH_PRESETS, DRUM_ROWS, instDefaults } from './instruments.js';

const E = new Engine();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI = { track: null, clip: null, ppb: 44, snap: 0.25, tab: 'editor', dev: { kind: 'track', id: null }, oct: 4, hist: [], fut: [], prGrid: 0.25, prZoom: 1, peaks: new Map(), confirmNew: 0 };
const LANE = 68, NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nname = p => NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); };
E.on((type, d) => { if (type === 'error') toast(d); if (type === 'transport') paintTransport(); if (type === 'recorded') { commit(true); } });

// ---------- project helpers ----------
const P = () => E.p;
const trk = id => P().tracks.find(t => t.id === id);
const findClip = id => { for (const t of P().tracks) { const c = t.clips.find(c => c.id === id); if (c) return { t, c }; } return null; };
const snapB = b => UI.snap ? Math.round(b / UI.snap) * UI.snap : b;
const audioName = id => P().audio?.[id]?.name || 'Audio';
function snapshot() { UI.hist.push(JSON.stringify(P())); if (UI.hist.length > 120) UI.hist.shift(); UI.fut = []; }
async function commit(structural = false) { if (structural) await E.rebuild(); else E.applyMix(); render(); persist(); }
async function undo() { if (!UI.hist.length) return toast('Nothing to undo'); UI.fut.push(JSON.stringify(P())); E.p = JSON.parse(UI.hist.pop()); await E.rebuild(); render(); persist(); }
async function redo() { if (!UI.fut.length) return; UI.hist.push(JSON.stringify(P())); E.p = JSON.parse(UI.fut.pop()); await E.rebuild(); render(); persist(); }

// ---------- persistence (project in localStorage, audio in IndexedDB) ----------
let idb = null;
const openDB = () => new Promise(r => { try { const q = indexedDB.open('rose', 1); q.onupgradeneeded = () => q.result.createObjectStore('audio'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); } catch { r(null); } });
const idbDo = (mode, fn) => new Promise(r => { if (!idb) return r(null); try { const tx = idb.transaction('audio', mode), st = tx.objectStore('audio'); const q = fn(st); tx.oncomplete = () => r(q?.result); tx.onerror = () => r(null); } catch { r(null); } });
let saveT;
function persist() {
  clearTimeout(saveT); saveT = setTimeout(async () => {
    try { localStorage.setItem('rose:project', JSON.stringify(P())); } catch { }
    for (const [id, ab] of E.raw) if (!persist.saved?.has(id)) { await idbDo('readwrite', st => st.put(ab, id)); (persist.saved ||= new Set()).add(id); }
  }, 400);
}
async function restore() {
  idb = await openDB(); let p = null;
  try { p = JSON.parse(localStorage.getItem('rose:project') || 'null'); } catch { }
  if (p?.tracks) {
    E.p = p; const keys = await idbDo('readonly', st => st.getAllKeys()) || [];
    for (const id of keys) { const ab = await idbDo('readonly', st => st.get(id)); if (!ab) continue; try { E.buffers.set(id, await E.ctx.decodeAudioData(ab.slice(0))); E.raw.set(id, ab); (persist.saved ||= new Set()).add(id); } catch { } }
  }
  E.p.audio ||= {};
}

// ---------- startup ----------
$('#bStart').onclick = async () => {
  await E.start(); await restore(); await E.rebuild();
  UI.track = P().tracks[0]?.id; UI.dev = { kind: 'track', id: UI.track };
  $('#startScreen').remove(); render(); initMIDI(); requestAnimationFrame(frame);
};

// ---------- transport ----------
$('#bPlay').onclick = () => E.playing ? E.stop(true) : E.play();
$('#bStop').onclick = () => E.stop();
$('#bHome').onclick = () => E.seek(0);
$('#bRec').onclick = () => E.record();
$('#bLoop').onclick = () => { P().loop.on = !P().loop.on; paintTransport(); renderRuler(); persist(); };
$('#bMet').onclick = () => { P().metronome = !P().metronome; paintTransport(); persist(); };
$('#bpm').onchange = e => { snapshot(); E.setTempo(+e.target.value || 120); e.target.value = P().bpm; render(); persist(); };
$('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
$('#songName').onchange = e => { P().name = e.target.value; persist(); };
$('#zoom').oninput = e => { UI.ppb = +e.target.value; renderLanes(); renderRuler(); };
$('#snap').onchange = e => UI.snap = +e.target.value;
function paintTransport() {
  $('#bPlay').classList.toggle('on', E.playing); $('#bPlay').textContent = E.playing ? '❚❚' : '▶';
  $('#bRec').classList.toggle('on', E.recording); $('#bLoop').classList.toggle('on', P().loop.on); $('#bMet').classList.toggle('on', P().metronome);
  $('#bpm').value = P().bpm; $('#songName').value = P().name;
}

// add tracks, import, save/open/new/export
$('#addTrack').onchange = async e => {
  const v = e.target.value; e.target.value = ''; if (!v) return; snapshot();
  const n = P().tracks.filter(t => (t.inst || t.kind) === (v === 'audio' ? 'audio' : v)).length + 1;
  const t = newTrack(v === 'audio' ? 'audio' : 'inst', v === 'audio' ? null : v, n); P().tracks.push(t); UI.track = t.id; UI.dev = { kind: 'track', id: t.id }; await commit(true);
};
$('#fImport').onchange = async e => { const files = [...e.target.files]; e.target.value = ''; await importFiles(files, null, P().cursor || 0); };
async function importFiles(files, trackId, beat) {
  let t = trackId && trk(trackId)?.kind === 'audio' ? trk(trackId) : null; snapshot();
  for (const f of files) {
    if (!f.type.startsWith('audio') && !/\.(wav|mp3|m4a|aac|ogg|flac|aif|aiff)$/i.test(f.name)) continue;
    const id = await E.addAudio(await f.arrayBuffer(), f.name); if (!id) continue; P().audio[id] = { name: f.name.replace(/\.[^.]+$/, '') };
    if (!t) { t = newTrack('audio', null, P().tracks.filter(x => x.kind === 'audio').length + 1); t.name = P().audio[id].name.slice(0, 24); P().tracks.push(t); }
    const len = E.buffers.get(id).duration / E.spb;
    t.clips.push({ id: uid(), name: P().audio[id].name, start: snapB(beat), len, sample: id, offset: 0, gain: 0 }); beat += len;
  }
  await commit(true); toast('Audio imported');
}
$('#bSave').onclick = async () => download(new Blob([await E.toFile()], { type: 'application/json' }), (P().name || 'song') + '.rose');
$('#fOpen').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { snapshot(); await E.fromFile(await f.text()); E.p.audio ||= {}; UI.track = P().tracks[0]?.id; render(); persist(); toast('Project opened'); } catch (err) { toast('That file is not a Rose project'); } };
$('#bNew').onclick = async () => {
  if (Date.now() - UI.confirmNew > 3000) { UI.confirmNew = Date.now(); return toast('Press New again to start a fresh song (you can undo)'); }
  snapshot(); E.stop(); E.p = newProject(); E.p.audio = {}; UI.track = P().tracks[0].id; UI.clip = null; await commit(true);
};
$('#bExport').onclick = async () => {
  $('#bExport').textContent = 'Rendering…'; E.stop(true);
  try { const { wav, skipped } = await E.renderWav(); download(wav, (P().name || 'song') + '.wav'); toast(skipped ? 'Exported — web plugins are skipped in export' : 'WAV exported'); }
  catch (e) { toast('Export failed: ' + e.message); } $('#bExport').textContent = 'Export WAV';
};
function download(blob, name) { try { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); } catch { toast('Downloads are blocked here — open Rose from its GitHub Pages address'); } }

// ---------- render ----------
function render() { paintTransport(); renderHeads(); renderRuler(); renderLanes(); renderDock(); }
function beatsShown() { return Math.max(E.songEnd() + 16, P().loop.end + 8, 64, Math.ceil(($('#lanesWrap').clientWidth || 800) / UI.ppb) + 4); }

function renderHeads() {
  $('#hlist').innerHTML = P().tracks.map(t => `<div class="th ${t.id === UI.track ? 'sel' : ''}" data-id="${t.id}" style="--c:${t.color}">
    <div class="cs"></div><div class="body">
      <div class="row"><input class="name" value="${esc(t.name)}" aria-label="Track name"><button class="sm" data-act="del" title="Delete track">×</button></div>
      <div class="row"><button class="sm m ${t.mute ? 'on' : ''}" data-act="mute" title="Mute">M</button><button class="sm s ${t.solo ? 'on' : ''}" data-act="solo" title="Solo">S</button><button class="sm a ${t.arm ? 'on' : ''}" data-act="arm" title="Arm for recording">●</button>
      <input class="vol" type="range" min="-60" max="6" step="0.5" value="${t.vol}" aria-label="Volume" title="${t.vol} dB"></div>
      <div class="kind">${t.kind === 'audio' ? 'Audio' : esc(INSTRUMENTS[t.inst]?.name)}${t.inserts.length ? ' · ' + t.inserts.length + ' fx' : ''}</div></div></div>`).join('');
}
$('#hlist').addEventListener('click', async e => {
  const h = e.target.closest('.th'); if (!h) return; const t = trk(h.dataset.id), act = e.target.dataset.act;
  if (act === 'del') { snapshot(); P().tracks = P().tracks.filter(x => x !== t); if (UI.track === t.id) UI.track = P().tracks[0]?.id; await commit(true); return; }
  if (act) { snapshot(); t[act] = !t[act]; if (act === 'arm' && t.arm && t.kind === 'audio') P().tracks.forEach(x => { if (x !== t && x.kind === 'audio') x.arm = false; }); await commit(false); return; }
  if (e.target.tagName !== 'INPUT') { UI.track = t.id; UI.dev = { kind: 'track', id: t.id }; renderHeads(); renderDock(); }
});
$('#hlist').addEventListener('input', e => { const h = e.target.closest('.th'); if (!h || !e.target.classList.contains('vol')) return; trk(h.dataset.id).vol = +e.target.value; E.applyMix(); });
$('#hlist').addEventListener('change', e => { const h = e.target.closest('.th'); if (!h) return; const t = trk(h.dataset.id); if (e.target.classList.contains('name')) { snapshot(); t.name = e.target.value; } persist(); renderDock(); });
$('#lanesWrap').addEventListener('scroll', () => { $('#hlist').scrollTop = $('#lanesWrap').scrollTop; });

function renderRuler() {
  const n = beatsShown(), sig = P().sig, lp = P().loop; let h = '';
  for (let b = 0; b < n; b += sig) h += `<div class="bar" style="left:${b * UI.ppb}px">${b / sig + 1}</div>`;
  h += `<div class="loopr ${lp.on ? '' : 'off'}" style="left:${lp.start * UI.ppb}px;width:${(lp.end - lp.start) * UI.ppb}px" title="Loop — drag here to set, click Loop to toggle"></div>`;
  const r = $('#ruler'); r.style.width = n * UI.ppb + 'px'; r.innerHTML = h;
}
$('#ruler').addEventListener('pointerdown', e => {
  const r = $('#ruler').getBoundingClientRect(), x0 = e.clientX - r.left, b0 = snapB(x0 / UI.ppb);
  if (e.clientY - r.top > 28) { E.seek(Math.max(0, x0 / UI.ppb)); return; }
  const lp = P().loop; const move = ev => { const b = snapB((ev.clientX - r.left) / UI.ppb); lp.start = Math.max(0, Math.min(b0, b)); lp.end = Math.max(b0, b, lp.start + (UI.snap || 0.25)); lp.on = true; renderRuler(); paintTransport(); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); persist(); renderLanes(); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});

function renderLanes() {
  const n = beatsShown(), w = n * UI.ppb, lp = P().loop;
  $('#lanes').style.width = w + 'px';
  $('#lanes').innerHTML = (lp.on ? `<div class="loopshade" style="left:${lp.start * UI.ppb}px;width:${(lp.end - lp.start) * UI.ppb}px"></div>` : '') +
    P().tracks.map(t => `<div class="lane" data-id="${t.id}" style="--c:${t.color};background-image:repeating-linear-gradient(90deg,var(--grid) 0 1px,transparent 1px ${UI.ppb}px),repeating-linear-gradient(90deg,var(--line) 0 1px,transparent 1px ${UI.ppb * P().sig}px)">${t.clips.map(c =>
      `<div class="clip ${c.id === UI.clip ? 'sel' : ''}" data-clip="${c.id}" style="left:${c.start * UI.ppb}px;width:${Math.max(6, c.len * UI.ppb)}px"><span class="cn">${esc(c.name || (c.notes ? 'MIDI' : audioName(c.sample)))}</span><canvas></canvas><div class="rs"></div></div>`).join('')}</div>`).join('');
  $('#lanes').querySelectorAll('.clip').forEach(el => drawClip(el, findClip(el.dataset.clip)));
  $('#playhead').style.height = Math.max($('#lanesWrap').clientHeight, 56 + P().tracks.length * LANE) + 'px';
}
function markSel() { document.querySelectorAll('#lanes .clip').forEach(c => c.classList.toggle('sel', c.dataset.clip === UI.clip)); }
function peaksFor(id) {
  if (UI.peaks.has(id)) return UI.peaks.get(id); const b = E.buffers.get(id); if (!b) return null;
  const d = b.getChannelData(0), d2 = b.numberOfChannels > 1 ? b.getChannelData(1) : d, step = 256, pk = new Float32Array(Math.ceil(d.length / step));
  for (let i = 0; i < pk.length; i++) { let m = 0; for (let j = i * step, e = Math.min(d.length, j + step); j < e; j++) m = Math.max(m, Math.abs(d[j]), Math.abs(d2[j])); pk[i] = m; }
  UI.peaks.set(id, pk); return pk;
}
function drawClip(el, fc) {
  if (!fc) return; const { t, c } = fc, cv = el.querySelector('canvas'), W = Math.max(1, el.clientWidth), H = 44, dpr = devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.fillStyle = t.color;
  if (c.notes) {
    if (!c.notes.length) return; const ps = c.notes.map(n => n.p), lo = Math.min(...ps) - 1, hi = Math.max(...ps) + 1, rh = Math.max(2, Math.min(6, H / (hi - lo + 1)));
    for (const n of c.notes) if (n.s < c.len) g.fillRect(n.s / c.len * W, H - (n.p - lo + 1) * (H - rh) / (hi - lo + 1) - rh, Math.max(2, n.l / c.len * W - 1), rh);
  } else {
    const pk = peaksFor(c.sample), b = E.buffers.get(c.sample); if (!pk) return; const sr = b.sampleRate / 256, mid = H / 2;
    for (let x = 0; x < W; x++) { const sec = (c.offset || 0) + x / W * c.len * E.spb, i = Math.floor(sec * sr); if (i >= pk.length) break; const a = pk[i] * mid * db(c.gain || 0); g.fillRect(x, mid - a, 1, Math.max(1, a * 2)); }
  }
}
// clip drag / resize / create / drop
$('#lanes').addEventListener('pointerdown', e => {
  const el = e.target.closest('.clip'), lane = e.target.closest('.lane'); if (!lane) return;
  if (!el) { UI.clip = null; UI.track = lane.dataset.id; UI.dev = { kind: 'track', id: UI.track }; markSel(); renderHeads(); renderDock(); return; }
  const fc = findClip(el.dataset.clip); UI.clip = fc.c.id; UI.track = fc.t.id; UI.dev = { kind: 'track', id: fc.t.id };
  const resize = e.target.classList.contains('rs'), x0 = e.clientX, y0 = e.clientY, s0 = fc.c.start, l0 = fc.c.len; let moved = false, src = fc.t;
  el.setPointerCapture(e.pointerId);
  const move = ev => {
    const db_ = (ev.clientX - x0) / UI.ppb; if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 4) return;
    if (!moved) { snapshot(); moved = true; }
    if (resize) fc.c.len = Math.max(UI.snap || 0.0625, snapB(l0 + db_));
    else {
      fc.c.start = Math.max(0, snapB(s0 + db_));
      const r = $('#lanes').getBoundingClientRect(), idx = Math.floor((ev.clientY - r.top) / LANE), dest = P().tracks[idx];
      if (dest && dest !== src && (dest.kind === 'audio') === !fc.c.notes) { src.clips = src.clips.filter(c => c !== fc.c); dest.clips.push(fc.c); src = dest; fc.t = dest; UI.track = dest.id; }
    }
    renderLanes();
  };
  const up = async () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (moved) await commit(false); else { markSel(); renderHeads(); renderDock(); } };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
});
$('#lanes').addEventListener('dblclick', async e => {
  const el = e.target.closest('.clip'), lane = e.target.closest('.lane'); if (!lane) return;
  if (el) { setTab('editor'); return; }
  const t = trk(lane.dataset.id); if (t.kind !== 'inst') return toast('Drop audio files here, or record into this track');
  const r = lane.getBoundingClientRect(), b = Math.floor((e.clientX - r.left) / UI.ppb / P().sig) * P().sig; snapshot();
  const c = { id: uid(), name: t.name, start: b, len: P().sig, notes: [] }; t.clips.push(c); UI.clip = c.id; UI.track = t.id; await commit(false); setTab('editor');
});
['dragover', 'drop'].forEach(ev => $('#lanesWrap').addEventListener(ev, async e => {
  e.preventDefault(); if (ev === 'dragover') return; const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  const r = $('#lanes').getBoundingClientRect(), lane = P().tracks[Math.floor((e.clientY - r.top) / LANE)];
  await importFiles(files, lane?.id, Math.max(0, (e.clientX - r.left) / UI.ppb));
}));

// ---------- dock ----------
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
function setTab(t) { UI.tab = t; document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); ['editor', 'devices', 'mixer', 'plugins'].forEach(p => $('#' + p).hidden = p !== t); renderDock(); }
function renderDock() {
  const t = trk(UI.track); $('#dockinfo').textContent = t ? `${t.name}${UI.clip ? ' · ' + (findClip(UI.clip)?.c.name || '') : ''}` : '';
  if (UI.tab === 'editor') renderEditor(); else if (UI.tab === 'devices') renderDevices(); else if (UI.tab === 'mixer') renderMixer(); else renderPlugins();
}

// ---------- editor: piano roll / step sequencer / audio clip ----------
function renderEditor() {
  const fc = UI.clip && findClip(UI.clip), box = $('#editor');
  if (!fc) { box.innerHTML = `<div class="empty">Select a clip to edit it. Double-click an empty spot on an instrument track to make a new MIDI clip, or drop audio files onto the arrangement.</div>`; return; }
  if (!fc.c.notes) return renderAudioEditor(fc, box);
  if (fc.t.inst === 'drums') return renderSeq(fc, box);
  renderPianoRoll(fc, box);
}
function clipBar(fc, extra = '') {
  return `<div class="prbar"><input id="cName" value="${esc(fc.c.name)}" aria-label="Clip name" style="width:140px;cursor:text"><label>Length <input id="cLen" type="number" min="0.25" step="0.25" value="${+fc.c.len.toFixed(3)}" style="width:72px;cursor:text"> beats</label>${extra}${fc.c.notes ? '<button id="cMid">Export .mid</button>' : ''}<button id="cDup">Duplicate →</button><button id="cDel">Delete clip</button></div>`;
}
function bindClipBar(fc, rerender) {
  $('#cName').onchange = e => { snapshot(); fc.c.name = e.target.value; commit(false); };
  $('#cLen').onchange = e => { snapshot(); fc.c.len = Math.max(0.25, +e.target.value || 4); commit(false); };
  if ($('#cMid')) $('#cMid').onclick = () => download(midiFile(fc.c, P().bpm), (fc.c.name || 'clip') + '.mid');
  $('#cDup').onclick = () => duplicateClip(); $('#cDel').onclick = () => deleteClip();
}
function renderPianoRoll(fc, box) {
  const grids = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 };
  box.innerHTML = clipBar(fc, `<select id="prGrid" aria-label="Grid">${Object.entries(grids).map(([k, v]) => `<option value="${v}" ${v === UI.prGrid ? 'selected' : ''}>Grid ${k}</option>`).join('')}</select>
    <button id="prQ">Quantize</button><button id="prUp">Oct +</button><button id="prDn">Oct −</button><label>Zoom <input id="prZ" type="range" min="0.5" max="3" step="0.1" value="${UI.prZoom}" style="width:90px;padding:0"></label>`) +
    `<div class="prwrap" id="prwrap"><canvas id="pr"></canvas></div>`;
  bindClipBar(fc);
  $('#prGrid').onchange = e => { UI.prGrid = +e.target.value; draw(); };
  $('#prZ').oninput = e => { UI.prZoom = +e.target.value; size(); draw(); };
  $('#prQ').onclick = () => { snapshot(); fc.c.notes.forEach(n => n.s = Math.round(n.s / UI.prGrid) * UI.prGrid); commit(false); };
  $('#prUp').onclick = () => { snapshot(); fc.c.notes.forEach(n => n.p = Math.min(120, n.p + 12)); commit(false); };
  $('#prDn').onclick = () => { snapshot(); fc.c.notes.forEach(n => n.p = Math.max(12, n.p - 12)); commit(false); };
  const LO = 24, HI = 108, RH = 12, KW = 46, cv = $('#pr'), wrap = $('#prwrap'); let ppb;
  const size = () => { ppb = 70 * UI.prZoom; cv.width = (KW + fc.c.len * ppb) * devicePixelRatio; cv.height = (HI - LO + 1) * RH * devicePixelRatio; cv.style.width = KW + fc.c.len * ppb + 'px'; cv.style.height = (HI - LO + 1) * RH + 'px'; };
  const yOf = p => (HI - p) * RH, pOf = y => HI - Math.floor(y / RH);
  const draw = () => {
    const g = cv.getContext('2d'), W = KW + fc.c.len * ppb, H = (HI - LO + 1) * RH, cs = getComputedStyle(document.documentElement);
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); g.clearRect(0, 0, W, H);
    for (let p = LO; p <= HI; p++) { const black = [1, 3, 6, 8, 10].includes(p % 12); g.fillStyle = black ? cs.getPropertyValue('--lane2') : cs.getPropertyValue('--lane'); g.fillRect(KW, yOf(p), W, RH); if (p % 12 === 0) { g.fillStyle = cs.getPropertyValue('--line'); g.fillRect(KW, yOf(p) + RH - 1, W, 1); } }
    for (let b = 0; b <= fc.c.len + 1e-9; b += UI.prGrid) { g.fillStyle = cs.getPropertyValue(Math.abs(b % P().sig) < 1e-9 ? '--mute' : Math.abs(b % 1) < 1e-9 ? '--line' : '--grid'); g.fillRect(KW + b * ppb, 0, 1, H); }
    for (const n of fc.c.notes) { g.fillStyle = fc.t.color; g.globalAlpha = 0.45 + n.v * 0.55; g.fillRect(KW + n.s * ppb + 1, yOf(n.p) + 1, Math.max(3, n.l * ppb - 2), RH - 2); g.globalAlpha = 1; g.strokeStyle = cs.getPropertyValue('--ink'); g.strokeRect(KW + n.s * ppb + 1.5, yOf(n.p) + 1.5, Math.max(3, n.l * ppb - 3), RH - 3); }
    for (let p = LO; p <= HI; p++) { const black = [1, 3, 6, 8, 10].includes(p % 12); g.fillStyle = black ? '#222' : '#f4f1ec'; g.fillRect(0, yOf(p), KW, RH); g.fillStyle = '#999'; g.fillRect(0, yOf(p) + RH - 1, KW, 1); if (p % 12 === 0) { g.fillStyle = '#333'; g.font = '9px Inter'; g.fillText(nname(p), 4, yOf(p) + 10); } }
  };
  size(); draw(); wrap.scrollTop = yOf(Math.max(...fc.c.notes.map(n => n.p), 72)) - 40;
  let last = UI.prGrid;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, p = pOf(y);
    if (x < KW) { E.liveOn(fc.t.id, p, 0.8); const off = () => { E.liveOff(fc.t.id, p); removeEventListener('pointerup', off); }; addEventListener('pointerup', off); return; }
    const b = (x - KW) / ppb, hit = fc.c.notes.find(n => n.p === p && b >= n.s && b <= n.s + n.l);
    snapshot();
    if (hit && (e.button === 2 || e.altKey)) { fc.c.notes = fc.c.notes.filter(n => n !== hit); draw(); commitQuiet(); return; }
    if (e.button === 2) { UI.hist.pop(); return; }
    let n = hit, mode = 'move', ds = 0;
    if (!n) { n = { p, s: Math.max(0, Math.floor(b / UI.prGrid) * UI.prGrid), l: last, v: 0.8 }; fc.c.notes.push(n); E.liveOn(fc.t.id, p, 0.8); setTimeout(() => E.liveOff(fc.t.id, p), 150); }
    else if (x > KW + (n.s + n.l) * ppb - 7) mode = 'size'; else ds = b - n.s;
    draw(); cv.setPointerCapture(e.pointerId);
    const mv = ev => { const xx = ev.clientX - r.left, bb = (xx - KW) / ppb, g = UI.prGrid;
      if (mode === 'size') { n.l = Math.max(g, Math.round((bb - n.s) / g) * g); last = n.l; }
      else { n.s = Math.max(0, Math.min(fc.c.len - g, Math.round((bb - ds) / g) * g)); const np = pOf(ev.clientY - r.top); if (np !== n.p && np >= LO && np <= HI) { n.p = np; E.liveOn(fc.t.id, np, 0.7); setTimeout(() => E.liveOff(fc.t.id, np), 120); } }
      draw(); };
    const upp = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', upp); commitQuiet(); };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', upp);
  });
  cv.addEventListener('dblclick', e => { const r = cv.getBoundingClientRect(), b = (e.clientX - r.left - KW) / ppb, p = pOf(e.clientY - r.top); const before = fc.c.notes.length; fc.c.notes = fc.c.notes.filter(n => !(n.p === p && b >= n.s && b <= n.s + n.l)); if (fc.c.notes.length !== before) { draw(); commitQuiet(); } });
}
function commitQuiet() { renderLanes(); persist(); }
function renderSeq(fc, box) {
  const steps = Math.round(fc.c.len * 4);
  box.innerHTML = clipBar(fc, `<span class="dockinfo" style="margin:0">Click a step to toggle · Shift-click for an accent · click a name to hear it</span>`) +
    `<div class="seq" id="seq" style="grid-template-columns:110px repeat(${steps},minmax(18px,1fr));--c:${fc.t.color}">${DRUM_ROWS.map(([p, nm]) =>
      `<div class="rl" data-p="${p}">${nm}</div>` + [...Array(steps)].map((_, i) => { const n = fc.c.notes.find(n => n.p === p && Math.abs(n.s - i / 4) < 1e-6); return `<button class="st ${i % 4 === 0 ? 'beat' : ''} ${n ? 'on' : ''}" data-p="${p}" data-i="${i}" style="${n && n.v < 0.85 ? 'opacity:.6' : ''}" aria-label="${nm} step ${i + 1}"></button>`; }).join('')).join('')}</div>`;
  bindClipBar(fc);
  $('#seq').onclick = e => {
    const rl = e.target.closest('.rl'); if (rl) { E.liveOn(fc.t.id, +rl.dataset.p, 0.9); return; }
    const b = e.target.closest('.st'); if (!b) return; const p = +b.dataset.p, s = +b.dataset.i / 4; snapshot();
    const ex = fc.c.notes.find(n => n.p === p && Math.abs(n.s - s) < 1e-6);
    if (ex && !e.shiftKey) fc.c.notes = fc.c.notes.filter(n => n !== ex);
    else if (ex) ex.v = ex.v > 0.85 ? 0.6 : 1;
    else { fc.c.notes.push({ p, s, l: 0.25, v: e.shiftKey ? 1 : 0.8 }); E.liveOn(fc.t.id, p, 0.8); }
    renderSeq(fc, box); commitQuiet();
  };
}
function renderAudioEditor(fc, box) {
  const c = fc.c, b = E.buffers.get(c.sample);
  box.innerHTML = clipBar(fc) + `<div class="dev" style="max-width:none"><div class="ps">
    <div class="pr"><label>Gain</label><input id="aG" type="range" min="-24" max="12" step="0.1" value="${c.gain || 0}"><output>${(c.gain || 0).toFixed(1)} dB</output></div>
    <div class="pr"><label>Trim start</label><input id="aO" type="range" min="0" max="${b ? b.duration.toFixed(2) : 0}" step="0.01" value="${c.offset || 0}"><output>${(c.offset || 0).toFixed(2)} s</output></div>
    <div class="pr"><label>Source</label><span>${esc(audioName(c.sample))} · ${b ? b.duration.toFixed(1) + ' s' : 'missing audio'}</span></div>
    <div class="prbar"><button id="aFit">Fit length to audio</button><button id="aSplit">Split at playhead (Ctrl+E)</button></div></div></div>`;
  bindClipBar(fc);
  $('#aG').oninput = e => { c.gain = +e.target.value; e.target.nextElementSibling.textContent = c.gain.toFixed(1) + ' dB'; renderLanes(); };
  $('#aG').onchange = () => { persist(); };
  $('#aO').oninput = e => { c.offset = +e.target.value; e.target.nextElementSibling.textContent = c.offset.toFixed(2) + ' s'; renderLanes(); };
  $('#aO').onchange = () => persist();
  $('#aFit').onclick = () => { if (!b) return; snapshot(); c.len = (b.duration - (c.offset || 0)) / E.spb; commit(false); };
  $('#aSplit').onclick = splitClip;
}

// ---------- devices ----------
const fmt = (p, v) => p.type !== 'range' ? '' : (p.unit === 'Hz' ? (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz' : p.unit === 's' ? (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s') : (Math.abs(v) < 10 && p.step < 1 ? (+v).toFixed(p.step < 0.1 ? 2 : 1) : Math.round(v)) + (p.unit ? ' ' + p.unit : ''));
const toPos = (p, v) => p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) * 1000 : v;
const fromPos = (p, x) => p.log ? +(p.min * Math.pow(p.max / p.min, x / 1000)).toFixed(1) : +x;
function paramsHtml(params, vals, key) {
  return params.map(p => { const v = vals[p.id] ?? p.def;
    if (p.type === 'select') return `<div class="pr"><label>${p.label}</label><select data-k="${key}" data-p="${p.id}">${p.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    if (p.type === 'toggle') return `<div class="pr"><label>${p.label}</label><input type="checkbox" data-k="${key}" data-p="${p.id}" ${v ? 'checked' : ''} style="justify-self:start;width:20px;height:20px;accent-color:var(--rose)"></div>`;
    return `<div class="pr"><label title="${p.label}">${p.label}</label><input type="range" data-k="${key}" data-p="${p.id}" min="${p.log ? 0 : p.min}" max="${p.log ? 1000 : p.max}" step="${p.log ? 1 : p.step}" value="${toPos(p, v)}"><output>${fmt(p, v)}</output></div>`; }).join('');
}
function devOwner() { const d = UI.dev; return d.kind === 'master' ? P().master : d.kind === 'return' ? P().returns.find(r => r.id === d.id) : trk(d.id); }
function renderDevices() {
  const o = devOwner(), box = $('#devices'); if (!o) { box.innerHTML = '<div class="empty">Select a track.</div>'; return; }
  const opts = [...P().tracks.map(t => [`track:${t.id}`, t.name]), ...P().returns.map(r => [`return:${r.id}`, r.name]), ['master:', 'Master']];
  const cur = `${UI.dev.kind}:${UI.dev.kind === 'master' ? '' : UI.dev.id}`;
  let h = `<div class="rack"><div class="addfx" style="border-style:solid;min-width:170px"><label style="font-weight:700">Device chain for</label><select id="devSel">${opts.map(([v, n]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  if (UI.dev.kind === 'track' && o.kind === 'inst') h += `<label>Instrument</label><select id="instSel">${Object.entries(INSTRUMENTS).map(([k, d]) => `<option value="${k}" ${k === o.inst ? 'selected' : ''}>${d.name}</option>`).join('')}</select>`;
  h += `</div>`;
  if (UI.dev.kind === 'track' && o.kind === 'inst') {
    h += `<div class="dev" style="--c:${o.color}"><h4 style="border-top:3px solid ${o.color}"><span class="t">${INSTRUMENTS[o.inst].name}</span></h4><div class="ps">${paramsHtml(INSTRUMENTS[o.inst].params, o.instParams, 'inst')}`;
    if (o.inst === 'sampler') h += `<div class="pr"><label>Sample</label><select data-k="inst" data-p="sample"><option value="">— choose —</option>${Object.keys(P().audio || {}).filter(id => E.buffers.has(id)).map(id => `<option value="${id}" ${o.instParams.sample === id ? 'selected' : ''}>${esc(audioName(id))}</option>`).join('')}</select></div><label class="tb file" style="height:30px">Load sample…<input id="smpFile" type="file" accept="audio/*" hidden></label>`;
    if (o.inst === 'external') h += `<div class="pr"><label>MIDI output</label><select data-k="inst" data-p="port">${(UI.midiOuts || []).length ? UI.midiOuts.map(n => `<option ${o.instParams.port === n ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option value="">No MIDI outputs found</option>'}</select></div><p style="font-size:12px;color:var(--mute);margin:4px 0 0">Plays SHRUB's browser editor (set its MIDI in to the same virtual port, e.g. the Mac IAC Driver), an FM-1 over USB, or any synth. Not captured in WAV export — record its audio back in on an audio track.</p>`;
    h += `</div></div>`;
  }
  o.inserts.forEach((s, i) => {
    const def = s.type === 'wam' ? { name: 'Web plugin', params: [] } : EFFECTS[s.type];
    h += `<div class="dev ${s.bypass ? 'off' : ''}" data-slot="${s.id}"><h4><span class="t" title="${esc(s.url || '')}">${esc(def?.name || s.type)}</span><button data-a="byp" title="Bypass">${s.bypass ? 'Off' : 'On'}</button><button data-a="l" title="Move left" ${i ? '' : 'disabled'}>‹</button><button data-a="r" title="Move right" ${i < o.inserts.length - 1 ? '' : 'disabled'}>›</button><button data-a="x" title="Remove">×</button></h4>`;
    if (s.type === 'eq') h += `<canvas class="eqc" data-eq="${s.id}"></canvas>`;
    if (s.type === 'comp' || s.type === 'limiter') h += `<div style="font-size:11px;color:var(--mute);padding:6px 10px 2px">Gain reduction</div><div class="gr"><i data-gr="${s.id}"></i></div>`;
    if (s.type === 'wam') h += `<div class="ps"><button class="tb" data-a="gui">Open plugin window</button></div>`;
    h += `<div class="ps">${def ? paramsHtml(def.params, s.params, s.id) : ''}</div></div>`;
  });
  const cats = {}; Object.entries(EFFECTS).forEach(([k, d]) => (cats[d.cat] ||= []).push([k, d.name]));
  h += `<div class="addfx"><label style="font-weight:700">Add effect</label><select id="fxAdd"><option value="">Choose…</option>${Object.entries(cats).map(([c, l]) => `<optgroup label="${c}">${l.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</optgroup>`).join('')}</select>
    <label style="font-size:12px;color:var(--mute)">Or a web plugin (WAM) URL</label><input id="wamUrl" placeholder="https://…/index.js"><button id="wamAdd">Load web plugin</button></div></div>`;
  box.innerHTML = h;
  $('#devSel').onchange = e => { const [k, id] = e.target.value.split(':'); UI.dev = { kind: k, id }; if (k === 'track') UI.track = id; renderHeads(); renderDevices(); };
  if ($('#instSel')) $('#instSel').onchange = async e => { snapshot(); o.inst = e.target.value; o.instParams = instDefaults(o.inst); await commit(true); };
  if ($('#smpFile')) $('#smpFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; const id = await E.addAudio(await f.arrayBuffer(), f.name); if (!id) return; P().audio[id] = { name: f.name.replace(/\.[^.]+$/, '') }; snapshot(); o.instParams.sample = id; await commit(true); };
  $('#fxAdd').onchange = async e => { const k = e.target.value; if (!k) return; snapshot(); o.inserts.push({ id: uid(), type: k, params: {}, bypass: false }); await commit(true); };
  $('#wamAdd').onclick = async () => { const u = $('#wamUrl').value.trim(); if (!/^https:\/\//.test(u)) return toast('Paste the https:// address of a WAM plugin'); snapshot(); o.inserts.push({ id: uid(), type: 'wam', url: u, params: {}, bypass: false }); await commit(true); toast('Loading web plugin…'); };
  box.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const id = b.closest('[data-slot]').dataset.slot, i = o.inserts.findIndex(s => s.id === id), a = b.dataset.a;
    if (a === 'gui') { const f = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === id); return openWamGui(f?.node?.wam); }
    snapshot();
    if (a === 'x') o.inserts.splice(i, 1); else if (a === 'byp') o.inserts[i].bypass = !o.inserts[i].bypass;
    else { const j = a === 'l' ? i - 1 : i + 1; [o.inserts[i], o.inserts[j]] = [o.inserts[j], o.inserts[i]]; }
    await commit(true);
  });
  box.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k, pid = inp.dataset.p;
    const pdef = k === 'inst' ? INSTRUMENTS[o.inst].params.find(p => p.id === pid) : EFFECTS[o.inserts.find(s => s.id === k)?.type]?.params.find(p => p.id === pid);
    const val = () => inp.type === 'checkbox' ? inp.checked : inp.tagName === 'SELECT' ? inp.value : fromPos(pdef, inp.value);
    const apply = () => { const v = val();
      if (k === 'inst') { if (pid === 'preset') { Object.assign(o.instParams, SYNTH_PRESETS[v], { preset: v }); Object.entries(o.instParams).forEach(([a, b]) => E.setInstParam(o.id, a, b)); renderDevices(); } else E.setInstParam(o.id, pid, v); }
      else E.setFxParam(UI.dev.kind, UI.dev.id, k, pid, v);
      if (inp.nextElementSibling?.tagName === 'OUTPUT') inp.nextElementSibling.textContent = fmt(pdef, v);
      drawEq(); };
    inp.addEventListener('pointerdown', () => snapshot(), { once: false });
    inp.addEventListener('input', apply); inp.addEventListener('change', () => { if (inp.tagName === 'SELECT' || inp.type === 'checkbox') snapshot(); apply(); persist(); if (k === 'inst' && pid === 'sample') commit(true); });
  });
  drawEq();
}
function drawEq() {
  document.querySelectorAll('canvas[data-eq]').forEach(cv => {
    const f = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === cv.dataset.eq)?.node; if (!f?.filters) return;
    const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; const g = cv.getContext('2d'); g.scale(devicePixelRatio, devicePixelRatio);
    const N = 200, fr = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N), tot = new Float32Array(N).fill(0);
    for (let i = 0; i < N; i++) fr[i] = 20 * Math.pow(1000, i / (N - 1));
    f.filters.forEach(b => { b.getFrequencyResponse(fr, mag, ph); for (let i = 0; i < N; i++) tot[i] += 20 * Math.log10(Math.max(1e-6, mag[i])); });
    g.strokeStyle = 'rgba(128,128,128,.35)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); [100, 1000, 10000].forEach(hz => { const x = Math.log(hz / 20) / Math.log(1000) * W; g.moveTo(x, 0); g.lineTo(x, H); }); g.stroke();
    g.strokeStyle = '#ff4f8b'; g.lineWidth = 2; g.beginPath(); for (let i = 0; i < N; i++) { const x = i / (N - 1) * W, y = H / 2 - Math.max(-24, Math.min(24, tot[i])) / 24 * (H / 2 - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  });
}
async function openWamGui(wam) {
  if (!wam) return toast('That plugin did not load');
  try { const gui = await wam.createGui(); const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:10% 10%;z-index:25;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:auto;padding:10px';
    const x = document.createElement('button'); x.textContent = 'Close'; x.className = 'tb'; x.onclick = () => { wam.destroyGui?.(gui); d.remove(); }; d.append(x, gui); document.body.append(d); }
  catch (e) { toast('This plugin has no window: ' + e.message); }
}

// ---------- mixer ----------
function chHtml(kind, o, name, color) {
  const sel = (UI.dev.kind === kind && (kind === 'master' || UI.dev.id === o.id)) ? 'sel' : '';
  const sends = kind === 'track' ? `<div class="snd">${P().returns.map(r => `<span>${r.id}</span><input type="range" min="0" max="1" step="0.01" value="${o.sends[r.id] || 0}" data-send="${r.id}" aria-label="Send ${r.name}">`).join('')}</div>` : '<div class="snd" style="min-height:34px"></div>';
  const pan = kind === 'track' ? `<input type="range" min="-1" max="1" step="0.01" value="${o.pan}" data-pan style="width:100%" aria-label="Pan" title="Pan">` : '<div style="height:20px"></div>';
  return `<div class="ch ${sel}" data-kind="${kind}" data-id="${o.id || ''}" style="--c:${color}"><div class="cname" title="${esc(name)}">${esc(name)}</div><div class="fx">${o.inserts.map(s => s.type === 'wam' ? 'Web' : EFFECTS[s.type]?.name.split(' ')[0]).join(' · ') || '—'}</div>${sends}${pan}
    <div class="fz"><input class="fader" type="range" min="-60" max="6" step="0.1" value="${o.vol}" aria-label="${esc(name)} volume"><canvas class="mtr" width="12" height="100"></canvas></div><div class="db">${o.vol <= -60 ? '−∞' : o.vol.toFixed(1)} dB</div>
    <div class="btns">${kind === 'track' ? `<button class="m ${o.mute ? 'on' : ''}" data-ms="mute">M</button><button class="s ${o.solo ? 'on' : ''}" data-ms="solo">S</button>` : ''}<button data-fx>FX</button></div></div>`;
}
function renderMixer() {
  $('#mixer').innerHTML = `<div class="mix">${P().tracks.map(t => chHtml('track', t, t.name, t.color)).join('')}${P().returns.map(r => chHtml('return', r, r.name, '#888')).join('')}${chHtml('master', P().master, 'Master', '#ff4f8b')}</div>`;
}
const mixOwner = ch => ch.dataset.kind === 'master' ? P().master : ch.dataset.kind === 'return' ? P().returns.find(r => r.id === ch.dataset.id) : trk(ch.dataset.id);
$('#mixer').addEventListener('input', e => {
  const ch = e.target.closest('.ch'); if (!ch) return; const o = mixOwner(ch);
  if (e.target.classList.contains('fader')) { o.vol = +e.target.value; ch.querySelector('.db').textContent = (o.vol <= -60 ? '−∞' : o.vol.toFixed(1)) + ' dB'; }
  else if (e.target.dataset.send) o.sends[e.target.dataset.send] = +e.target.value; else if ('pan' in e.target.dataset) o.pan = +e.target.value;
  E.applyMix();
});
$('#mixer').addEventListener('change', () => { persist(); renderHeads(); });
$('#mixer').addEventListener('pointerdown', e => { if (e.target.type === 'range') snapshot(); });
$('#mixer').addEventListener('click', async e => {
  const ch = e.target.closest('.ch'); if (!ch) return; const o = mixOwner(ch);
  if (e.target.dataset.ms) { snapshot(); o[e.target.dataset.ms] = !o[e.target.dataset.ms]; await commit(false); return; }
  UI.dev = { kind: ch.dataset.kind, id: ch.dataset.id }; if (ch.dataset.kind === 'track') UI.track = ch.dataset.id;
  if ('fx' in e.target.dataset) setTab('devices'); else { renderMixer(); renderHeads(); }
});

// ---------- plugins tab ----------
function renderPlugins() {
  $('#plugins').innerHTML = `<div class="doc">
  <h3>Built-in devices</h3><p>${Object.keys(EFFECTS).length} effects — ${Object.values(EFFECTS).map(e => e.name).join(', ')} — plus Rose Synth (${Object.keys(SYNTH_PRESETS).length} presets), Rose Drums and Rose Sampler. Add them from the <b>Devices</b> tab. Two return buses (reverb and delay) are fed by each track's A/B sends in the <b>Mixer</b>.</p>
  <h3>VST3 and AU plugins (Serum, FabFilter, Softube Flow, Google Flow Music, Valhalla…)</h3><p>Browsers can't run VST3 or AU plugins — no web DAW can. Use the <b>Rose desktop app</b> in this repo's <code>native/</code> folder: it scans and loads every VST3 and AU plugin on your Mac, including the plugins you use in FL Studio, Logic and Ableton. Stock devices that live inside those apps (FL's Fruity plugins, Logic's ChromaVerb, Ableton's devices) only run inside their own app.</p>
  <h3>SHRUB (Xfer's free Serum for the FM-1)</h3><p><b>Desktop app:</b> install the SHRUB VST3 from shrub.audio, then use <i>Scan plugins</i> in Rose — it loads like any instrument. <b>Browser:</b> add an <b>External MIDI</b> track (+ Track menu) and pick a MIDI output. To play the SHRUB browser editor, turn on the Mac's IAC Driver (Audio MIDI Setup → MIDI Studio → IAC Driver → Device is online), choose it here and as "MIDI in" in the SHRUB editor. An FM-1 running SHRUB shows up directly over USB. Use <b>Export .mid</b> on any MIDI clip to take parts anywhere.</p>
  <h3>Web plugins (WAM 2)</h3><p>The browser version can load Web Audio Modules — the web's plugin standard. Paste a plugin's <code>index.js</code> address in <b>Devices → Add effect</b>, or below to add it to the selected chain. Web plugins play live but are skipped in WAV export.</p>
  <div class="wamrow"><input id="wamUrl2" placeholder="https://…/index.js" aria-label="Web plugin URL"><button id="wamAdd2">Add to ${esc(devOwner()?.name || 'Master')}</button></div>
  <h3>MIDI keyboards</h3><p>${navigator.requestMIDIAccess ? (UI.midiNames?.length ? 'Connected: ' + esc(UI.midiNames.join(', ')) + '. ' : 'No MIDI device found yet — plug one in and it appears automatically. ') + 'Notes play the selected instrument track; arm it (●) and press record to capture them.' : 'This browser has no Web MIDI — use Chrome or Edge for MIDI keyboards.'}</p></div>`;
  $('#wamAdd2').onclick = async () => { const u = $('#wamUrl2').value.trim(); if (!/^https:\/\//.test(u)) return toast('Paste the https:// address of a WAM plugin'); snapshot(); (devOwner() || P().master).inserts.push({ id: uid(), type: 'wam', url: u, params: {}, bypass: false }); await commit(true); setTab('devices'); };
}

// ---------- MIDI file export (SMF type 0, 480 ticks per beat) ----------
function midiFile(clip, bpm) {
  const TPB = 480, ev = [];
  clip.notes.filter(n => n.s < clip.len).forEach(n => { const on = Math.round(n.s * TPB), off = Math.round(Math.min(n.s + n.l, clip.len) * TPB); ev.push([on, 1, [0x90, n.p, Math.max(1, Math.round(n.v * 127))]], [off, 0, [0x80, n.p, 0]]); });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const vlq = v => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
  const us = Math.round(60e6 / bpm), trk = [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255]; let t = 0;
  for (const [at, , m] of ev) { trk.push(...vlq(at - t), ...m); t = at; }
  trk.push(0, 0xff, 0x2f, 0);
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (TPB >> 8) & 255, TPB & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk])], { type: 'audio/midi' });
}

// ---------- clip ops ----------
async function deleteClip() { const fc = UI.clip && findClip(UI.clip); if (!fc) return; snapshot(); fc.t.clips = fc.t.clips.filter(c => c !== fc.c); UI.clip = null; await commit(false); }
async function duplicateClip() { const fc = UI.clip && findClip(UI.clip); if (!fc) return; snapshot(); const c = JSON.parse(JSON.stringify(fc.c)); c.id = uid(); c.start = fc.c.start + fc.c.len; fc.t.clips.push(c); UI.clip = c.id; await commit(false); }
async function splitClip() {
  const fc = UI.clip && findClip(UI.clip), b = snapB(E.position()); if (!fc || b <= fc.c.start || b >= fc.c.start + fc.c.len) return toast('Put the playhead inside the selected clip to split it');
  snapshot(); const c = fc.c, cut = b - c.start, d = JSON.parse(JSON.stringify(c)); d.id = uid(); d.start = b; d.len = c.len - cut; c.len = cut;
  if (c.notes) { d.notes = c.notes.filter(n => n.s >= cut).map(n => ({ ...n, s: n.s - cut })); c.notes = c.notes.filter(n => n.s < cut); } else d.offset = (c.offset || 0) + cut * E.spb;
  fc.t.clips.push(d); await commit(false);
}

// ---------- keyboard ----------
const KEYMAP = 'awsedftgyhujkolp;'; const held = new Set();
addEventListener('keydown', e => {
  if (!E.ctx || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && !(document.activeElement.type === 'range' || document.activeElement.type === 'checkbox')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateClip(); return; }
  if (mod && k === 's') { e.preventDefault(); $('#bSave').click(); return; }
  if (mod && k === 'e') { e.preventDefault(); splitClip(); return; }
  if (mod) return;
  if (e.code === 'Space') { e.preventDefault(); E.playing ? E.stop(true) : E.play(); return; }
  if (e.key === 'Enter') { E.stop(); return; }
  if (e.key === 'Home') { E.seek(0); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteClip(); return; }
  const i = KEYMAP.indexOf(k);
  if (i >= 0 && !e.repeat) { const t = trk(UI.track); if (t?.kind !== 'inst') return; const p = 12 * (UI.oct + 1) + i; held.add(k); E.liveOn(t.id, p, 0.8); return; }
  if (k === 'z') { UI.oct = Math.max(0, UI.oct - 1); toast('Octave ' + UI.oct); } else if (k === 'x') { UI.oct = Math.min(8, UI.oct + 1); toast('Octave ' + UI.oct); }
  else if (k === 'r') E.record(); else if (k === 'm') $('#bMet').click();
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(), i = KEYMAP.indexOf(k); if (i >= 0 && held.has(k)) { held.delete(k); E.liveOff(UI.track, 12 * (UI.oct + 1) + i); } });

// ---------- MIDI ----------
async function initMIDI() {
  if (!navigator.requestMIDIAccess) return;
  try {
    const acc = await navigator.requestMIDIAccess();
    const hook = () => { UI.midiNames = []; UI.midiOuts = []; E.midiOutputs = new Map(); acc.outputs.forEach(o => { UI.midiOuts.push(o.name); E.midiOutputs.set(o.name, o); }); acc.inputs.forEach(inp => { UI.midiNames.push(inp.name); inp.onmidimessage = m => { const [st, p, v] = m.data, c = st & 0xf0; const t = trk(UI.track); if (!t || t.kind !== 'inst') return; if (c === 0x90 && v > 0) E.liveOn(t.id, p, v / 127); else if (c === 0x80 || (c === 0x90 && v === 0)) E.liveOff(t.id, p); }; }); };
    hook(); acc.onstatechange = () => { hook(); if (UI.tab === 'plugins') renderPlugins(); if (UI.tab === 'devices') renderDevices(); };
  } catch { }
}

// ---------- animation: playhead, clock, meters ----------
const tbuf = new Float32Array(1024);
const peak = an => { an.getFloatTimeDomainData(tbuf); let m = 0; for (let i = 0; i < tbuf.length; i++) m = Math.max(m, Math.abs(tbuf[i])); return m; };
function meterDraw(cv, v) { const g = cv.getContext('2d'), W = cv.width, H = cv.height, dbv = 20 * Math.log10(v + 1e-9), f = Math.max(0, Math.min(1, (dbv + 60) / 66));
  g.clearRect(0, 0, W, H); g.fillStyle = dbv > -1 ? '#ef4444' : dbv > -9 ? '#f59e0b' : '#22c55e';
  if (W > H) g.fillRect(0, 0, W * f, H); else g.fillRect(0, H * (1 - f), W, H * f); }
function frame() {
  const b = E.position(), spb = E.spb, sig = P().sig;
  $('#playhead').style.transform = `translateX(${b * UI.ppb}px)`;
  const bar = Math.floor(b / sig) + 1, beat = Math.floor(b % sig) + 1, six = Math.floor((b % 1) * 4) + 1, secs = b * spb;
  $('#pos').textContent = `${bar}.${beat}.${six}`; $('#clock').textContent = `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`;
  if (E.g) {
    meterDraw($('#mmeter'), peak(E.g.analyser));
    if (UI.tab === 'mixer') document.querySelectorAll('#mixer .ch').forEach(ch => { const s = E.stripFor(ch.dataset.kind, ch.dataset.id); if (s) meterDraw(ch.querySelector('.mtr'), peak(s.meter)); });
    if (UI.tab === 'devices') document.querySelectorAll('[data-gr]').forEach(el => { const f = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === el.dataset.gr)?.node; if (f?.meter) el.style.width = Math.min(100, -f.meter() * 5) + '%'; });
  }
  if (E.playing) {
    const w = $('#lanesWrap'), x = b * UI.ppb; if (x > w.scrollLeft + w.clientWidth - 40 || x < w.scrollLeft) w.scrollLeft = Math.max(0, x - 80);
    const fc = UI.tab === 'editor' && UI.clip && findClip(UI.clip);
    if (fc && fc.c.notes && fc.t.inst === 'drums') { const i = Math.floor((b - fc.c.start) * 4); document.querySelectorAll('#seq .st').forEach(s => s.classList.toggle('now', +s.dataset.i === i)); }
  }
  requestAnimationFrame(frame);
}
addEventListener('resize', () => { if (E.ctx) { renderLanes(); renderRuler(); } });
paintTransport();
