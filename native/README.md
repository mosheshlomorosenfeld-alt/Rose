# Rose Desktop (macOS)

The native version of Rose. It **hosts real VST3 and Audio Unit plugins**: Serum, SHRUB, FabFilter, Softube Flow, Google Flow Music, Valhalla, Arturia, Native Instruments and any other VST3/AU on your Mac.

## Build it (about 10 minutes the first time)
1. Install **Xcode** from the App Store, then run `xcode-select --install` in Terminal.
2. Install CMake: `brew install cmake` (or download it from cmake.org).
3. In Terminal:
   ```bash
   git clone https://github.com/mosheshlomorosenfeld-alt/Rose.git
   cd Rose/native
   cmake -B build -G Xcode
   cmake --build build --config Release
   open build/Rose_artefacts/Release/Rose.app
   ```
   (Or `open build/Rose.xcodeproj` and press ▶ in Xcode.) JUCE downloads automatically on the first build.

## First run
- **Plugins...** → Options → *Scan for new or updated VST3 plug-ins* and *AudioUnit plug-ins*. Rose remembers the list.
- **Audio/MIDI...** to choose your interface, sample rate and MIDI keyboard.

## What's in it
- Audio tracks (drag WAV/AIFF/MP3/FLAC onto the timeline) and instrument tracks (Rose Synth or any VST3/AU instrument)
- Device chain per track and on the master: **13 built-in effects** (EQ, Filter, Compressor, Limiter, Gate, Reverb, Delay, Chorus, Flanger, Phaser, Distortion, Bitcrusher, Width & Utility) plus any VST3/AU effect, with bypass and reordering; each plugin opens in its own window
- Recording: audio from your interface to `~/Music/Rose/Recordings`, MIDI from your keyboard into clips; input monitoring
- Piano roll (double-click a MIDI clip), clip move/resize/duplicate (⌘D)/split (⌘E)/delete, loop region (drag the top of the ruler), metronome, tempo, playhead/transport sent to plugins so tempo-synced plugins lock in
- Save/open `.rose` sessions (plugin settings included) and **Bounce WAV** (offline render through every plugin)

## Limits
- Plugins that live inside other DAWs (FL Studio's Fruity plugins, Logic's stock plugins, Ableton's devices) can't be loaded by any other app. Their VST3/AU editions (for example FL plugins sold as VST) work.
- No undo yet in the desktop app; save often.
