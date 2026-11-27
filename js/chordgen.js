// Rose chord generator — progressions in any key and scale, voice-led voicings, rhythm patterns and bass lines.
// Pure functions: the web app and the desktop app (ChordGen.h, a line-for-line port) make the same chords from the same settings.

export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];   // chord-chart spelling
export const MODES = {
  'Major': [0, 2, 4, 5, 7, 9, 11],
  'Minor': [0, 2, 3, 5, 7, 8, 10],
  'Harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'Freygish (Ahava Raba)': [0, 1, 4, 5, 7, 8, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
};
// Progressions by style. A step is a scale degree (1-7); "b7" = a major chord a whole step below the tonic (borrowed),
// a trailing quality forces it: "4m" = minor iv, "5M" = major V, "2m7" etc.
export const STYLES = {
  'Major': {
    'Pop anthem (I–V–vi–IV)': ['1', '5', '6', '4'],
    'Emotional (vi–IV–I–V)': ['6', '4', '1', '5'],
    'Doo-wop (I–vi–IV–V)': ['1', '6', '4', '5'],
    'Festival EDM (IV–V–vi–vi)': ['4', '5', '6', '6'],
    'Royal road (IV–V–iii–vi)': ['4', '5', '3', '6'],
    'Gospel lift (I–iii–IV–iv)': ['1', '3', '4', '4m'],
    'Neo-soul (ii–V–I–vi)': ['2', '5', '1', '6'],
    'Rock (I–bVII–IV–I)': ['1', 'b7', '4', '1'],
    'Ballad (I–V–vi–iii–IV–I–IV–V)': ['1', '5', '6', '3', '4', '1', '4', '5'],
  },
  'Minor': {
    'Epic (i–VI–III–VII)': ['1', '6', '3', '7'],
    'Dark trap (i–iv–VI–V)': ['1', '4', '6', '5M'],
    'Andalusian (i–VII–VI–V)': ['1', '7', '6', '5M'],
    'Sad pop (i–VI–VII–i)': ['1', '6', '7', '1'],
    'Drill (i–VI–iv–V)': ['1', '6', '4', '5M'],
    'Deep house (i–v–VI–iv)': ['1', '5', '6', '4'],
    'R&B minor (i–iv–VII–III)': ['1', '4', '7', '3'],
  },
  'Harmonic minor': {
    'Cinematic (i–iv–V–i)': ['1', '4', '5', '1'],
    'Tango (i–VI–V–i)': ['1', '6', '5', '1'],
    'Mystic (i–ii°–V–i)': ['1', '2', '5', '1'],
  },
  'Freygish (Ahava Raba)': {
    'Simcha (I–bII–I–iv)': ['1', '2', '1', '4'],
    'Chassidic (I–iv–bII–I)': ['1', '4', '2', '1'],
    'Klezmer (I–vii–bII–I)': ['1', '7', '2', '1'],
    'Niggun (iv–I–bII–I)': ['4', '1', '2', '1'],
  },
  'Dorian': {
    'Funk (i–IV)': ['1', '4', '1', '4'],
    'Santana (i–IV–i–VII)': ['1', '4', '1', '7'],
  },
  'Mixolydian': {
    'Anthem rock (I–bVII–IV–I)': ['1', '7', '4', '1'],
    'Celtic (I–bVII–I–V)': ['1', '7', '1', '5m'],
  },
};
// what usually follows what (for "Surprise me"), by scale degree
const NEXT = { 1: [4, 5, 6, 2, 3, 7], 2: [5, 7, 4], 3: [6, 4, 2], 4: [5, 1, 2, 6], 5: [1, 6, 4], 6: [4, 2, 5, 3], 7: [1, 3, 6] };
export const EXTENSIONS = ['Triads', '7ths', '9ths', 'Sus'];
export const VOICINGS = ['Close', 'Open', 'Drop 2', 'Piano (two hands)', 'Wide pad'];
export const RHYTHMS = ['Sustained', 'Half notes', 'Quarter pulse', 'Eighth pulse', 'Off-beat stabs (house)', 'Charleston', 'Dembow (3-3-2)', 'Arp up', 'Arp up-down', 'Guitar strum', 'Oom-pah (simcha)'];
export const BASSES = ['Off', 'Roots', 'Driving eighths', 'Octaves', 'Root–fifth', 'Walking'];

const QUAL = { '': [0, 4, 7], 'm': [0, 3, 7], 'dim': [0, 3, 6], 'aug': [0, 4, 8], '7': [0, 4, 7, 10], 'maj7': [0, 4, 7, 11], 'm7': [0, 3, 7, 10], 'm7b5': [0, 3, 6, 10], 'dim7': [0, 3, 6, 9], 'mmaj7': [0, 3, 7, 11], '9': [0, 4, 7, 10, 14], 'maj9': [0, 4, 7, 11, 14], 'm9': [0, 3, 7, 10, 14], 'sus2': [0, 2, 7], 'sus4': [0, 5, 7], '7sus4': [0, 5, 7, 10] };
export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// name from intervals over the root
function qualityOf(iv) {
  const set = iv.map(x => x % 12), has = x => set.includes(x);
  const third = has(4) ? 'M' : has(3) ? 'm' : has(5) ? 's4' : has(2) ? 's2' : 'M', fifth = has(7) ? 7 : has(6) ? 6 : has(8) ? 8 : 7, sev = has(11) ? 11 : has(10) ? 10 : has(9) && fifth === 6 ? 9 : 0, nine = iv.some(x => x === 14);
  if (third === 's4') return sev === 10 ? '7sus4' : 'sus4'; if (third === 's2') return 'sus2';
  if (third === 'M') { if (fifth === 8) return 'aug'; if (!sev) return ''; if (sev === 11) return nine ? 'maj9' : 'maj7'; return nine ? '9' : '7'; }
  if (fifth === 6) return sev === 9 ? 'dim7' : sev === 10 ? 'm7b5' : 'dim';
  if (!sev) return 'm'; if (sev === 11) return 'mmaj7'; return nine ? 'm9' : 'm7';
}
// one chord: root pitch class, intervals (from stacking thirds in the scale, or a forced quality) and its name
export function buildChord(step, key, mode, ext) {
  const sc = MODES[mode] || MODES.Major, m = /^(b?)(\d)(.*)$/.exec(step); if (!m) return null;
  const deg = +m[2] - 1, force = m[3];
  const rootOff = m[1] ? (deg === 6 ? 10 : (MODES.Major[deg] + 11) % 12) : sc[deg];   // bVII = 10, bVI = 8, bIII = 3 …
  let iv;
  if (m[1]) iv = [0, 4, 7];                                       // borrowed bVII etc: major
  else { const n = ext === '9ths' ? 5 : ext === '7ths' ? 4 : 3; iv = []; for (let k = 0; k < n; k++) { const d = deg + 2 * k, o = Math.floor(d / 7) * 12; iv.push(sc[d % 7] + o - sc[deg]); } }
  if (force) { const f = force === 'M' ? '' : force; if (QUAL[f]) iv = QUAL[f].slice(); }
  if ((m[1] || force) && iv.length === 3 && iv[2] === 7) { if (ext === '7ths') iv.push(10); if (ext === '9ths') iv.push(10, 14); }
  if (ext === 'Sus' && !force && iv.length >= 3 && iv[2] === 7 && [0, 3, 4].includes(deg)) iv[1] = deg === 4 ? 5 : 2;   // Vsus4, Isus2, IVsus2
  const root = (key + rootOff) % 12;
  return { root, iv, name: NAMES[root] + qualityOf(iv) };
}
export function surprise(mode, len, seed) {
  const r = rng(seed), styles = Object.values(STYLES[mode] || STYLES.Major);
  if (r() < 0.45 || mode === 'Freygish (Ahava Raba)') return styles[Math.floor(r() * styles.length)].slice();
  const out = ['1']; while (out.length < len) { const opts = NEXT[+out.at(-1)] || [1]; let n = opts[Math.floor(Math.pow(r(), 1.6) * opts.length)]; if (out.length === len - 1 && r() < 0.6) n = [4, 5][Math.floor(r() * 2)]; out.push(String(n)); }
  return out;
}
// voice leading: choose the inversion/octave of each chord that moves the fewest semitones from the last one
function voice(ch, prev, style, center) {
  const pcs = ch.iv.map(x => ch.root + x), cands = [];
  for (let inv = 0; inv < pcs.length; inv++) {
    let v = pcs.map((p, i) => p + (i < inv ? 12 : 0)).sort((a, b) => a - b);
    for (let o = -2; o <= 2; o++) { const w = v.map(x => x + 12 * o + 48); if (w[0] >= center - 9 && w[0] <= center + 5) cands.push(w); }
  }
  const cost = w => { if (!prev) return Math.abs(w.reduce((a, x) => a + x, 0) / w.length - center - 4); let c = 0; for (const x of w) c += Math.min(...prev.map(y => Math.abs(x - y))); return c + Math.abs(w[0] - center) * 0.05; };
  let best = cands.sort((a, b) => cost(a) - cost(b))[0] || pcs.map(x => x + 48);
  if (style === 'Open' && best.length >= 3) best = [best[0], ...best.slice(2), best[1] + 12].sort((a, b) => a - b);
  if (style === 'Drop 2' && best.length >= 3) { const i = best.length - 2; best = [best[i] - 12, ...best.filter((_, k) => k !== i)].sort((a, b) => a - b); }
  const lh = 36 + ch.root - (ch.root > 7 ? 12 : 0) + 12;   // left-hand root in octave 3
  if (style === 'Piano (two hands)') best = [lh, lh + 7, ...best.filter(x => x > lh + 7)];
  if (style === 'Wide pad') best = [best[0] - 12, ...best, best[1] + 12].filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => a - b);
  while (best[0] < center - 12) best = best.map(x => x + 12);          // keep it out of the mud…
  while (best[best.length - 1] > center + 26) best = best.map(x => x - 12); // …and out of the squeak
  return best;
}
// the whole thing. o: { key, mode, steps[], bars, perBar, ext, voicing, lead, rhythm, octave, bass, humanize, seed }
export function generate(o) {
  const per = o.perBar || 1, bars = o.bars || 4, beatsPer = 4 / per, n = Math.max(1, Math.round(bars * per)), r = rng((o.seed || 1) * 7919 + 13);
  const steps = []; for (let i = 0; i < n; i++) steps.push(o.steps[i % o.steps.length]);
  const chords = steps.map(st => buildChord(st, o.key, o.mode, o.ext)).filter(Boolean);
  const center = 57 + 12 * (o.octave || 0); let prev = null;
  const notes = [], bass = [], list = [];
  const hum = (x, a) => x + (o.humanize ? (r() - 0.5) * a * o.humanize : 0);
  chords.forEach((ch, i) => {
    const v = o.lead === false ? ch.iv.map(x => ch.root + x + center - (center % 12) + (ch.root + x + center - (center % 12) < center - 6 ? 12 : 0)).sort((a, b) => a - b) : voice(ch, prev, o.voicing, center);
    prev = v; const s = i * beatsPer, L = beatsPer; list.push({ name: ch.name, b: s, len: L, notes: v });
    const hit = (t, len, vel, which = v) => { if (t >= L - 1e-9) return; which.forEach(p => notes.push({ p, s: Math.max(0, hum(s + t, 0.03)), l: Math.min(len, L - t) * 0.98, v: Math.max(0.15, Math.min(1, hum(vel, 0.16))) })); };
    const each = (step, fn) => { for (let t = 0, k = 0; t < L - 1e-9; t += step, k++) fn(t, k); };
    switch (o.rhythm) {
      case 'Half notes': each(2, t => hit(t, 2, 0.72)); break;
      case 'Quarter pulse': each(1, (t, k) => hit(t, 0.9, k % 2 ? 0.62 : 0.75)); break;
      case 'Eighth pulse': each(0.5, (t, k) => hit(t, 0.42, k % 2 ? 0.55 : 0.75)); break;
      case 'Off-beat stabs (house)': each(1, t => hit(t + 0.5, 0.3, 0.8)); break;
      case 'Charleston': each(4, t => { hit(t, 0.6, 0.8); hit(t + 1.5, 0.45, 0.7); }); break;
      case 'Dembow (3-3-2)': each(4, t => [0, 0.75, 1.5, 2, 2.75, 3.5].forEach((x, k) => hit(t + x, 0.3, k % 3 ? 0.62 : 0.8))); break;
      case 'Arp up': case 'Arp up-down': {
        const seq = [...v, v[0] + 12]; const pat = o.rhythm === 'Arp up' ? seq : [...seq, ...seq.slice(1, -1).reverse()];
        each(0.5, (t, k) => notes.push({ p: pat[k % pat.length], s: hum(s + t, 0.02), l: 0.45, v: Math.max(0.2, hum(k % 2 ? 0.6 : 0.75, 0.14)) })); break;
      }
      case 'Guitar strum': each(4, t => [[0, 1, 0.8], [1, 1, 0.7], [1.5, -1, 0.55], [2.5, -1, 0.6], [3, 1, 0.7], [3.5, -1, 0.55]].forEach(([x, dir, vel]) => {
        const ord = dir > 0 ? v : [...v].reverse(); ord.forEach((p, k) => { if (t + x < L) notes.push({ p, s: s + t + x + k * 0.02, l: Math.min(0.5, L - t - x) * 0.95, v: hum(vel, 0.1) }); });
      })); break;
      case 'Oom-pah (simcha)': each(2, t => hit(t + 1, 0.4, 0.72)); break;
      default: hit(0, L, 0.72);
    }
    // bass, octave 2, from the chord root
    const b0 = 36 + ch.root - (ch.root > 7 ? 12 : 0), b5 = b0 + 7, nextRoot = chords[i + 1] ? 36 + chords[i + 1].root - (chords[i + 1].root > 7 ? 12 : 0) : b0;
    const bn = (p, t, len, vel) => { if (t < L - 1e-9) bass.push({ p, s: s + t, l: Math.min(len, L - t) * 0.95, v: vel }); };
    switch (o.bass) {
      case 'Roots': bn(b0, 0, L, 0.85); break;
      case 'Driving eighths': each(0.5, (t, k) => bn(b0, t, 0.45, k % 2 ? 0.7 : 0.85)); break;
      case 'Octaves': each(0.5, (t, k) => bn(k % 2 ? b0 + 12 : b0, t, 0.45, 0.8)); break;
      case 'Root–fifth': each(2, (t, k) => bn(k % 2 ? b5 : b0, t, 1.8, 0.82)); break;
      case 'Walking': each(1, (t, k) => { const last = t + 1 >= L - 1e-9; bn(last ? nextRoot + (nextRoot > b0 ? -1 : 1) : [b0, b0 + ch.iv[1], b5, b0 + ch.iv[1]][k % 4], t, 0.9, 0.8); }); break;
    }
  });
  return { chords: list, notes, bass, len: n * beatsPer };
}
