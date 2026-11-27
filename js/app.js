// Rose — UI: arrangement, track headers, piano roll, step sequencer, device rack, mixer, plugins, keyboard & MIDI.
import { Engine, clipRate, clipSemis, midiShift, bpmAt, secAt, barAt, barStart, tempoChanges, meterChanges, newTrack, newProject, blankProject, projectFromTemplate, uid, db, isMidi, upgrade, autoRange, SCENES, encodeWav } from './engine.js';
import { EFFECTS, worklet } from './effects.js';
import * as CG from './chordgen.js';
import { INSTRUMENTS, SYNTH_PRESETS, SOUND_LIB, DRUM_ROWS, instDefaults, ARP_PARAMS, CHORD_PARAMS, midiDefaults, applyMidiFx, chordOf } from './instruments.js';

const E = new Engine(); window.roseEngine = E;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI = { songRows: (() => { try { return localStorage.getItem('rose:songrows') === '1'; } catch { return false; } })(), track: null, clip: null, ppb: 44, snap: 0.25, tab: 'editor', dev: { kind: 'track', id: null }, oct: 4, hist: [], fut: [], prGrid: 0.25, prZoom: 1, peaks: new Map(), confirmNew: 0 };
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
async function boot(mode, tpl) {
  await E.start(); await restore();
  if (mode === 'blank') { E.p = blankProject(); E.p.audio = {}; }
  else if (mode === 'template') { E.p = projectFromTemplate(tpl); E.p.audio = {}; } else if (mode === 'demo' && !saved?.tracks) { E.p = newProject(); E.p.audio = {}; }
  await E.rebuild(); UI.track = P().tracks[0]?.id; UI.dev = { kind: 'track', id: UI.track };
  $('#startScreen').remove(); try { UI.lib = localStorage.getItem('rose:lib') !== '0'; } catch { UI.lib = true; }
  $('#lib').hidden = !UI.lib; document.body.classList.toggle('songrows', !!UI.songRows); renderLib(); render(); initMIDI(); requestAnimationFrame(frame); persist();
  if (mode === 'open') $('#fOpen').click();
  let helped = false; try { helped = !!localStorage.getItem('rose:helped'); localStorage.setItem('rose:helped', '1'); } catch { }
  if (!helped) toast('New here? Press ? for a 1-minute guide');
}
$('#bStart').onclick = () => boot('demo');
$('#bBlank').onclick = () => boot('blank');
$('#bOpenStart').onclick = () => boot('open');
// ---------- templates (shared with the desktop app) ----------
let TEMPLATES = null;
async function templates() {
  if (!TEMPLATES) try { TEMPLATES = (await (await fetch('templates/templates.json')).json()).templates; } catch { TEMPLATES = []; }
  return TEMPLATES;
}
const tplList = list => `<div class="tpl">${list.map(t => `<button data-tpl="${t.id}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span><i>${t.bpm} BPM · ${t.tracks.length} tracks</i></button>`).join('')}</div>`;
$('#bTplStart').onclick = async () => {
  const box = $('#startScreen .choices'); box.outerHTML = tplList(await templates()) + '<button class="tb" id="tplBack" style="margin-top:10px">Back</button>';
  $('#tplBack').onclick = () => location.reload();
  $('#startScreen').onclick = e => { const b = e.target.closest('[data-tpl]'); if (b) { b.querySelector('b').textContent = 'Loading sounds…'; boot('template', TEMPLATES.find(t => t.id === b.dataset.tpl)); } };
};
async function newFromTemplate() {
  closePops(); dialog('New song from a template', '<p class="small" style="margin:0 0 10px">Tracks, instruments, vocal chains and a starter idea — your current song stays in Undo.</p>' + tplList(await templates()));
  $('.help .tpl').onclick = async e => {
    const b = e.target.closest('[data-tpl]'); if (!b) return; b.querySelector('b').textContent = 'Loading sounds…';
    snapshot(); E.stop(); E.p = projectFromTemplate(TEMPLATES.find(t => t.id === b.dataset.tpl)); E.p.audio = {};
    UI.track = P().tracks[0].id; UI.dev = { kind: 'track', id: UI.track }; UI.clip = null; await commit(true); $('.help')?.remove(); toast(`${P().name} template ready — press Space`);
  };
}
$('#bTpl').onclick = newFromTemplate;

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
  if (v === 'sounds') { t.instParams.patch = opts.patch || 'Grand Piano'; t.name = t.instParams.patch; }
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
function render() { paintTransport(); renderHeads(); renderRuler(); renderLanes(); renderDock(); refreshWindows(); }
function beatsShown() { return Math.max(E.songEnd() + 16, P().loop.end + 8, 64, Math.ceil(($('#lanesWrap').clientWidth || 800) / UI.ppb) + 4); }

function renderHeads() {
  $('#hlist').innerHTML = P().tracks.map(t => {
    const grp = t.kind === 'group', members = grp ? P().tracks.filter(x => x.out === t.id).length : 0;
    const kind = grp ? `Group bus, ${members} track${members === 1 ? '' : 's'}` : t.kind === 'audio' ? 'Audio' : esc(INSTRUMENTS[t.inst]?.name);
    const outTo = !grp && t.out !== 'master' ? ' → ' + esc(trk(t.out)?.name || '') : '';
    const autoSel = t.autoShow ? `<select class="autosel" aria-label="Automation parameter">${autoTargets(t).map(([v, l]) => `<option value="${v}" ${v === t.autoShow ? 'selected' : ''}>${esc(l)}${t.auto.some(a => a.target === v && a.points.length) ? ' •' : ''}</option>`).join('')}</select>` : '';
    return `<div class="th ${t.id === UI.track ? 'sel' : ''}" data-id="${t.id}" style="--c:${t.color}">
    <div class="cs"></div><div class="body">
      <div class="row"><input class="name" value="${esc(t.name)}" aria-label="Track name">${t.transpose ? `<span class="tbadge" title="Track transpose — everything on this track sounds ${Math.abs(t.transpose)} semitone${Math.abs(t.transpose) > 1 ? 's' : ''} ${t.transpose > 0 ? 'higher' : 'lower'}">${t.transpose > 0 ? '+' : ''}${t.transpose}</span>` : ''}<button class="sm" data-act="menu" title="Track options" aria-label="Track options">⋯</button></div>
      <div class="row"><button class="sm m ${t.mute ? 'on' : ''}" data-act="mute" title="Mute">M</button><button class="sm s ${t.solo ? 'on' : ''}" data-act="solo" title="Solo">S</button>${grp ? '' : `<button class="sm a ${t.arm ? 'on' : ''}" data-act="arm" title="Arm for recording">●</button>`}<button class="sm au ${t.autoShow ? 'on' : ''} ${t.auto?.some(a => a.points.length) ? 'has' : ''}" data-act="auto" title="Show automation (draw volume, pan and effect changes over time)">A</button>
      <input class="vol" type="range" min="-60" max="6" step="0.5" value="${t.vol}" data-def="0" aria-label="Volume" title="${t.vol} dB"></div>
      ${autoSel || `<div class="kind">${kind}${t.inserts.length ? `, ${t.inserts.length} effect${t.inserts.length === 1 ? '' : 's'}` : ''}${outTo}</div>`}</div></div>`;
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
  m.innerHTML = items.map((it, i) => `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}><b>${esc(it.label)}</b><small>${esc(it.key || '')}</small></button>`).join('');
  document.body.append(m); const r = anchor.getBoundingClientRect(); m.style.top = Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4) + 'px'; m.style.left = Math.min(innerWidth - m.offsetWidth - 8, r.left) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-i]'); if (b) { m.remove(); items[+b.dataset.i].run(); } }; m.querySelector('button')?.focus();
  setTimeout(() => addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); removeEventListener('click', off); } }), 0);
}
function trackMenu(t, anchor) {
  const i = P().tracks.indexOf(t);
  menuAt(anchor, [
    { icon: '⇩', label: 'Bounce to audio', sub: 'Render this track with its effects to a new audio track', run: () => bounceInPlace(t) },
    { icon: '⧉', label: 'Duplicate track', sub: 'Copy clips, sound and effects', run: () => duplicateTrack(t) },
    { icon: '♯', label: `Transpose track${t.transpose ? ` (now ${t.transpose > 0 ? '+' : ''}${t.transpose})` : ''}`, sub: t.inst === 'drums' ? 'Drum kits keep their sounds in place' : 'Shift every clip on this track — audio and MIDI', disabled: t.inst === 'drums', run: () => transposeTrackDialog(t) },
    { icon: '●', label: 'Change colour', run: async () => { snapshot(); const C = ['#ff4f8b', '#ffb020', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6', '#f43f5e', '#eab308', '#06b6d4', '#f97316']; t.color = C[(C.indexOf(t.color) + 1) % C.length]; await commit(false); } },
    { icon: '↑', label: 'Move up', disabled: i === 0, run: async () => { snapshot(); [P().tracks[i - 1], P().tracks[i]] = [P().tracks[i], P().tracks[i - 1]]; await commit(false); } },
    { icon: '↓', label: 'Move down', disabled: i === P().tracks.length - 1, run: async () => { snapshot(); [P().tracks[i + 1], P().tracks[i]] = [P().tracks[i], P().tracks[i + 1]]; await commit(false); } },
    { icon: '×', label: 'Delete track', sub: 'You can undo', run: async () => { snapshot(); P().tracks = P().tracks.filter(x => x !== t); P().tracks.forEach(x => { if (x.out === t.id) x.out = 'master'; }); if (UI.track === t.id) UI.track = P().tracks[0]?.id; await commit(true); } }
  ]);
}
function transposeTrackDialog(t) {
  const v = t.transpose || 0;
  dialog(`Transpose ${t.name}`, `<p class="small" style="margin:0 0 12px">Moves everything on this track up or down without changing its speed — MIDI notes, audio and loops. Live keyboard playing follows too.</p>
    <div class="pitchctl big"><button data-tt="-12">−12</button><button data-tt="-1">−1</button><output id="ttv">${v > 0 ? '+' : ''}${v}</output><button data-tt="1">+1</button><button data-tt="12">+12</button><button data-tt="0" style="margin-left:12px">Reset</button></div>`);
  $('.help .pitchctl').onclick = async e => {
    const b = e.target.closest('[data-tt]'); if (!b) return; snapshot(); const d = +b.dataset.tt;
    t.transpose = d === 0 ? 0 : Math.max(-36, Math.min(36, (t.transpose || 0) + d)); if (!t.transpose) delete t.transpose;
    $('#ttv').textContent = `${t.transpose > 0 ? '+' : ''}${t.transpose || 0}`; await commit(false);
  };
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
  const n = beatsShown(), lp = P().loop, X = b => b * UI.ppb; let h = '';
  // bar numbers follow time-signature changes; skip labels when zoomed far out
  const every = UI.ppb * 4 < 26 ? 4 : UI.ppb * 4 < 44 ? 2 : 1;
  for (let k = 0, b = 0; b < n; k++, b = barStart(P(), k)) h += `<div class="bar ${k % every ? 'nolab' : ''}" style="left:${X(b)}px">${k % every ? '' : k + 1}</div>`;
  h += `<div class="loopr ${lp.on ? '' : 'off'}" style="left:${X(lp.start)}px;width:${X(lp.end - lp.start)}px" title="Loop — drag here to set, click Loop to toggle"></div>`;
  for (const m of P().markers || []) h += `<div class="mk" data-mk="${m.id}" style="left:${X(m.b)}px" title="${esc(m.name)} — click to jump · double-click to rename · right-click for options">${esc(m.name)}</div>`;
  for (const x of tempoChanges(P())) h += `<div class="tflag" data-tempo="1" style="left:${X(x.b)}px" title="Tempo change — click to edit">♩${+x.bpm.toFixed(2)}</div>`;
  for (const x of meterChanges(P())) h += `<div class="tflag sig" data-tempo="1" style="left:${X(x.b)}px" title="Time signature change — click to edit">${x.n}/4</div>`;
  if (UI.songRows) {
    h += `<div class="srow2 arrrow" data-row="sections" title="Arranger: drag across this row to make a section">${(P().sections || []).map(x => `<div class="sec" data-sec="${x.id}" style="left:${X(x.start)}px;width:${X(x.len)}px;--c:${x.color}" title="${esc(x.name)} — click to jump · double-click to rename · right-click for duplicate, delete, loop, move">${esc(x.name)}</div>`).join('')}</div>`;
    const ch = (P().chords || []).slice().sort((a, b) => a.b - b.b);
    h += `<div class="srow2 chordrow" data-row="chords" title="Chord track: click to add a chord">${ch.map((c, i) => `<div class="chd" data-chd="${c.id}" style="left:${X(c.b)}px;width:${X((ch[i + 1]?.b ?? c.b + barAt(P(), c.b).n) - c.b)}px" title="${esc(c.name)} — click to change · right-click to delete">${esc(c.name)}</div>`).join('')}</div>`;
  }
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
  if (e.target.closest('.mk,.tflag,.sec,.chd,.srow2')) return songRowDown(e, r);
  if (e.clientY - r.top > 22) { E.seek(Math.max(0, x0 / UI.ppb)); return; }
  const lp = P().loop; const move = ev => { const b = snapB((ev.clientX - r.left) / UI.ppb); lp.start = Math.max(0, Math.min(b0, b)); lp.end = Math.max(b0, b, lp.start + (UI.snap || 0.25)); lp.on = true; renderRuler(); paintTransport(); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); persist(); renderLanes(); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});

const clipName0 = c => c.pattern ? '⧉ ' + (P().patterns[c.pattern]?.name || c.name) : (c.name || (isMidi(c) ? 'MIDI' : audioName(c.sample)));
const clipName = c => { const v = clipPitch(c); return clipName0(c) + (v ? ` · ${v > 0 ? '+' : ''}${v} st` : '') + (c.bpm ? ' · ⟲' : ''); };
function renderLanes() {
  if (UI.view === 'session') return renderSession();
  const n = beatsShown(), w = n * UI.ppb, lp = P().loop, sl = ($('#lanesWrap').scrollLeft || 0) + 14;
  $('#lanes').style.width = w + 'px';
  $('#lanes').innerHTML = (lp.on ? `<div class="loopshade" style="left:${lp.start * UI.ppb}px;width:${(lp.end - lp.start) * UI.ppb}px"></div>` : '') +
    P().tracks.map(t => {
      const hint = t.kind === 'group' ? 'Group bus — in the Mixer, set other tracks’ Out to this group' : t.clips.length ? '' : t.kind === 'audio' ? 'Drop an audio file here, or arm ● and press Record' : 'Double-click here to draw notes · or arm ● and record from your keyboard';
      return `<div class="lane ${t.autoShow ? 'autoon' : ''}" data-id="${t.id}" style="--c:${t.color};background-image:repeating-linear-gradient(90deg,var(--grid) 0 1px,transparent 1px ${UI.ppb}px),repeating-linear-gradient(90deg,var(--line) 0 1px,transparent 1px ${UI.ppb * P().sig}px)">${hint && !t.autoShow ? `<span class="lanehint" style="left:${sl}px">${hint}</span>` : ''}${t.clips.map(c =>
      `<div class="clip ${c.id === UI.clip ? 'sel' : ''} ${c.pattern ? 'pat' : ''}" data-clip="${c.id}" style="left:${c.start * UI.ppb}px;width:${Math.max(6, c.len * UI.ppb)}px"><span class="cn">${c.loopLen && c.loopLen < c.len ? '↻ ' : ''}${esc(clipName(c))}</span><canvas></canvas>${isMidi(c) ? '' : '<div class="fh in" title="Drag: fade in"></div><div class="fh out" title="Drag: fade out"></div>'}<div class="rs" title="Drag: resize"></div><div class="lh" title="Drag: loop the clip (repeat it)"></div></div>`).join('')}${t.autoShow ? autoSvg(t, w) : ''}</div>`;
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
  if (e.button === 2) return;
  if (UI.tool === 'split' || e.altKey) { const r = el.getBoundingClientRect(); splitAt(fc, snapB(fc.c.start + (e.clientX - r.left) / UI.ppb)); return; }
  const fh = e.target.closest('.fh');
  if (fh) {
    const c = fc.c, which = fh.classList.contains('in') ? 'fadeIn' : 'fadeOut', x0f = e.clientX, v0 = c[which] || 0; snapshot(); fh.setPointerCapture(e.pointerId);
    const mv = ev => { const d = (ev.clientX - x0f) / UI.ppb * (which === 'fadeIn' ? 1 : -1); c[which] = Math.max(0, Math.min(c.len / 2, Math.round((v0 + d) * 16) / 16)); renderLanes(); toastQuiet(`${which === 'fadeIn' ? 'Fade in' : 'Fade out'}: ${c[which].toFixed(2)} beats`); };
    const up2 = () => { fh.removeEventListener('pointermove', mv); fh.removeEventListener('pointerup', up2); persist(); if (UI.tab === 'editor') renderEditor(); };
    fh.addEventListener('pointermove', mv); fh.addEventListener('pointerup', up2); return;
  }
  const loopDrag = e.target.classList.contains('lh');
  if (loopDrag && !fc.c.pattern && !fc.c.loopLen) fc.c.loopLen = fc.c.len;
  const resize = e.target.classList.contains('rs') || loopDrag, x0 = e.clientX, y0 = e.clientY, s0 = fc.c.start, l0 = fc.c.len; let moved = false, src = fc.t;
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
  if ([...(e.dataTransfer?.types || [])].some(t => t.startsWith('application/x-rose'))) return;
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
    const LL = c.loopLen && c.loopLen < c.len ? c.loopLen : c.len;
    for (let x = 0; x < W; x++) { const bb = x / W * c.len, within = bb % LL; if (LL < c.len && within < c.len / W) { g.globalAlpha = .5; g.fillRect(x, 0, 1, H); g.globalAlpha = 1; } const sec = (c.offset || 0) + within * E.spb * clipRate(c, P().bpm), i = Math.floor(sec * sr); if (i >= pk.length) continue; const a = pk[i] * mid * db(c.gain || 0); g.fillRect(x, mid - a, 1, Math.max(1, a * 2)); }
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
  const t = trk(UI.track); $('#dockinfo').textContent = t ? `${t.name}${UI.clip ? ' / ' + (findClip(UI.clip)?.c.name || '') : ''}` : '';
  if (UI.tab === 'editor') renderEditor(); else if (UI.tab === 'devices') renderDevices(); else if (UI.tab === 'mixer') renderMixer(); else renderPlugins();
}

// ---------- editor: piano roll / step sequencer / audio clip ----------
function renderEditor() {
  const fc = UI.clip && findClip(UI.clip), box = $('#editor');
  if (!fc) { box.innerHTML = `<div class="empty">Select a clip to edit it. Double-click an empty spot on an instrument track to make a new MIDI clip, or drop audio files onto the arrangement.</div>`; return; }
  renderEditorInto(fc, box);
}
function renderEditorInto(fc, box) {
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
  const pv = clipPitch(ref), pitchCtl = `<span class="pitchctl" title="Pitch in semitones — Alt+↑/↓, add Shift for an octave"><span>Pitch</span><button data-pt="-12" aria-label="Down an octave">−12</button><button data-pt="-1" aria-label="Down a semitone">−1</button><output id="cPitch">${pv > 0 ? '+' : ''}${pv}</output><button data-pt="1" aria-label="Up a semitone">+1</button><button data-pt="12" aria-label="Up an octave">+12</button></span>`;
  return `<div class="prbar"><input id="cName" value="${esc(fc.c.name)}" aria-label="${pat ? 'Pattern' : 'Clip'} name" style="width:140px;cursor:text"><label>${pat ? 'Pattern length' : 'Length'} <input id="cLen" type="number" min="0.25" step="0.25" value="${+fc.c.len.toFixed(3)}" style="width:72px;cursor:text"> beats</label>${fc.t?.inst === 'drums' ? '' : pitchCtl}${extra}${patBits}${midi ? '<button id="cMid">Export .mid</button>' : ''}${box_pop(fc)}${where}${!pat ? `<button id="cLoop" class="${ref.loopLen ? 'on' : ''}" title="Loop: repeat this clip's content when you stretch it (Logic: L)">${ref.loopLen ? '↻ Loop on' : '↻ Loop'}</button>` : ''}<button id="cDup">Duplicate →</button><button id="cDel">Delete clip</button></div>`;
}
// Pitch of any clip: MIDI clips transpose their notes, audio clips use the pitch engine (speed unchanged)
const clipPitch = c => isMidi(c) ? (c.transpose || 0) : (c.pitch || 0);
function pitchClips(clips, d) {
  clips = clips.filter(c => !(isMidi(c) && P().tracks.find(t => t.clips.includes(c))?.inst === 'drums'));
  if (!clips.length) return toast('Drum kits don’t transpose — each note is a different drum'); snapshot();
  for (const c of clips) { const k = isMidi(c) ? 'transpose' : 'pitch'; c[k] = Math.max(-48, Math.min(48, (c[k] || 0) + d)); if (!c[k]) delete c[k]; }
  commit(false); const v = clipPitch(clips[0]); toast(`${clips.length > 1 ? clips.length + ' clips' : 'Clip'} pitch ${v > 0 ? '+' : ''}${v} st`);
}
function bindClipBar(fc, box = document) {
  const $ = s => box.querySelector(s);
  box.querySelectorAll('.pitchctl [data-pt]').forEach(b => b.onclick = () => pitchClips([fc.ref || fc.c], +b.dataset.pt));
  if ($('#cPitch')) $('#cPitch').ondblclick = () => { const c = fc.ref || fc.c; if (clipPitch(c)) pitchClips([c], -clipPitch(c)); };
  $('#cName').onchange = e => { snapshot(); fc.c.name = e.target.value; commit(false); };
  $('#cLen').onchange = e => { snapshot(); fc.c.len = Math.max(0.25, +e.target.value || 4); commit(false); };
  if ($('#cMid')) $('#cMid').onclick = () => download(midiFile(fc.c, P().bpm), (fc.c.name || 'clip') + '.mid');
  $('#cDup').onclick = () => duplicateClip(); $('#cDel').onclick = () => deleteClip();
  if ($('#cLoop')) $('#cLoop').onclick = () => toggleClipLoop();
  const ref = fc.ref || fc.c;
  if ($('#cPattern')) $('#cPattern').onclick = async () => { snapshot(); const id = uid(); P().patterns[id] = { name: ref.name || 'Pattern', len: ref.len, notes: ref.notes }; delete ref.notes; ref.pattern = id; await commit(false); toast('Now a pattern — duplicate it and every copy stays linked'); };
  if ($('#cUnique')) $('#cUnique').onclick = async () => { snapshot(); const pt = P().patterns[ref.pattern], notes = []; for (let b = 0; b < ref.len; b += pt.len) for (const n of pt.notes) if (b + n.s < ref.len) notes.push({ ...n, s: b + n.s }); ref.notes = notes; ref.name = pt.name; delete ref.pattern; await commit(false); toast('This copy is now independent'); };
  if ($('#cToSes')) $('#cToSes').onclick = async () => { const sl = E.slots(fc.t.id), i = sl.findIndex(x => !x); if (i < 0) return toast('All 8 session slots on this track are full'); snapshot(); sl[i] = { ...JSON.parse(JSON.stringify(ref)), id: uid(), start: 0 }; await commit(false); setView('session'); toast(`Copied to Session, scene ${i + 1}`); };
  if ($('#cToArr')) $('#cToArr').onclick = async () => { snapshot(); const b = Math.floor(E.position() / P().sig) * P().sig; const c = { ...JSON.parse(JSON.stringify(ref)), id: uid(), start: b }; fc.t.clips.push(c); await commit(false); toast('Copied to the arrangement at bar ' + (b / P().sig + 1)); };
}
function renderPianoRoll(fc, box) {
  const $ = s => box.querySelector(s);   // scoped: several editors can be open at once
  const grids = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 };
  box.innerHTML = clipBar(fc, `<select id="prGrid" aria-label="Grid">${Object.entries(grids).map(([k, v]) => `<option value="${v}" ${v === UI.prGrid ? 'selected' : ''}>Grid ${k}</option>`).join('')}</select>
    <button id="prQ">Quantize</button><select id="prSw" aria-label="Swing" title="Swing applied by Quantize"><option value="0">Straight</option><option value="0.1">Swing 10%</option><option value="0.2">Swing 20%</option><option value="0.33">Swing 33%</option><option value="0.5">Swing 50%</option></select><button id="prHum" title="Cubase-style humanize: tiny random timing and velocity changes">Humanize</button><button id="prLeg" title="Stretch each note to the next one">Legato</button><button id="prVel" title="Velocity: louder (+) / Shift-click softer">Vel ±</button><button id="prUp">Oct +</button><button id="prDn">Oct −</button><label>Zoom <input id="prZ" data-def="1" type="range" min="0.5" max="3" step="0.1" value="${UI.prZoom}" style="width:90px;padding:0"></label>`) +
    `<div class="prwrap" id="prwrap"><canvas id="pr"></canvas></div>`;
  bindClipBar(fc, box);
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
    for (let p = LO; p <= HI; p++) { const black = [1, 3, 6, 8, 10].includes(p % 12); g.fillStyle = black ? '#222' : '#f4f1ec'; g.fillRect(0, yOf(p), KW, RH); g.fillStyle = '#999'; g.fillRect(0, yOf(p) + RH - 1, KW, 1); if (p % 12 === 0) { g.fillStyle = '#333'; g.font = '9px "IBM Plex Sans", sans-serif'; g.fillText(nname(p), 4, yOf(p) + 10); } }
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
  const $ = s => box.querySelector(s);
  const steps = Math.round(fc.c.len * 4);
  box.innerHTML = clipBar(fc, `<span class="dockinfo" style="margin:0">Click a step to toggle · Shift-click for an accent · click a name to hear it</span>`) +
    `<div class="seq" id="seq" style="grid-template-columns:110px repeat(${steps},minmax(18px,1fr));--c:${fc.t.color}">${DRUM_ROWS.map(([p, nm]) =>
      `<div class="rl" data-p="${p}">${nm}</div>` + [...Array(steps)].map((_, i) => { const n = fc.c.notes.find(n => n.p === p && Math.abs(n.s - i / 4) < 1e-6); return `<button class="st ${i % 4 === 0 ? 'beat' : ''} ${n ? 'on' : ''}" data-p="${p}" data-i="${i}" style="${n && n.v < 0.85 ? 'opacity:.6' : ''}" aria-label="${nm} step ${i + 1}"></button>`; }).join('')).join('')}</div>`;
  bindClipBar(fc, box);
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
function regionPeak(b, c) { const sr = b.sampleRate, s0 = Math.floor((c.offset || 0) * sr), s1 = Math.min(b.length, s0 + Math.floor(c.len * E.spb * clipRate(c, P().bpm) * sr)); let m = 0; for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch); for (let i = s0; i < s1; i++) { const v = Math.abs(d[i]); if (v > m) m = v; } } return m; }
function renderAudioEditor(fc, box) {
  const $ = s => box.querySelector(s);
  const c = fc.c, b = E.buffers.get(c.sample);
  box.innerHTML = clipBar(fc) + `<div class="dev" style="max-width:none"><div class="ps">
    <div class="pr"><label>Gain</label><input id="aG" data-def="0" type="range" min="-24" max="12" step="0.1" value="${c.gain || 0}"><output>${(c.gain || 0).toFixed(1)} dB</output></div>
    <div class="pr"><label>Trim start</label><input id="aO" data-def="0" type="range" min="0" max="${b ? b.duration.toFixed(2) : 0}" step="0.01" value="${c.offset || 0}"><output>${(c.offset || 0).toFixed(2)} s</output></div>
    <div class="pr"><label>Source</label><span>${esc(audioName(c.sample))} · ${b ? b.duration.toFixed(1) + ' s' : 'missing audio'}</span></div>
    <div class="pr"><label>Fade in</label><input id="aFi" data-def="0" type="range" min="0" max="${Math.max(0.25, c.len / 2).toFixed(2)}" step="0.0625" value="${c.fadeIn || 0}"><output>${(c.fadeIn || 0).toFixed(2)} beats</output></div>
    <div class="pr"><label>Fade out</label><input id="aFo" data-def="0" type="range" min="0" max="${Math.max(0.25, c.len / 2).toFixed(2)}" step="0.0625" value="${c.fadeOut || 0}"><output>${(c.fadeOut || 0).toFixed(2)} beats</output></div>
    <div class="pr"><label title="Fine pitch, in cents (100 = one semitone)">Fine pitch</label><input id="aFine" data-def="0" type="range" min="-100" max="100" step="1" value="${c.fine || 0}"><output>${c.fine || 0} ¢</output></div>
    ${c.bpm ? `<div class="pr"><label title="Library loops stretch to the song tempo">Tempo</label><span>Follows the song · recorded at ${+c.bpm.toFixed(1)} BPM <button id="aWarp" title="Stop following the tempo (keep the current speed)">Unlock</button></span></div>`
      : `<div class="pr"><label title="Varispeed: like a turntable, speed and pitch change together">Varispeed</label><input id="aRate" data-def="0" type="range" min="-12" max="12" step="1" value="${Math.round(12 * Math.log2(clipRate(c, P().bpm)))}"><output>${Math.round(12 * Math.log2(clipRate(c, P().bpm)))} st</output></div>`}
    <div class="pr"><label title="Strip Silence threshold">Silence below</label><input id="aTh" data-def="-40" type="range" min="-70" max="-10" step="1" value="${UI.stripTh || -40}"><output>${UI.stripTh || -40} dB</output></div>
    <div class="prbar"><button id="aFit">Fit length to audio</button><button id="aSplit">Split at playhead (Ctrl+E)</button><button id="aStrip" title="Pro Tools Strip Silence: cut the clip into pieces wherever it's quiet">Strip silence</button><button id="aNorm" title="Raise the clip gain so its loudest peak hits -0.3 dB">Normalize</button><button id="aRev" title="Play the clip backwards">Reverse</button></div></div></div>`;
  bindClipBar(fc, box);
  $('#aG').oninput = e => { c.gain = +e.target.value; e.target.nextElementSibling.textContent = c.gain.toFixed(1) + ' dB'; renderLanes(); };
  $('#aG').onchange = () => { persist(); };
  $('#aO').oninput = e => { c.offset = +e.target.value; e.target.nextElementSibling.textContent = c.offset.toFixed(2) + ' s'; renderLanes(); };
  $('#aO').onchange = () => persist();
  $('#aFit').onclick = () => { if (!b) return; snapshot(); c.len = (b.duration - (c.offset || 0)) / E.spb / clipRate(c, P().bpm); commit(false); };
  const live = (id, key, fmt2) => { $(id).onpointerdown = () => snapshot(); $(id).oninput = e => { c[key] = +e.target.value; e.target.nextElementSibling.textContent = fmt2(c[key]); renderLanes(); }; $(id).onchange = () => persist(); };
  live('#aFi', 'fadeIn', v => v.toFixed(2) + ' beats'); live('#aFo', 'fadeOut', v => v.toFixed(2) + ' beats');
  if ($('#aRate')) { $('#aRate').onpointerdown = () => snapshot(); $('#aRate').oninput = e => { c.rate = Math.pow(2, +e.target.value / 12); e.target.nextElementSibling.textContent = e.target.value + ' st'; renderLanes(); }; $('#aRate').onchange = () => persist(); }
  live('#aFine', 'fine', v => v + ' ¢');
  if ($('#aWarp')) $('#aWarp').onclick = () => {   // keep sounding exactly the same, but as a fixed-speed clip
    snapshot(); const rate = P().bpm / c.bpm, tot = (c.pitch || 0) + (c.fine || 0) / 100 - (c.keepPitch !== false ? 12 * Math.log2(rate) : 0);
    c.rate = rate; c.pitch = Math.trunc(tot); c.fine = Math.round((tot - c.pitch) * 100); delete c.bpm; commit(false); toast('Loop unlocked — it keeps this speed');
  };
  $('#aTh').oninput = e => { UI.stripTh = +e.target.value; e.target.nextElementSibling.textContent = e.target.value + ' dB'; };
  $('#aNorm').onclick = () => { if (!b) return; const pk = regionPeak(b, c); if (pk <= 0) return toast('This clip is silent'); snapshot(); c.gain = +(-20 * Math.log10(pk) - 0.3).toFixed(1); commit(false); toast(`Clip gain set to ${c.gain > 0 ? '+' : ''}${c.gain} dB`); };
  $('#aRev').onclick = async () => {
    if (!b) return; const nb = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
    for (let ch = 0; ch < b.numberOfChannels; ch++) { const d = b.getChannelData(ch).slice().reverse(); nb.copyToChannel(d, ch); }
    const id = await E.addAudio(await encodeWav(nb).arrayBuffer(), audioName(c.sample) + ' (reversed)'); if (!id) return; snapshot();
    P().audio[id] = { name: audioName(c.sample) + ' (reversed)' }; const used = c.len * E.spb * clipRate(c, P().bpm); c.offset = Math.max(0, b.duration - (c.offset || 0) - used); c.sample = id; await commit(false); toast('Reversed');
  };
  $('#aStrip').onclick = async () => {
    if (!b) return; const th = Math.pow(10, (UI.stripTh || -40) / 20), rate = clipRate(c, P().bpm), sr = b.sampleRate, win = Math.floor(sr * 0.01);
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


// ---------- song tools: markers, arranger sections, chord track, tempo & time-signature changes ----------
function setSongRows(v) { UI.songRows = v; document.body.classList.toggle('songrows', v); try { localStorage.setItem('rose:songrows', v ? '1' : '0'); } catch { } renderRuler(); }
const SEC_NAMES = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Verse 2', 'Chorus 2', 'Bridge', 'Drop', 'Breakdown', 'Outro'];
const SEC_COLORS = ['#5b8def', '#3fb68b', '#d9a441', '#e0708a', '#9b7be0', '#46b5c8', '#e07d4f', '#8fb04a'];
function songTimeEach(fn) {   // every time-based thing in the song, for moving whole regions
  const p = P();
  for (const t of p.tracks) { t.clips.forEach(c => fn(c, 'start')); (t.auto || []).forEach(a => a.points.forEach(pt => fn(pt, 'b'))); }
  (p.markers || []).forEach(m => fn(m, 'b')); (p.chords || []).forEach(c => fn(c, 'b')); (p.tempo || []).forEach(x => fn(x, 'b')); (p.meter || []).forEach(x => fn(x, 'b'));
}
function splitAllAt(b) { for (const t of P().tracks) for (const c of [...t.clips]) splitRaw(t, c, b); }
function insertTime(at, len) {
  songTimeEach((o, k) => { if (o[k] >= at - 1e-9) o[k] += len; });
  (P().sections || []).forEach(x => { if (x.start >= at - 1e-9) x.start += len; });
  const lp = P().loop; if (lp.start >= at) { lp.start += len; lp.end += len; }
}
function removeTime(s0, e0) {   // assumes everything was split at s0 and e0
  const len = e0 - s0, p = P();
  for (const t of p.tracks) { t.clips = t.clips.filter(c => !(c.start >= s0 - 1e-9 && c.start < e0 - 1e-9)); (t.auto || []).forEach(a => a.points = a.points.filter(pt => !(pt.b >= s0 && pt.b < e0))); }
  for (const k of ['markers', 'chords', 'tempo', 'meter']) if (p[k]) p[k] = p[k].filter(x => !(x.b >= s0 && x.b < e0));
  songTimeEach((o, k) => { if (o[k] >= e0 - 1e-9) o[k] -= len; });
  p.sections = (p.sections || []).filter(x => !(x.start >= s0 - 1e-9 && x.start < e0 - 1e-9)); p.sections.forEach(x => { if (x.start >= e0 - 1e-9) x.start -= len; });
}
function copyRegion(s0, e0) {   // deep copies of everything inside [s0, e0), positioned relative to s0
  const p = P(), cp = { clips: [], auto: [], markers: [], chords: [] };
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.start >= s0 - 1e-9 && c.start < e0 - 1e-9) cp.clips.push({ tid: t.id, c: { ...JSON.parse(JSON.stringify(c)), id: uid(), start: c.start - s0 } });
    for (const a of t.auto || []) for (const pt of a.points) if (pt.b >= s0 && pt.b < e0) cp.auto.push({ tid: t.id, aid: a.id, pt: { ...pt, b: pt.b - s0 } });
  }
  for (const m of p.markers || []) if (m.b >= s0 && m.b < e0) cp.markers.push({ ...m, id: uid(), b: m.b - s0 });
  for (const c of p.chords || []) if (c.b >= s0 && c.b < e0) cp.chords.push({ ...c, id: uid(), b: c.b - s0 });
  return cp;
}
function pasteRegion(cp, at) {
  const p = P();
  for (const { tid, c } of cp.clips) { const t = trk(tid); if (t) t.clips.push({ ...c, start: c.start + at }); }
  for (const { tid, aid, pt } of cp.auto) { const a = trk(tid)?.auto?.find(x => x.id === aid); if (a) { a.points.push({ ...pt, b: pt.b + at }); a.points.sort((x, y) => x.b - y.b); } }
  (p.markers ||= []).push(...cp.markers.map(m => ({ ...m, b: m.b + at }))); (p.chords ||= []).push(...cp.chords.map(c => ({ ...c, b: c.b + at })));
}
const sec = id => (P().sections || []).find(x => x.id === id);
async function duplicateSection(x) {
  snapshot(); const s0 = x.start, e0 = x.start + x.len; splitAllAt(s0); splitAllAt(e0);
  const cp = copyRegion(s0, e0); insertTime(e0, x.len); pasteRegion(cp, e0);
  P().sections.push({ ...x, id: uid(), start: e0, name: x.name.replace(/( \d+)?$/, m => ' ' + ((+m || 1) + 1)) });
  await commit(true); toast(`${x.name} duplicated — everything after it moved ${x.len / barAt(P(), s0).n} bars later`);
}
async function deleteSection(x, keepTime) {
  snapshot(); const s0 = x.start, e0 = x.start + x.len; splitAllAt(s0); splitAllAt(e0);
  if (keepTime) { for (const t of P().tracks) t.clips = t.clips.filter(c => !(c.start >= s0 - 1e-9 && c.start < e0 - 1e-9)); P().sections = P().sections.filter(y => y !== x); }
  else removeTime(s0, e0);
  await commit(true); toast(keepTime ? `${x.name} cleared` : `${x.name} removed — the song closed the gap`);
}
async function moveSection(x, dir) {
  const list = (P().sections || []).slice().sort((a, b) => a.start - b.start), i = list.indexOf(x), other = list[i + dir]; if (!other) return toast(dir < 0 ? 'Already the first section' : 'Already the last section');
  snapshot(); const s0 = x.start, e0 = x.start + x.len, len = x.len; splitAllAt(s0); splitAllAt(e0);
  const cp = copyRegion(s0, e0), meta = { ...x }; removeTime(s0, e0);
  const target = dir < 0 ? other.start : other.start + other.len;   // positions after the removal
  splitAllAt(target); insertTime(target, len); pasteRegion(cp, target); P().sections.push({ ...meta, start: target });
  await commit(true); toast(`${x.name} moved ${dir < 0 ? 'before' : 'after'} ${other.name}`);
}
function sectionMenu(x, ev) {
  const at = { getBoundingClientRect: () => ({ left: ev.clientX, bottom: ev.clientY, top: ev.clientY }) };
  menuAt(at, [
    { icon: '↻', label: 'Loop this section', run: () => { const lp = P().loop; lp.start = x.start; lp.end = x.start + x.len; lp.on = true; persist(); renderRuler(); renderLanes(); paintTransport(); } },
    { icon: '⧉', label: 'Duplicate', sub: 'Copies its clips, chords and automation right after it', run: () => duplicateSection(x) },
    { icon: '←', label: 'Move earlier', run: () => moveSection(x, -1) }, { icon: '→', label: 'Move later', run: () => moveSection(x, 1) },
    { icon: '✎', label: 'Rename', run: () => renameThing(x, 'name', 'Section name') },
    { icon: '●', label: 'Change colour', run: () => { snapshot(); x.color = SEC_COLORS[(SEC_COLORS.indexOf(x.color) + 1) % SEC_COLORS.length]; commit(false); } },
    { icon: '⌫', label: 'Clear contents', sub: 'Keeps the empty bars', run: () => deleteSection(x, true) },
    { icon: '×', label: 'Delete section', sub: 'Removes the bars and closes the gap', run: () => deleteSection(x, false) },
  ]);
}
function renameThing(o, key, label) {
  dialog(label, `<input id="rnm" value="${esc(o[key])}" style="width:100%;font-size:15px;padding:8px" aria-label="${label}"><div class="prbar" style="margin-top:10px"><button id="rnmOk" class="on">Save</button></div>`);
  const i = $('#rnm'); i.focus(); i.select();
  const ok = () => { snapshot(); o[key] = i.value.trim() || o[key]; $('.help')?.remove(); commit(false); };
  $('#rnmOk').onclick = ok; i.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') $('.help')?.remove(); };
}
function addMarker(b = E.position(), name) {
  snapshot(); const p = P(); (p.markers ||= []).push({ id: uid(), b: snapB(b), name: name || `Marker ${p.markers.length + 1}` }); p.markers.sort((x, y) => x.b - y.b);
  commit(false); toast('Marker added — double-click it to rename');
}
function jumpMarker(dir) {
  const b = E.position(), list = [...(P().markers || []).map(m => m.b), ...(P().sections || []).map(x => x.start)].sort((x, y) => x - y);
  const t = dir > 0 ? list.find(x => x > b + 0.05) : list.reverse().find(x => x < b - 0.25); if (t != null) E.seek(t);
}
// ---- chords ----
const CHORD_Q = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus2: [0, 2, 7], sus4: [0, 5, 7], dim: [0, 3, 6], aug: [0, 4, 8], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], add9: [0, 4, 7, 14] };
const parseChord = name => { const m = /^([A-G][#b]?)(.*)$/.exec(name || ''); if (!m) return null; const root = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }[m[1]] || m[1]; const q = CHORD_Q[m[2]] ? m[2] : m[2] === 'maj' ? '' : m[2] === 'min' ? 'm' : null; return q == null || !KEY12.includes(root) ? null : { root: KEY12.indexOf(root), q, iv: CHORD_Q[q] }; };
function chordDialog(at, existing) {
  const cur = existing ? parseChord(existing.name) : null;
  dialog(existing ? 'Change chord' : `Add a chord at bar ${barAt(P(), at).bar + 1}`, `<div class="chordpick"><div>${KEY12.map((k, i) => `<button data-root="${i}" class="${cur?.root === i ? 'on' : ''}">${k}</button>`).join('')}</div>
    <div>${Object.keys(CHORD_Q).map(q => `<button data-q="${q}" class="${cur && cur.q === q ? 'on' : ''}">${q || 'maj'}</button>`).join('')}</div>
    <p class="small" style="margin:8px 0 0">Pick a root, then a quality. ${existing ? '<button id="chDel">Delete chord</button>' : ''}</p></div>`);
  let root = cur?.root ?? null;
  $('.help .chordpick').onclick = async e => {
    const r = e.target.closest('[data-root]'), q = e.target.closest('[data-q]');
    if (r) { root = +r.dataset.root; $('.help').querySelectorAll('[data-root]').forEach(x => x.classList.toggle('on', x === r)); E.liveOn(UI.track, 60 + root, 0.7); setTimeout(() => E.liveOff(UI.track, 60 + root), 300); return; }
    if (e.target.id === 'chDel') { snapshot(); P().chords = P().chords.filter(c => c !== existing); $('.help').remove(); await commit(false); return; }
    if (q && root != null) {
      snapshot(); const name = KEY12[root] + q.dataset.q;
      if (existing) existing.name = name; else { (P().chords ||= []).push({ id: uid(), b: at, name }); P().chords.sort((x, y) => x.b - y.b); }
      $('.help').remove(); await commit(false); toast(`${name} at bar ${barAt(P(), at).bar + 1}`);
    } else if (q) toast('Pick a root note first');
  };
}
// name the chord that best matches a set of pitch classes (weighted by how long each note sounds)
function nameChord(weights) {
  let best = null, bs = 0.2;
  for (let r = 0; r < 12; r++) for (const [q, iv] of Object.entries(CHORD_Q)) {
    if (q === 'add9') continue; const set = iv.map(x => (r + x) % 12); let hit = 0, miss = 0;
    for (let pc = 0; pc < 12; pc++) (set.includes(pc) ? (hit += weights[pc]) : (miss += weights[pc]));
    const score = hit - miss * 0.6 - (iv.length > 3 ? 0.06 : 0) + (weights[r] > 0 ? 0.08 : 0);
    if (score > bs) { bs = score; best = KEY12[r] + q; }
  }
  return best;
}
async function detectChords() {
  const p = P(), end = E.songEnd(); const out = [];
  for (let k = 0, b = 0; b < end; k++, b = barStart(p, k)) {
    const e = barStart(p, k + 1), w = new Array(12).fill(0);
    for (const t of p.tracks) { if (t.kind !== 'inst' || t.inst === 'drums' || t.mute) continue;
      for (const c of t.clips) { if (!isMidi(c)) continue; const L = E.loopLen(c), ns = E.notesOf(c), tp = midiShift(c, t);
        for (let o = 0; o < c.len; o += L) for (const n of ns) { const s0 = c.start + o + n.s, s1 = s0 + Math.min(n.l, L - n.s); if (n.s >= L || s0 >= c.start + c.len) continue; const ov = Math.min(s1, e) - Math.max(s0, b); if (ov > 0) w[(n.p + tp) % 12] += ov * n.v; } } }
    const tot = w.reduce((a, x) => a + x, 0); if (tot <= 0) continue; const name = nameChord(w.map(x => x / tot));
    if (name && out.at(-1)?.name !== name) out.push({ id: uid(), b, name });
  }
  if (!out.length) return toast('No MIDI notes to read chords from — add a chord by clicking the chord row');
  snapshot(); p.chords = out; setSongRows(true); await commit(false); toast(`Found ${out.length} chord${out.length > 1 ? 's' : ''} — click any to change it`);
}
async function chordsToMidi(kind) {
  const p = P(), ch = (p.chords || []).slice().sort((a, b) => a.b - b.b); if (!ch.length) return toast('The chord track is empty — add chords or use Detect chords');
  let t = trk(UI.track); if (!t || t.kind !== 'inst' || t.inst === 'drums') return toast('Select an instrument track (not drums) first');
  const notes = [], end = Math.max(E.songEnd(), ch.at(-1).b + barAt(p, ch.at(-1).b).n);
  ch.forEach((c, i) => { const pc = parseChord(c.name); if (!pc) return; const s0 = c.b, s1 = ch[i + 1]?.b ?? end, L = s1 - s0;
    if (kind === 'bass') { notes.push({ p: 36 + pc.root, s: s0, l: L * 0.95, v: 0.85 }); return; }
    const base = 48 + pc.root + (pc.root > 6 ? -12 : 0), voiced = pc.iv.map(x => base + x).map(n => n < 55 ? n + 12 : n).sort((a, b) => a - b);   // close voicing around middle C
    if (kind === 'stabs') for (let b = s0; b < s1 - 1e-9; b += 1) voiced.forEach(n => notes.push({ p: n, s: b + 0.5, l: 0.25, v: 0.8 }));
    else voiced.forEach(n => notes.push({ p: n, s: s0, l: L * 0.98, v: 0.7 }));
  });
  snapshot(); const start = ch[0].b; t.clips.push({ id: uid(), name: kind === 'bass' ? 'Bass from chords' : kind === 'stabs' ? 'Stabs from chords' : 'Chords', start, len: end - start, notes: notes.map(n => ({ ...n, s: n.s - start })) });
  await commit(true); toast(`${kind === 'bass' ? 'Bass line' : kind === 'stabs' ? 'Off-beat stabs' : 'Chord pad'} written to ${t.name}`);
}
// ---- ruler interactions ----
function songRowDown(e, r) {
  const row = e.target.closest('.srow2'); if (!row || e.target.closest('.sec,.chd') || row.dataset.row !== 'sections' || e.button !== 0) return;
  // drag across the arranger row to make a section (whole bars)
  const p = P(), b0 = barAt(p, Math.max(0, (e.clientX - r.left) / UI.ppb)).start; const ghost = document.createElement('div'); ghost.className = 'sec ghost'; row.append(ghost);
  let b1 = barStart(p, barAt(p, b0).bar + 1);
  const mv = ev => { const bb = Math.max(0, (ev.clientX - r.left) / UI.ppb), bi = barAt(p, bb); b1 = Math.max(barStart(p, barAt(p, b0).bar + 1), bi.start + (bi.beat > 0.01 ? bi.n : 0)); ghost.style.left = b0 * UI.ppb + 'px'; ghost.style.width = (b1 - b0) * UI.ppb + 'px'; };
  const up = async () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); ghost.remove();
    if ((p.sections || []).some(x => x.start < b1 - 1e-9 && x.start + x.len > b0 + 1e-9)) return toast('Sections can’t overlap');
    snapshot(); const n = (p.sections || []).length; (p.sections ||= []).push({ id: uid(), start: b0, len: b1 - b0, name: SEC_NAMES[n % SEC_NAMES.length], color: SEC_COLORS[n % SEC_COLORS.length] }); await commit(false); };
  mv(e); addEventListener('pointermove', mv); addEventListener('pointerup', up);
}
$('#ruler').addEventListener('click', e => {
  if (UI.view === 'session') return;
  const mk = e.target.closest('[data-mk]'), sc = e.target.closest('[data-sec]'), cd = e.target.closest('[data-chd]'), tf = e.target.closest('[data-tempo]'), row = e.target.closest('.chordrow');
  if (mk) E.seek(P().markers.find(m => m.id === mk.dataset.mk).b);
  else if (sc) E.seek(sec(sc.dataset.sec).start);
  else if (cd) chordDialog(null, P().chords.find(c => c.id === cd.dataset.chd));
  else if (tf) tempoWindow();
  else if (row) { const r = $('#ruler').getBoundingClientRect(); chordDialog(barAt(P(), Math.max(0, (e.clientX - r.left) / UI.ppb)).start); }
});
$('#ruler').addEventListener('dblclick', e => {
  const mk = e.target.closest('[data-mk]'), sc = e.target.closest('[data-sec]');
  if (mk) renameThing(P().markers.find(m => m.id === mk.dataset.mk), 'name', 'Marker name'); else if (sc) renameThing(sec(sc.dataset.sec), 'name', 'Section name');
});
$('#ruler').addEventListener('contextmenu', e => {
  const mk = e.target.closest('[data-mk]'), sc = e.target.closest('[data-sec]'), cd = e.target.closest('[data-chd]'); if (!mk && !sc && !cd) return; e.preventDefault();
  if (sc) return sectionMenu(sec(sc.dataset.sec), e);
  const at = { getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY, top: e.clientY }) };
  if (mk) { const m = P().markers.find(x => x.id === mk.dataset.mk); menuAt(at, [{ icon: '✎', label: 'Rename', run: () => renameThing(m, 'name', 'Marker name') }, { icon: '×', label: 'Delete marker', run: () => { snapshot(); P().markers = P().markers.filter(x => x !== m); commit(false); } }]); }
  if (cd) { const c = P().chords.find(x => x.id === cd.dataset.chd); menuAt(at, [{ icon: '✎', label: 'Change chord', run: () => chordDialog(null, c) }, { icon: '×', label: 'Delete chord', run: () => { snapshot(); P().chords = P().chords.filter(x => x !== c); commit(false); } }]); }
});
// ---- tempo & time signature window ----
function tempoWindow() {
  const body = document.createElement('div'); body.className = 'toolwin tempowin';
  const draw = () => {
    const p = P(), rows = [...tempoChanges(p).map(x => ({ k: 'tempo', x })), ...meterChanges(p).map(x => ({ k: 'meter', x }))].sort((a, b) => a.x.b - b.x.b);
    body.innerHTML = `<p class="small">Start: <b>${p.bpm} BPM</b>, <b>${p.sig}/4</b>. Changes happen at the start of a bar.</p>
      <table class="tt"><thead><tr><th>Bar</th><th>Change</th><th></th></tr></thead><tbody>${rows.map(({ k, x }) => `<tr><td>${barAt(p, x.b).bar + 1}</td><td>${k === 'tempo' ? `<input type="number" min="40" max="240" step="0.5" value="${x.bpm}" data-bpm="${x.b}" aria-label="Tempo"> BPM` : `<select data-sig="${x.b}" aria-label="Beats per bar">${[2, 3, 4, 5, 6, 7].map(n => `<option ${n === x.n ? 'selected' : ''}>${n}</option>`).join('')}</select> /4`}</td><td><button data-del="${k}:${x.b}" aria-label="Remove">×</button></td></tr>`).join('') || '<tr><td colspan="3" class="small">No changes yet — the whole song uses the starting tempo and meter.</td></tr>'}</tbody></table>
      <div class="prbar"><label>At bar <input id="twBar" type="number" min="2" value="${UI.twBar || (barAt(p, E.position()).bar + 1 > 1 ? barAt(p, E.position()).bar + 1 : 9)}" style="width:60px"></label>
      <button id="twTempo">+ Tempo change</button><button id="twSig">+ Time signature</button></div>
      <p class="small">Tip: a ramp is a few small tempo changes a bar apart. Library loops follow every change.</p>`;
  };
  draw(); floatWin('tempo', 'Tempo & time signature', body);
  body.onchange = async e => {
    if (e.target.id === 'twBar') { UI.twBar = +e.target.value; return; }
    const p = P(), bb = e.target.dataset.bpm, sg = e.target.dataset.sig; if (bb == null && sg == null) return; snapshot();
    if (bb != null) p.tempo.find(x => Math.abs(x.b - +bb) < 1e-9).bpm = Math.max(40, Math.min(240, +e.target.value || 120));
    if (sg != null) p.meter.find(x => Math.abs(x.b - +sg) < 1e-9).n = +e.target.value;
    await commit(false); draw();
  };
  body.onclick = async e => {
    const p = P(), at = barStart(p, Math.max(1, (+(body.querySelector('#twBar')?.value) || 2) - 1));
    if (e.target.id === 'twTempo') { snapshot(); p.tempo = (p.tempo || []).filter(x => Math.abs(x.b - at) > 1e-9); p.tempo.push({ b: at, bpm: Math.round(bpmAt(p, at) + 10) }); await commit(true); draw(); }
    if (e.target.id === 'twSig') { snapshot(); p.meter = (p.meter || []).filter(x => Math.abs(x.b - at) > 1e-9); p.meter.push({ b: at, n: barAt(p, at).n === 3 ? 4 : 3 }); await commit(true); draw(); }
    const d = e.target.dataset.del; if (d) { const [k, b] = d.split(':'); snapshot(); p[k] = p[k].filter(x => Math.abs(x.b - +b) > 1e-9); await commit(true); draw(); }
  };
  WINDRAW.tempo = draw;
}


// ---------- windows: pop-out mixer & editors, analysis tools, reference A/B, chord generator ----------
const WINDRAW = {}, EDWINS = new Map();
const box_pop = fc => fc.slot != null ? '' : `<button data-popout="${fc.ref?.id || fc.c.id}" title="Open this clip in its own window (you can open several)">⧉ Window</button>`;
document.addEventListener('click', e => { const b = e.target.closest('[data-popout]'); if (b) popEditor(b.dataset.popout); });
function popEditor(id) {
  const fc = findClip(id); if (!fc) return;
  if (floats.has('ed:' + id)) { floats.get('ed:' + id).style.zIndex = 36; return; }
  const body = document.createElement('div'); body.className = 'edwin'; EDWINS.set(id, body);
  const w = floatWin('ed:' + id, `${fc.t.name} — ${clipName0(fc.c)}`, body, () => EDWINS.delete(id)); w.classList.add('big');
  body.addEventListener('pointerdown', () => { if (UI.clip !== id) { UI.clip = id; markSel(); } }, true);
  renderPop(id);
}
function renderPop(id) {
  const box = EDWINS.get(id), fc = findClip(id); if (!box) return;
  if (!fc) { floats.get('ed:' + id)?.remove(); floats.delete('ed:' + id); EDWINS.delete(id); return; }
  const sc = box.querySelector('.prwrap')?.scrollTop; renderEditorInto(fc, box); const wr = box.querySelector('.prwrap'); if (wr && sc != null) wr.scrollTop = sc;
}
function refreshWindows() { for (const id of EDWINS.keys()) renderPop(id); for (const k in WINDRAW) if (floats.has(k)) WINDRAW[k](); else delete WINDRAW[k]; }

// pop the real mixer out into a window (and back) — every control keeps working
function popMixer() {
  if (floats.has('mixer')) return dockMixer();
  const mx = $('#mixer'), ph = document.createElement('div'); ph.id = 'mixerHome'; ph.className = 'empty'; ph.innerHTML = 'The mixer is in its own window. <button id="mixBack">Put it back here</button>';
  mx.before(ph); const body = document.createElement('div'); body.className = 'mixwin'; body.append(mx); mx.hidden = false;
  const w = floatWin('mixer', 'Mixer', body, () => dockMixer(true)); w.classList.add('big', 'wide'); renderMixer();
  ph.querySelector('#mixBack').onclick = () => dockMixer();
}
function dockMixer(closed) { const mx = $('#mixer'), ph = $('#mixerHome'); if (ph) { ph.before(mx); ph.remove(); } if (!closed) { floats.get('mixer')?.remove(); floats.delete('mixer'); } mx.hidden = UI.tab !== 'mixer'; renderMixer(); }

// ---- analysis taps on the master (or a track / the microphone) ----
const TAP = { g: null };
function tap() {
  if (!E.g || !E.ctx) return null; if (TAP.g === E.g) return TAP;
  const ctx = E.ctx, src = E.g.master.fader, sp = ctx.createChannelSplitter(2), aL = ctx.createAnalyser(), aR = ctx.createAnalyser(), spec = ctx.createAnalyser(), tune = ctx.createAnalyser();
  aL.fftSize = aR.fftSize = 2048; spec.fftSize = 8192; spec.smoothingTimeConstant = 0.6; tune.fftSize = 4096;
  src.connect(sp); sp.connect(aL, 0); sp.connect(aR, 1); src.connect(spec); src.connect(tune);
  const loud = worklet(ctx, 'rose-loud'); if (loud) { src.connect(loud); loud.port.onmessage = e => loudBlock(e.data); }
  Object.assign(TAP, { g: E.g, aL, aR, spec, tune, loud, src }); return TAP;
}
async function tuneSource(kind) {   // tuner input: 'master', 'mic' or a track id
  const T = tap(); if (!T) return; try { T.tuneIn?.disconnect(T.tune); } catch { }
  if (kind === 'mic') { try { const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); T.tuneIn = E.ctx.createMediaStreamSource(st); T.tuneIn.connect(T.tune); try { T.src.disconnect(T.tune); } catch { } } catch { toast('Microphone blocked — allow it in the browser to tune a live instrument'); } }
  else if (kind === 'master') { T.tuneIn = null; T.src.connect(T.tune); }
  else { const s = E.g.tracks.get(kind); if (s) { try { T.src.disconnect(T.tune); } catch { } T.tuneIn = s.fader; s.fader.connect(T.tune); } }
}
function yin(d, sr) {   // returns Hz or 0
  const N = d.length >> 1, x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = (d[2 * i] + d[2 * i + 1]) / 2; const fs = sr / 2, W = 1024, tmax = Math.min(Math.floor(fs / 50), N - W - 1), tmin = Math.floor(fs / 1500);
  let rms = 0; for (let i = 0; i < W; i++) rms += x[i] * x[i]; if (Math.sqrt(rms / W) < 0.004) return 0;
  const dd = new Float32Array(tmax + 2); let run = 0; dd[0] = 1;
  for (let t = 1; t <= tmax; t++) { let s2 = 0; for (let i = 0; i < W; i++) { const a = x[i] - x[i + t]; s2 += a * a; } run += s2; dd[t] = run ? s2 * t / run : 1;
    if (t > tmin + 1 && dd[t - 1] < 0.12 && dd[t] > dd[t - 1]) { const b = t - 1, a = dd[b - 1], c = dd[b + 1], den = a - 2 * dd[b] + c; return fs / (den ? b + 0.5 * (a - c) / den : b); } }
  return 0;
}
function toolWin(key, title, html, draw, wide) {
  if (floats.has(key)) { floats.get(key).remove(); floats.delete(key); delete WINDRAW[key]; return null; }
  const body = document.createElement('div'); body.className = 'toolwin'; body.innerHTML = html; const w = floatWin(key, title, body, () => delete WINDRAW[key]); if (wide) w.classList.add('big');
  E.start().then(() => tap()); return body;
}
function tunerWin() {
  const b = toolWin('tuner', 'Tuner', `<div class="tuner"><div class="tnote" id="tnNote">–</div><div class="tcents"><canvas id="tnCv" width="300" height="46"></canvas></div><div class="thz" id="tnHz">Play or sing a single note</div>
    <div class="prbar"><select id="tnSrc" aria-label="Listen to"><option value="mic">Microphone / input</option><option value="master">Master output</option>${P().tracks.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
    <label>A4 = <input id="tnRef" type="number" min="415" max="466" value="${UI.a4 || 440}" style="width:58px"> Hz</label></div></div>`); if (!b) return;
  b.querySelector('#tnSrc').onchange = e => tuneSource(e.target.value); b.querySelector('#tnRef').onchange = e => UI.a4 = +e.target.value || 440;
  E.start().then(() => { tap(); tuneSource('mic'); });
  let last = 0, sm = null;
  WINDRAW.tuner = () => {}; TOOLFRAME.tuner = () => {
    const T = tap(); if (!T || performance.now() - last < 60) return; last = performance.now();
    const d = new Float32Array(T.tune.fftSize); T.tune.getFloatTimeDomainData(d); const hz = yin(d, E.ctx.sampleRate), cv = b.querySelector('#tnCv'), g = cv.getContext('2d');
    g.clearRect(0, 0, 300, 46); g.fillStyle = cssColor('--line'); for (let c = -50; c <= 50; c += 10) g.fillRect(150 + c * 2.8, c % 50 ? 30 : 22, 1, c % 50 ? 10 : 18); g.fillStyle = cssColor('--play'); g.fillRect(149, 14, 2, 30);
    if (!hz) { if (sm != null) b.querySelector('#tnHz').textContent = 'Listening…'; sm = null; return; }
    const m = 69 + 12 * Math.log2(hz / (UI.a4 || 440)), n = Math.round(m), c = (m - n) * 100; sm = sm == null ? c : sm * 0.6 + c * 0.4;
    b.querySelector('#tnNote').textContent = KEY12[(n % 12 + 12) % 12] + (Math.floor(n / 12) - 1); b.querySelector('#tnHz').textContent = `${hz.toFixed(1)} Hz · ${sm >= 0 ? '+' : '−'}${Math.abs(sm).toFixed(0)} cents ${Math.abs(sm) < 4 ? '· in tune' : sm > 0 ? '· sharp' : '· flat'}`;
    g.fillStyle = Math.abs(sm) < 4 ? cssColor('--play') : cssColor('--sel'); g.fillRect(150 + Math.max(-50, Math.min(50, sm)) * 2.8 - 3, 6, 6, 36);
  };
}
const TOOLFRAME = {};
function spectrumWin() {
  const b = toolWin('spectrum', 'Spectrum analyzer', `<canvas id="spCv" width="760" height="300" class="specbig"></canvas><div class="small" id="spInfo">Master output · hover for frequency and note · peaks hold for 2 s</div>`, null, true); if (!b) return;
  const cv = b.querySelector('#spCv'); let hold = null, holdT = null, hover = null;
  cv.onpointermove = e => { const r = cv.getBoundingClientRect(); hover = (e.clientX - r.left) / r.width; }; cv.onpointerleave = () => hover = null;
  TOOLFRAME.spectrum = () => {
    const T = tap(); if (!T) return; const a = T.spec, d = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(d);
    const W = cv.width, H = cv.height, g = cv.getContext('2d'), sr = E.ctx.sampleRate, fx = f => Math.log(f / 20) / Math.log(1000) * W, dbY = v => (1 - (v + 90) / 90) * H;
    g.clearRect(0, 0, W, H); g.font = '11px "IBM Plex Sans", sans-serif';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.fillStyle = cssColor('--line'); g.fillRect(fx(f), 0, 1, H); g.fillStyle = cssColor('--mute'); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, fx(f) + 3, H - 4); }
    for (let v = -12; v > -90; v -= 12) { g.fillStyle = cssColor('--line'); g.fillRect(0, dbY(v), W, 1); g.fillStyle = cssColor('--mute'); g.fillText(v + ' dB', 3, dbY(v) - 3); }
    const now = performance.now(); if (!hold || hold.length !== d.length) { hold = new Float32Array(d.length).fill(-120); holdT = new Float32Array(d.length); }
    g.beginPath(); let started = false;
    for (let i = 1; i < d.length; i++) { const f = i * sr / a.fftSize; if (f < 20 || f > 20000) continue; const x = fx(f), y = dbY(Math.max(-90, d[i])); if (!started) { g.moveTo(x, H); g.lineTo(x, y); started = true; } else g.lineTo(x, y);
      if (d[i] > hold[i]) { hold[i] = d[i]; holdT[i] = now; } else if (now - holdT[i] > 2000) hold[i] = Math.max(d[i], hold[i] - 0.6); }
    g.lineTo(W, H); g.closePath(); g.fillStyle = cssColor('--sel'); g.globalAlpha = 0.25; g.fill(); g.globalAlpha = 1; g.strokeStyle = cssColor('--sel'); g.lineWidth = 1.4; g.stroke();
    g.beginPath(); g.strokeStyle = cssColor('--ink'); g.globalAlpha = 0.5; g.lineWidth = 1; for (let i = 1; i < d.length; i += 2) { const f = i * sr / a.fftSize; if (f < 20 || f > 20000) continue; const x = fx(f), y = dbY(Math.max(-90, hold[i])); i < 3 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); g.globalAlpha = 1;
    if (hover != null) { const f = 20 * Math.pow(1000, hover), m = 69 + 12 * Math.log2(f / 440), n = Math.round(m), bin = Math.round(f * a.fftSize / sr); b.querySelector('#spInfo').textContent = `${f < 1000 ? f.toFixed(0) + ' Hz' : (f / 1000).toFixed(2) + ' kHz'} · ${KEY12[(n % 12 + 12) % 12]}${Math.floor(n / 12) - 1} · ${d[bin]?.toFixed(1)} dB`; g.fillStyle = cssColor('--ink'); g.fillRect(hover * W, 0, 1, H); }
  };
}
// ---- loudness (EBU R128) ----
const LOUD = { blocks: [], peak: 0, reset() { this.blocks = []; this.peak = 0; } };
function loudBlock({ ms, pk }) { LOUD.blocks.push(ms); if (LOUD.blocks.length > 36000) LOUD.blocks.splice(0, 6000); LOUD.peak = Math.max(LOUD.peak, pk); LOUD.last = pk; }
const lufs = ms => ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
function loudStats(blocks) {
  const avg = n => { const s = blocks.slice(-n); return s.length ? s.reduce((a, x) => a + x, 0) / s.length : 0; };
  const gates = []; for (let i = 3; i < blocks.length; i++) gates.push((blocks[i] + blocks[i - 1] + blocks[i - 2] + blocks[i - 3]) / 4);   // 400 ms windows, 75 % overlap
  const abs = gates.filter(x => lufs(x) > -70), rel = abs.length ? lufs(abs.reduce((a, x) => a + x, 0) / abs.length) - 10 : -70, g2 = abs.filter(x => lufs(x) > rel);
  return { M: lufs(avg(4)), S: lufs(avg(30)), I: g2.length ? lufs(g2.reduce((a, x) => a + x, 0) / g2.length) : -Infinity };
}
function loudnessWin() {
  const b = toolWin('loud', 'Loudness (LUFS)', `<div class="loudgrid"><div><span>Momentary</span><b id="lM">–</b></div><div><span>Short-term</span><b id="lS">–</b></div><div><span>Integrated</span><b id="lI">–</b></div><div><span>Peak</span><b id="lP">–</b></div></div>
    <canvas id="lCv" width="440" height="90"></canvas>
    <div class="prbar"><button id="lReset">Reset</button><button id="lSong" title="Render the whole song offline and measure it">Measure whole song</button><select id="lTarget" aria-label="Target"><option value="-14">Streaming (−14)</option><option value="-9">Club / EDM (−9)</option><option value="-16">Podcast (−16)</option><option value="-23">Broadcast (−23)</option></select></div>
    <p class="small" id="lNote">Measures the master while you play. Spotify, Apple Music and YouTube turn songs down to about −14 LUFS.</p>`); if (!b) return;
  LOUD.reset(); const hist = [];
  b.querySelector('#lReset').onclick = () => { LOUD.reset(); hist.length = 0; };
  b.querySelector('#lSong').onclick = async () => { const n = b.querySelector('#lNote'); n.textContent = 'Rendering the song…'; const buf = await E.render(P(), E.songEnd(), 1); const r = measureBuffer(buf); const tg = +b.querySelector('#lTarget').value;
    n.innerHTML = `Whole song: <b>${r.I.toFixed(1)} LUFS</b> integrated, peak <b>${r.peak.toFixed(1)} dBFS</b>. ${Math.abs(r.I - tg) < 1 ? 'Right on target.' : r.I > tg ? `${(r.I - tg).toFixed(1)} dB louder than the target — streaming services will turn it down.` : `${(tg - r.I).toFixed(1)} dB quieter than the target — raise the master limiter's gain.`}`; };
  TOOLFRAME.loud = () => {
    const st = loudStats(LOUD.blocks), f = v => isFinite(v) ? v.toFixed(1) : '–', tg = +b.querySelector('#lTarget').value;
    b.querySelector('#lM').textContent = f(st.M); b.querySelector('#lS').textContent = f(st.S); b.querySelector('#lI').textContent = f(st.I);
    const pk = 20 * Math.log10(LOUD.peak || 1e-9); b.querySelector('#lP').textContent = LOUD.peak ? pk.toFixed(1) : '–'; b.querySelector('#lP').classList.toggle('hot', pk > -1);
    if (E.playing) hist.push(st.S); if (hist.length > 440) hist.shift();
    const cv = b.querySelector('#lCv'), g = cv.getContext('2d'), y = v => 90 - (Math.max(-40, Math.min(0, v)) + 40) / 40 * 90; g.clearRect(0, 0, 440, 90);
    g.fillStyle = cssColor('--play'); g.globalAlpha = 0.35; g.fillRect(0, y(tg) - 1, 440, 2); g.globalAlpha = 1; g.strokeStyle = cssColor('--sel'); g.beginPath(); hist.forEach((v, i) => i ? g.lineTo(i, y(v)) : g.moveTo(i, y(v))); g.stroke();
  };
}
function measureBuffer(buf) {   // offline BS.1770 integrated loudness + sample peak
  const sr = buf.sampleRate, N = Math.round(sr / 10), out = [];
  let K = Math.tan(Math.PI * 1681.974450955533 / sr), Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416), Q = 0.7071752369554196, a0 = 1 + K / Q + K * K;
  const s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan(Math.PI * 38.13547087602444 / sr); Q = 0.5003270373238773; a0 = 1 + K / Q + K * K; const s2 = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  let peak = 0; const acc = new Float64Array(Math.ceil(buf.length / N) + 1);
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) { const x = buf.getChannelData(c); let z0 = 0, z1 = 0, z2 = 0, z3 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i]; peak = Math.max(peak, Math.abs(v)); const y1 = s1[0] * v + z0; z0 = s1[1] * v - s1[3] * y1 + z1; z1 = s1[2] * v - s1[4] * y1; const y2 = s2[0] * y1 + z2; z2 = s2[1] * y1 - s2[3] * y2 + z3; z3 = s2[2] * y1 - s2[4] * y2; acc[(i / N) | 0] += y2 * y2; } }
  for (let k = 0; k < acc.length - 1; k++) out.push(acc[k] / N);
  return { ...loudStats(out), peak: 20 * Math.log10(peak || 1e-9) };
}
function scopeWin() {
  const b = toolWin('scope', 'Stereo scope', `<div class="scopewrap"><canvas id="scCv" width="260" height="260"></canvas><div class="scmeters"><div><span>Correlation</span><canvas id="scCorr" width="200" height="18"></canvas><b id="scC">–</b></div><div><span>Balance L/R</span><canvas id="scBal" width="200" height="18"></canvas><b id="scB">–</b></div><p class="small">+1 = mono-safe, 0 = wide, below 0 = phase problems that vanish on phones and club systems.</p></div></div>`); if (!b) return;
  let corr = 0, bal = 0;
  TOOLFRAME.scope = () => {
    const T = tap(); if (!T) return; const L = new Float32Array(2048), R = new Float32Array(2048); T.aL.getFloatTimeDomainData(L); T.aR.getFloatTimeDomainData(R);
    const cv = b.querySelector('#scCv'), g = cv.getContext('2d'), W = 260, h = W / 2; g.fillStyle = cssColor('--deck'); g.fillRect(0, 0, W, W);
    g.strokeStyle = cssColor('--line'); g.beginPath(); g.moveTo(h, 0); g.lineTo(h, W); g.moveTo(0, h); g.lineTo(W, h); g.moveTo(0, 0); g.lineTo(W, W); g.moveTo(W, 0); g.lineTo(0, W); g.stroke();
    g.fillStyle = cssColor('--sel'); g.globalAlpha = 0.55; let sLR = 0, sLL = 0, sRR = 0;
    for (let i = 0; i < 2048; i++) { const l = L[i], r = R[i]; sLR += l * r; sLL += l * l; sRR += r * r; const m = (l + r) * 0.7071, sd = (r - l) * 0.7071; g.fillRect(h + sd * h * 1.3, h - m * h * 1.3, 1.4, 1.4); }
    g.globalAlpha = 1; const c = sLL && sRR ? sLR / Math.sqrt(sLL * sRR) : 0, bl = sLL + sRR ? (Math.sqrt(sRR) - Math.sqrt(sLL)) / (Math.sqrt(sRR) + Math.sqrt(sLL)) : 0;
    corr = corr * 0.85 + c * 0.15; bal = bal * 0.85 + bl * 0.15;
    const bar = (id, v, colr) => { const k = b.querySelector(id), gg = k.getContext('2d'); gg.clearRect(0, 0, 200, 18); gg.fillStyle = cssColor('--deck'); gg.fillRect(0, 4, 200, 10); gg.fillStyle = cssColor('--line'); gg.fillRect(100, 0, 1, 18); gg.fillStyle = colr; gg.fillRect(100 + v * 98 - 3, 2, 6, 14); };
    bar('#scCorr', corr, corr < 0 ? cssColor('--rec') : cssColor('--play')); bar('#scBal', bal, cssColor('--sel'));
    b.querySelector('#scC').textContent = (corr >= 0 ? '+' : '') + corr.toFixed(2); b.querySelector('#scB').textContent = Math.abs(bal) < 0.02 ? 'Centre' : (bal < 0 ? 'L ' : 'R ') + Math.round(Math.abs(bal) * 100) + '%';
  };
}
// ---- reference track A/B ----
const REF = { src: null, gain: null, buf: null };
async function refLoad(file) {
  await E.start(); const ab = await file.arrayBuffer(); const id = await E.addAudio(ab, file.name); if (!id) return toast('Couldn’t read that file');
  snapshot(); P().audio[id] = { name: file.name.replace(/\.[^.]+$/, ''), reference: true }; P().reference = { sample: id, name: P().audio[id].name, offset: 0, gain: 0 }; REF.lufs = measureBuffer(E.buffers.get(id)).I; persist(); refreshWindows(); toast('Reference loaded — press Shift+B to switch between your mix and the reference');
}
function refStart(t, b) { refStop(); const r = P().reference, buf = r && E.buffers.get(r.sample); if (!buf || !E.ctx) return;
  REF.gain ||= E.ctx.createGain(); REF.gain.connect(E.ctx.destination); REF.gain.gain.value = UI.refOn ? db(r.gain || 0) : 0;
  const s = E.ctx.createBufferSource(); s.buffer = buf; s.connect(REF.gain); const off = secAt(P(), b) + (r.offset || 0); if (off < buf.duration) s.start(Math.max(E.ctx.currentTime, t), Math.max(0, off)); REF.src = s; }
function refStop() { try { REF.src?.stop(); } catch { } REF.src = null; }
E.onPlay = (t, b) => refStart(t, b); E.onStop = () => refStop(); E.onLoop = (t, b) => { if (P().reference) setTimeout(() => refStart(t, b), Math.max(0, (t - E.ctx.currentTime) * 1000 - 30)); };
function refAB(on = !UI.refOn) {
  if (!P().reference) return toast('Load a reference track first (Windows → Reference A/B)');
  UI.refOn = on; const now = E.ctx?.currentTime || 0;
  E.monitorGain = on ? 0 : 1; E.g?.monitor?.gain.setTargetAtTime(E.monitorGain, now, 0.01); REF.gain?.gain.setTargetAtTime(on ? db(P().reference.gain || 0) : 0, now, 0.01);
  paintTransport(); refreshWindows(); toastQuiet(on ? 'B — reference' : 'A — your mix');
}
function refWin() {
  const body = document.createElement('div'); body.className = 'toolwin';
  const draw = () => { const r = P().reference;
    body.innerHTML = r ? `<div class="abrow"><button id="rfA" class="${UI.refOn ? '' : 'on'}">A · Your mix</button><button id="rfB" class="${UI.refOn ? 'on' : ''}">B · ${esc(r.name)}</button></div>
      <div class="pr"><label>Reference level</label><input id="rfG" type="range" min="-24" max="6" step="0.1" value="${r.gain || 0}" data-def="0"><output>${(r.gain || 0).toFixed(1)} dB</output></div>
      <div class="pr"><label title="Line the reference up with your song">Start offset</label><input id="rfO" type="range" min="0" max="${Math.floor(E.buffers.get(r.sample)?.duration || 0)}" step="0.1" value="${r.offset || 0}" data-def="0"><output>${(r.offset || 0).toFixed(1)} s</output></div>
      <div class="prbar"><button id="rfMatch" title="Measure both and turn the louder one down so you compare sound, not volume">Match loudness</button><button id="rfLoad">Load another…</button><button id="rfDel">Remove</button></div>
      <p class="small">Press <kbd>Shift+B</kbd> to flip between A and B while the song plays. The reference never goes into your bounce.${REF.lufs != null ? ` Reference: ${REF.lufs.toFixed(1)} LUFS.` : ''}</p>`
      : `<p class="small">Load a finished song you love to compare against yours, in sync with the playhead.</p><div class="prbar"><button id="rfLoad" class="on">Load a reference track…</button></div>`;
  };
  draw(); floatWin('ref', 'Reference A/B', body); WINDRAW.ref = draw;
  body.onclick = async e => {
    const id = e.target.id; if (id === 'rfA') refAB(false); if (id === 'rfB') refAB(true);
    if (id === 'rfLoad') { const i = document.createElement('input'); i.type = 'file'; i.accept = 'audio/*'; i.onchange = () => i.files[0] && refLoad(i.files[0]); i.click(); }
    if (id === 'rfDel') { snapshot(); refStop(); refAB(false); delete P().reference; persist(); draw(); }
    if (id === 'rfMatch') { toast('Measuring your mix…'); const mix = measureBuffer(await E.render(P(), E.songEnd(), 0.5)).I; const r = P().reference; REF.lufs ??= measureBuffer(E.buffers.get(r.sample)).I;
      r.gain = +(mix - REF.lufs).toFixed(1); persist(); draw(); if (UI.refOn) REF.gain?.gain.setTargetAtTime(db(r.gain), E.ctx.currentTime, 0.02); toast(`Mix ${mix.toFixed(1)} LUFS · reference ${REF.lufs.toFixed(1)} LUFS → reference set to ${r.gain} dB`); }
  };
  body.oninput = e => { const r = P().reference; if (!r) return; if (e.target.id === 'rfG') { r.gain = +e.target.value; e.target.nextElementSibling.textContent = r.gain.toFixed(1) + ' dB'; if (UI.refOn) REF.gain?.gain.setTargetAtTime(db(r.gain), E.ctx.currentTime, 0.02); }
    if (e.target.id === 'rfO') { r.offset = +e.target.value; e.target.nextElementSibling.textContent = r.offset.toFixed(1) + ' s'; } };
  body.onchange = () => persist();
}
// ---- chord generator ----
function chordGenWin() {
  if (floats.has('chordgen')) { floats.get('chordgen').style.zIndex = 36; return; }
  const o = UI.cg ||= { key: 0, mode: 'Major', style: Object.keys(CG.STYLES.Major)[0], steps: null, bars: 4, perBar: 1, ext: 'Triads', voicing: 'Close', lead: true, rhythm: 'Sustained', octave: 0, bass: 'Off', humanize: 0.3, seed: 1, toChordTrack: true };
  const body = document.createElement('div'); body.className = 'toolwin cgwin';
  const sel = (id, list, v, lab) => `<label>${lab}<select data-cg="${id}">${list.map(x => { const [val, txt] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(String(val))}" ${String(val) === String(v) ? 'selected' : ''}>${esc(String(txt))}</option>`; }).join('')}</select></label>`;
  const res = () => { if (!o.steps) o.steps = (CG.STYLES[o.mode] || {})[o.style] || CG.surprise(o.mode, 4, o.seed); return CG.generate({ ...o, steps: o.steps }); };
  const draw = () => {
    const r = res(), styles = Object.keys(CG.STYLES[o.mode] || {});
    body.innerHTML = `<div class="cggrid">${sel('key', CG.KEYS.map((k, i) => [i, k]), o.key, 'Key')}${sel('mode', Object.keys(CG.MODES), o.mode, 'Scale')}
      ${sel('style', [...styles, ['__custom', o.style === '__custom' ? 'Surprise (generated)' : '— generated —']], o.style, 'Progression')}
      ${sel('bars', [[2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars']], o.bars, 'Length')}${sel('perBar', [[0.5, 'Every 2 bars'], [1, '1 per bar'], [2, '2 per bar']], o.perBar, 'Chord changes')}
      ${sel('ext', CG.EXTENSIONS, o.ext, 'Colour')}${sel('voicing', CG.VOICINGS, o.voicing, 'Voicing')}${sel('rhythm', CG.RHYTHMS, o.rhythm, 'Rhythm')}
      ${sel('octave', [[-1, 'Low'], [0, 'Middle'], [1, 'High']], o.octave, 'Register')}${sel('bass', CG.BASSES, o.bass, 'Bass line')}
      <label>Humanize<input type="range" data-cg="humanize" min="0" max="1" step="0.05" value="${o.humanize}"></label>
      <label class="chk"><input type="checkbox" data-cg="lead" ${o.lead ? 'checked' : ''}> Smooth voice leading</label><label class="chk"><input type="checkbox" data-cg="toChordTrack" ${o.toChordTrack ? 'checked' : ''}> Also fill the chord track</label></div>
      <div class="cgchips">${r.chords.map((c, i) => `<button data-cgplay="${i}" title="Hear it">${esc(c.name)}</button>`).join('')}</div>
      <canvas class="cgroll" width="720" height="120"></canvas>
      <div class="prbar"><button id="cgSurprise" title="A new progression in this scale">⟳ Surprise me</button><button id="cgPlay">▶ Preview</button><button id="cgWrite" class="on">Write to ${esc(trk(UI.track)?.kind === 'inst' && trk(UI.track)?.inst !== 'drums' ? trk(UI.track).name : 'a new track')} at bar ${barAt(P(), E.position()).bar + 1}</button></div>`;
    const cv = body.querySelector('.cgroll'), g = cv.getContext('2d'), all = [...r.notes, ...r.bass], lo = Math.min(...all.map(n => n.p)) - 2, hi = Math.max(...all.map(n => n.p)) + 2, X = b => b / r.len * 720, Y = p => 120 - (p - lo) / (hi - lo) * 120;
    g.fillStyle = cssColor('--deck'); g.fillRect(0, 0, 720, 120); r.chords.forEach((c, i) => { if (i % 2) { g.fillStyle = cssColor('--lane2'); g.fillRect(X(c.b), 0, X(c.len), 120); } });
    for (const n of r.notes) { g.fillStyle = cssColor('--sel'); g.fillRect(X(n.s), Y(n.p) - 2, Math.max(2, X(n.l)), 4); } for (const n of r.bass) { g.fillStyle = cssColor('--play'); g.fillRect(X(n.s), Y(n.p) - 2, Math.max(2, X(n.l)), 4); }
  };
  draw(); floatWin('chordgen', 'Chord generator', body).classList.add('big'); WINDRAW.chordgen = draw;
  body.onchange = e => { const k = e.target.dataset.cg; if (!k) return; const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    o[k] = ['key', 'bars', 'perBar', 'octave', 'humanize'].includes(k) ? +v : v;
    if (k === 'mode') { o.style = Object.keys(CG.STYLES[o.mode] || {})[0] || '__custom'; o.steps = null; } if (k === 'style') o.steps = o.style === '__custom' ? CG.surprise(o.mode, 4, ++o.seed) : null; draw(); };
  const audition = async (chords, step) => { await E.start(); let t = UI.track; if (!trk(t) || trk(t).kind !== 'inst' || trk(t).inst === 'drums') { const any = P().tracks.find(x => x.kind === 'inst' && x.inst !== 'drums'); t = any?.id; } if (!t) return toast('Add an instrument track to hear chords');
    chords.forEach((c, i) => setTimeout(() => { c.notes.forEach(p => E.liveOn(t, p, 0.7)); setTimeout(() => c.notes.forEach(p => E.liveOff(t, p)), step * 0.9); }, i * step)); };
  body.onclick = async e => {
    const pc = e.target.closest('[data-cgplay]'); if (pc) return audition([res().chords[+pc.dataset.cgplay]], 900);
    if (e.target.id === 'cgSurprise') { o.style = '__custom'; o.seed++; o.steps = CG.surprise(o.mode, 4, o.seed); draw(); }
    if (e.target.id === 'cgPlay') audition(res().chords, 60000 / P().bpm * 4 / o.perBar);
    if (e.target.id === 'cgWrite') await writeChordGen(res());
  };
}
async function writeChordGen(r) {
  const p = P(); snapshot(); let t = trk(UI.track);
  if (!t || t.kind !== 'inst' || t.inst === 'drums') { t = newTrack('inst', 'sounds', p.tracks.length + 1); t.instParams.patch = 'Electric Piano'; t.name = 'Chords'; p.tracks.push(t); }
  const at = barAt(p, E.position()).start, name = r.chords.slice(0, 4).map(c => c.name).join(' ');
  t.clips.push({ id: uid(), name, start: at, len: r.len, notes: r.notes.map(n => ({ ...n })) });
  if (r.bass.length) { let bt = p.tracks.find(x => x.name === 'Bass' && x.kind === 'inst'); if (!bt) { bt = newTrack('inst', 'sounds', p.tracks.length + 1); bt.instParams.patch = 'Electric Bass'; bt.name = 'Bass'; p.tracks.push(bt); }
    bt.clips.push({ id: uid(), name: 'Bass · ' + name, start: at, len: r.len, notes: r.bass.map(n => ({ ...n })) }); }
  if (UI.cg.toChordTrack) { p.chords = (p.chords || []).filter(c => c.b < at || c.b >= at + r.len); r.chords.forEach(c => p.chords.push({ id: uid(), b: at + c.b, name: c.name })); p.chords.sort((a, b) => a.b - b.b); setSongRows(true); }
  UI.track = t.id; await commit(true); toast(`${r.chords.length} chords written to ${t.name}${r.bass.length ? ' + a bass line' : ''}`);
}
// ---- Windows menu ----
function windowsMenu(anchor) {
  menuAt(anchor, [
    { icon: '▦', label: floats.has('mixer') ? 'Put the mixer back' : 'Mixer window', key: 'Shift+X', run: popMixer },
    { icon: '⧉', label: 'Open selected clip in a window', disabled: !UI.clip, run: () => popEditor(UI.clip) },
    { icon: '♫', label: 'Chord generator', key: 'Shift+G', sub: 'Progressions, voicings, rhythms and bass in any key', run: chordGenWin },
    { icon: '◎', label: 'Tuner', run: tunerWin }, { icon: '∿', label: 'Spectrum analyzer', run: spectrumWin },
    { icon: '▮', label: 'Loudness (LUFS)', run: loudnessWin }, { icon: '◐', label: 'Stereo scope', run: scopeWin },
    { icon: 'B', label: 'Reference A/B', key: 'Shift+B', run: refWin },
    { icon: '♩', label: 'Tempo & time signature', run: tempoWindow },
    { icon: '☰', label: UI.songRows ? 'Hide arranger & chord rows' : 'Show arranger & chord rows', run: () => setSongRows(!UI.songRows) },
    { icon: '⚑', label: 'Add marker at playhead', key: 'Shift+M', run: () => addMarker() },
    { icon: '♪', label: 'Detect chords from MIDI', run: detectChords },
    { icon: '⇣', label: 'Chord track → pad on selected track', run: () => chordsToMidi('pad') }, { icon: '⇣', label: 'Chord track → bass line', run: () => chordsToMidi('bass') },
  ]);
}
$('#bWin').onclick = e => windowsMenu(e.currentTarget);

// ---------- devices ----------
const fmt = (p, v) => p.type !== 'range' ? '' : (p.unit === 'Hz' ? (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz' : p.unit === 's' ? (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s') : (Math.abs(v) < 10 && p.step < 1 ? (+v).toFixed(p.step < 0.1 ? 2 : 1) : Math.round(v)) + (p.unit ? ' ' + p.unit : ''));
const toPos = (p, v) => p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) * 1000 : v;
const fromPos = (p, x) => p.log ? +(p.min * Math.pow(p.max / p.min, x / 1000)).toFixed(1) : +x;
function paramsHtml(params, vals, key) {
  return params.map(p => { const v = vals[p.id] ?? p.def;
    if (p.type === 'select') return `<div class="pr"><label>${p.label}</label><select data-k="${key}" data-p="${p.id}">${p.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    if (p.type === 'track') { const self = devOwner()?.id; return `<div class="pr"><label>${p.label}</label><select data-k="${key}" data-p="${p.id}"><option value="">— choose the kick or key track —</option>${P().tracks.filter(t => t.id !== self && t.kind !== 'group').map(t => `<option value="${t.id}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>`; }
    if (p.type === 'toggle') return `<div class="pr"><label>${p.label}</label><input type="checkbox" data-k="${key}" data-p="${p.id}" ${v ? 'checked' : ''} style="justify-self:start;width:20px;height:20px;accent-color:var(--rose)"></div>`;
    return `<div class="pr"><label title="${p.label}">${p.label}</label><input type="range" data-k="${key}" data-p="${p.id}" data-def="${toPos(p, p.def)}" ${p.log ? `data-log="1" data-vmin="${p.min}" data-vmax="${p.max}"` : ""} min="${p.log ? 0 : p.min}" max="${p.log ? 1000 : p.max}" step="${p.log ? 1 : p.step}" value="${toPos(p, v)}"><output>${fmt(p, v)}</output></div>`; }).join('');
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
    h += `<div class="dev ${s.bypass ? 'off' : ''}" data-slot="${s.id}"><h4 draggable="true" title="Drag to reorder, or onto a mixer channel to move it (Alt to copy)"><span class="t" title="${esc(s.url || '')}">${esc(def?.name || s.type)}</span><button data-a="float" title="Open in a floating window that stays on top">Float</button><button data-a="byp" title="Bypass">${s.bypass ? 'Off' : 'On'}</button><button data-a="l" title="Move left" ${i ? '' : 'disabled'}>‹</button><button data-a="r" title="Move right" ${i < o.inserts.length - 1 ? '' : 'disabled'}>›</button><button data-a="x" title="Remove">×</button></h4>`;
    if (s.type === 'eq') h += `<canvas class="eqc" data-eq="${s.id}"></canvas>`;
    if (s.type === 'analyzer') h += `<canvas class="eqc" data-an="${s.id}" style="height:140px"></canvas>`;
    if (s.type === 'tune') h += `<div class="tunerd"><b data-tune="${s.id}">–</b><span>input pitch, live</span></div>`;
    if (s.type === 'comp' || s.type === 'limiter' || s.type === 'sccomp' || s.type === 'deesser') h += `<div style="font-size:11px;color:var(--mute);padding:6px 10px 2px">Gain reduction</div><div class="gr"><i data-gr="${s.id}"></i></div>`;
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
    if (a === 'float') { const sl = o.inserts.find(x => x.id === id); return sl?.type === 'wam' ? openWamGui(E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === id)?.node?.wam) : floatDevice(UI.dev.kind, UI.dev.id, id); }
    snapshot();
    if (a === 'x') o.inserts.splice(i, 1); else if (a === 'byp') o.inserts[i].bypass = !o.inserts[i].bypass;
    else { const j = a === 'l' ? i - 1 : i + 1; [o.inserts[i], o.inserts[j]] = [o.inserts[j], o.inserts[i]]; }
    await commit(true);
  });
  bindParams(box, o, UI.dev.kind, UI.dev.id);
  fitRack(); drawEq();
}
// wires every parameter control inside root to its owner (track, return or master); shared by the rack and floating windows
function bindParams(root, o, devKind, devId) {
  root.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k, pid = inp.dataset.p;
    const pdef = k === 'inst' ? INSTRUMENTS[o.inst].params.find(p => p.id === pid) : k === 'arp' ? ARP_PARAMS.find(p => p.id === pid) : k === 'chord' ? CHORD_PARAMS.find(p => p.id === pid) : EFFECTS[o.inserts.find(s => s.id === k)?.type]?.params.find(p => p.id === pid);
    const val = () => inp.type === 'checkbox' ? inp.checked : inp.tagName === 'SELECT' ? inp.value : fromPos(pdef, inp.value);
    const apply = () => { const v = val();
      if (k === 'arp' || k === 'chord') { o.midifx[k][pid] = v; if (pid === 'on') $('#midiCard').classList.toggle('dim', !(o.midifx.arp.on || o.midifx.chord.on)); }
      else if (k === 'inst') { if (pid === 'preset') { Object.assign(o.instParams, SYNTH_PRESETS[v], { preset: v }); Object.entries(o.instParams).forEach(([a, b]) => E.setInstParam(o.id, a, b)); renderDevices(); } else E.setInstParam(o.id, pid, v); }
      else E.setFxParam(devKind, devId, k, pid, v);
      if (inp.nextElementSibling?.tagName === 'OUTPUT') inp.nextElementSibling.textContent = fmt(pdef, v);
      syncTwins(inp, root); drawEq(); };
    inp.addEventListener('pointerdown', () => snapshot(), { once: false });
    inp.addEventListener('input', apply); inp.addEventListener('change', () => { if (inp.tagName === 'SELECT' || inp.type === 'checkbox') snapshot(); apply(); persist(); if ((k === 'inst' && pid === 'sample') || pdef?.type === 'track') commit(true); });
  });
}
// keep the rack and any floating copy of the same device showing the same values
function syncTwins(inp, root) {
  document.querySelectorAll(`[data-k="${inp.dataset.k}"][data-p="${inp.dataset.p}"]`).forEach(o2 => {
    if (o2 === inp || root.contains(o2)) return;
    if (o2.type === 'checkbox') o2.checked = inp.checked; else o2.value = inp.value;
    const out = inp.nextElementSibling, out2 = o2.nextElementSibling; if (out?.tagName === 'OUTPUT' && out2?.tagName === 'OUTPUT') out2.textContent = out.textContent;
  });
}

// ---------- floating device windows: stay on top of the whole studio, drag anywhere ----------
const floats = new Map();
function floatWin(key, title, bodyEl, onClose) {
  floats.get(key)?.remove();
  const w = document.createElement('div'); w.className = 'fwin'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', title);
  w.innerHTML = `<div class="fbar"><span>${esc(title)}</span><button data-fclose title="Close (the device keeps running)" aria-label="Close">×</button></div>`;
  const body = document.createElement('div'); body.className = 'fbody'; body.append(bodyEl); w.append(body); document.body.append(w);
  // place it where it covers no other window (scan from the top-right), else cascade
  const n = floats.size; w.style.left = Math.min(innerWidth - 300, 260 + n * 28) + 'px'; w.style.top = Math.min(innerHeight - 200, 90 + n * 28) + 'px';
  requestAnimationFrame(() => {
    const me = w.getBoundingClientRect(), others = [...floats.values()].filter(x => x !== w && x.isConnected).map(x => x.getBoundingClientRect()), hit = (x, y) => others.some(o => x < o.right + 8 && x + me.width + 8 > o.left && y < o.bottom + 8 && y + me.height + 8 > o.top);
    for (let y = 60; y + me.height < innerHeight - 10; y += 24) for (let x = innerWidth - me.width - 16; x >= 220; x -= 24) if (!hit(x, y)) { w.style.left = x + 'px'; w.style.top = y + 'px'; return; }
  });
  const bar = w.querySelector('.fbar');
  bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; bar.setPointerCapture(e.pointerId);
    const mv = ev => { w.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)) + 'px'; w.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy)) + 'px'; };
    const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); }; bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up); });
  w.addEventListener('pointerdown', () => { document.querySelectorAll('.fwin').forEach(x => x.style.zIndex = 35); w.style.zIndex = 36; });
  w.querySelector('[data-fclose]').onclick = () => { w.remove(); floats.delete(key); onClose?.(); };
  floats.set(key, w); return w;
}
function floatDevice(kind, id, slotId) {
  const o = kind === 'master' ? P().master : kind === 'return' ? P().returns.find(r => r.id === id) : trk(id), slot = o?.inserts.find(s => s.id === slotId); if (!slot) return;
  const def = EFFECTS[slot.type]; if (!def) return;
  const body = document.createElement('div'); body.innerHTML = paramsHtml(def.params, slot.params, slot.id);
  floatWin('fx:' + slotId, `${def.name}  /  ${o.name || 'Master'}`, body); bindParams(body, o, kind, id);
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
  document.querySelectorAll('#devices .dev .ps').forEach(ps => { const dev = ps.closest('.dev'), avail = dev.getBoundingClientRect().bottom - ps.getBoundingClientRect().top - 14; ps.style.gridTemplateRows = `repeat(${Math.max(1, Math.floor((avail + 5) / 29))}, 24px)`; });
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
  try { const gui = await wam.createGui(); floatWin('wam:' + (wam.instanceId || Math.random()), wam.name || 'Web plugin', gui, () => wam.destroyGui?.(gui)); }
  catch (e) { toast('This plugin has no window: ' + e.message); }
}

// ---------- mixer ----------
function chHtml(kind, o, name, color) {
  const sel = (UI.dev.kind === kind && (kind === 'master' || UI.dev.id === o.id)) ? 'sel' : '';
  const sends = kind === 'track' ? `<div class="snd">${P().returns.map(r => `<span>${r.id}</span><input type="range" min="0" max="1" step="0.01" value="${o.sends[r.id] || 0}" data-def="0" data-send="${r.id}" aria-label="Send ${r.name}">`).join('')}</div>` : '<div class="snd" style="min-height:34px"></div>';
  const pan = kind === 'track' ? `<input type="range" min="-1" max="1" step="0.01" value="${o.pan}" data-def="0" data-pan style="width:100%" aria-label="Pan" title="Pan">` : '<div style="height:20px"></div>';
  const outSel = kind === 'track' && o.kind !== 'group' ? `<select class="outsel" aria-label="Output" title="Where this track's sound goes"><option value="master">→ Master</option>${P().tracks.filter(g => g.kind === 'group').map(g => `<option value="${g.id}" ${o.out === g.id ? 'selected' : ''}>→ ${esc(g.name)}</option>`).join('')}</select>` : kind === 'track' ? '<div class="fx">Group bus</div>' : '';
  return `<div class="ch ${sel}" data-kind="${kind}" data-id="${o.id || ''}" style="--c:${color}"><div class="cname" title="${esc(name)}">${esc(name)}</div>${outSel}<div class="fx">${o.inserts.map(s => s.type === 'wam' ? 'Web' : EFFECTS[s.type]?.name.split(' ')[0]).join(' · ') || '—'}</div>${sends}${pan}
    <div class="fz"><input class="fader" type="range" min="-60" max="6" step="0.1" value="${o.vol}" data-def="0" title="Double-click: back to 0 dB" aria-label="${esc(name)} volume"><canvas class="mtr" width="12" height="100"></canvas></div><div class="db">${o.vol <= -60 ? '−∞' : o.vol.toFixed(1)} dB</div>
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
  if ('fx' in e.target.dataset) setTab('devices'); else { document.querySelectorAll('#mixer .ch').forEach(c => c.classList.toggle('sel', c === ch)); renderHeads(); }
});

// ---------- plugins tab ----------
function renderPlugins() {
  $('#plugins').innerHTML = `<div class="doc">
  <h3>Built-in devices</h3><p>${Object.keys(EFFECTS).length} effects — ${Object.values(EFFECTS).map(e => e.name).join(', ')} — plus Rose Synth (${Object.keys(SYNTH_PRESETS).length} presets), Rose Drums and Rose Sampler. Add them from the <b>Library</b> or the <b>Sound & FX</b> tab. Two return buses (reverb and delay) are fed by each track's A/B sends in the <b>Mixer</b>.</p>
  <h3>VST3 and AU plugins (Serum, FabFilter, Softube Flow, Google Flow Music, Valhalla…)</h3><p>Browsers can't run VST3 or AU plugins — no web DAW can. Use the <b>Rose desktop app</b> in this repo's <code>native/</code> folder: it scans and loads every VST3 and AU plugin on your Mac, including the plugins you use in FL Studio, Logic and Ableton. Stock devices that live inside those apps (FL's Fruity plugins, Logic's ChromaVerb, Ableton's devices) only run inside their own app.</p>
  <h3>Real instruments and templates</h3><p><b>Rose Sounds</b> plays ${SOUND_LIB.length} sampled instruments — ${SOUND_LIB.map(x => x.name).join(', ')} — from the open-source FluidR3 General MIDI set by Frank Wen (MIT licence; recordings rendered by the midi-js-soundfonts project, CC BY 3.0). <b>File → New from template</b> starts an EDM, pop, trap, R&B, simcha, singer-songwriter, orchestral or podcast session, with the same templates in the desktop app.</p>
  <h3>Free open-source plugins for the desktop app</h3><p>These are free, open-source VST3/AU instruments. Install one, then press <i>Scan plugins</i> in Rose Studio: <a href="https://surge-synthesizer.github.io/" target="_blank" rel="noopener">Surge XT</a> (huge hybrid synth), <a href="https://vital.audio/" target="_blank" rel="noopener">Vital</a> (wavetable, free tier), <a href="https://asb2m10.github.io/dexed/" target="_blank" rel="noopener">Dexed</a> (DX7 FM), <a href="https://github.com/reales/OB-Xd" target="_blank" rel="noopener">OB-Xd</a> (Oberheim-style analog), <a href="https://thewavewarden.com/odin2" target="_blank" rel="noopener">Odin 2</a> and <a href="https://tytel.org/helm/" target="_blank" rel="noopener">Helm</a>. They're linked rather than built in because their GPL licences don't allow bundling them inside Rose.</p>
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
  const fc = UI.clip && findClip(UI.clip); if (!fc) return toast('Select a clip, then split at the playhead (or use the scissors tool)');
  return splitAt(fc, snapB(E.position()));
}
// split one clip at a beat; looped and pattern clips are expanded first so both halves keep exactly what you hear
function splitRaw(t, c, b) {   // splits in place, returns the new clips to the right of b (no undo/commit)
  if (b <= c.start + 1e-6 || b >= c.start + c.len - 1e-6) return [];
  if (isMidi(c) && (c.pattern || (c.loopLen && c.loopLen < c.len))) { const src = E.notesOf(c), L = E.loopLen(c), ns = []; for (let o = 0; o < c.len; o += L) for (const n of src) if (n.s < L && o + n.s < c.len) ns.push({ ...n, s: o + n.s }); c.notes = ns; delete c.pattern; delete c.loopLen; }
  const cut = b - c.start, d = JSON.parse(JSON.stringify(c)); d.id = uid(); d.start = b; d.len = c.len - cut; c.len = cut; const out = [d];
  if (isMidi(c)) { d.notes = c.notes.filter(n => n.s >= cut).map(n => ({ ...n, s: n.s - cut })); c.notes = c.notes.filter(n => n.s < cut).map(n => ({ ...n, l: Math.min(n.l, cut - n.s) })); }
  else {
    const L = c.loopLen && c.loopLen < c.len + cut - 1e-9 ? c.loopLen : null, rate = clipRate(c, P().bpm), spbS = 60 / P().bpm, ph = L ? cut % L : cut;
    d.offset = (c.offset || 0) + ph * spbS * rate; delete d.loopLen;
    if (L) {   // the rest of this loop cycle, then the remaining whole cycles as a looped clip
      if (c.len <= L + 1e-9) delete c.loopLen;
      const rest = d.len, first = Math.min(rest, ph > 1e-9 ? L - ph : L);
      if (ph < 1e-9) { d.offset = c.offset || 0; d.loopLen = L; }
      else { d.len = first; if (rest - first > 1e-9) { const e = JSON.parse(JSON.stringify(c)); e.id = uid(); e.start = b + first; e.len = rest - first; e.offset = c.offset || 0; e.loopLen = L; e.fadeIn = 0; d.fadeOut = 0; out.push(e); } }
    }
    c.fadeOut = 0; d.fadeIn = 0;
  }
  t.clips.push(...out); return out;
}
async function splitAt(fc, b) {
  if (fc.slot != null) return toast('Split works on arrangement clips');
  const c = fc.c; if (b <= c.start + 1e-6 || b >= c.start + c.len - 1e-6) return toast('Click inside the clip to split it');
  snapshot(); const out = splitRaw(fc.t, c, b); UI.clip = out[0].id; await commit(false);
}

// ---------- clipboard: cut / copy / paste ----------
UI.clipboard = null;
function copyClip(cut = false) {
  const fc = UI.clip && findClip(UI.clip); if (!fc) return toast('Select a clip first');
  UI.clipboard = { clip: JSON.parse(JSON.stringify(fc.c)), kind: isMidi(fc.c) ? 'midi' : 'audio', from: fc.t.id };
  if (cut) { deleteClip(); toast('Cut — select a track and press Ctrl+V to paste at the playhead'); } else toast('Copied — press Ctrl+V to paste at the playhead');
}
async function pasteClip() {
  const cb = UI.clipboard; if (!cb) return toast('Nothing copied yet');
  let t = trk(UI.track); const fits = x => x && x.kind !== 'group' && (x.kind === 'audio') === (cb.kind === 'audio');
  if (!fits(t)) t = trk(cb.from); if (!fits(t)) t = P().tracks.find(fits); if (!t) return toast('No track that can hold this clip');
  snapshot(); const c = JSON.parse(JSON.stringify(cb.clip)); c.id = uid(); c.start = snapB(E.position());
  if (UI.view === 'session') { const sl = E.slots(t.id), i = sl.findIndex(x => !x); if (i < 0) return toast('No empty slot'); c.start = 0; sl[i] = c; } else t.clips.push(c);
  UI.clip = c.id; UI.track = t.id; await commit(false); toast(`Pasted on ${t.name}`);
}
async function toggleClipLoop() {
  const fc = UI.clip && findClip(UI.clip); if (!fc || fc.c.pattern) return toast('Select a clip to loop');
  snapshot(); const c = fc.c;
  if (c.loopLen) { delete c.loopLen; toast('Clip loop off'); } else { c.loopLen = c.len; c.len = c.len * 2; toast('Clip loop on — drag the clip’s right edge to repeat it more'); }
  await commit(false);
}
function loopToSelection() {
  const fc = UI.clip && findClip(UI.clip);
  if (!fc || fc.slot != null) { $('#bLoop').click(); return; }
  P().loop = { on: true, start: fc.c.start, end: fc.c.start + fc.c.len }; paintTransport(); renderRuler(); renderLanes(); persist(); toast('Loop set to the selected clip');
}
function clipMenu(fc, anchorEvent) {
  const audio = !isMidi(fc.c), dummy = { getBoundingClientRect: () => ({ left: anchorEvent.clientX, bottom: anchorEvent.clientY, top: anchorEvent.clientY }) };
  const fade = (k, v) => async () => { snapshot(); fc.c[k] = v; await commit(false); };
  menuAt(dummy, [
    { icon: '✂', label: 'Cut', key: 'Ctrl+X', run: () => copyClip(true) },
    { icon: '⧉', label: 'Copy', key: 'Ctrl+C', run: () => copyClip(false) },
    { icon: '▤', label: 'Paste at playhead', key: 'Ctrl+V', disabled: !UI.clipboard, run: pasteClip },
    { icon: '♯', label: 'Pitch up', key: 'Alt+↑', run: () => pitchClips([fc.ref || fc.c], 1) },
    { icon: '♭', label: 'Pitch down', key: 'Alt+↓', run: () => pitchClips([fc.ref || fc.c], -1) },
    { icon: '⇅', label: 'Up an octave', key: 'Alt+Shift+↑', run: () => pitchClips([fc.ref || fc.c], 12) },
    { icon: '⇥', label: 'Duplicate', key: 'Ctrl+D', run: duplicateClip },
    { icon: '⫶', label: 'Split at playhead', key: 'B', run: splitClip },
    { icon: '↻', label: fc.c.loopLen ? 'Loop clip: on → off' : 'Loop clip', sub: 'Repeat its content as you stretch it', disabled: !!fc.c.pattern, run: toggleClipLoop },
    { icon: '⟲', label: 'Set loop region to clip', key: 'Ctrl+L', run: loopToSelection },
    ...(audio ? [{ icon: '◺', label: 'Fade in (short)', sub: 'or drag the clip’s top-left corner', run: fade('fadeIn', 0.25) }, { icon: '◿', label: 'Fade out (1 beat)', sub: 'or drag the top-right corner', run: fade('fadeOut', 1) }, { icon: '▭', label: 'Remove fades', run: async () => { snapshot(); fc.c.fadeIn = 0; fc.c.fadeOut = 0; await commit(false); } }] : []),
    { icon: '×', label: 'Delete', key: 'Del', run: deleteClip }
  ]);
}
$('#lanes').addEventListener('contextmenu', e => { const el = e.target.closest('.clip'); if (!el) return; e.preventDefault(); const fc = findClip(el.dataset.clip); UI.clip = fc.c.id; UI.track = fc.t.id; markSel(); clipMenu(fc, e); });
// tools: pointer (1) and scissors (3), Cubase-style
UI.tool = 'select';
function setTool(t) { UI.tool = t; $('#tSel').classList.toggle('on', t === 'select'); $('#tSplit').classList.toggle('on', t === 'split'); document.body.classList.toggle('scissors', t === 'split'); }
$('#tSel').onclick = () => setTool('select'); $('#tSplit').onclick = () => setTool('split');

// ---------- install, download, about ----------
export const VERSION = '1.4.0';
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => toast('Rose is installed — open it from your Dock, Launchpad or Start menu'));
if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude\.ai|claudeusercontent/.test(location.hostname)) navigator.serviceWorker.register('sw.js').then(reg => {
  // installed web app: when a new version is published, offer a one-click reload
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Rose was updated — press Ctrl+S if needed, then reload to use the new version'); });
  setInterval(() => reg.update().catch(() => { }), 30 * 60 * 1000);
}).catch(() => { });
const DL = 'https://github.com/mosheshlomorosenfeld-alt/Rose/releases/latest';
$('#bInstall').onclick = async () => {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome === 'accepted') return; }
  if (matchMedia('(display-mode: standalone)').matches) return toast('You\u2019re already using the installed app');
  dialog('Install Rose', `<ol><li><b>Chrome or Edge</b> (Mac or PC): click the install icon at the right end of the address bar, or ⋮ menu → <i>Cast, save and share</i> → <i>Install page as app</i>.</li>
    <li><b>Safari on Mac</b>: menu bar → <i>File</i> → <i>Add to Dock</i>.</li><li><b>iPad / iPhone</b>: Share button → <i>Add to Home Screen</i>.</li></ol>
    <p>The installed app gets its own window and icon, and opens even without internet. Your songs stay saved inside it.</p>`);
};
$('#bDownload').onclick = () => dialog('Rose desktop app', `<p>The desktop version runs your real <b>VST3 and Audio Unit plugins</b> (Serum, SHRUB, FabFilter, Softube Flow, Google Flow Music…).</p>
  <p><a class="tb accent" href="${DL}/download/Rose-mac.zip" target="_blank" rel="noopener">Download for Mac</a> <a class="tb" href="${DL}/download/Rose-windows.zip" target="_blank" rel="noopener">Download for Windows</a></p>
  <p style="font-size:13px"><a href="download.html" target="_blank" rel="noopener">Full download page</a> · <code>${DL}</code><br>Mac first launch: unzip, drag Rose to Applications, then right-click Rose → <i>Open</i> → <i>Open</i> (it isn't signed with an Apple developer certificate yet).</p>`);
$('#bAbout').onclick = () => dialog('Rose Studio', `<div style="display:flex;gap:16px;align-items:center"><img src="icons/icon-192.png" width="72" height="72" alt="" style="border-radius:16px"><div><b style="font-size:17px">Rose Studio ${VERSION}</b><br><span style="color:var(--mute)">by Moshe Rosenfeld</span></div></div>
  <p>${Object.keys(EFFECTS).length} effects including Rose Tune pitch correction and vocal tools, ${SOUND_LIB.length} sampled instruments plus synth, drums and sampler, song templates, automation, a clip launcher, linked patterns, an arpeggiator and chord pads, sidechain and group buses, Strip Silence, and WAV and MIDI export.</p>
  <p style="color:var(--mute);font-size:13px">Rose Sounds: FluidR3 GM SoundFont by Frank Wen (MIT), rendered by midi-js-soundfonts (CC BY 3.0).</p>
  <p style="color:var(--mute);font-size:13px">Desktop app with VST3/AU hosting: File → Download desktop app.</p>`);
function dialog(title, html) {
  $('.help')?.remove(); const d = document.createElement('div'); d.className = 'help';
  d.innerHTML = `<div class="card" role="dialog" aria-label="${esc(title)}" style="max-width:560px"><h2>${esc(title)}</h2>${html}<button class="tb accent" data-close style="margin-top:10px">Close</button></div>`;
  document.body.append(d); d.onclick = e => { if (e.target === d || e.target.closest('[data-close]')) d.remove(); }; d.querySelector('[data-close]').focus();
}

// ---------- double-click controls ----------
// Pro-DAW behaviour: double-click any knob, fader or slider to reset it; double-click a value to type an exact number.
function fire(el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
function typeValue(out) {
  const range = out.previousElementSibling; if (!range || range.type !== 'range' || out.querySelector('input')) return;
  const ed = document.createElement('input'); ed.className = 'valedit'; ed.value = out.textContent.replace(/\s*(Hz|dB|ms|s|st|beats|x|ct|×|:1)$/, ''); out.textContent = ''; out.append(ed); ed.focus(); ed.select();
  const done = ok => {
    if (ok) {
      let t = ed.value.trim().toLowerCase(), v = parseFloat(t); if (/k\s*(hz)?$/.test(t)) v *= 1000; if (/ms$/.test(t) && +range.max <= 60) v = v / 1000;
      if (Number.isFinite(v)) { const d = range.dataset; let pos = v;
        if (d.log) { const lo = +d.vmin, hi = +d.vmax; v = Math.max(lo, Math.min(hi, v)); pos = Math.log(v / lo) / Math.log(hi / lo) * 1000; }
        range.value = Math.max(+range.min, Math.min(+range.max, pos)); fire(range); }
    }
    if (!out.textContent || out.contains(ed)) { ed.remove(); fire(range); }
  };
  ed.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  ed.onblur = () => done(true);
}
// sliders: detect the double-click ourselves (browsers skip dblclick on some sliders, e.g. vertical faders)
let lastPD = { el: null, t: 0 };
document.addEventListener('pointerdown', e => {
  const r = e.target.closest('input[type=range][data-def]'); if (!r) return; const now = performance.now();
  if (lastPD.el === r && now - lastPD.t < 400) {
    lastPD = { el: null, t: 0 }; const reset = () => { r.value = r.dataset.def; fire(r); };
    r.addEventListener('pointerup', () => { reset(); toastQuiet('Reset to default'); }, { once: true }); setTimeout(reset, 0);
  } else lastPD = { el: r, t: now };
}, true);
document.addEventListener('dblclick', e => {
  if (e.target.closest('input[type=range][data-def]')) return;
  const o = e.target.closest('.pr output'); if (o) { typeValue(o); return; }
  if (e.target.closest('.lcd')) { goToBar(); return; }
  const dt = e.target.closest('.dev h4 .t'); if (dt) { dt.closest('.dev').querySelector('[data-a=byp]')?.click(); return; }
  const cn = e.target.closest('.ch .cname'); if (cn) { const ch = cn.closest('.ch'); UI.dev = { kind: ch.dataset.kind, id: ch.dataset.id }; if (ch.dataset.kind === 'track') UI.track = ch.dataset.id; setTab('devices'); return; }
  const cs = e.target.closest('.th .cs'); if (cs) { const t = trk(cs.closest('.th').dataset.id); snapshot(); const C = ['#ff4f8b', '#ffb020', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6', '#f43f5e', '#eab308', '#06b6d4', '#f97316']; t.color = C[(C.indexOf(t.color) + 1) % C.length]; commit(false); return; }
  if (e.target.closest('.tabs [data-tab]') && UI.tab === e.target.closest('[data-tab]').dataset.tab) { const cur = getComputedStyle(document.documentElement).getPropertyValue('--dockH').trim(); document.documentElement.style.setProperty('--dockH', cur === '70vh' ? '44vh' : '70vh'); setTimeout(() => { renderLanes(); if (UI.tab === 'devices') fitRack(); }, 50); return; }
  if (e.target.closest('.mk,.tflag,.sec,.chd,.srow2')) return;
  if (e.target.closest('#ruler') && UI.view !== 'session' && !e.target.closest('.loopr')) { const r2 = $('#ruler').getBoundingClientRect(); const b = Math.max(0, (e.clientX - r2.left) / UI.ppb); E.stop(true); E.p.cursor = b; E.play(b); return; }
  if (e.target.closest('.loopr')) { $('#bLoop').click(); return; }
});
function goToBar() {
  const lcd = $('.lcd'); if (lcd.querySelector('input')) return; const span = $('#pos');
  const ed = document.createElement('input'); ed.className = 'valedit'; ed.value = span.textContent; ed.setAttribute('aria-label', 'Go to bar.beat'); span.hidden = true; lcd.prepend(ed); ed.focus(); ed.select();
  let closed = false;
  const done = ok => { if (closed) return; closed = true; const [bar, beat = 1] = ed.value.split('.').map(Number); ed.remove(); span.hidden = false; if (ok && bar > 0) E.seek(barStart(P(), bar - 1) + (beat - 1)); };
  ed.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  ed.onblur = () => done(true);
}

// ---------- library ----------
const PRESET_INFO = { 'Supersaw Lead': 'Big EDM lead', 'Pluck': 'Short, bouncy pluck', 'Warm Pad': 'Soft chords that swell', 'Sub Bass': 'Deep, clean low end', 'Reese Bass': 'Wide, gritty bass', 'Keys': 'Electric-piano style', 'Chip Square': '8-bit game sound', 'Brass': 'Punchy stabs' };
const FX_INFO = { eq: 'Shape the tone', filter: 'Sweeps & wobbles', comp: 'Even out levels, add punch', limiter: 'Make it loud, stop clipping', gate: 'Cut background noise', reverb: 'Room & space', delay: 'Echoes in time', chorus: 'Thicker, wider', flanger: 'Jet-plane swoosh', phaser: 'Swirling movement', tremolo: 'Volume / pan wobble', pump: 'EDM sidechain pump', distortion: 'Grit & warmth', crusher: 'Lo-fi crunch', width: 'Wider stereo', utility: 'Gain, mono, phase', tune: 'Pitch correction — set key & scale', deesser: 'Tame harsh S sounds', harmonizer: 'Instant 2-part harmonies', doubler: 'Double-tracked, wider vocal', pitch: 'Shift pitch up or down' };
function renderLib() {
  const t = trk(UI.track);
  const onT = t && t.kind === 'inst' ? esc(t.name) : 'an instrument track';
  $('#lib').innerHTML = `<h5>Templates</h5><div class="chips2"><button data-tplopen="1" class="wide" title="EDM, pop, trap, R&B, simcha, orchestral, podcast…">New song from a template</button></div>
    <h5>Loops <span class="h5n">${LOOPS ? LOOPS.length + ' free · CC0' : ''}</span></h5>${loopsHtml()}
    <h5>Real instruments</h5><div class="chips2">${SOUND_LIB.map(x => `<button data-sound="${esc(x.name)}" title="${x.cat} — sampled, open source">${esc(x.name)}</button>`).join('')}</div>
    <h5>Synth presets</h5><div class="chips2">${Object.keys(SYNTH_PRESETS).map(n => `<button data-preset="${esc(n)}" title="${PRESET_INFO[n] || ''}">${esc(n)}</button>`).join('')}
    <button data-addk="drums" title="Step-sequencer beat">Drum kit</button><button data-addk="sampler" title="Play any sound across the keyboard">Sampler</button><button data-addk="external" class="wide" title="Play SHRUB, an FM-1 or hardware">External MIDI</button></div>
    <h5>Patterns</h5><div class="chips2">${Object.entries(P().patterns || {}).map(([id, pt]) => `<button data-pat="${id}" title="${pt.len} beats — click to place on ${onT}">⧉ ${esc(pt.name)}</button>`).join('')}<button data-newpat="1" title="A linked clip you can paint across the song">+ New</button></div>
    <h5>MIDI tools</h5><div class="chips2"><button data-midi="arp" title="Turn held chords into arpeggios">Arpeggiator</button><button data-midi="chord" title="Play full chords from single notes">Chord maker</button><button data-cgen="1" class="wide" title="Whole progressions in any key and style, with voicings, rhythms and bass">Chord generator</button><button data-midi="pads" class="wide" title="Click chords in any key">Chord pads</button></div>
    <h5>Vocal tools${t ? ' → ' + esc(t.name) : ''}</h5><div class="chips2"><button data-chain="vocal" class="wide" title="Rose Tune → EQ → De-esser → Compressor, plus reverb send">Vocal chain (one click)</button>${['tune', 'deesser', 'harmonizer', 'doubler', 'pitch'].map(k => `<button data-fx="${k}" title="${FX_INFO[k]}">${esc(EFFECTS[k].name)}</button>`).join('')}</div>
    <h5>Effects${t ? ' → ' + esc(t.name) : ''}</h5><div class="chips2">${Object.entries(EFFECTS).filter(([, d]) => d.cat !== 'Vocal').map(([k, d]) => `<button data-fx="${k}" title="${FX_INFO[k] || d.cat}">${esc(d.name.replace(/^(Parametric|Sidechain|Spectrum|Stereo|Tremolo \/) ?/, m => m === 'Parametric ' ? '' : m))}</button>`).join('')}</div>
    <h5>Mixing</h5><div class="chips2"><button data-addk="group" class="wide" title="Mix several tracks together">Group bus</button></div>`;
  $('#lib').querySelectorAll('[data-fx],[data-chain]').forEach(b => { b.draggable = true; b.title = (b.title ? b.title + ' — ' : '') + 'click to add, or drag onto a mixer channel, track or the device rack'; });
  bindLoops();
}

// ---------- loop library (CC0 loops from the Stargate DAW sample pack and Sonic Pi) ----------
let LOOPS = null, preview = null;
const KEY12 = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
async function loopLib() { if (!LOOPS) try { LOOPS = (await (await fetch('loops/index.json')).json()).loops; } catch { LOOPS = []; } return LOOPS; }
const loopShift = L => { if (!UI.loopKey || !L.key) return 0; let d = (KEY12.indexOf(UI.loopKey) - KEY12.indexOf(L.key) + 12) % 12; return d > 6 ? d - 12 : d; };
function loopRows() {
  const q = (UI.loopQ || '').toLowerCase(), cat = UI.loopCat || '';
  const list = (LOOPS || []).filter(L => (!cat || L.cat === cat) && (!q || (L.name + ' ' + L.cat + ' ' + (L.bpm || '') + ' ' + (L.key || '')).toLowerCase().includes(q)));
  if (!LOOPS) return '<p class="small">Loading loops…</p>'; if (!list.length) return '<p class="small">No loops match.</p>';
  return list.map(L => `<div class="loop ${preview?.id === L.id ? 'on' : ''}" draggable="true" data-loop="${L.id}" title="Drag into the arrangement — it follows the song tempo"><button data-lp="${L.id}" aria-label="Preview ${esc(L.name)}">${preview?.id === L.id ? '■' : '▶'}</button><span class="ln">${esc(L.name.replace(/^(Drums|Bass|Chords|Guitar|Melody|Ambience) · /, ''))}</span><span class="lm">${L.cat}${L.bpm ? ' · ' + Math.round(L.bpm) : ''}${L.key ? ' · ' + (loopShift(L) ? UI.loopKey : L.key) : ''}</span><button data-loopadd="${L.id}" aria-label="Add ${esc(L.name)} at the playhead" title="Add at the playhead">+</button></div>`).join('');
}
function loopsHtml() {
  const cats = [...new Set((LOOPS || []).map(L => L.cat))];
  return `<div class="loopbar"><input id="loopQ" type="search" placeholder="Search loops" value="${esc(UI.loopQ || '')}" aria-label="Search loops">
    <select id="loopCat" aria-label="Loop type"><option value="">All types</option>${cats.map(c => `<option ${UI.loopCat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <select id="loopKey" aria-label="Play loops in key" title="Pitch every melodic loop into this key (speed stays the same)"><option value="">Original key</option>${KEY12.map(k => `<option ${UI.loopKey === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="loops" id="loopList">${loopRows()}</div>`;
}
function bindLoops() {
  const box = $('#loopList'); if (!box) return;
  $('#loopQ').oninput = e => { UI.loopQ = e.target.value; box.innerHTML = loopRows(); };
  $('#loopCat').onchange = e => { UI.loopCat = e.target.value; box.innerHTML = loopRows(); };
  $('#loopKey').onchange = e => { UI.loopKey = e.target.value; box.innerHTML = loopRows(); if (preview) { const id = preview.id; stopPreview(); previewLoop(id); } };
  box.onclick = e => {
    const pb = e.target.closest('[data-lp]'), ab = e.target.closest('[data-loopadd]');
    if (pb) { preview?.id === pb.dataset.lp ? stopPreview() : previewLoop(pb.dataset.lp); }
    else if (ab) { const t = trk(UI.track); placeLoop(LOOPS.find(L => L.id === ab.dataset.loopadd), t?.kind === 'audio' ? t.id : null, P().cursor || 0); }
  };
  box.ondblclick = e => { const r = e.target.closest('[data-loop]'); if (r && !e.target.closest('button')) placeLoop(LOOPS.find(L => L.id === r.dataset.loop), null, P().cursor || 0); };
  box.ondragstart = e => { const r = e.target.closest('[data-loop]'); if (!r) return; e.dataTransfer.setData('application/x-rose-loop', r.dataset.loop); e.dataTransfer.effectAllowed = 'copy'; DRAG.kind = 'loop'; };
  box.ondragend = () => dragEnd();
}
const loopBuffers = new Map();
async function loopBuffer(L) {
  if (!loopBuffers.has(L.id)) loopBuffers.set(L.id, fetch(`loops/${L.id}.mp3`).then(r => r.arrayBuffer()).then(ab => E.ctx.decodeAudioData(ab)).catch(() => (loopBuffers.delete(L.id), null)));
  return loopBuffers.get(L.id);
}
function stopPreview() { if (!preview) return; try { preview.src.stop(); } catch { } preview.nodes.forEach(n => n.disconnect()); preview = null; const b = $('#loopList'); if (b) b.innerHTML = loopRows(); }
async function previewLoop(id) {
  stopPreview(); await E.start(); const L = LOOPS.find(x => x.id === id), buf = await loopBuffer(L); if (!buf) return toast('Couldn’t load that loop');
  // audition at the song tempo and chosen key, like it will sound in the song
  const ctx = E.ctx, src = ctx.createBufferSource(), g = ctx.createGain(), rate = L.bpm ? P().bpm / L.bpm : 1, semis = loopShift(L) - (L.bpm ? 12 * Math.log2(rate) : 0), pw = Math.abs(semis) > 0.004 ? worklet(ctx, 'rose-pitch') : null;
  src.buffer = buf; src.loop = true; if (L.beats && L.bpm) { src.loopEnd = Math.min(buf.duration, L.beats * 60 / L.bpm); } src.playbackRate.value = rate; g.gain.value = 0.8;
  if (pw) { pw.parameters.get('mode').value = 1; pw.parameters.get('shift').value = Math.trunc(semis); pw.parameters.get('detune').value = (semis - Math.trunc(semis)) * 100; src.connect(pw).connect(g); } else src.connect(g);
  g.connect(ctx.destination); src.start(); preview = { id, src, nodes: [src, g, pw].filter(Boolean) }; const b = $('#loopList'); if (b) b.innerHTML = loopRows();
}
async function placeLoop(L, trackId, beat, newTrackAt) {
  if (!L) return; stopPreview(); toast(`Adding ${L.name}…`);
  let id = Object.entries(P().audio || {}).find(([k, a]) => a.loop === L.id && E.buffers.get(k))?.[0];
  if (!id) { const ab = await (await fetch(`loops/${L.id}.mp3`)).arrayBuffer(); id = await E.addAudio(ab, L.name); if (!id) return toast('Couldn’t add that loop'); }
  snapshot(); P().audio[id] = { name: L.name, loop: L.id };
  const len0 = L.bpm && L.beats ? L.beats : E.buffers.get(id).duration / E.spb, b0 = snapB(beat);
  let t = trackId && trk(trackId)?.kind === 'audio' ? trk(trackId) : null;
  if (t && t.clips.some(c => c.start < b0 + len0 - 1e-6 && c.start + c.len > b0 + 1e-6)) t = null;   // never stack on top of another clip
  if (!t) { t = newTrack('audio', null, P().tracks.filter(x => x.kind === 'audio').length + 1); t.name = (L.cat === 'Drums' || L.cat === 'Percussion' ? L.name.replace(/ · .*/, '') : L.name).slice(0, 24); P().tracks.splice(newTrackAt ?? P().tracks.length, 0, t); }
  const c = { id: uid(), name: L.name, start: snapB(beat), sample: id, offset: 0, gain: 0 };
  if (L.bpm && L.beats) { c.bpm = L.bpm; c.len = L.beats; c.loopLen = L.beats; } else c.len = E.buffers.get(id).duration / E.spb;
  const sh = loopShift(L); if (sh) c.pitch = sh;
  t.clips.push(c); UI.track = t.id; UI.clip = c.id; await commit(true);
  toast(`${L.name} added${c.bpm ? ` — stretched to ${P().bpm} BPM` : ''}${sh ? `, pitched to ${UI.loopKey}` : ''}. Drag its right edge to repeat it`);
}
loopLib().then(() => { if (UI.lib && $('#lib').innerHTML) renderLib(); });

// ---------- drag and drop: effects onto the mixer, tracks and rack; loops into the arrangement ----------
const DRAG = { kind: null };
function dragEnd() { DRAG.kind = null; document.querySelectorAll('.dropok,.dropbefore,.dropafter').forEach(el => el.classList.remove('dropok', 'dropbefore', 'dropafter')); }
$('#lib').addEventListener('dragstart', e => {
  const b = e.target.closest('[data-fx],[data-chain]'); if (!b) return;
  e.dataTransfer.setData('application/x-rose-fx', b.dataset.fx || 'chain:vocal'); e.dataTransfer.effectAllowed = 'copy'; DRAG.kind = 'fx';
});
$('#lib').addEventListener('dragend', dragEnd);
const fxTarget = el => {   // which channel an effect would land on
  const ch = el.closest('.ch'); if (ch) return ch.dataset.kind === 'master' ? { kind: 'master', o: P().master, el: ch } : ch.dataset.kind === 'return' ? { kind: 'return', o: P().returns.find(r => r.id === ch.dataset.id), el: ch } : { kind: 'track', o: trk(ch.dataset.id), el: ch };
  const th = el.closest('.th'); if (th) return { kind: 'track', o: trk(th.dataset.id), el: th };
  const lane = el.closest('.lane'); if (lane && lane.dataset.id) return { kind: 'track', o: trk(lane.dataset.id), el: lane };
  const rack = el.closest('#devices'); if (rack) { const d = UI.dev; const o = d.kind === 'master' ? P().master : d.kind === 'return' ? P().returns.find(r => r.id === d.id) : trk(d.id); return o && { kind: d.kind, o, el: rack, rack: true }; }
  return null;
};
function rackIndex(e, o) {   // insert position from the card under the pointer
  const cards = [...document.querySelectorAll('#devices .dev[data-slot]')]; document.querySelectorAll('.dropbefore,.dropafter').forEach(x => x.classList.remove('dropbefore', 'dropafter'));
  for (const c of cards) { const r = c.getBoundingClientRect(); if (e.clientY < r.bottom && e.clientX < r.right && e.clientY > r.top - 4) { const before = e.clientX < r.left + r.width / 2; c.classList.add(before ? 'dropbefore' : 'dropafter'); const i = o.inserts.findIndex(s => s.id === c.dataset.slot); return before ? i : i + 1; } }
  return o.inserts.length;
}
const fxTypes = e => [...e.dataTransfer.types];
document.addEventListener('dragover', e => {
  const ty = fxTypes(e), isFx = ty.includes('application/x-rose-fx'), isSlot = ty.includes('application/x-rose-slot'), isLoop = ty.includes('application/x-rose-loop');
  if (!isFx && !isSlot && !isLoop) return;
  document.querySelectorAll('.dropok').forEach(x => x.classList.remove('dropok'));
  if (isLoop) { const lw = e.target.closest('#lanesWrap'); if (!lw) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const r = $('#lanes').getBoundingClientRect(), lane = document.querySelectorAll('#lanes .lane')[Math.floor((e.clientY - r.top) / LANE)]; (lane || lw).classList.add('dropok'); return; }
  const tg = fxTarget(e.target); if (!tg || !tg.o || tg.o.kind === 'group' && false) return;
  e.preventDefault(); e.dataTransfer.dropEffect = isSlot && !e.altKey ? 'move' : 'copy'; tg.el.classList.add('dropok'); if (tg.rack) rackIndex(e, tg.o);
});
document.addEventListener('drop', async e => {
  const ty = fxTypes(e), fx = e.dataTransfer.getData('application/x-rose-fx'), slotId = e.dataTransfer.getData('application/x-rose-slot'), loopId = e.dataTransfer.getData('application/x-rose-loop');
  if (!fx && !slotId && !loopId) return; e.preventDefault(); e.stopPropagation();
  if (loopId) {
    dragEnd(); if (UI.view === 'session') return toast('Switch to the Arrangement to drop loops'); const r = $('#lanes').getBoundingClientRect(), i = Math.floor((e.clientY - r.top) / LANE), lane = P().tracks[i];
    return placeLoop(LOOPS.find(L => L.id === loopId), lane?.id, Math.max(0, Math.floor((e.clientX - r.left) / UI.ppb / P().sig) * P().sig), lane ? i + 1 : undefined);
  }
  const tg = fxTarget(e.target); const at = tg?.rack ? rackIndex(e, tg.o) : null; dragEnd(); if (!tg?.o) return;
  snapshot(); const o = tg.o, where = tg.kind === 'master' ? 'Master' : o.name;
  if (fx === 'chain:vocal') {
    const add = (type, params) => { if (!o.inserts.some(s => s.type === type)) o.inserts.push({ id: uid(), type, params, bypass: false }); };
    add('tune', { key: 'C', scale: 'Major', speed: 20 }); add('eq', { hp: 90, m1f: 300, m1g: -2, hsg: 2.5 }); add('deesser', { threshold: -32 }); add('comp', { threshold: -22, ratio: 3.5, attack: 0.006, release: 0.12, makeup: 4 });
    if (o.sends) o.sends.A = Math.max(o.sends.A || 0, 0.25); toast(`Vocal chain added to ${where}`);
  } else if (fx) { o.inserts.splice(at ?? o.inserts.length, 0, { id: uid(), type: fx, params: {}, bypass: false }); toast(`${EFFECTS[fx].name} added to ${where}`); }
  else {   // a device dragged out of the rack: reorder, or move (Alt/Option = copy) to another channel
    const from = DRAG.from, src = from && (from.kind === 'master' ? P().master : from.kind === 'return' ? P().returns.find(r => r.id === from.id) : trk(from.id)); if (!src) return;
    const i = src.inserts.findIndex(s => s.id === slotId); if (i < 0) return; const slot = src.inserts[i];
    if (e.altKey) { const cp = JSON.parse(JSON.stringify(slot)); cp.id = uid(); o.inserts.splice(at ?? o.inserts.length, 0, cp); toast(`${EFFECTS[slot.type]?.name || 'Plugin'} copied to ${where}`); }
    else { src.inserts.splice(i, 1); let j = at ?? o.inserts.length; if (src === o && j > i) j--; o.inserts.splice(j, 0, slot); if (src !== o) { (o.auto || []).length; toast(`${EFFECTS[slot.type]?.name || 'Plugin'} moved to ${where} — hold Alt to copy instead`); } }
  }
  UI.dev = tg.kind === 'master' ? { kind: 'master' } : { kind: tg.kind, id: o.id }; await commit(true);
}, true);
document.addEventListener('dragstart', e => {   // drag a device card by its title bar
  const card = e.target.closest?.('#devices .dev[data-slot]'); if (!card) return;
  e.dataTransfer.setData('application/x-rose-slot', card.dataset.slot); e.dataTransfer.effectAllowed = 'copyMove'; DRAG.kind = 'slot'; DRAG.from = { ...UI.dev };
});
document.addEventListener('dragend', dragEnd);
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
  else if (b.dataset.tplopen) newFromTemplate();
  else if (b.dataset.cgen) chordGenWin();
  else if (b.dataset.sound) {
    const name = b.dataset.sound;
    if (t && t.inst === 'sounds') { snapshot(); t.instParams.patch = name; if (SOUND_LIB.some(x => x.name === t.name)) t.name = name; E.setInstParam(t.id, 'patch', name); persist(); render(); toast(`Loading ${name}…`); await E.g?.tracks.get(t.id)?.inst?.ready; toast(`${name} on ${t.name}`); E.liveOn(t.id, 60, 0.8); setTimeout(() => E.liveOff(t.id, 60), 500); }
    else { const nt = await addTrackOf('sounds', { patch: name }); toast(`${name} added — play the A to ; keys`); }
  } else if (b.dataset.chain) {
    if (!t) return toast('Select a vocal track first'); snapshot();
    const key = t.inserts.find(s => s.type === 'tune')?.params.key || 'C';
    const add = (type, params) => t.inserts.push({ id: uid(), type, params, bypass: false });
    if (!t.inserts.some(s => s.type === 'tune')) add('tune', { key, scale: 'Major', speed: 20 });
    const has = k => t.inserts.some(s => s.type === k);
    if (!has('eq')) add('eq', { hp: 90, m1f: 300, m1g: -2, hsg: 2.5 }); if (!has('deesser')) add('deesser', { threshold: -32 }); if (!has('comp')) add('comp', { threshold: -22, ratio: 3.5, attack: 0.006, release: 0.12, makeup: 4 });
    t.sends.A = Math.max(t.sends.A || 0, 0.25); UI.dev = { kind: 'track', id: t.id }; await commit(true); setTab('devices'); toast('Vocal chain added — set Rose Tune to your song’s key');
  }
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
  <h2>Rose Studio in one minute</h2><p style="color:var(--mute);margin:0">Everything starts from <b>Add track</b> and the <b>Library</b>.</p>
  <div class="cols"><div><h3>Make a beat</h3><ol><li>Add track → <b>Drums</b></li><li>Click the squares in the Editor below — each column is a 16th note</li><li>Shift-click a square for a louder hit</li><li>Press <kbd>Space</kbd> to hear it loop</li></ol>
  <h3>Play &amp; record notes</h3><ol><li>Pick an instrument in the Library</li><li>Play with your keyboard: <kbd>A</kbd>–<kbd>;</kbd> (<kbd>Z</kbd>/<kbd>X</kbd> change octave) or a MIDI keyboard</li><li>Click ● on the track, then Record (<kbd>R</kbd>)</li><li>Or double-click a lane and click in the piano roll to draw notes</li></ol></div>
  <div><h3>Record vocals</h3><ol><li>Add track → <b>Audio / vocals</b></li><li>Click ● on it, then Record — allow the microphone</li><li>Stop with <kbd>Space</kbd>; your take appears as a clip</li></ol>
  <h3>Tune &amp; polish vocals</h3><ol><li>Library → <b>Vocal chain (one click)</b> on the vocal track</li><li>In <b>Rose Tune</b> set Key and Scale; Retune speed 0 ms = hard T-Pain snap, 20–40 ms = natural pop</li><li>Add <b>Harmonizer</b> or <b>Vocal Doubler</b> for instant stacks</li></ol>
  <h3>Start fast</h3><ol><li>File → <b>New from template</b>: EDM, pop, trap, R&amp;B, simcha, orchestral, podcast</li><li>Library → <b>Real instruments</b> for piano, strings, choir, brass and more</li></ol>
  <h3>Mix &amp; finish</h3><ol><li><b>Sound &amp; FX</b>: add effects (try Compressor, then Reverb)</li><li><b>Mixer</b>: faders, pan, and A/B sends to the reverb &amp; delay buses</li><li>File → <b>Export WAV</b> to share your song</li></ol></div></div>
  <div class="cols"><div><h3>Automation</h3><ol><li>Click <b>A</b> on a track</li><li>Pick what to automate (volume, pan, sends or any effect knob)</li><li>Click the lane to add points, drag to shape, double-click to remove</li></ol>
  <h3>Patterns (FL Studio style)</h3><ol><li>Library → <b>+ New pattern</b>, or “Make pattern” on a clip</li><li>Click the pattern in the Library to paint copies — edit one, they all change</li></ol></div>
  <div><h3>Session / clip launcher (Ableton style)</h3><ol><li>Switch to <b>Session</b> at the top</li><li>Double-click a slot to make a clip, or send a clip there with “→ Session”</li><li>Press ▶ on a clip or a whole Scene — it starts on the next bar</li></ol>
  <h3>Pro mixing</h3><ol><li><b>Sidechain Compressor</b>: pick the kick as its key track</li><li>Add track → <b>Group bus</b>, then route tracks to it in the Mixer</li><li>Track ⋯ → <b>Bounce to audio</b> to print a track with its effects</li><li>The Mixer shows a live spectrum of your master</li></ol></div></div>
  <div class="cols"><div><h3>Key commands</h3><dl class="keys"><dt>Play / pause</dt><dd><kbd>Space</kbd></dd><dt>Stop, then back to start</dt><dd><kbd>Enter</kbd></dd><dt>Record</dt><dd><kbd>R</kbd></dd><dt>Loop on / off</dt><dd><kbd>C</kbd></dd><dt>Loop the selected clip</dt><dd><kbd>Ctrl+L</kbd></dd><dt>Metronome</dt><dd><kbd>M</kbd></dd><dt>Arrange / Session</dt><dd><kbd>Tab</kbd></dd><dt>Cut / copy / paste</dt><dd><kbd>Ctrl+X / C / V</kbd></dd><dt>Duplicate</dt><dd><kbd>Ctrl+D</kbd></dd><dt>Split at playhead</dt><dd><kbd>B or Ctrl+E</kbd></dd><dt>Split where you click</dt><dd><kbd>Alt-click, or scissors (3)</kbd></dd><dt>Pointer tool</dt><dd><kbd>1</kbd></dd><dt>Quantize clip</dt><dd><kbd>Q</kbd></dd><dt>Nudge clip</dt><dd><kbd>← →  (Alt: fine)</kbd></dd><dt>Delete clip</dt><dd><kbd>Delete</kbd></dd><dt>Undo / redo</dt><dd><kbd>Ctrl+Z / Ctrl+Shift+Z</kbd></dd><dt>Save project</dt><dd><kbd>Ctrl+S</kbd></dd><dt>Play notes</dt><dd><kbd>A to ;   (Z / X octave)</kbd></dd><dt>This guide</dt><dd><kbd>?</kbd></dd></dl></div><div><h3>Double-click</h3><dl class="keys"><dt>Knob, fader or slider</dt><dd>Reset to default</dd><dt>A value</dt><dd>Type an exact number, e.g. 2.5k</dd><dt>Empty lane</dt><dd>New clip</dd><dt>Clip</dt><dd>Open its editor</dd><dt>Ruler</dt><dd>Play from there</dd><dt>Loop bar</dt><dd>Loop on / off</dd><dt>Counter</dt><dd>Jump to a bar</dd><dt>Effect name</dt><dd>Bypass</dd><dt>Mixer channel name</dt><dd>Show its effects</dd><dt>Track colour strip</dt><dd>Next colour</dd><dt>Active tab</dt><dd>Taller panel</dd></dl><p>Right-click a clip for every clip command. Drag a clip\u2019s top corners for fades and its bottom-right corner to loop it. On a Mac use Cmd instead of Ctrl.</p></div></div>
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
  if (mod && k === 'x') { e.preventDefault(); copyClip(true); return; }
  if (mod && k === 'c') { e.preventDefault(); copyClip(false); return; }
  if (mod && k === 'v') { e.preventDefault(); pasteClip(); return; }
  if (mod && k === 'l') { e.preventDefault(); loopToSelection(); return; }
  if (mod) return;
  if (e.code === 'Space') { e.preventDefault(); E.playing ? E.stop(true) : E.play(); return; }
  if (e.key === 'Enter') { E.stop(); return; }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && UI.clip) {   // pitch the selected clip(s)
    const fc = findClip(UI.clip); if (fc) { e.preventDefault(); pitchClips([fc.ref || fc.c], (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)); return; }
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && UI.clip) {
    const fc = findClip(UI.clip); if (fc && fc.slot == null) { e.preventDefault(); const step = e.altKey ? 1 / 64 : (UI.snap || 0.25), d = e.key === 'ArrowLeft' ? -step : step;
      if (!e.repeat) snapshot(); fc.c.start = Math.max(0, +(fc.c.start + d).toFixed(5)); renderLanes(); persist(); toastQuiet(`Nudged to beat ${(fc.c.start + 1).toFixed(3)}`); return; }
  }
  if (e.key === 'Home') { E.seek(0); return; }
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.code === 'KeyM') { e.preventDefault(); addMarker(); return; }
    if (e.code === 'KeyB') { e.preventDefault(); refAB(); return; }
    if (e.code === 'KeyX') { e.preventDefault(); popMixer(); return; }
    if (e.code === 'KeyG') { e.preventDefault(); chordGenWin(); return; }
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === ',' || e.key === '.')) { e.preventDefault(); jumpMarker(e.key === '.' ? 1 : -1); return; }
  if (e.key === 'Tab') { e.preventDefault(); setView(UI.view === 'session' ? 'arrange' : 'session'); return; }
  if (k === 'b' && !e.repeat) { splitClip(); return; }
  if (k === 'c' && !e.repeat) { $('#bLoop').click(); return; }
  if (k === 'q' && !e.repeat) { const fc = UI.clip && findClip(UI.clip); if (fc && isMidi(fc.c)) { const tg = fc.c.pattern ? P().patterns[fc.c.pattern] : fc.c, gr = UI.prGrid || 0.25; snapshot(); tg.notes.forEach(n => n.s = Math.round(n.s / gr) * gr); commit(false); toast('Quantized'); } return; }
  if (k === '1') { setTool('select'); return; } if (k === '3') { setTool('split'); toast('Scissors — click a clip to split it (press 1 for the pointer)'); return; }
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
  g.fillStyle = 'rgba(128,128,128,.7)'; g.font = '10px "IBM Plex Sans", sans-serif'; [['100', 100], ['1k', 1000], ['10k', 10000]].forEach(([l, hz]) => g.fillText(l, Math.log(hz / 20) / Math.log(1000) * W + 3, H - 4));
  g.beginPath(); for (let x = 0; x <= W; x++) { const hz = 20 * Math.pow(1000, x / W), i = Math.min(n - 1, Math.round(hz / (sr / 2) * n)), v = Math.max(0, Math.min(1, (fbuf[i] + 100) / 80)); const y = H - v * (H - 6); x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = acc; g.globalAlpha = 0.35; g.fill(); g.globalAlpha = 1; g.strokeStyle = acc; g.lineWidth = 1.5; g.stroke();
}
function frame() {
  for (const k in TOOLFRAME) if (floats.has(k)) TOOLFRAME[k](); else delete TOOLFRAME[k];
  const b = E.position(), bi = barAt(P(), b);
  $('#playhead').style.transform = `translateX(${b * UI.ppb}px)`;
  const bar = bi.bar + 1, beat = Math.floor(bi.beat + 1e-6) + 1, six = Math.floor((bi.beat % 1) * 4 + 1e-6) + 1, secs = secAt(P(), b);
  $('#pos').textContent = `${bar}.${beat}.${six}`; $('#clock').textContent = `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`;
  if (E.g) {
    meterDraw($('#mmeter'), peak(E.g.analyser));
    if (UI.tab === 'mixer' && $('#spec')) spectrum($('#spec'), E.g.analyser);
    if (UI.tab === 'devices') document.querySelectorAll('[data-an]').forEach(cv => { const n = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === cv.dataset.an)?.node; if (n?.analyser) spectrum(cv, n.analyser); });
    if (UI.tab === 'mixer') document.querySelectorAll('#mixer .ch').forEach(ch => { const s = E.stripFor(ch.dataset.kind, ch.dataset.id); if (s) meterDraw(ch.querySelector('.mtr'), peak(s.meter)); });
    if (UI.tab === 'devices') document.querySelectorAll('[data-tune]').forEach(el => {
      const f = E.stripFor(UI.dev.kind, UI.dev.id)?.fx.find(f => f.slot.id === el.dataset.tune)?.node, hz = f?.readout?.() || 0;
      if (!hz) { el.textContent = '–'; return; } const m = 69 + 12 * Math.log2(hz / 440), n = Math.round(m), c = Math.round((m - n) * 100);
      el.textContent = `${NOTE_NAMES[(n % 12 + 12) % 12]}${Math.floor(n / 12) - 1} ${c >= 0 ? '+' : '−'}${Math.abs(c)}¢`;
    });
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
