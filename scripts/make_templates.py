"""Generates templates/templates.json — the song templates shared by the web app and Rose Studio desktop.
Each track carries web settings (fx, preset) and desktop settings (nfx, nparams) side by side."""
import json, os

def notes_of(chords, beats_each=4, l=None, v=0.7, rhythm=None):
    out = []
    for i, ch in enumerate(chords):
        base = i * beats_each
        for s in (rhythm or [0]):
            for p in ch: out.append([p, base + s, l or (beats_each - 0.25 if not rhythm else 0.45), v])
    return out
def bassline(roots, beats_each=4, pattern=((0, 1.5), (2, 1.5)), v=0.9):
    return [[r, i * beats_each + s, l, v] for i, r in enumerate(roots) for s, l in pattern]
def drums(bars, kick, snare, hat, ohat=(), clap=(), hat_v=0.6):
    n = []
    for b in range(bars):
        o = b * 4
        n += [[36, o + s, 0.25, 1.0] for s in kick] + [[38, o + s, 0.25, 0.9] for s in snare] + [[39, o + s, 0.25, 0.85] for s in clap]
        n += [[42, o + s, 0.125, hat_v] for s in hat] + [[46, o + s, 0.25, 0.6] for s in ohat]
    return n
def clip(name, length, notes, start=0): return {"name": name, "start": start, "len": length, "notes": notes}

VOX_WEB = lambda key, scale, speed, hum=0: [
    {"type": "tune", "params": {"key": key, "scale": scale, "speed": speed, "humanize": hum}},
    {"type": "eq", "params": {"hp": 90, "m1f": 300, "m1g": -2, "hsg": 2.5}},
    {"type": "deesser", "params": {"freq": 6500, "threshold": -32}},
    {"type": "comp", "params": {"threshold": -22, "ratio": 3.5, "attack": 0.006, "release": 0.12, "makeup": 4}}]
NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
SCALES = ['Chromatic', 'Major', 'Minor', 'Harmonic minor', 'Freygish (Ahava Raba)', 'Major pentatonic', 'Minor pentatonic', 'Blues', 'Dorian', 'Mixolydian']
VOX_NAT = lambda key, scale, speed, hum=0, rv=0.15: [
    {"type": "tune", "params": {"key": NOTE.index(key), "scale": SCALES.index(scale), "speed": speed, "hum": hum}},
    {"type": "eq", "params": {"lc": 90, "mf": 300, "mg": -2, "hsg": 2.5}},
    {"type": "deesser", "params": {"fq": 6500, "th": -32}},
    {"type": "comp", "params": {"th": -22, "ra": 3.5, "at": 6, "re": 120, "mk": 4}},
    {"type": "reverb", "params": {"sz": 0.55, "mx": rv}}]
NSYNTH = {  # desktop Rose Synth settings that match the web presets
    "Supersaw Lead": {"wa": 0, "un": 7, "dt": 28, "co": 6500, "re": 2, "fe": 2500, "a": 0.005, "d": 0.25, "s": 0.75, "r": 0.3, "vo": 0.5},
    "Warm Pad": {"wa": 0, "un": 5, "dt": 18, "co": 1800, "re": 1, "fe": 600, "a": 0.8, "d": 1, "s": 0.8, "r": 1.6, "vo": 0.45},
    "Sub Bass": {"wa": 3, "un": 1, "dt": 0, "co": 900, "re": 0.7, "fe": 300, "a": 0.004, "d": 0.3, "s": 0.9, "r": 0.12, "vo": 0.8},
    "Reese Bass": {"wa": 0, "un": 3, "dt": 22, "co": 700, "re": 3, "fe": 900, "a": 0.01, "d": 0.4, "s": 0.8, "r": 0.2, "vo": 0.55},
    "Pluck": {"wa": 0, "un": 3, "dt": 12, "co": 600, "re": 4, "fe": 6000, "a": 0.002, "d": 0.22, "s": 0, "r": 0.18, "vo": 0.6}}

def synth(name, preset, clips, vol=-8, pan=0, sends=None, fx=None, nfx=None):
    return {"name": name, "type": "synth", "preset": preset, "nparams": NSYNTH[preset], "vol": vol, "pan": pan, "sends": sends or {}, "fx": fx or [], "nfx": nfx or [], "clips": clips}
def sounds(name, patch, clips, vol=-8, pan=0, sends=None, fx=None, nfx=None, params=None):
    return {"name": name, "type": "sounds", "patch": patch, "params": params or {}, "vol": vol, "pan": pan, "sends": sends or {}, "fx": fx or [], "nfx": nfx or [], "clips": clips}
def kit(clips, vol=-5, fx=None, nfx=None): return {"name": "Drums", "type": "drums", "vol": vol, "pan": 0, "sends": {}, "fx": fx or [], "nfx": nfx or [], "clips": clips}
def audio(name, fx, nfx, vol=-6, pan=0, sends=None): return {"name": name, "type": "audio", "vol": vol, "pan": pan, "sends": sends or {"A": 0.25}, "fx": fx, "nfx": nfx, "clips": []}
MASTER = {"fx": [{"type": "eq", "params": {"hp": 25}}, {"type": "limiter", "params": {"gain": 2, "ceiling": -0.5}}],
          "nfx": [{"type": "eq", "params": {"lc": 25}}, {"type": "limiter", "params": {"in": 2, "ce": -0.5}}]}

T = []
# ---- EDM / Rave: A minor, i-VI-III-VII ----
am = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
T.append({"id": "edm", "name": "EDM / Rave", "desc": "128 BPM festival drop — supersaw, Reese bass, sidechain pump, hard-tuned vocal", "bpm": 128, "loop": [0, 16], "tracks": [
    kit([clip("Four on the floor", 16, drums(4, [0, 1, 2, 3], [], [0.5, 1.5, 2.5, 3.5], clap=[1, 3]))], vol=-4),
    synth("Bass", "Reese Bass", [clip("Bass", 16, bassline([33, 29, 36, 31], pattern=((0.5, 0.4), (1.5, 0.4), (2.5, 0.4), (3.5, 0.4))))], vol=-9,
          fx=[{"type": "pump", "params": {"depth": 0.8}}]),
    synth("Lead", "Supersaw Lead", [clip("Chords", 16, notes_of([[p + 12 for p in c] for c in am], rhythm=[0, 0.75, 1.5, 2.5, 3.25]))], vol=-12, sends={"A": 0.3, "B": 0.2},
          fx=[{"type": "eq", "params": {"hp": 180}}, {"type": "pump", "params": {"depth": 0.9}}]),
    synth("Pad", "Warm Pad", [clip("Pad", 16, notes_of(am, v=0.5))], vol=-16, sends={"A": 0.5}),
    audio("Lead Vocal", VOX_WEB('A', 'Minor', 0), VOX_NAT('A', 'Minor', 0, rv=0.2))], "master": MASTER})
# ---- Pop vocal: C major I-V-vi-IV ----
pop = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]
T.append({"id": "pop", "name": "Pop vocal", "desc": "100 BPM — piano, bass, strings, a tuned lead vocal and stacked harmonies", "bpm": 100, "loop": [0, 16], "tracks": [
    kit([clip("Groove", 16, drums(4, [0, 2.5], [1, 3], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], hat_v=0.45))], vol=-7),
    sounds("Piano", "Grand Piano", [clip("Chords", 16, notes_of(pop, rhythm=[0, 1.5, 2, 3], v=0.6))], vol=-9, sends={"A": 0.2}),
    sounds("Bass", "Electric Bass", [clip("Bass", 16, bassline([36, 31, 33, 29], pattern=((0, 1.4), (1.5, 0.4), (2, 1.4), (3.5, 0.4))))], vol=-8),
    sounds("Strings", "Strings", [clip("Strings", 16, notes_of([[p + 12 for p in c] for c in pop], v=0.45))], vol=-15, sends={"A": 0.35}, params={"a": 0.25, "r": 0.8}),
    audio("Lead Vocal", VOX_WEB('C', 'Major', 20, 5), VOX_NAT('C', 'Major', 20, 5)),
    audio("Harmonies", VOX_WEB('C', 'Major', 30) + [{"type": "harmonizer", "params": {"mix": 0.45}}, {"type": "doubler", "params": {"mix": 0.4}}],
          VOX_NAT('C', 'Major', 30, rv=0.25) + [{"type": "harmonizer", "params": {"mx": 0.45}}, {"type": "doubler", "params": {"mx": 0.4}}], vol=-10, sends={"A": 0.4})], "master": MASTER})
# ---- Hip-hop / Trap: F minor ----
fm = [[53, 56, 60], [49, 53, 56], [51, 55, 58], [48, 52, 55]]
hats = [i * 0.25 for i in range(16)]
T.append({"id": "trap", "name": "Hip-hop / Trap", "desc": "140 BPM half-time — 808, rolling hats, electric piano, hard-tuned vocal", "bpm": 140, "loop": [0, 16], "tracks": [
    kit([clip("Trap beat", 16, drums(4, [0, 1.75, 2.5], [2], hats, hat_v=0.4))], vol=-5),
    synth("808", "Sub Bass", [clip("808", 16, bassline([29, 25, 27, 24], pattern=((0, 1.5), (1.75, 0.6), (2.5, 1.4))))], vol=-6,
          fx=[{"type": "distortion", "params": {"drive": 8, "mix": 0.4}}], nfx=[{"type": "distortion", "params": {"dr": 8, "mx": 0.4}}]),
    sounds("Keys", "Electric Piano", [clip("Keys", 16, notes_of(fm, v=0.55))], vol=-11, sends={"A": 0.3}),
    audio("Vocal", VOX_WEB('F', 'Minor', 0), VOX_NAT('F', 'Minor', 0, rv=0.1))], "master": MASTER})
# ---- R&B / Smooth: Eb major 7ths ----
rnb = [[51, 55, 58, 62], [48, 51, 55, 58], [53, 56, 60, 63], [46, 50, 53, 56]]
T.append({"id": "rnb", "name": "R&B / Smooth", "desc": "75 BPM — electric piano 7th chords, finger bass, warm strings, natural-sounding tuning", "bpm": 75, "loop": [0, 16], "tracks": [
    kit([clip("Laid back", 16, drums(4, [0, 0.75, 2.5], [1, 3], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], hat_v=0.35))], vol=-8),
    sounds("Rhodes", "Electric Piano", [clip("Chords", 16, notes_of(rnb, v=0.5))], vol=-9, sends={"A": 0.3}),
    sounds("Bass", "Electric Bass", [clip("Bass", 16, bassline([39, 36, 41, 34]))], vol=-8),
    sounds("Strings", "Strings", [clip("Pad", 16, notes_of([[p + 12 for p in c[1:]] for c in rnb], v=0.35))], vol=-17, sends={"A": 0.5}, params={"a": 0.4, "r": 1.2}),
    audio("Lead Vocal", VOX_WEB('D#', 'Major', 45, 15), VOX_NAT('D#', 'Major', 45, 15, rv=0.22)),
    audio("Backgrounds", VOX_WEB('D#', 'Major', 60, 10) + [{"type": "doubler", "params": {"mix": 0.5}}],
          VOX_NAT('D#', 'Major', 60, 10, rv=0.3) + [{"type": "doubler", "params": {"mx": 0.5}}], vol=-12, sends={"A": 0.45})], "master": MASTER})
# ---- Simcha / Jewish wedding: D freygish (Ahava Raba) ----
fr = [[50, 54, 57], [51, 55, 58], [50, 54, 57], [55, 58, 62]]
mel = [[62, 0, 0.5], [63, 0.5, 0.5], [66, 1, 0.5], [67, 1.5, 0.5], [69, 2, 1], [67, 3, 0.5], [66, 3.5, 0.5],
       [67, 4, 0.5], [66, 4.5, 0.5], [63, 5, 0.5], [62, 5.5, 0.5], [63, 6, 1.5], [62, 8, 0.5], [63, 8.5, 0.5], [66, 9, 0.5], [67, 9.5, 0.5],
       [69, 10, 0.5], [70, 10.5, 0.5], [69, 11, 1], [67, 12, 0.5], [66, 12.5, 0.5], [63, 13, 0.5], [66, 13.5, 0.5], [62, 14, 1.75]]
T.append({"id": "simcha", "name": "Simcha / Wedding", "desc": "132 BPM freilach in D Freygish (Ahava Raba) — clarinet lead, brass, organ, oom-pah bass", "bpm": 132, "loop": [0, 16], "tracks": [
    kit([clip("Freilach", 16, drums(4, [0, 2], [1, 3], [0.5, 1.5, 2.5, 3.5], hat_v=0.5))], vol=-7),
    sounds("Clarinet", "Clarinet", [clip("Freilach melody", 16, [[p, s, l, 0.85] for p, s, l in mel])], vol=-8, sends={"A": 0.25}),
    sounds("Brass", "Brass Section", [clip("Stabs", 16, notes_of(fr, rhythm=[1, 3], v=0.7))], vol=-12, sends={"A": 0.2}),
    sounds("Organ", "Organ", [clip("Organ", 16, notes_of(fr, rhythm=[0.5, 1.5, 2.5, 3.5], v=0.45))], vol=-15),
    sounds("Bass", "Electric Bass", [clip("Oom-pah", 16, bassline([38, 39, 38, 43], pattern=((0, 0.8), (2, 0.8))))], vol=-8),
    audio("Vocal", VOX_WEB('D', 'Freygish (Ahava Raba)', 25, 5), VOX_NAT('D', 'Freygish (Ahava Raba)', 25, 5, rv=0.2))], "master": MASTER})
# ---- Singer-songwriter ----
ss = [[55, 59, 62], [52, 55, 59], [48, 52, 55], [50, 54, 57]]
T.append({"id": "acoustic", "name": "Singer-songwriter", "desc": "90 BPM — nylon guitar, piano and one warm, lightly-tuned vocal", "bpm": 90, "loop": [0, 16], "tracks": [
    sounds("Guitar", "Nylon Guitar", [clip("Picking", 16, [[p, i * 4 + j * 0.5, 0.9, 0.6] for i, c in enumerate(ss) for j, p in enumerate((c + [c[1] + 12, c[2] + 12, c[1] + 12, c[2]])[:8])])], vol=-8, pan=-0.2, sends={"A": 0.2}),
    sounds("Piano", "Grand Piano", [clip("Piano", 16, notes_of([[p + 12 for p in c] for c in ss], v=0.4))], vol=-14, pan=0.2, sends={"A": 0.3}),
    audio("Vocal", VOX_WEB('G', 'Major', 60, 20), VOX_NAT('G', 'Major', 60, 20, rv=0.2))], "master": MASTER})
# ---- Orchestral / Film ----
orc = [[50, 57, 62], [46, 53, 58], [43, 50, 55], [45, 52, 57]]
T.append({"id": "orchestral", "name": "Orchestral / Film", "desc": "90 BPM D minor — strings, violin, brass, flute, choir and pizzicato", "bpm": 90, "loop": [0, 16], "tracks": [
    sounds("Strings", "Strings", [clip("Strings", 16, notes_of(orc, v=0.55))], vol=-9, sends={"A": 0.45}, params={"a": 0.3, "r": 1}),
    sounds("Violin", "Violin", [clip("Melody", 16, [[74, 0, 2, 0.7], [72, 2, 2, 0.7], [70, 4, 3, 0.7], [69, 7, 1, 0.7], [67, 8, 4, 0.7], [69, 12, 4, 0.7]])], vol=-11, sends={"A": 0.4}),
    sounds("Brass", "Brass Section", [clip("Swell", 16, notes_of([[p - 12 for p in c] for c in orc], v=0.5))], vol=-15, sends={"A": 0.35}, params={"a": 0.5}),
    sounds("Flute", "Flute", [clip("Flute", 16, [[81, 8, 1, 0.6], [79, 9, 1, 0.6], [77, 10, 2, 0.6], [76, 12, 4, 0.6]])], vol=-14, sends={"A": 0.4}),
    sounds("Choir", "Choir", [clip("Aahs", 16, notes_of([[p + 12 for p in c] for c in orc], v=0.45))], vol=-16, sends={"A": 0.5}, params={"a": 0.4, "r": 1.5}),
    sounds("Pizzicato", "Pizzicato Strings", [clip("Pizz", 16, [[c[0] + 12, i * 4 + s, 0.3, 0.6] for i, c in enumerate(orc) for s in (0, 1, 2, 3)])], vol=-12)], "master": MASTER})
# ---- Podcast / voice ----
POD_WEB = [{"type": "gate", "params": {"threshold": -50}}, {"type": "eq", "params": {"hp": 80, "m1f": 250, "m1g": -2, "m2f": 4000, "m2g": 2}},
           {"type": "deesser", "params": {"threshold": -30}}, {"type": "comp", "params": {"threshold": -24, "ratio": 4, "makeup": 6}}]
POD_NAT = [{"type": "gate", "params": {"th": -50}}, {"type": "eq", "params": {"lc": 80, "mf": 250, "mg": -2}},
           {"type": "deesser", "params": {"th": -30}}, {"type": "comp", "params": {"th": -24, "ra": 4, "mk": 6}}]
T.append({"id": "podcast", "name": "Podcast / Voice-over", "desc": "Two voice tracks with gate, EQ, de-esser and compression — ready to record", "bpm": 120, "loop": [0, 16], "tracks": [
    audio("Host", POD_WEB, POD_NAT, vol=-4, pan=0, sends={}), audio("Guest", POD_WEB, POD_NAT, vol=-4, pan=0, sends={}),
    audio("Music bed", [{"type": "eq", "params": {"m2f": 2500, "m2g": -4}}], [{"type": "eq", "params": {"hsg": -4}}], vol=-20, sends={})],
    "master": {"fx": [{"type": "limiter", "params": {"gain": 3, "ceiling": -1}}], "nfx": [{"type": "limiter", "params": {"in": 3, "ce": -1}}]}})

out = os.path.join(os.path.dirname(__file__), '..', 'templates', 'templates.json')
json.dump({"version": 1, "templates": T}, open(out, 'w'), separators=(',', ':'))
print('wrote', len(T), 'templates', os.path.getsize(out), 'bytes')
