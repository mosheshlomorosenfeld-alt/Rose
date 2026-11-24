# Rose

A DAW by Rosenfeld Productions, in two versions:

| | **Rose Web** (this folder) | **Rose Desktop** (`native/`) |
|---|---|---|
| Runs | In Chrome, Edge or Safari — `https://mosheshlomorosenfeld-alt.github.io/Rose/` | Native Mac app (JUCE / C++) |
| VST3 & AU plugins | No (browsers can't) | **Yes** — Serum, SHRUB, FabFilter, Softube Flow, Google Flow Music, Valhalla… |
| Web plugins (WAM 2) | Yes | — |

## Rose Web features
- **Arrangement**: audio and instrument tracks, drag/resize/move clips between tracks, snap, zoom, loop region, split (Ctrl+E), duplicate (Ctrl+D), undo/redo
- **Recording**: microphone/interface audio with latency compensation; MIDI from a keyboard or the computer keys (A–; with Z/X for octave)
- **Editors**: piano roll (draw, move, resize, quantize, transpose) and a 16-step drum sequencer; audio clip gain and trim
- **Instruments**: Rose Synth (supersaw unison, filter env, 8 presets), Rose Drums (11 synthesized sounds), Rose Sampler, **External MIDI** (play SHRUB's browser editor, an FM-1 or any hardware synth)
- **16 effects**: Parametric EQ (with curve), Auto Filter, Compressor, Limiter, Noise Gate, Reverb, Delay (tempo-synced, ping-pong), Chorus, Flanger, Phaser, Tremolo/Auto-pan, Sidechain Pump, Distortion, Bitcrusher, Stereo Width, Utility
- **Mixer**: volume, pan, mute/solo, meters, reverb and delay return buses with per-track sends, master chain with limiter
- **Export** WAV, export clips as **.mid**, save/open `.rose` projects; autosaves in the browser

## Turn on the website
Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save.

## SHRUB
- Desktop: install the SHRUB VST3 from shrub.audio → **Scan plugins** in Rose Desktop → add it as an instrument.
- Web: add an **External MIDI** track. On a Mac enable the IAC Driver (Audio MIDI Setup → MIDI Studio → IAC Driver → "Device is online"), pick it as the track's output and as "MIDI in" in the SHRUB editor. An FM-1 running SHRUB appears directly over USB.

See `native/README.md` for building the desktop app.
