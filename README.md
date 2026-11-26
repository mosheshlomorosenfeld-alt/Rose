# Rose Studio

**Download:** https://mosheshlomorosenfeld-alt.github.io/Rose/download.html
- **Mac** (Apple Silicon + Intel): [Rose-mac.zip](https://github.com/mosheshlomorosenfeld-alt/Rose/releases/latest/download/Rose-mac.zip)
- **Windows** 10/11: [Rose-windows.zip](https://github.com/mosheshlomorosenfeld-alt/Rose/releases/latest/download/Rose-windows.zip)
- **Web app** (installable, works offline): https://mosheshlomorosenfeld-alt.github.io/Rose/ → File → Install Rose app

The desktop downloads are built automatically by GitHub Actions (`.github/workflows/desktop.yml`) every time `native/` changes, and published on the Releases page.


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
- **Templates**: EDM / Rave, Pop vocal, Hip-hop / Trap, R&B / Smooth, Simcha / Wedding (D Freygish), Singer-songwriter, Orchestral / Film, Podcast — the same `templates/templates.json` drives the web app and the desktop app
- **Instruments**: **Rose Sounds** — 14 sampled real instruments (Grand Piano, Electric Piano, Organ, Marimba, Nylon Guitar, Electric Bass, Strings, Pizzicato, Violin, Brass Section, Trumpet, Flute, Clarinet, Choir), Rose Synth (supersaw unison, filter env, 8 presets), Rose Drums (11 synthesized sounds), Rose Sampler, **External MIDI** (play SHRUB's browser editor, an FM-1 or any hardware synth)
- **Vocal tools**: **Rose Tune** pitch correction (key, scale incl. Freygish/Ahava Raba, retune speed from robotic to natural, humanize, live pitch readout), De-esser, Harmonizer (two voices), Vocal Doubler, Pitch Shifter, and a one-click vocal chain
- **21 effects**: Rose Tune, De-esser, Harmonizer, Vocal Doubler, Pitch Shifter, Parametric EQ (with curve), Auto Filter, Compressor, Limiter, Noise Gate, Reverb, Delay (tempo-synced, ping-pong), Chorus, Flanger, Phaser, Tremolo/Auto-pan, Sidechain Pump, Distortion, Bitcrusher, Stereo Width, Utility
- **Mixer**: volume, pan, mute/solo, meters, reverb and delay return buses with per-track sends, master chain with limiter
- **Export** WAV, export clips as **.mid**, save/open `.rose` projects; autosaves in the browser

## Turn on the website
Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save.

## SHRUB
- Desktop: install the SHRUB VST3 from shrub.audio → **Scan plugins** in Rose Desktop → add it as an instrument.
- Web: add an **External MIDI** track. On a Mac enable the IAC Driver (Audio MIDI Setup → MIDI Studio → IAC Driver → "Device is online"), pick it as the track's output and as "MIDI in" in the SHRUB editor. An FM-1 running SHRUB appears directly over USB.

See `native/README.md` for building the desktop app.

## Free open-source plugins
Install any of these, then press **Plugins…** in Rose Studio desktop to scan: [Surge XT](https://surge-synthesizer.github.io/), [Vital](https://vital.audio/), [Dexed](https://asb2m10.github.io/dexed/), [OB-Xd](https://github.com/reales/OB-Xd), [Odin 2](https://thewavewarden.com/odin2), [Helm](https://tytel.org/helm/). They're linked, not bundled, because their GPL licences don't allow shipping them inside Rose.

## Credits
Rose Sounds uses the **FluidR3 GM SoundFont** by Frank Wen (MIT licence), as rendered by [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (CC BY 3.0). See `sounds/CREDITS.md`.
