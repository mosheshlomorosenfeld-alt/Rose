// Rose — UI: arrangement, track headers, piano roll, step sequencer, device rack, mixer, plugins, keyboard & MIDI.
import { Engine, newTrack, newProject, blankProject, uid, db, isMidi, upgrade, autoRange, SCENES, encodeWav } from './engine.js';
import { EFFECTS } from './effects.js';
import { INSTRUMENTS, SYNTH_PRESETS, DRUM_ROWS, instDefaults, ARP_PARAMS, CHORD_PARAMS, midiDefaults, applyMidiFx, chordOf } from './instruments.js';

const E = new Engine(); window.roseEngine = E;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI = { track: null, clip: null, ppb: 44, snap: 0.25, tab: 'editor', dev: { kind: 'track', id: null }, oct: 4, hist: [], fut: [], prGrid: 0.25, prZoom: 1, peaks: new Map(), confirmNew: 0 };
const LANE = 68, NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nname = p => NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);
const probe = document.createElement('i'); probe.style.display = 'none'; document.documentElement.append(probe);
const cssColor = v => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };   // resolves light-dark() for canvas drawing
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); };
E.on((type, d) => { if (type === 'error') toast(d); if (type === 'transport') paintTransport(); if (type === 'recorded') { commit(true); } });

// ---------- project helpers ----------
const P = () => E.p;
const trk = id => P().tracks.find(t => t.id === id);
const findClip = id => { if (!id) return null; for (const t of P().tracks) { const c = t.clips.find(c => c.id === id); if (c) return { t, c }; const sl = P().session?.slots?.[t.id]; const i = sl ? sl.findIndex(c => c && c.id === id) : -1; if (i >= 0) return { t, c: sl[i], slot: i }; } return null; };
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
    E.p = upgrade(p); const keys = await idbDo('readonly', st => st.getAllKeys()) || [];
    for (const id of keys) { const ab = await idbDo('readonly', st => st.get(id)); if (!ab) continue; try { E.buffers.set(id, await E.ctx.decodeAudioData(ab.slice(0))); E.raw.set(id, ab); (persist.saved ||= new Set()).add(id); } catch { } }
  }
  E.p.audio ||= {};
}

// ---------- startup ----------
let saved = null; try { saved = JSON.parse(localStorage.getItem('rose:project') || 'null'); } catch { }
if (saved?.tracks) { $('#startLabel').textContent = 'Continue your song'; $('#startSub').textContent = saved.name || 'Pick up where you left off'; }
async function boot(mode) {
  await E.start(); await restore();
  if (mode === 'blank') { E.p = blankProject(); E.p.audio = {}; } else if (mode === 'demo' && !saved?.tracks) { E.p = newProject(); E.p.audio = {}; }
  await E.rebuild(); UI.track = P().tracks[0]?.id; UI.dev = { kind: 'track', id: UI.track };
  $('#startScreen').remove(); try { UI.lib = localStorage.getItem('rose:lib') !== '0'; } catch { UI.lib = true; }
  $('#lib').hidden = !UI.lib; renderLib(); render(); initMIDI(); requestAnimationFrame(frame); persist();
  if (mode === 'open') $('#fOpen').click();
  let helped = false; try { helped = !!localStorage.getItem('rose:helped'); localStorage.setItem('rose:helped', '1'); } catch { }
  if (!helped) toast('New here? Press ? for a 1-minute guide');
}
$('#bStart').onclick = () => boot('demo');
$('#bBlank').onclick = () => boot('blank');
$('#bOpenStart').onclick = () => boot('open');

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
  $('#bPlay').classList.toggle('on', E.playing); $('#bPlay').innerHTML = `<svg><use href="#i-${E.playing ? 'pause' : 'play'}"/></svg>`;
  $('#bRec').classList.toggle('on', E.recording); $('#bLoop').classList.toggle('on', P().loop.on); $('#bMet').classList.toggle('on', P().metronome);
  $('#bpm').value = P().bpm; $('#songName').value = P().name;
}

// add tracks, import, save/open/new/export
// ---------- menus: add track, file, library, theme, help ----------
function popover(btn, pop) {
  const open = () => { const r = btn.getBoundingClientRect(); pop.hidden = false; pop.style.top = r.bottom + 6 + 'px'; pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + 'px'; pop.querySelector('button')?.focus(); };
  btn.onclick = e => { e.stopPropagation(); pop.hidden ? (closePops(), open()) : closePops(); };
  pop.addEventListener('click', () => setTimeout(closePops, 0));
}
function closePops() { document.querySelectorAll('.pop:not(#ctxPop)').forEach(p => p.hidden = true); }
addEventListener('click', e => { if (!e.target.closest('.pop')) closePops(); });
popover($('#bAdd'), $('#addPop')); popover($('#bFile'), $('#filePop'));
$('#addPop').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) addTrackOf(b.dataset.add); });
$('#bOpenBtn').onclick = () => $('#fOpen').click(); $('#bImportBtn').onclick = () => $('#fImport').click();
$('#skin').value = document.documentElement.dataset.skin || '';
$('#skin').onchange = e => { const v = e.target.value; if (v) document.documentElement.dataset.skin = v; else delete document.documentElement.dataset.skin; try { localStorage.setItem('rose:skin', v); } catch { } if (E.ctx) render(); };
$('#bLib').onclick = () => { UI.lib = !UI.lib; $('#lib').hidden = !UI.lib; try { localStorage.setItem('rose:lib', UI.lib ? '1' : '0'); } catch { } renderLanes(); };
$('#bHelp').onclick = () => showHelp();
async function addTrackOf(v, opts = {}) {
  snapshot();
  const n = P().tracks.filter(t => (t.inst || t.kind) === (v === 'audio' ? 'audio' : v)).length + 1;
  const t = newTrack(v === 'audio' ? 'audio' : v === 'group' ? 'group' : 'inst', v === 'audio' || v === 'group' ? null : v, n); if (opts.preset) { Object.assign(t.instParams, SYNTH_PRESETS[opts.preset], { preset: opts.preset }); t.name = opts.preset; }
  if (v === 'drums') t.clips.push({ id: uid(), name: 'Beat', start: Math.floor((P().cursor || 0) / P().sig) * P().sig, len: 4, notes: [] });
  P().tracks.push(t); UI.track = t.id; UI.dev = { kind: 'track', id: t.id }; UI.clip = t.clips[0]?.id || null; await commit(true);
  toast(v === 'group' ? 'Group bus added — in the Mixer, set other tracks’ Out to it' : v === 'audio' ? 'Audio track added — arm ● and press Record, or drop a file on it' : v === 'drums' ? 'Drum track added — click the steps below to make a beat' : 'Track added — double-click its lane to draw notes');
  return t;
}
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
  $('#hlist').innerHTML = P().tracks.map(t => {
    const grp = t.kind === 'group', members = grp ? P().tracks.filter(x => x.out === t.id).length : 0;
    const kind = grp ? `Group bus · ${members} track${members === 1 ? '' : 's'}` : t.kind === 'audio' ? 'Audio' : esc(INSTRUMENTS[t.inst]?.name);
    const outTo = !grp && t.out !== 'master' ? ' → ' + esc(trk(t.out)?.name || '') : '';
    const autoSel = t.autoShow ? `<select class="autosel" aria-label="Automation parameter">${autoTargets(t).map(([v, l]) => `<option value="${v}" ${v === t.autoShow ? 'selected' : ''}>${esc(l)}${t.auto.some(a => a.target === v && a.points.length) ? ' •' : ''}</option>`).join('')}</select>` : '';
    return `<div class="th ${t.id === UI.track ? 'sel' : ''}" data-id="${t.id}" style="--c:${t.color}">
    <div class="cs"></div><div class="body">
      <div class="row"><input class="name" value="${esc(t.name)}" aria-label="Track name"><button class="sm" data-act="menu" title="Track options" aria-label="Track options">⋯</button></div>
      <div class="row"><button class="sm m ${t.mute ? 'on' : ''}" data-act="mute" title="Mute">M</button><button class="sm s ${t.solo ? 'on' : ''}" data-act="solo" title="Solo">S</button>${grp ? '' : `<button class="sm a ${t.arm ? 'on' : ''}" data-act="arm" title="Arm for recording">●</button>`}<button class="sm au ${t.autoShow ? 'on' : ''} ${t.auto?.some(a => a.points.length) ? 'has' : ''}" data-act="auto" title="Show automation (draw volume, pan and effect changes over time)">A</button>
      <input class="vol" type="range" min="-60" max="6" step="0.5" value="${t.vol}" aria-label="Volume" title="${t.vol} dB"></div>
      ${autoSel || `<div class="kind">${kind}${t.inserts.length ? ' · ' + t.inserts.length + ' fx' : ''}${outTo}</div>`}</div></div>`;
  }).join('');
}
function autoTargets(t) {
  const list = [['vol', 'Volume'], ['pan', 'Pan'], ...P().returns.map(r => ['send:' + r.id, 'Send ' + r.id + ' (' + r.name + ')'])];
  for (const s of t.inserts) { const d = EFFECTS[s.type]; if (!d) continue; for (const p of d.params) if (p.type === 'range') list.push([`fx:${s.id}:${p.id}`, `${d.name}: ${p.label}`]); }
  return list;
}
$('#hlist').addEventListener('click', async e => {
  const h = e.target.closest('.th'); if (!h) return; const t = trk(h.dataset.id), act = e.target.dataset.act;
  if (act === 'menu') { trackMenu(t, e.target); return; }
  if (act === 'auto') { t.autoShow = t.autoShow ? null : (t.auto.find(a => a.points.length)?.target || 'vol'); persist(); renderHeads(); renderLanes(); return; }
  if (act) { snapshot(); t[act] = !t[act]; if (act === 'arm' && t.arm && t.kind === 'audio') P().tracks.forEach(x => { if (x !== t && x.kind === 'audio') x.arm = false; }); await commit(false); return; }
  if (!/INPUT|SELECT/.test(e.target.tagName)) { UI.track = t.id; UI.dev = { kind: 'track', id: t.id }; renderHeads(); renderDock(); }
});
$('#hlist').addEventListener('input', e => { const h = e.target.closest('.th'); if (!h || !e.target.classList.contains('vol')) return; trk(h.dataset.id).vol = +e.target.value; E.applyMix(); });
$('#hlist').addEventListener('change', e => {
  const h = e.target.closest('.th'); if (!h) return; const t = trk(h.dataset.id);
  if (e.target.classList.contains('name')) { snapshot(); t.name = e.target.value; }
  if (e.target.classList.contains('autosel')) { t.autoShow = e.target.value; renderLanes(); }
  persist(); renderDock();
});
$('#lanesWrap').addEventListener('scroll', () => { $('#hlist').scrollTop = $('#lanesWrap').scrollTop; });

// ---------- track menu ----------
function menuAt(anchor, items) {
  closePops(); $('#ctxPop')?.remove(); const m = document.createElement('div'); m.className = 'pop'; m.id = 'ctxPop';
  m.innerHTML = items.map((it, i) => `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}><span class="ic">${it.icon || ''}</span><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('');
  document.body.append(m); const r = anchor.getBoundingClientRect(); m.style.top = Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4) + 'px'; m.style.left = Math.min(innerWidth - m.offsetWidth - 8, r.left) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-i]'); if (b) { m.remove(); items[+b.dataset.i].run(); } }; m.querySelector('button')?.focus();
  setTimeout(() => addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); removeEventListener('click', off); } }), 0);
}
function trackMenu(t, anchor) {
  const i = P().tracks.indexOf(t);
  menuAt(anchor, [
    { icon: '⇩', label: 'Bounce to audio', sub: 'Render this track with its effects to a new audio track', run: () => bounceInPlace(t) },
    { icon: '⧉', label: 'Duplicate track', sub: 'Copy clips, sound and effects', run: () => duplicateTrack(t) },
    { icon: '●', label: 'Change colour', run: async () => { snapshot(); const C = ['#ff4f8b', '#ffb020', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6', '#f43f5e', '#eab308', '#06b6d4', '#f97316']; t.color = C[(C.indexOf(t.color) + 1) % C.length]; await commit(false); } },
    { icon: '↑', label: 'Move up', disabled: i === 0, run: async () => { snapshot(); [P().tracks[i - 1], P().tracks[i]] = [P().tracks[i], P().tracks[i - 1]]; await commit(false); } },
    { icon: '↓', label: 'Move down', disabled: i === P().tracks.length - 1, run: async () => { snapshot(); [P().tracks[i + 1], P().tracks[i]] = [P().tracks[i], P().tracks[i + 1]]; await commit(false); } },
    { icon: '×', label: 'Delete track', sub: 'You can undo', run: async () => { snapshot(); P().tracks = P().tracks.filter(x => x !== t); P().tracks.forEach(x => { if (x.out === t.id) x.out = 'master'; }); if (UI.track === t.id) UI.track = P().tracks[0]?.id; await commit(true); } }
  ]);
}
async function duplicateTrack(t) {
  snapshot(); const c = JSON.parse(JSON.stringify(t)); c.id = uid(); c.name = t.name + ' copy'; c.arm = false; c.solo = false;
  const map = {}; c.inserts.forEach(s => { const n = uid(); map[s.id] = n; s.id = n; }); c.clips.forEach(x => x.id = uid());
  c.auto = (c.auto || []).map(a => ({ ...a, id: uid(), target: a.target.replace(/^fx:([^:]+)/, (m, id) => 'fx:' + (map[id] || id)) }));
  if (c.autoShow) c.autoShow = c.autoShow.replace(/^fx:([^:]+)/, (m, id) => 'fx:' + (map[id] || id));
  P().tracks.splice(P().tracks.indexOf(t) + 1, 0, c); UI.track = c.id; await commit(true); toast('Track duplicated');
}
async function bounceInPlace(t) {
  if (t.kind === 'audio' && !t.inserts.length && !t.auto.length) return toast('This audio track has no effects to print — nothing to bounce');
  toast('Bouncing ' + t.name + '…'); E.stop(true);
  try {
    const r = await E.bounceTrack(t.id); if (!r) return toast('Bounce failed');
    snapshot(); P().audio[r.id] = { name: t.name + ' (bounced)' };
    const a = newTrack('audio', null, 1); a.name = t.name + ' (audio)'; a.color = t.color; a.vol = t.vol; a.pan = t.pan; a.sends = { ...t.sends }; a.out = t.kind === 'group' ? 'master' : t.out;
    a.clips.push({ id: uid(), name: t.name, start: 0, len: r.buf.duration / E.spb, sample: r.id, offset: 0, gain: 0 });
    t.mute = true; P().tracks.splice(P().tracks.indexOf(t) + 1, 0, a); UI.track = a.id; await commit(true); toast(`Bounced — ${t.name} is muted, the new audio track plays instead`);
  } catch (e) { toast('Bounce failed: ' + e.message); }
}

// ---------- arrangement / session switch ----------
UI.view = 'arrange';
function setView(v) {
  UI.view = v; $('#vArr').classList.toggle('on', v === 'arrange'); $('#vSes').classList.toggle('on', v === 'session');
  document.body.classList.toggle('session', v === 'session'); renderRuler(); renderLanes();
}
$('#vArr').onclick = () => setView('arrange'); $('#vSes').onclick = () => setView('session');

function renderRuler() {
  const r = $('#ruler');
  if (UI.view === 'session') {
    r.style.width = 'auto';
    r.innerHTML = `<div class="scn"><button class="sstop" id="stopAll" title="Stop all clips">■</button>${[...Array(SCENES)].map((_, i) => `<button class="sbtn" data-scene="${i}" title="Launch every clip in scene ${i + 1}"><svg width="12" height="12"><use href="#i-play"/></svg> Scene ${i + 1}</button>`).join('')}</div>`;
    return;
  }
  const n = beatsShown(), sig = P().sig, lp = P().loop; let h = '';
  for (let b = 0; b < n; b += sig) h += `<div class="bar" style="left:${b * UI.ppb}px">${b / sig + 1}</div>`;
  h += `<div class="loopr ${lp.on ? '' : 'off'}" style="left:${lp.start * UI.ppb}px;width:${(lp.end - lp.start) * UI.ppb}px" title="Loop — drag here to set, click Loop to toggle"></div>`;
  r.style.width = n * UI.ppb + 'px'; r.innerHTML = h;
}
$('#ruler').addEventListener('click', e => {
  if (UI.view !== 'session') return;
  const s = e.target.closest('[data-scene]'); if (s) E.launchScene(+s.dataset.scene);
  if (e.target.closest('#stopAll')) E.stopAllClips();
});
$('#ruler').addEventListener('pointerdown', e => {
  if (UI.view === 'session') return;
  const r = $('#ruler').getBoundingClientRect(), x0 = e.clientX - r.left, b0 = snapB(x0 / UI.ppb);
  if (e.clientY - r.top > 28) { E.seek(Math.max(0, x0 / UI.ppb)); return; }
  const lp = P().loop; const move = ev => { const b = snapB((ev.clientX - r.left) / UI.ppb); lp.start = Math.max(0, Math.min(b0, b)); lp.end = Math.max(b0, b, lp.start + (UI.snap || 0.25)); lp.on = true; renderRuler(); paintTransport(); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); persist(); renderLanes(); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});

const clipName = c => c.pattern ? '⧉ ' + (P().patterns[c.pattern]?.name || c.name) : (c.name || (isMidi(c) ? 'MIDI' : audioName(c.sample)));
function renderLanes() {
  if (UI.view === 'session') return renderSession();
  const n = beatsShown(), w = n * UI.ppb, lp = P().loop, sl = ($('#lanesWrap').scrollLeft || 0) + 14;
  $('#lanes').style.width = w + 'px';
  $('#lanes').innerHTML = (lp.on ? `<div class="loopshade" style="left:${lp.start * UI.ppb}px;width:${(lp.end - lp.start) * UI.ppb}px"></div>` : '') +
    P().tracks.map(t => {
      const hint = t.kind === 'group' ? 'Group bus — in the Mixer, set other tracks’ Out to this group' : t.clips.length ? '' : t.kind === 'audio' ? 'Drop an audio file here, or arm ● and press Record' : 'Double-click here to draw notes · or arm ● and record from your keyboard';
      return `<div class="lane ${t.autoShow ? 'autoon' : ''}" data-id="${t.id}" style="--c:${t.color};background-image:repeating-linear-gradient(90deg,var(--grid) 0 1px,transparent 1px ${UI.ppb}px),repeating-linear-gradient(90deg,var(--line) 0 1px,transparent 1px ${UI.ppb * P().sig}px)">${hint && !t.autoShow ? `<span class="lanehint" style="left:${sl}px">${hint}</span>` : ''}${t.clips.map(c =>
      `<div class="clip ${c.id === UI.clip ? 'sel' : ''} ${c.pattern ? 'pat' : ''}" data-clip="${c.id}" style="left:${c.start * UI.ppb}px;width:${Math.max(6, c.len * UI.ppb)}px"><span class="cn">${esc(clipName(c))}</span><canvas></canvas><div class="rs"></div></div>`).join('')}${t.autoShow ? autoSvg(t, w) : ''}</div>`;
    }).join('');
  $('#lanes').querySelectorAll('.clip').forEach(el => drawClip(el, findClip(el.dataset.clip)));
  $('#playhead').style.height = Math.max($('#lanesWrap').clientHeight, 56 + P().tracks.length * LANE) + 'px';
}
// ---------- automation lane ----------
const AH = LANE - 2;
function aNorm(rg, v) { return rg.log ? Math.log(v / rg.min) / Math.log(rg.max / rg.min) : (v - rg.min) / (rg.max - rg.min); }
function aDenorm(rg, f) { f = Math.max(0, Math.min(1, f)); const v = rg.log ? rg.min * Math.pow(rg.max / rg.min, f) : rg.min + f * (rg.max - rg.min); return +v.toFixed(3); }
function autoSvg(t, w) {
  const rg = autoRange(t, t.autoShow); if (!rg) return '';
  const lane = t.auto.find(a => a.target === t.autoShow), y = v => 6 + (1 - aNorm(rg, v)) * (AH - 12);
  const pts = lane?.points || []; const cur = t.autoShow === 'vol' ? t.vol : t.autoShow === 'pan' ? t.pan : null;
  const path = pts.length ? `M0 ${y(pts[0].v)} ` + pts.map(p => `L${p.b * UI.ppb} ${y(p.v)}`).join(' ') + ` L${w} ${y(pts[pts.length - 1].v)}` : (cur != null ? `M0 ${y(cur)} L${w} ${y(cur)}` : '');
  return `<svg class="auto" data-id="${t.id}" width="${w}" height="${AH}" aria-label="${esc(rg.label)} automation"><text x="${($('#lanesWrap').scrollLeft || 0) + 8}" y="14">${esc(rg.label)} — click to add a point, drag to move, double-click to remove</text><path d="${path}" class="${pts.length ? '' : 'flat'}"/>${pts.map((p, i) => `<circle cx="${p.b * UI.ppb}" cy="${y(p.v)}" r="5" data-pt="${i}"><title>${fmtAuto(rg, p.v)} at beat ${(p.b + 1).toFixed(2)}</title></circle>`).join('')}</svg>`;
}
const fmtAuto = (rg, v) => rg.unit === 'Hz' ? Math.round(v) + ' Hz' : rg.unit === 'dB' ? v.toFixed(1) + ' dB' : rg.label === 'Pan' ? (v === 0 ? 'C' : v < 0 ? Math.round(-v * 100) + 'L' : Math.round(v * 100) + 'R') : (+v).toFixed(2) + (rg.unit ? ' ' + rg.unit : '');
function autoPointer(e, svg) {
  const t = trk(svg.dataset.id), rg = autoRange(t, t.autoShow); if (!rg) return;
  let lane = t.auto.find(a => a.target === t.autoShow); const r = svg.getBoundingClientRect();
  const at = ev => ({ b: Math.max(0, snapB((ev.clientX - r.left) / UI.ppb)), v: aDenorm(rg, 1 - ((ev.clientY - r.top) - 6) / (AH - 12)) });
  snapshot();
  if (!lane) { lane = { id: uid(), target: t.autoShow, points: [] }; t.auto.push(lane); }
  let pt = e.target.dataset.pt != null ? lane.points[+e.target.dataset.pt] : null;
  if (!pt) { pt = at(e); lane.points.push(pt); lane.points.sort((a, b) => a.b - b.b); }
  svg.setPointerCapture(e.pointerId);
  const mv = ev => { Object.assign(pt, at(ev)); lane.points.sort((a, b) => a.b - b.b); renderLanes(); toastQuiet(`${rg.label}: ${fmtAuto(rg, pt.v)}`); };
  const up = () => { svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up); renderLanes(); renderHeads(); persist(); };
  svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up); renderLanes();
}
function toastQuiet(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 900); }
function autoDelete(e, svg) {
  const t = trk(svg.dataset.id), lane = t.auto.find(a => a.target === t.autoShow), i = e.target.dataset.pt; if (!lane || i == null) return;
  snapshot(); lane.points.splice(+i, 1); if (!lane.points.length) t.auto = t.auto.filter(a => a !== lane); renderLanes(); renderHeads(); persist();
}
// ---------- session view (clip launcher) ----------
function renderSession() {
  $('#lanes').style.width = 'auto';
  $('#lanes').innerHTML = P().tracks.map(t => {
    if (t.kind === 'group') return `<div class="srow grp" data-id="${t.id}" style="--c:${t.color}"><span class="lanehint" style="left:14px">Group bus</span></div>`;
    const slots = E.slots(t.id), live = E.live[t.id], q = E.queued[t.id];
    return `<div class="srow" data-id="${t.id}" style="--c:${t.color}"><button class="sstop" data-stop="${t.id}" title="Stop this track">■</button>${slots.map((c, i) => c
      ? `<div class="slot full ${live?.slot === i && live.clip === c ? 'live' : ''} ${q?.slot === i ? 'queued' : ''} ${c.id === UI.clip ? 'sel' : ''}" data-slot="${i}" data-clip="${c.id}"><button class="go" data-launch="${i}" aria-label="Launch ${esc(clipName(c))}"><svg width="12" height="12"><use href="#i-play"/></svg></button><span>${esc(clipName(c))}</span><i class="prog"></i></div>`
      : `<div class="slot ${q?.slot === -1 && i === 0 ? '' : ''}" data-slot="${i}" title="${t.kind === 'audio' ? 'Drop an audio file here' : 'Double-click to make a clip'}"></div>`).join('')}</div>`;
  }).join('');
  $('#playhead').style.height = '0px';
}
E.on(type => { if (type === 'session' && UI.view === 'session') renderSession(); });
$('#lanes').addEventListener('click', async e => {
  if (UI.view !== 'session') return;
  const row = e.target.closest('.srow'); if (!row) return; const t = trk(row.dataset.id);
  if (e.target.closest('[data-stop]')) { E.stopTrack(t.id); return; }
  const go = e.target.closest('[data-launch]'); if (go) { E.launch(t.id, +go.dataset.launch); return; }
  const slot = e.target.closest('.slot'); UI.track = t.id; UI.dev = { kind: 'track', id: t.id };
  UI.clip = slot?.dataset.clip || null; document.querySelectorAll('#lanes .slot').forEach(x => x.classList.toggle('sel', !!UI.clip && x.dataset.clip === UI.clip)); renderHeads(); if (UI.clip) setTab('editor'); else renderDock();
});
$('#lanes').addEventListener('dblclick', async e => {
  if (UI.view !== 'session') return;
  const row = e.target.closest('.srow'), slot = e.target.closest('.slot:not(.full)'); if (!row || !slot) return; const t = trk(row.dataset.id);
  if (t.kind !== 'inst') return toast('Drop an audio file on this slot');
  snapshot(); const c = { id: uid(), name: t.name + ' ' + (+slot.dataset.slot + 1), start: 0, len: P().sig, notes: [] }; E.slots(t.id)[+slot.dataset.slot] = c;
  UI.clip = c.id; UI.track = t.id; await commit(false); setTab('editor');
});

$('#lanes').addEventListener('pointerdown', e => {
  if (UI.view === 'session') return;
  const svg = e.target.closest('svg.auto'); if (svg) { if (e.detail < 2) autoPointer(e, svg); return; }
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
      if (dest && dest !== src && dest.kind !== 'group' && (dest.kind === 'audio') === !isMidi(fc.c)) { src.clips = src.clips.filter(c => c !== fc.c); dest.clips.push(fc.c); src = dest; fc.t = dest; UI.track = dest.id; }
    }
    renderLanes();
  };
  const up = async () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (moved) await commit(false); else { markSel(); renderHeads(); renderDock(); } };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
});
$('#lanes').addEventListener('dblclick', async e => {
  if (UI.view === 'session') return;
  const svg = e.target.closest('svg.auto'); if (svg) { autoDelete(e, svg); return; }
  const el = e.target.closest('.clip'), lane = e.target.closest('.lane'); if (!lane) return;
  if (el) { setTab('editor'); return; }
  const t = trk(lane.dataset.id); if (t.kind === 'group') return; if (t.kind !== 'inst') return toast('Drop audio files here, or record into this track');
  const r = lane.getBoundingClientRect(), b = Math.floor((e.clientX - r.left) / UI.ppb / P().sig) * P().sig; snapshot();
  const c = { id: uid(), name: t.name, start: b, len: P().sig, notes: [] }; t.clips.push(c); UI.clip = c.id; UI.track = t.id; await commit(false); setTab('editor');
});
['dragover', 'drop'].forEach(ev => $('#lanesWrap').addEventListener(ev, async e => {
  e.preventDefault(); if (ev === 'dragover') return; const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  if (UI.view === 'session') {
    const row = e.target.closest('.srow'), slot = e.target.closest('.slot'), t = row && trk(row.dataset.id); if (!t || !slot || t.kind !== 'audio') return toast('Drop audio onto an audio track slot');
    const f = files[0], id = await E.addAudio(await f.arrayBuffer(), f.name); if (!id) return; snapshot(); P().audio[id] = { name: f.name.replace(/\.[^.]+$/, '') };
    E.slots(t.id)[+slot.dataset.slot] = { id: uid(), name: P().audio[id].name, start: 0, len: Math.max(1, Math.round(E.buffers.get(id).duration / E.spb)), sample: id, offset: 0, gain: 0 };
    await commit(false); return;
  }
  const r = $('#lanes').getBoundingClientRect(), lane = P().tracks[Math.floor((e.clientY - r.top) / LANE)];
  await importFiles(files, lane?.id, Math.max(0, (e.clientX - r.left) / UI.ppb));
}));

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
  if (isMidi(c)) {
    const notes = E.notesOf(c), L = Math.max(0.0625, E.loopLen(c)); if (!notes.length) return; const ps = notes.map(n => n.p), lo = Math.min(...ps) - 1, hi = Math.max(...ps) + 1, rh = Math.max(2, Math.min(6, H / (hi - lo + 1)));
    for (let base = 0; base < c.len; base += L) { if (base > 0) { g.globalAlpha = 0.35; g.fillRect(base / c.len * W, 0, 1, H); } g.globalAlpha = base > 0 ? 0.75 : 1;
      for (const n of notes) if (n.s < L && base + n.s < c.len) g.fillRect((base + n.s) / c.len * W, H - (n.p - lo + 1) * (H - rh) / (hi - lo + 1) - rh, Math.max(2, Math.min(n.l, L - n.s) / c.len * W - 1), rh); }
    g.globalAlpha = 1;
  } else {
    const pk = peaksFor(c.sample), b = E.buffers.get(c.sample); if (!pk) return; const sr = b.sampleRate / 256, mid = H / 2;
    for (let x = 0; x < W; x++) { const sec = (c.offset || 0) + x / W * c.len * E.spb * (c.rate || 1), i = Math.floor(sec * sr); if (i >= pk.length) break; const a = pk[i] * mid * db(c.gain || 0); g.fillRect(x, mid - a, 1, Math.max(1, a * 2)); }
    g.strokeStyle = cssColor('--ink'); g.lineWidth = 1.2; g.beginPath();
    if (c.fadeIn) { const fx = c.fadeIn / c.len * W; g.moveTo(0, H); g.lineTo(fx, 0); }
    if (c.fadeOut) { const fx = W - c.fadeOut / c.len * W; g.moveTo(fx, 0); g.lineTo(W, H); } g.stroke();
  }
}
// ---------- dock ----------
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
function setTab(t) { UI.tab = t; document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); ['editor', 'devices', 'mixer', 'plugins'].forEach(p => $('#' + p).hidden = p !== t); renderDock(); }
function renderDock() {
  if (UI.lib && $('#lib').innerHTML) renderLib();
  const t = trk(UI.track); $('#dockinfo').textContent = t ? `${t.name}${UI.clip ? ' · ' + (findClip(UI.clip)?.c.name || '') : ''}` : '';
  if (UI.tab === 'editor') renderEditor(); else if (UI.tab === 'devices') renderDevices(); else if (UI.tab === 'mixer') renderMixer(); else renderPlugins();
}

// ---------- editor: piano roll / step sequencer / audio clip ----------
function renderEditor() {
  const fc = UI.clip && findClip(UI.clip), box = $('#editor');
  if (!fc) { box.innerHTML = `<div class="empty">Select a clip to edit it. Double-click an empty spot on an instrument track to make a new MIDI clip, or drop audio files onto the arrangement.</div>`; return; }
  if (!isMidi(fc.c)) return renderAudioEditor({ ...fc, ref: fc.c }, box);
  const pat = fc.c.pattern && P().patterns[fc.c.pattern];
  const ed = pat ? { t: fc.t, c: pat, ref: fc.c, slot: fc.slot } : { ...fc, ref: fc.c };
  if (fc.t.inst === 'drums') return renderSeq(ed, box);
  renderPianoRoll(ed, box);
}
function clipBar(fc, extra = '') {
  const ref = fc.ref || fc.c, midi = isMidi(ref), pat = !!ref.pattern;
  const patBits = midi ? (pat ? `<span class="pattag" title="This clip is a pattern: every copy plays the same notes, so editing one edits all">⧉ Pattern · edits change every copy</span><button id="cUnique">Make unique</button>` : `<button id="cPattern" title="Turn this clip into a pattern so its copies stay linked (FL Studio style)">Make pattern</button>`) : '';
  const where = fc.slot != null ? `<button id="cToArr" title="Copy this clip into the arrangement at the playhead">→ Arrangement</button>` : `<button id="cToSes" title="Copy this clip into the clip launcher">→ Session</button>`;
  return `<div class="prbar"><input id="cName" value="${esc(fc.c.name)}" aria-label="${pat ? 'Pattern' : 'Clip'} name" style="width:140px;cursor:text"><label>${pat ? 'Pattern length' : 'Length'} <input id="cLen" type="number" min="0.25" step="0.25" value="${+fc.c.len.toFixed(3)}" style="width:72px;cursor:text"> beats</label>${extra}${patBits}${midi ? '<button id="cMid">Export .mid</button>' : ''}${where}<button id="cDup">Duplicate →</button><button id="cDel">Delete clip</button></div>`;
}
function bindClipBar(fc, rerender) {
  $('#cName').onchange = e => { snapshot(); fc.c.name = e.target.value; commit(false); };
  $('#cLen').onchange = e => { snapshot(); fc.c.len = Math.max(0.25, +e.target.value || 4); commit(false); };
  if ($('#cMid')) $('#cMid').onclick = () => download(midiFile(fc.c, P().bpm), (fc.c.name || 'clip') + '.mid');
  $('#cDup').onclick = () => duplicateClip(); $('#cDel').onclick = () => deleteClip();
  const ref = fc.ref || fc.c;
  if ($('#cPattern')) $('#cPattern').onclick = async () => { snapshot(); const id = uid(); P().patterns[id] = { name: ref.name || 'Pattern', len: ref.len, notes: ref.notes }; delete ref.notes; ref.pattern = id; await commit(false); toast('Now a pattern — duplicate it and every copy stays linked'); };
  if ($('#cUnique')) $('#cUnique').onclick = async () => { snapshot(); const pt = P().patterns[ref.pattern], notes = []; for (let b = 0; b < ref.len; b += pt.len) for (const n of pt.notes) if (b + n.s < ref.len) notes.push({ ...n, s: b + n.s }); ref.notes = notes; ref.name = pt.name; delete ref.pattern; await commit(false); toast('This copy is now independent'); };
  if ($('#cToSes')) $('#cToSes').onclick = async () => { const sl = E.slots(fc.t.id), i = sl.findIndex(x => !x); if (i < 0) return toast('All 8 session slots on this track are full'); snapshot(); sl[i] = { ...JSON.parse(JSON.stringify(ref)), id: uid(), start: 0 }; await commit(false); setView('session'); toast(`Copied to Session, scene ${i + 1}`); };
  if ($('#cToArr')) $('#cToArr').onclick = async () => { snapshot(); const b = Math.floor(E.position() / P().sig) * P().sig; const c = { ...JSON.parse(JSON.stringify(ref)), id: uid(), start: b }; fc.t.clips.push(c); await commit(false); toast('Copied to the arrangement at bar ' + (b / P().sig + 1)); };
}
function renderPianoRoll(fc, box) {
  const grids = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 };
  box.innerHTML = clipBar(fc, `<select id="prGrid" aria-label="Grid">${Object.entries(grids).map(([k, v]) => `<option value="${v}" ${v === UI.prGrid ? 'selected' : ''}>Grid ${k}</option>`).join('')}</select>
    <button id="prQ">Quantize</button><select id="prSw" aria-label="Swing" title="Swing applied by Quantize"><option value="0">Straight</option><option value="0.1">Swing 10%</option><option value="0.2">Swing 20%</option><option value="0.33">Swing 33%</option><option value="0.5">Swing 50%</option></select><button id="prHum" title="Cubase-style humanize: tiny random timing and velocity changes">Humanize</button><button id="prLeg" title="Stretch each note to the next one">Legato</button><button id="prVel" title="Velocity: louder (+) / Shift-click softer">Vel ±</button><button id="prUp">Oct +</button><button id="prDn">Oct −</button><label>Zoom <input id="prZ" type="range" min="0.5" max="3" step="0.1" value="${UI.prZoom}" style="width:90px;padding:0"></label>`) +
    `<div class="prwrap" id="prwrap"><canvas id="pr"></canvas></div>`;
  bindClipBar(fc);
  $('#prGrid').onchange = e => { UI.prGrid = +e.target.value; draw(); };
  $('#prZ').oninput = e => { UI.prZoom = +e.target.value; size(); draw(); };
  $('#prSw').value = UI.swing || 0; $('#prSw').onchange = e => UI.swing = +e.target.value;
  $('#prQ').onclick = () => { snapshot(); const g = UI.prGrid, sw = UI.swing || 0; fc.c.notes.forEach(n => { const k = Math.round(n.s / g); n.s = k * g + (k % 2 === 1 ? sw * g : 0); }); commit(false); toast(sw ? `Quantized with ${Math.round(sw * 100)}% swing` : 'Quantized'); };
  $('#prHum').onclick = () => { snapshot(); fc.c.notes.forEach(n => { n.s = Math.max(0, n.s + (Math.random() - 0.5) * 0.04); n.v = Math.max(0.1, Math.min(1, n.v + (Math.random() - 0.5) * 0.2)); }); commit(false); toast('Humanized'); };
  $('#prLeg').onclick = () => { snapshot(); const ns = fc.c.notes.slice().sort((a, b) => a.s - b.s); ns.forEach(n => { const nx = ns.find(m => m.s > n.s + 1e-6); n.l = Math.max(0.05, (nx ? nx.s : fc.c.len) - n.s); }); commit(false); toast('Legato'); };
  $('#prVel').onclick = e => { snapshot(); fc.c.notes.forEach(n => n.v = Math.max(0.05, Math.min(1, n.v + (e.shiftKey ? -0.1 : 0.1)))); commit(false); };
  $('#prUp').onclick = () => { snapshot(); fc.c.notes.forEach(n => n.p = Math.min(120, n.p + 12)); commit(false); };
  $('#prDn').onclick = () => { snapshot(); fc.c.notes.forEach(n => n.p = Math.max(12, n.p - 12)); commit(false); };
  const LO = 24, HI = 108, RH = 12, KW = 46, cv = $('#pr'), wrap = $('#prwrap'); let ppb;
  const size = () => { ppb = 70 * UI.prZoom; cv.width = (KW + fc.c.len * ppb) * devicePixelRatio; cv.height = (HI - LO + 1) * RH * devicePixelRatio; cv.style.width = KW + fc.c.len * ppb + 'px'; cv.style.height = (HI - LO + 1) * RH + 'px'; };
  const yOf = p => (HI - p) * RH, pOf = y => HI - Math.floor(y / RH);
  const draw = () => {
    const g = cv.getContext('2d'), W = KW + fc.c.len * ppb, H = (HI - LO + 1) * RH, cs = getComputedStyle(document.documentElement);
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); g.clearRect(0, 0, W, H);
    for (let p = LO; p <= HI; p++) { const black = [1, 3, 6, 8, 10].includes(p % 12); g.fillStyle = black ? cssColor('--lane2') : cssColor('--lane'); g.fillRect(KW, yOf(p), W, RH); if (p % 12 === 0) { g.fillStyle = cssColor('--line'); g.fillRect(KW, yOf(p) + RH - 1, W, 1); } }
    for (let b = 0; b <= fc.c.len + 1e-9; b += UI.prGrid) { g.fillStyle = cssColor(Math.abs(b % P().sig) < 1e-9 ? '--mute' : Math.abs(b % 1) < 1e-9 ? '--line' : '--grid'); g.fillRect(KW + b * ppb, 0, 1, H); }
    for (const n of fc.c.notes) { g.fillStyle = fc.t.color; g.globalAlpha = 0.45 + n.v * 0.55; g.fillRect(KW + n.s * ppb + 1, yOf(n.p) + 1, Math.max(3, n.l * ppb - 2), RH - 2); g.globalAlpha = 1; g.strokeStyle = cssColor('--ink'); g.strokeRect(KW + n.s * ppb + 1.5, yOf(n.p) + 1.5, Math.max(3, n.l * ppb - 3), RH - 3); }
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
function regionPeak(b, c) { const sr = b.sampleRate, s0 = Math.floor((c.offset || 0) * sr), s1 = Math.min(b.length, s0 + Math.floor(c.len * E.spb * (c.rate || 1) * sr)); let m = 0; for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch); for (let i = s0; i < s1; i++) { const v = Math.abs(d[i]); if (v > m) m = v; } } return m; }
function renderAudioEditor(fc, box) {
  const c = fc.c, b = E.buffers.get(c.sample);
  box.innerHTML = clipBar(fc) + `<div class="dev" style="max-width:none"><div class="ps">
    <div class="pr"><label>Gain</label><input id="aG" type="range" min="-24" max="12" step="0.1" value="${c.gain || 0}"><output>${(c.gain || 0).toFixed(1)} dB</output></div>
    <div class="pr"><label>Trim start</label><input id="aO" type="range" min="0" max="${b ? b.duration.toFixed(2) : 0}" step="0.01" value="${c.offset || 0}"><output>${(c.offset || 0).toFixed(2)} s</output></div>
    <div class="pr"><label>Source</label><span>${esc(audioName(c.sample))} · ${b ? b.duration.toFixed(1) + ' s' : 'missing audio'}</span></div>
    <div class="pr"><label>Fade in</label><input id="aFi" type="range" min="0" max="${Math.max(0.25, c.len / 2).toFixed(2)}" step="0.0625" value="${c.fadeIn || 0}"><output>${(c.fadeIn || 0).toFixed(2)} beats</output></div>
    <div class="pr"><label>Fade out</label><input id="aFo" type="range" min="0" max="${Math.max(0.25, c.len / 2).toFixed(2)}" step="0.0625" value="${c.fadeOut || 0}"><output>${(c.fadeOut || 0).toFixed(2)} beats</output></div>
    <div class="pr"><label title="Varispeed: changes speed and pitch together">Speed / pitch</label><input id="aRate" type="range" min="-12" max="12" step="1" value="${Math.round(12 * Math.log2(c.rate || 1))}"><output>${Math.round(12 * Math.log2(c.rate || 1))} st</output></div>
    <div class="pr"><label title="Strip Silence threshold">Silence below</label><input id="aTh" type="range" min="-70" max="-10" step="1" value="${UI.stripTh || -40}"><output>${UI.stripTh || -40} dB</output></div>
    <div class="prbar"><button id="aFit">Fit length to audio</button><button id="aSplit">Split at playhead (Ctrl+E)</button><button id="aStrip" title="Pro Tools Strip Silence: cut the clip into pieces wherever it's quiet">Strip silence</button><button id="aNorm" title="Raise the clip gain so its loudest peak hits -0.3 dB">Normalize</button><button id="aRev" title="Play the clip backwards">Reverse</button></div></div></div>`;
  bindClipBar(fc);
  $('#aG').oninput = e => { c.gain = +e.target.value; e.target.nextElementSibling.textContent = c.gain.toFixed(1) + ' dB'; renderLanes(); };
  $('#aG').onchange = () => { persist(); };
  $('#aO').oninput = e => { c.offset = +e.target.value; e.target.nextElementSibling.textContent = c.offset.toFixed(2) + ' s'; renderLanes(); };
  $('#aO').onchange = () => persist();
  $('#aFit').onclick = () => { if (!b) return; snapshot(); c.len = (b.duration - (c.offset || 0)) / E.spb / (c.rate || 1); commit(false); };
  const live = (id, key, fmt2) => { $(id).onpointerdown = () => snapshot(); $(id).oninput = e => { c[key] = +e.target.value; e.target.nextElementSibling.textContent = fmt2(c[key]); renderLanes(); }; $(id).onchange = () => persist(); };
  live('#aFi', 'fadeIn', v => v.toFixed(2) + ' beats'); live('#aFo', 'fadeOut', v => v.toFixed(2) + ' beats');
  $('#aRate').onpointerdown = () => snapshot(); $('#aRate').oninput = e => { c.rate = Math.pow(2, +e.target.value / 12); e.target.nextElementSibling.textContent = e.target.value + ' st'; renderLanes(); }; $('#aRate').onchange = () => persist();
  $('#aTh').oninput = e => { UI.stripTh = +e.target.value; e.target.nextElementSibling.textContent = e.target.value + ' dB'; };
  $('#aNorm').onclick = () => { if (!b) return; const pk = regionPeak(b, c); if (pk <= 0) return toast('This clip is silent'); snapshot(); c.gain = +(-20 * Math.log10(pk) - 0.3).toFixed(1); commit(false); toast(`Clip gain set to ${c.gain > 0 ? '+' : ''}${c.gain} dB`); };
  $('#aRev').onclick = async () => {
    if (!b) return; const nb = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
    for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch).slice().reverse(); nb.copyToChannel(d, ch); }
    const id = await E.addAudio(await encodeWav(nb).arrayBuffer(), audioName(c.sample) + ' (reversed)'); if (!id) return; snapshot();
    P().audio[id] = { name: audioName(c.sample) + ' (reversed)' }; const used = c.len * E.spb * (c.rate || 1); c.offset = Math.max(0, b.duration - (c.offset || 0) - used); c.sample = id; await commit(false); toast('Reversed');
  };
  $('#aStrip').onclick = async () => {
    if (!b) return; const th = Math.pow(10, (UI.stripTh || -40) / 20), rate = c.rate || 1, sr = b.sampleRate, win = Math.floor(sr * 0.01);
    const s0 = Math.floor((c.offset || 0) * sr), s1 = Math.min(b.length, s0 + Math.floor(c.len * E.spb * rate * sr)), chans = [...Array(b.numberOfChannels)].map((_, i) => b.getChannelData(i));
    const loud = []; for (let i = s0; i < s1; i += win) { let m = 0; for (const d of chans) for (let j = i; j < Math.min(s1, i + win); j++) m = Math.max(m, Math.abs(d[j])); loud.push(m >= th); }
    const regs = []; let st = -1, gap = 0; const minGap = 10, pad = 1;   // windows of 10 ms: merge gaps under 100 ms
    loud.forEach((l, i) => { if (l) { if (st < 0) st = i; gap = 0; } else if (st >= 0 && ++gap > minGap) { regs.push([st, i - gap + 1]); st = -1; gap = 0; } });
    if (st >= 0) regs.push([st, loud.length]);
    const keep = regs.filter(([a, z]) => z - a >= 5).map(([a, z]) => [Math.max(0, a - pad), Math.min(loud.length, z + pad)]);
    if (!keep.length) return toast('Everything is below the threshold — lower “Silence below”'); if (keep.length === 1 && keep[0][0] === 0 && keep[0][1] >= loud.length - 1) return toast('No silence found at this threshold');
    snapshot(); const t = fc.t, secPerWin = win / sr;
    t.clips = t.clips.filter(x => x !== c);
    keep.forEach(([a, z], i) => t.clips.push({ ...c, id: uid(), name: c.name + ' ' + (i + 1), start: c.start + a * secPerWin / rate / E.spb, len: (z - a) * secPerWin / rate / E.spb, offset: (c.offset || 0) + a * secPerWin, fadeIn: 0.03, fadeOut: 0.06 }));
    UI.clip = null; await commit(false); toast(`Strip silence: ${keep.length} region${keep.length === 1 ? '' : 's'} kept`);
  };
  $('#aSplit').onclick = splitClip;
}

// ---------- devices ----------
const fmt = (p, v) => p.type !== 'range' ? '' : (p.unit === 'Hz' ? (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz' : p.unit === 's' ? (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s') : (Math.abs(v) < 10 && p.step < 1 ? (+v).toFixed(p.step < 0.1 ? 2 : 1) : Math.round(v)) + (p.unit ? ' ' + p.unit : ''));
const toPos = (p, v) => p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) * 1000 : v;
const fromPos = (p, x) => p.log ? +(p.min * Math.pow(p.max / p.min, x / 1000)).toFixed(1) : +x;
function paramsHtml(params, vals, key) {
  return params.map(p => { const v = vals[p.id] ?? p.def;
    if (p.type === 'select') return `<div class="pr"><label>${p.label}</label><select data-k="${key}" data-p="${p.id}">${p.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    if (p.type === 'track') { const self = devOwner()?.id; return `<div class="pr"><label>${p.label}</label><select data-k="${key}" data-p="${p.id}"><option value="">— choose the kick or key track —</option>${P().tracks.filter(t => t.id !== self && t.kind !== 'group').map(t => `<option value="${t.id}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>`; }
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
    o.midifx ||= midiDefaults();
    h += `<div class="dev ${o.midifx.arp.on || o.midifx.chord.on ? '' : 'dim'}" id="midiCard"><h4><span class="t">MIDI tools</span><button data-mfx="print" title="Write what the arp/chord maker plays into the selected clip, so you can edit the notes">Print to clip</button></h4><div class="ps">${paramsHtml(CHORD_PARAMS, o.midifx.chord, 'chord')}${paramsHtml(ARP_PARAMS, o.midifx.arp, 'arp')}</div></div>`;
    h += chordPadsHtml(o);
    h += `<div class="dev" style="--c:${o.color}"><h4 style="border-top:3px solid ${o.color}"><span class="t">${INSTRUMENTS[o.inst].name}</span></h4><div class="ps">${paramsHtml(INSTRUMENTS[o.inst].params, o.instParams, 'inst')}`;
    if (o.inst === 'sampler') h += `<div class="pr"><label>Sample</label><select data-k="inst" data-p="sample"><option value="">— choose —</option>${Object.keys(P().audio || {}).filter(id => E.buffers.has(id)).map(id => `<option value="${id}" ${o.instParams.sample === id ? 'selected' : ''}>${esc(audioName(id))}</option>`).join('')}</select></div><label class="tb file" style="height:30px">Load sample…<input id="smpFile" type="file" accept="audio/*" hidden></label>`;
    if (o.inst === 'external') h += `<div class="pr"><label>MIDI output</label><select data-k="inst" data-p="port">${(UI.midiOuts || []).length ? UI.midiOuts.map(n => `<option ${o.instParams.port === n ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option value="">No MIDI outputs found</option>'}</select></div><p style="font-size:12px;color:var(--mute);margin:4px 0 0">Plays SHRUB's browser editor (set its MIDI in to the same virtual port, e.g. the Mac IAC Driver), an FM-1 over USB, or any synth. Not captured in WAV export — record its audio back in on an audio track.</p>`;
    h += `</div></div>`;
  }
  o.inserts.forEach((s, i) => {
    const def = s.type === 'wam' ? { name: 'Web plugin', params: [] } : EFFECTS[s.type];
    h += `<div class="dev ${s.bypass ? 'off' : ''}" data-slot="${s.id}"><h4><span class="t" title="${esc(s.url || '')}">${esc(def?.name || s.type)}</span><button data-a="byp" title="Bypass">${s.bypass ? 'Off' : 'On'}</button><button data-a="l" title="Move left" ${i ? '' : 'disabled'}>‹</button><button data-a="r" title="Move right" ${i < o.inserts.length - 1 ? '' : 'disabled'}>›</button><button data-a="x" title="Remove">×</button></h4>`;
    if (s.type === 'eq') h += `<canvas class="eqc" data-eq="${s.id}"></canvas>`;
    if (s.type === 'analyzer') h += `<canvas class="eqc" data-an="${s.id}" style="height:140px"></canvas>`;
    if (s.type === 'comp' || s.type === 'limiter' || s.type === 'sccomp') h += `<div style="font-size:11px;color:var(--mute);padding:6px 10px 2px">Gain reduction</div><div class="gr"><i data-gr="${s.id}"></i></div>`;
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
  bindChordPads(o);
  if ($('[data-mfx=print]')) $('[data-mfx=print]').onclick = async () => {
    const fc = UI.clip && findClip(UI.clip); if (!fc || fc.t !== o || !isMidi(fc.c)) return toast('Select one of this track’s MIDI clips first');
    const tgt = fc.c.pattern ? P().patterns[fc.c.pattern] : fc.c, L = fc.c.pattern ? tgt.len : fc.c.len; snapshot();
    tgt.notes = applyMidiFx(o.midifx, tgt.notes, L); o.midifx.arp.on = false; o.midifx.chord.on = false; await commit(false); toast('Printed — the notes are now in the clip and the MIDI tools are off');
  };
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
    const pdef = k === 'inst' ? INSTRUMENTS[o.inst].params.find(p => p.id === pid) : k === 'arp' ? ARP_PARAMS.find(p => p.id === pid) : k === 'chord' ? CHORD_PARAMS.find(p => p.id === pid) : EFFECTS[o.inserts.find(s => s.id === k)?.type]?.params.find(p => p.id === pid);
    const val = () => inp.type === 'checkbox' ? inp.checked : inp.tagName === 'SELECT' ? inp.value : fromPos(pdef, inp.value);
    const apply = () => { const v = val();
      if (k === 'arp' || k === 'chord') { o.midifx[k][pid] = v; if (pid === 'on') $('#midiCard').classList.toggle('dim', !(o.midifx.arp.on || o.midifx.chord.on)); }
      else if (k === 'inst') { if (pid === 'preset') { Object.assign(o.instParams, SYNTH_PRESETS[v], { preset: v }); Object.entries(o.instParams).forEach(([a, b]) => E.setInstParam(o.id, a, b)); renderDevices(); } else E.setInstParam(o.id, pid, v); }
      else E.setFxParam(UI.dev.kind, UI.dev.id, k, pid, v);
      if (inp.nextElementSibling?.tagName === 'OUTPUT') inp.nextElementSibling.textContent = fmt(pdef, v);
      drawEq(); };
    inp.addEventListener('pointerdown', () => snapshot(), { once: false });
    inp.addEventListener('input', apply); inp.addEventListener('change', () => { if (inp.tagName === 'SELECT' || inp.type === 'checkbox') snapshot(); apply(); persist(); if ((k === 'inst' && pid === 'sample') || pdef?.type === 'track') commit(true); });
  });
  drawEq(); fitRack();
}
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALE = { Major: [0, 2, 4, 5, 7, 9, 11], Minor: [0, 2, 3, 5, 7, 8, 10] };
function padChords(pd) {
  const sc = SCALE[pd.scale] || SCALE.Major, root = 48 + KEYS.indexOf(pd.key), roman = pd.scale === 'Minor' ? ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'] : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
  return sc.map((_, d) => { const ns = [0, 2, 4, ...(pd.seventh ? [6] : [])].map(k => root + sc[(d + k) % 7] + 12 * Math.floor((d + k) / 7));
    const q = ns[1] - ns[0] === 3 ? (ns[2] - ns[0] === 6 ? 'dim' : 'm') : ''; return { label: KEYS[(KEYS.indexOf(pd.key) + sc[d]) % 12] + q + (pd.seventh ? '7' : ''), roman: roman[d], notes: ns }; });
}
function chordPadsHtml(o) {
  const pd = (o.pads ||= { key: 'C', scale: 'Major', seventh: false, write: false, len: 2 });
  return `<div class="dev pads" id="padsCard"><h4><span class="t">Chord pads</span></h4><div class="padbar"><select data-pd="key" aria-label="Key">${KEYS.map(k => `<option ${k === pd.key ? 'selected' : ''}>${k}</option>`).join('')}</select><select data-pd="scale" aria-label="Scale">${Object.keys(SCALE).map(k => `<option ${k === pd.scale ? 'selected' : ''}>${k}</option>`).join('')}</select>
    <label><input type="checkbox" data-pd="seventh" ${pd.seventh ? 'checked' : ''}> 7ths</label><label title="Clicking a pad also writes the chord into the selected clip at the playhead"><input type="checkbox" data-pd="write" ${pd.write ? 'checked' : ''}> Write to clip</label></div>
    <div class="padgrid">${padChords(pd).map((c, i) => `<button data-pad="${i}"><b>${c.label}</b><small>${c.roman}</small></button>`).join('')}</div></div>`;
}
function bindChordPads(o) {
  const card = $('#padsCard'); if (!card) return;
  card.querySelectorAll('[data-pd]').forEach(el => el.onchange = () => { o.pads[el.dataset.pd] = el.type === 'checkbox' ? el.checked : el.value; persist(); renderDevices(); });
  card.querySelectorAll('[data-pad]').forEach(b => {
    b.onpointerdown = async e => {
      const ch = padChords(o.pads)[+b.dataset.pad]; ch.notes.forEach(n => E.liveOn(o.id, n, 0.75));
      const up = () => { ch.notes.forEach(n => E.liveOff(o.id, n)); removeEventListener('pointerup', up); }; addEventListener('pointerup', up);
      if (o.pads.write) {
        const fc = UI.clip && findClip(UI.clip); if (!fc || fc.t !== o || !isMidi(fc.c)) return toast('Select one of this track’s MIDI clips to write chords into it');
        const tgt = fc.c.pattern ? P().patterns[fc.c.pattern] : fc.c, L = fc.c.pattern ? tgt.len : fc.c.len;
        let at = Math.floor((E.position() - (fc.c.start || 0)) / P().sig * 2) * P().sig / 2; at = ((at % L) + L) % L; snapshot();
        ch.notes.forEach(n => tgt.notes.push({ p: n, s: at, l: Math.min(o.pads.len || 2, L - at), v: 0.75 })); commitQuiet(); if (UI.tab === 'editor') renderEditor();
        toast(`${ch.label} written at beat ${(at + 1).toFixed(1)}`);
      }
    };
  });
}
function fitRack() {
  document.querySelectorAll('#devices .dev .ps').forEach(ps => { const dev = ps.closest('.dev'), avail = dev.clientHeight - ps.offsetTop - 12; ps.style.gridTemplateRows = `repeat(${Math.max(1, Math.floor((avail + 5) / 29))}, 24px)`; });
}
function drawEq() {
  document.querySelectorAll('canvas[data-eq]').forEach(cv => {
    const f = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === cv.dataset.eq)?.node; if (!f?.filters) return;
    const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; const g = cv.getContext('2d'); g.scale(devicePixelRatio, devicePixelRatio);
    const N = 200, fr = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N), tot = new Float32Array(N).fill(0);
    for (let i = 0; i < N; i++) fr[i] = 20 * Math.pow(1000, i / (N - 1));
    f.filters.forEach(b => { b.getFrequencyResponse(fr, mag, ph); for (let i = 0; i < N; i++) tot[i] += 20 * Math.log10(Math.max(1e-6, mag[i])); });
    g.strokeStyle = 'rgba(128,128,128,.35)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); [100, 1000, 10000].forEach(hz => { const x = Math.log(hz / 20) / Math.log(1000) * W; g.moveTo(x, 0); g.lineTo(x, H); }); g.stroke();
    g.strokeStyle = cssColor('--rose'); g.lineWidth = 2; g.beginPath(); for (let i = 0; i < N; i++) { const x = i / (N - 1) * W, y = H / 2 - Math.max(-24, Math.min(24, tot[i])) / 24 * (H / 2 - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
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
  const outSel = kind === 'track' && o.kind !== 'group' ? `<select class="outsel" aria-label="Output" title="Where this track's sound goes"><option value="master">→ Master</option>${P().tracks.filter(g => g.kind === 'group').map(g => `<option value="${g.id}" ${o.out === g.id ? 'selected' : ''}>→ ${esc(g.name)}</option>`).join('')}</select>` : kind === 'track' ? '<div class="fx">Group bus</div>' : '';
  return `<div class="ch ${sel}" data-kind="${kind}" data-id="${o.id || ''}" style="--c:${color}"><div class="cname" title="${esc(name)}">${esc(name)}</div>${outSel}<div class="fx">${o.inserts.map(s => s.type === 'wam' ? 'Web' : EFFECTS[s.type]?.name.split(' ')[0]).join(' · ') || '—'}</div>${sends}${pan}
    <div class="fz"><input class="fader" type="range" min="-60" max="6" step="0.1" value="${o.vol}" aria-label="${esc(name)} volume"><canvas class="mtr" width="12" height="100"></canvas></div><div class="db">${o.vol <= -60 ? '−∞' : o.vol.toFixed(1)} dB</div>
    <div class="btns">${kind === 'track' ? `<button class="m ${o.mute ? 'on' : ''}" data-ms="mute">M</button><button class="s ${o.solo ? 'on' : ''}" data-ms="solo">S</button>` : ''}<button data-fx>FX</button></div></div>`;
}
function renderMixer() {
  $('#mixer').innerHTML = `<div class="specwrap"><canvas id="spec" aria-label="Master spectrum"></canvas><span>Master spectrum</span></div><div class="mix">${P().tracks.map(t => chHtml('track', t, t.name, t.color)).join('')}${P().returns.map(r => chHtml('return', r, r.name, '#888')).join('')}${chHtml('master', P().master, 'Master', '#ff4f8b')}</div>`;
}
const mixOwner = ch => ch.dataset.kind === 'master' ? P().master : ch.dataset.kind === 'return' ? P().returns.find(r => r.id === ch.dataset.id) : trk(ch.dataset.id);
$('#mixer').addEventListener('input', e => {
  const ch = e.target.closest('.ch'); if (!ch) return; const o = mixOwner(ch);
  if (e.target.classList.contains('fader')) { o.vol = +e.target.value; ch.querySelector('.db').textContent = (o.vol <= -60 ? '−∞' : o.vol.toFixed(1)) + ' dB'; }
  else if (e.target.dataset.send) o.sends[e.target.dataset.send] = +e.target.value; else if ('pan' in e.target.dataset) o.pan = +e.target.value;
  E.applyMix();
});
$('#mixer').addEventListener('change', async e => { if (e.target.classList.contains('outsel')) { const t = trk(e.target.closest('.ch').dataset.id); snapshot(); t.out = e.target.value; await commit(true); return; } persist(); renderHeads(); });
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
  <h3>Built-in devices</h3><p>${Object.keys(EFFECTS).length} effects — ${Object.values(EFFECTS).map(e => e.name).join(', ')} — plus Rose Synth (${Object.keys(SYNTH_PRESETS).length} presets), Rose Drums and Rose Sampler. Add them from the <b>Library</b> or the <b>Sound & FX</b> tab. Two return buses (reverb and delay) are fed by each track's A/B sends in the <b>Mixer</b>.</p>
  <h3>VST3 and AU plugins (Serum, FabFilter, Softube Flow, Google Flow Music, Valhalla…)</h3><p>Browsers can't run VST3 or AU plugins — no web DAW can. Use the <b>Rose desktop app</b> in this repo's <code>native/</code> folder: it scans and loads every VST3 and AU plugin on your Mac, including the plugins you use in FL Studio, Logic and Ableton. Stock devices that live inside those apps (FL's Fruity plugins, Logic's ChromaVerb, Ableton's devices) only run inside their own app.</p>
  <h3>SHRUB (Xfer's free Serum for the FM-1)</h3><p><b>Desktop app:</b> install the SHRUB VST3 from shrub.audio, then use <i>Scan plugins</i> in Rose — it loads like any instrument. <b>Browser:</b> add an <b>External MIDI</b> track (+ Track menu) and pick a MIDI output. To play the SHRUB browser editor, turn on the Mac's IAC Driver (Audio MIDI Setup → MIDI Studio → IAC Driver → Device is online), choose it here and as "MIDI in" in the SHRUB editor. An FM-1 running SHRUB shows up directly over USB. Use <b>Export .mid</b> on any MIDI clip to take parts anywhere.</p>
  <h3>Web plugins (WAM 2)</h3><p>The browser version can load Web Audio Modules — the web's plugin standard. Paste a plugin's <code>index.js</code> address in <b>Sound & FX → Add effect</b>, or below to add it to the selected chain. Web plugins play live but are skipped in WAV export.</p>
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
async function deleteClip() { const fc = UI.clip && findClip(UI.clip); if (!fc) return; snapshot(); if (fc.slot != null) { E.slots(fc.t.id)[fc.slot] = null; if (E.live[fc.t.id]?.clip === fc.c) delete E.live[fc.t.id]; } else fc.t.clips = fc.t.clips.filter(c => c !== fc.c); UI.clip = null; await commit(false); }
async function duplicateClip() {
  const fc = UI.clip && findClip(UI.clip); if (!fc) return; const c = JSON.parse(JSON.stringify(fc.c)); c.id = uid();
  if (fc.slot != null) { const sl = E.slots(fc.t.id), i = sl.findIndex((x, k) => !x && k > fc.slot); if (i < 0) return toast('No empty slot below'); snapshot(); sl[i] = c; }
  else { snapshot(); c.start = fc.c.start + fc.c.len; fc.t.clips.push(c); }
  UI.clip = c.id; await commit(false); if (fc.c.pattern) toast('Linked copy — edit either one and both change');
}
async function splitClip() {
  const fc = UI.clip && findClip(UI.clip), b = snapB(E.position());
  if (fc?.slot != null) return toast('Split works on arrangement clips');
  if (fc?.c.pattern) return toast('Click “Make unique” first, then split'); if (!fc || b <= fc.c.start || b >= fc.c.start + fc.c.len) return toast('Put the playhead inside the selected clip to split it');
  snapshot(); const c = fc.c, cut = b - c.start, d = JSON.parse(JSON.stringify(c)); d.id = uid(); d.start = b; d.len = c.len - cut; c.len = cut;
  if (c.notes) { d.notes = c.notes.filter(n => n.s >= cut).map(n => ({ ...n, s: n.s - cut })); c.notes = c.notes.filter(n => n.s < cut); } else d.offset = (c.offset || 0) + cut * E.spb;
  fc.t.clips.push(d); await commit(false);
}

// ---------- library ----------
const PRESET_INFO = { 'Supersaw Lead': 'Big EDM lead', 'Pluck': 'Short, bouncy pluck', 'Warm Pad': 'Soft chords that swell', 'Sub Bass': 'Deep, clean low end', 'Reese Bass': 'Wide, gritty bass', 'Keys': 'Electric-piano style', 'Chip Square': '8-bit game sound', 'Brass': 'Punchy stabs' };
const FX_INFO = { eq: 'Shape the tone', filter: 'Sweeps & wobbles', comp: 'Even out levels, add punch', limiter: 'Make it loud, stop clipping', gate: 'Cut background noise', reverb: 'Room & space', delay: 'Echoes in time', chorus: 'Thicker, wider', flanger: 'Jet-plane swoosh', phaser: 'Swirling movement', tremolo: 'Volume / pan wobble', pump: 'EDM sidechain pump', distortion: 'Grit & warmth', crusher: 'Lo-fi crunch', width: 'Wider stereo', utility: 'Gain, mono, phase' };
function renderLib() {
  const t = trk(UI.track);
  const onT = t && t.kind === 'inst' ? esc(t.name) : 'an instrument track';
  $('#lib').innerHTML = `<h5>Instruments</h5><div class="chips2">${Object.keys(SYNTH_PRESETS).map(n => `<button data-preset="${esc(n)}" title="${PRESET_INFO[n] || ''}">${esc(n)}</button>`).join('')}
    <button data-addk="drums" title="Step-sequencer beat">Drum kit</button><button data-addk="sampler" title="Play any sound across the keyboard">Sampler</button><button data-addk="external" class="wide" title="Play SHRUB, an FM-1 or hardware">External MIDI</button></div>
    <h5>Patterns</h5><div class="chips2">${Object.entries(P().patterns || {}).map(([id, pt]) => `<button data-pat="${id}" title="${pt.len} beats — click to place on ${onT}">⧉ ${esc(pt.name)}</button>`).join('')}<button data-newpat="1" title="A linked clip you can paint across the song">+ New</button></div>
    <h5>MIDI tools</h5><div class="chips2"><button data-midi="arp" title="Turn held chords into arpeggios">Arpeggiator</button><button data-midi="chord" title="Play full chords from single notes">Chord maker</button><button data-midi="pads" class="wide" title="Click chords in any key">Chord pads</button></div>
    <h5>Effects${t ? ' → ' + esc(t.name) : ''}</h5><div class="chips2">${Object.entries(EFFECTS).map(([k, d]) => `<button data-fx="${k}" title="${FX_INFO[k] || d.cat}">${esc(d.name.replace(/^(Parametric|Sidechain|Spectrum|Stereo|Tremolo \/) ?/, m => m === 'Parametric ' ? '' : m))}</button>`).join('')}</div>
    <h5>Mixing</h5><div class="chips2"><button data-addk="group" class="wide" title="Mix several tracks together">Group bus</button></div>`;
}
$('#lib').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return; const t = trk(UI.track);
  if (b.dataset.preset) {
    const pr = b.dataset.preset;
    if (t && t.kind === 'inst' && t.inst === 'synth') { snapshot(); Object.assign(t.instParams, SYNTH_PRESETS[pr], { preset: pr }); Object.entries(t.instParams).forEach(([k, v]) => E.setInstParam(t.id, k, v)); persist(); renderDock(); toast(`${pr} loaded on ${t.name}`); E.liveOn(t.id, 60, 0.8); setTimeout(() => E.liveOff(t.id, 60), 400); }
    else await addTrackOf('synth', { preset: pr });
  } else if (b.dataset.midi) {
    if (!t || t.kind !== 'inst') return toast('Select an instrument track first');
    t.midifx ||= midiDefaults(); if (b.dataset.midi === 'arp') t.midifx.arp.on = true; if (b.dataset.midi === 'chord') t.midifx.chord.on = true;
    UI.dev = { kind: 'track', id: t.id }; persist(); setTab('devices'); document.getElementById(b.dataset.midi === 'pads' ? 'padsCard' : 'midiCard')?.scrollIntoView({ inline: 'start', block: 'nearest' });
    toast(b.dataset.midi === 'pads' ? 'Chord pads — click a chord to play it' : b.dataset.midi === 'arp' ? 'Arpeggiator on — hold a chord on your keyboard, or play a clip' : 'Chord maker on — one key now plays a full chord');
  } else if (b.dataset.addk) await addTrackOf(b.dataset.addk);
  else if (b.dataset.pat || b.dataset.newpat) {
    if (!t || t.kind !== 'inst') return toast('Select an instrument or drum track first');
    snapshot(); let id = b.dataset.pat; if (!id) { id = uid(); P().patterns[id] = { name: 'Pattern ' + (Object.keys(P().patterns).length + 1), len: 4, notes: [] }; }
    const bar = Math.floor(E.position() / P().sig) * P().sig, end = t.clips.reduce((m, c) => c.start <= bar && c.start + c.len > bar ? c.start + c.len : m, bar);
    const c = { id: uid(), name: P().patterns[id].name, start: end, len: P().patterns[id].len, pattern: id }; t.clips.push(c); UI.clip = c.id;
    await commit(false); setTab('editor'); renderLib(); toast(b.dataset.newpat ? 'New pattern — draw notes below, then click it again in the Library to paint more copies' : 'Pattern placed — all copies stay linked');
  }
  else if (b.dataset.fx) {
    const o = t || P().master; snapshot(); o.inserts.push({ id: uid(), type: b.dataset.fx, params: {}, bypass: false });
    UI.dev = t ? { kind: 'track', id: t.id } : { kind: 'master' }; await commit(true); setTab('devices'); toast(`${EFFECTS[b.dataset.fx].name} added to ${t ? t.name : 'Master'}`);
  }
});

// ---------- help ----------
function showHelp() {
  if ($('.help')) return $('.help').remove();
  const d = document.createElement('div'); d.className = 'help'; d.innerHTML = `<div class="card" role="dialog" aria-label="How to use Rose">
  <h2>Rose in one minute</h2><p style="color:var(--mute);margin:0">Everything starts from <b>Add track</b> and the <b>Library</b>.</p>
  <div class="cols"><div><h3>Make a beat</h3><ol><li>Add track → <b>Drums</b></li><li>Click the squares in the Editor below — each column is a 16th note</li><li>Shift-click a square for a louder hit</li><li>Press <kbd>Space</kbd> to hear it loop</li></ol>
  <h3>Play &amp; record notes</h3><ol><li>Pick an instrument in the Library</li><li>Play with your keyboard: <kbd>A</kbd>–<kbd>;</kbd> (<kbd>Z</kbd>/<kbd>X</kbd> change octave) or a MIDI keyboard</li><li>Click ● on the track, then Record (<kbd>R</kbd>)</li><li>Or double-click a lane and click in the piano roll to draw notes</li></ol></div>
  <div><h3>Record vocals</h3><ol><li>Add track → <b>Audio / vocals</b></li><li>Click ● on it, then Record — allow the microphone</li><li>Stop with <kbd>Space</kbd>; your take appears as a clip</li></ol>
  <h3>Mix &amp; finish</h3><ol><li><b>Sound &amp; FX</b>: add effects (try Compressor, then Reverb)</li><li><b>Mixer</b>: faders, pan, and A/B sends to the reverb &amp; delay buses</li><li>File → <b>Export WAV</b> to share your song</li></ol></div></div>
  <div class="cols"><div><h3>Automation</h3><ol><li>Click <b>A</b> on a track</li><li>Pick what to automate (volume, pan, sends or any effect knob)</li><li>Click the lane to add points, drag to shape, double-click to remove</li></ol>
  <h3>Patterns (FL Studio style)</h3><ol><li>Library → <b>+ New pattern</b>, or “Make pattern” on a clip</li><li>Click the pattern in the Library to paint copies — edit one, they all change</li></ol></div>
  <div><h3>Session / clip launcher (Ableton style)</h3><ol><li>Switch to <b>Session</b> at the top</li><li>Double-click a slot to make a clip, or send a clip there with “→ Session”</li><li>Press ▶ on a clip or a whole Scene — it starts on the next bar</li></ol>
  <h3>Pro mixing</h3><ol><li><b>Sidechain Compressor</b>: pick the kick as its key track</li><li>Add track → <b>Group bus</b>, then route tracks to it in the Mixer</li><li>Track ⋯ → <b>Bounce to audio</b> to print a track with its effects</li><li>The Mixer shows a live spectrum of your master</li></ol></div></div>
  <h3>Shortcuts</h3><p style="color:var(--mute)"><kbd>Space</kbd> play/pause · <kbd>Enter</kbd> stop · <kbd>R</kbd> record · <kbd>M</kbd> metronome · <kbd>Del</kbd> delete clip · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate · <kbd>Ctrl</kbd>+<kbd>E</kbd> split · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>S</kbd> save · <kbd>?</kbd> this guide</p>
  <p style="color:var(--mute)">Your song saves itself in this browser. Use File → Save project to keep a copy or move it to another computer. For VST/AU plugins (Serum, SHRUB…) use Rose Desktop — see the Plugins tab.</p>
  <button class="tb accent" id="helpClose" style="margin-top:8px">Got it</button></div>`;
  document.body.append(d); d.onclick = e => { if (e.target === d || e.target.id === 'helpClose') d.remove(); }; $('#helpClose').focus();
}

// ---------- keyboard ----------
const KEYMAP = 'awsedftgyhujkolp;'; const held = new Set();
addEventListener('keydown', e => {
  if (!E.ctx || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && !(document.activeElement.type === 'range' || document.activeElement.type === 'checkbox')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (e.key === '?') { showHelp(); return; }
  if (e.key === 'Escape') { closePops(); $('.help')?.remove(); return; }
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateClip(); return; }
  if (mod && k === 's') { e.preventDefault(); $('#bSave').click(); return; }
  if (mod && k === 'e') { e.preventDefault(); splitClip(); return; }
  if (mod) return;
  if (e.code === 'Space') { e.preventDefault(); E.playing ? E.stop(true) : E.play(); return; }
  if (e.key === 'Enter') { E.stop(); return; }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && UI.clip) {
    const fc = findClip(UI.clip); if (fc && fc.slot == null) { e.preventDefault(); const step = e.altKey ? 1 / 64 : (UI.snap || 0.25), d = e.key === 'ArrowLeft' ? -step : step;
      if (!e.repeat) snapshot(); fc.c.start = Math.max(0, +(fc.c.start + d).toFixed(5)); renderLanes(); persist(); toastQuiet(`Nudged to beat ${(fc.c.start + 1).toFixed(3)}`); return; }
  }
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
const fbuf = new Float32Array(2048);
function spectrum(cv, an) {
  const W = cv.clientWidth, H = cv.clientHeight; if (!W) return; if (cv.width !== W * devicePixelRatio) { cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; }
  const g = cv.getContext('2d'); g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); g.clearRect(0, 0, W, H);
  an.getFloatFrequencyData(fbuf); const n = an.frequencyBinCount, sr = E.ctx.sampleRate, acc = cssColor('--rose');
  g.strokeStyle = 'rgba(128,128,128,.25)'; g.beginPath(); [100, 1000, 10000].forEach(hz => { const x = Math.log(hz / 20) / Math.log(1000) * W; g.moveTo(x, 0); g.lineTo(x, H); }); g.stroke();
  g.fillStyle = 'rgba(128,128,128,.7)'; g.font = '10px Inter'; [['100', 100], ['1k', 1000], ['10k', 10000]].forEach(([l, hz]) => g.fillText(l, Math.log(hz / 20) / Math.log(1000) * W + 3, H - 4));
  g.beginPath(); for (let x = 0; x <= W; x++) { const hz = 20 * Math.pow(1000, x / W), i = Math.min(n - 1, Math.round(hz / (sr / 2) * n)), v = Math.max(0, Math.min(1, (fbuf[i] + 100) / 80)); const y = H - v * (H - 6); x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = acc; g.globalAlpha = 0.35; g.fill(); g.globalAlpha = 1; g.strokeStyle = acc; g.lineWidth = 1.5; g.stroke();
}
function frame() {
  const b = E.position(), spb = E.spb, sig = P().sig;
  $('#playhead').style.transform = `translateX(${b * UI.ppb}px)`;
  const bar = Math.floor(b / sig) + 1, beat = Math.floor(b % sig) + 1, six = Math.floor((b % 1) * 4) + 1, secs = b * spb;
  $('#pos').textContent = `${bar}.${beat}.${six}`; $('#clock').textContent = `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`;
  if (E.g) {
    meterDraw($('#mmeter'), peak(E.g.analyser));
    if (UI.tab === 'mixer' && $('#spec')) spectrum($('#spec'), E.g.analyser);
    if (UI.tab === 'devices') document.querySelectorAll('[data-an]').forEach(cv => { const n = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === cv.dataset.an)?.node; if (n?.analyser) spectrum(cv, n.analyser); });
    if (UI.tab === 'mixer') document.querySelectorAll('#mixer .ch').forEach(ch => { const s = E.stripFor(ch.dataset.kind, ch.dataset.id); if (s) meterDraw(ch.querySelector('.mtr'), peak(s.meter)); });
    if (UI.tab === 'devices') document.querySelectorAll('[data-gr]').forEach(el => { const f = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === el.dataset.gr)?.node; if (f?.meter) el.style.width = Math.min(100, -f.meter() * 5) + '%'; });
  }
  if (E.playing) {
    const w = $('#lanesWrap'), x = b * UI.ppb; if (x > w.scrollLeft + w.clientWidth - 40 || x < w.scrollLeft) w.scrollLeft = Math.max(0, x - 80);
    const fc = UI.tab === 'editor' && UI.clip && findClip(UI.clip);
    if (fc && isMidi(fc.c) && fc.t.inst === 'drums') {
      const L = E.loopLen(fc.c), st = fc.slot != null ? (E.live[fc.t.id]?.clip === fc.c ? E.live[fc.t.id].start : null) : fc.c.start;
      const i = st == null || b < st || (fc.slot == null && b >= st + fc.c.len) ? -1 : Math.floor((((b - st) % L) + L) % L * 4);
      document.querySelectorAll('#seq .st').forEach(s => s.classList.toggle('now', +s.dataset.i === i));
    }
    if (UI.view === 'session') for (const id in E.live) { const l = E.live[id], L = E.loopLen(l.clip), el = document.querySelector(`.srow[data-id="${id}"] .slot[data-slot="${l.slot}"] .prog`); if (el && b >= l.start) el.style.width = (((b - l.start) % L) / L * 100) + '%'; }
  }
  requestAnimationFrame(frame);
}
addEventListener('resize', () => { if (E.ctx) { renderLanes(); renderRuler(); if (UI.tab === 'devices') fitRack(); } });
try { const h = localStorage.getItem('rose:dockH'); if (h) document.documentElement.style.setProperty('--dockH', h); } catch { }
$('#dockgrip').addEventListener('pointerdown', e => {
  const g = e.target; g.setPointerCapture(e.pointerId);
  const mv = ev => { const h = Math.max(150, Math.min(innerHeight - 220, innerHeight - ev.clientY)); document.documentElement.style.setProperty('--dockH', h + 'px'); };
  const up = () => { g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); try { localStorage.setItem('rose:dockH', getComputedStyle(document.documentElement).getPropertyValue('--dockH')); } catch { } renderLanes(); if (UI.tab === 'devices') fitRack(); };
  g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up);
});
paintTransport();
