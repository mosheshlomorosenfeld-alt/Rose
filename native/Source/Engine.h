// Rose Desktop — engine: project model, plugin hosting (VST3 / AU), processing graph, transport, recording, bounce.
#pragma once
#include <JuceHeader.h>
#include "Registry.h"

namespace rose
{
struct Note { int pitch; double start, length; float vel; };
struct AudioClip
{
    juce::File file; double start = 0, length = 4, offsetSec = 0, fadeIn = 0, fadeOut = 0, loopLen = 0; float gainDb = 0;   // fades and loop in beats (loopLen 0 = no loop)
    std::shared_ptr<juce::AudioBuffer<float>> data; double fileRate = 44100;
    float pitch = 0;          // semitones (fractions = cents); speed unchanged
    double srcBpm = 0;        // library loops: tempo they were recorded at; they then follow the song tempo
    juce::String name;
};
struct MidiClip { juce::String name { "MIDI" }; double start = 0, length = 4, loopLen = 0; std::vector<Note> notes; int transpose = 0; };

class Engine;

// BS.1770 / EBU R128 loudness of a buffer (integrated LUFS with gating, plus sample peak)
struct Loudness { double integrated = -100, peakDb = -100; };
Loudness measureLoudness (const juce::AudioBuffer<float>&, double sampleRate);
// K-weighting filter + 100 ms block mean squares, shared by the live meter and the offline measurement
struct KWeight
{
    void prepare (double fs)
    {
        double K = std::tan (juce::MathConstants<double>::pi * 1681.974450955533 / fs), Vh = std::pow (10.0, 3.999843853973347 / 20), Vb = std::pow (Vh, 0.4996667741545416), Q = 0.7071752369554196, a0 = 1 + K / Q + K * K;
        s1[0] = (Vh + Vb * K / Q + K * K) / a0; s1[1] = 2 * (K * K - Vh) / a0; s1[2] = (Vh - Vb * K / Q + K * K) / a0; s1[3] = 2 * (K * K - 1) / a0; s1[4] = (1 - K / Q + K * K) / a0;
        K = std::tan (juce::MathConstants<double>::pi * 38.13547087602444 / fs); Q = 0.5003270373238773; a0 = 1 + K / Q + K * K;
        s2[0] = 1; s2[1] = -2; s2[2] = 1; s2[3] = 2 * (K * K - 1) / a0; s2[4] = (1 - K / Q + K * K) / a0; for (auto& z : zs) z = {}; block = (int) std::lround (fs / 10); acc = 0; count = 0;
    }
    // feeds stereo samples; calls onBlock (meanSquare) every 100 ms
    template <typename F> void process (const float* L, const float* R, int n, F&& onBlock)
    {
        for (int i = 0; i < n; ++i)
        {
            const float in[2] { L[i], R ? R[i] : L[i] };
            for (int c = 0; c < 2; ++c) { auto& z = zs[(size_t) c]; const double v = in[c];
                const double y1 = s1[0] * v + z[0]; z[0] = s1[1] * v - s1[3] * y1 + z[1]; z[1] = s1[2] * v - s1[4] * y1;
                const double y2 = s2[0] * y1 + z[2]; z[2] = s2[1] * y1 - s2[3] * y2 + z[3]; z[3] = s2[2] * y1 - s2[4] * y2; acc += y2 * y2; }
            if (++count >= block) { onBlock (acc / count); acc = 0; count = 0; }
        }
    }
    static double lufs (double ms) { return ms > 0 ? -0.691 + 10 * std::log10 (ms) : -100.0; }
    static double integrated (const std::vector<double>& blocks)
    {
        std::vector<double> g; for (size_t i = 3; i < blocks.size(); ++i) g.push_back ((blocks[i] + blocks[i - 1] + blocks[i - 2] + blocks[i - 3]) / 4);
        double s = 0; int n = 0; for (double x : g) if (lufs (x) > -70) { s += x; ++n; } if (n == 0) return -100;
        const double rel = lufs (s / n) - 10; s = 0; n = 0; for (double x : g) if (lufs (x) > -70 && lufs (x) > rel) { s += x; ++n; }
        return n ? lufs (s / n) : -100;
    }
    double s1[5] {}, s2[5] {}; std::array<std::array<double, 4>, 2> zs {}; int block = 4410, count = 0; double acc = 0;
};

// CC0 loop library (loops/index.json, shared with the web app)
struct LoopInfo { juce::String id, name, cat, key; double bpm = 0, beats = 0; };
const std::vector<LoopInfo>& loopLibrary();
juce::File loopFile (const LoopInfo&);
int keyShift (const juce::String& fromKey, const juce::String& toKey);   // nearest way up or down, -5..+6

//==============================================================================
// Shared transport, read by every processor on the audio thread.
struct Transport : juce::AudioPlayHead
{
    std::atomic<bool> playing { false }, recording { false }, looping { true }, metronome { false };
    std::atomic<double> bpm { 124.0 }, loopStart { 0.0 }, loopEnd { 16.0 };
    std::atomic<juce::int64> pos { 0 };   // samples
    double sampleRate = 44100;

    // Tempo and time-signature changes. The map is immutable once published, so the audio thread reads it without locks.
    struct TempoPoint { double beat, bpm; };
    struct MeterPoint { double beat; int num; };
    struct SongMap { std::vector<TempoPoint> tempo; std::vector<MeterPoint> meter; };
    std::atomic<const SongMap*> map { nullptr };
    std::vector<std::unique_ptr<SongMap>> maps;   // message thread only; old maps stay alive for any reader
    std::atomic<int> sig { 4 };
    void setMap (SongMap m)
    {
        std::sort (m.tempo.begin(), m.tempo.end(), [] (auto& a, auto& b) { return a.beat < b.beat; });
        std::sort (m.meter.begin(), m.meter.end(), [] (auto& a, auto& b) { return a.beat < b.beat; });
        auto p = std::make_unique<SongMap> (std::move (m)); map.store (p.get()); maps.push_back (std::move (p));
    }
    SongMap currentMap() const { if (auto* m = map.load()) return *m; return {}; }
    double bpmAt (double b) const { double v = bpm.load(); if (auto* m = map.load()) for (auto& t : m->tempo) { if (t.beat <= b + 1e-9) v = t.bpm; else break; } return v; }
    double secAt (double b) const
    {
        double t = 0, cur = 0, v = bpm.load();
        if (auto* m = map.load()) for (auto& x : m->tempo) { if (x.beat >= b) break; t += (x.beat - cur) * 60.0 / v; cur = x.beat; v = x.bpm; }
        return t + (b - cur) * 60.0 / v;
    }
    double beatAtSec (double s) const
    {
        double t = 0, cur = 0, v = bpm.load();
        if (auto* m = map.load()) for (auto& x : m->tempo) { const double seg = (x.beat - cur) * 60.0 / v; if (t + seg > s) break; t += seg; cur = x.beat; v = x.bpm; }
        return cur + (s - t) * v / 60.0;
    }
    struct BarInfo { int bar; double beat; int num; double start; };
    BarInfo barAt (double b) const
    {
        int bar = 0, n = sig.load(); double cur = 0;
        if (auto* m = map.load()) for (auto& x : m->meter) { if (x.beat > b + 1e-9) break; bar += (int) std::lround ((x.beat - cur) / n); cur = x.beat; n = x.num; }
        const int k = (int) std::floor ((b - cur) / n + 1e-9); return { bar + k, b - cur - k * n, n, cur + k * n };
    }
    double barStart (int bar) const
    {
        int k = 0, n = sig.load(); double cur = 0;
        if (auto* m = map.load()) for (auto& x : m->meter) { const int bars = (int) std::lround ((x.beat - cur) / n); if (k + bars > bar) break; k += bars; cur = x.beat; n = x.num; }
        return cur + (bar - k) * n;
    }
    double spb() const { return 60.0 / bpm.load() * sampleRate; }     // samples per beat at the starting tempo
    double beatsAt (juce::int64 s) const { return beatAtSec ((double) s / sampleRate); }
    juce::int64 samplesAt (double beat) const { return (juce::int64) std::llround (secAt (beat) * sampleRate); }
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo i; const auto p = pos.load(); const double b = beatsAt (p); const auto bi = barAt (b);
        i.setBpm (bpmAt (b)); i.setTimeInSamples (p); i.setTimeInSeconds (p / sampleRate); i.setPpqPosition (b);
        i.setPpqPositionOfLastBarStart (bi.start); i.setTimeSignature (TimeSignature { bi.num, 4 });
        i.setIsPlaying (playing.load()); i.setIsRecording (recording.load()); i.setIsLooping (looping.load());
        i.setLoopPoints (LoopPoints { loopStart.load(), loopEnd.load() });
        return i;
    }
    // Splits [start, start+n) into contiguous timeline segments, wrapping at the loop end.
    template <typename F> void segments (juce::int64 start, int n, F&& fn) const
    {
        const bool loop = looping.load() && ! recording.load();
        const auto ls = samplesAt (loopStart.load()), le = samplesAt (loopEnd.load());
        int done = 0; auto p = start;
        while (done < n)
        {
            int len = n - done;
            if (loop && le > ls && p < le && p + len > le) len = (int) (le - p);
            fn (p, done, len);
            done += len; p += len;
            if (loop && le > ls && p >= le) p = ls;
        }
    }
    juce::int64 advance (juce::int64 start, int n) const
    {
        juce::int64 end = start;
        segments (start, n, [&] (juce::int64 s, int, int len) { end = s + len; });
        const bool loop = looping.load() && ! recording.load();
        if (loop && end >= samplesAt (loopEnd.load())) end = samplesAt (loopStart.load());
        return end;
    }
};

//==============================================================================
// Per-track source: plays the track's clips from the timeline (audio, or MIDI into the instrument),
// passes live MIDI / input, and records.
class TrackSource : public juce::AudioProcessor
{
public:
    TrackSource (Engine& e, bool audio);
    const juce::String getName() const override { return "Track source"; }
    void prepareToPlay (double, int) override;
    void releaseResources() override {}
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    double getTailLengthSeconds() const override { return 0; }
    std::atomic<int> transpose { 0 };          // whole-track transpose (audio + MIDI + live keys)
    std::atomic<bool> drumKit { false };       // drum kits never transpose: each note is a different drum
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    int getNumPrograms() override { return 1; } int getCurrentProgram() override { return 0; } void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; } void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override {} void setStateInformation (const void*, int) override {}

    juce::CriticalSection lock;                 // guards clips
    std::vector<AudioClip> audioClips;
    std::vector<MidiClip> midiClips;
    std::atomic<bool> armed { false }, monitor { false }, liveTarget { false };
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writer;   // set while recording audio
    juce::CriticalSection writerLock;
    // recorded MIDI events (audio thread -> message thread)
    struct RecEvent { bool on; int pitch; float vel; double beat; };
    juce::AbstractFifo recFifo { 4096 }; std::array<RecEvent, 4096> recBuf;
    const bool isAudio;
private:
    Engine& engine; std::vector<int> sounding;
    PitchCore shifter[2]; juce::AudioBuffer<float> pitched; int pitchedHold = 0; float pitchedSemis = 0;
};

//==============================================================================
// Volume / pan / mute / meter at the end of every track and the master.
class StripProcessor : public juce::AudioProcessor
{
public:
    StripProcessor() : AudioProcessor (BusesProperties().withInput ("In", juce::AudioChannelSet::stereo()).withOutput ("Out", juce::AudioChannelSet::stereo())) {}
    const juce::String getName() const override { return "Strip"; }
    void prepareToPlay (double, int) override { lastGain = 0; }
    void releaseResources() override {}
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        const float g = muted.load() ? 0.0f : juce::Decibels::decibelsToGain (gainDb.load(), -60.0f), pan = panPos.load();
        const float gl = g * std::cos ((pan + 1) * juce::MathConstants<float>::pi / 4) * juce::MathConstants<float>::sqrt2,
                    gr = g * std::sin ((pan + 1) * juce::MathConstants<float>::pi / 4) * juce::MathConstants<float>::sqrt2;
        if (b.getNumChannels() > 1) { b.applyGainRamp (0, 0, b.getNumSamples(), lastL, gl); b.applyGainRamp (1, 0, b.getNumSamples(), lastR, gr); }
        lastL = gl; lastR = gr; lastGain = g;
        float pk = 0; for (int c = 0; c < b.getNumChannels(); ++c) pk = juce::jmax (pk, b.getMagnitude (c, 0, b.getNumSamples()));
        peak.store (juce::jmax (pk, peak.load() * 0.85f));
    }
    double getTailLengthSeconds() const override { return 0; }
    bool acceptsMidi() const override { return false; } bool producesMidi() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; } bool hasEditor() const override { return false; }
    int getNumPrograms() override { return 1; } int getCurrentProgram() override { return 0; } void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; } void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override {} void setStateInformation (const void*, int) override {}
    std::atomic<float> gainDb { -6.0f }, panPos { 0.0f }, peak { 0.0f }; std::atomic<bool> muted { false };
private:
    float lastL = 0, lastR = 0, lastGain = 0;
};

//==============================================================================
struct Slot   // one instrument or effect in a chain
{
    juce::AudioProcessorGraph::Node::Ptr node;
    juce::String builtInId;                 // set for built-ins
    juce::PluginDescription desc;           // set for hosted plugins
    bool bypass = false;
    juce::String displayName() const { return node ? node->getProcessor()->getName() : juce::String ("—"); }
};

struct Track
{
    juce::String name; bool isAudio = false; juce::Colour colour;
    bool mute = false, solo = false; float volDb = -6, pan = 0;
    juce::AudioProcessorGraph::Node::Ptr source, strip;
    Slot instrument; std::vector<Slot> inserts;
    TrackSource* src() const { return dynamic_cast<TrackSource*> (source->getProcessor()); }
    StripProcessor* str() const { return dynamic_cast<StripProcessor*> (strip->getProcessor()); }
};

//==============================================================================
class Engine : public juce::AudioIODeviceCallback, public juce::ChangeBroadcaster, private juce::MidiInputCallback
{
public:
    Engine();
    ~Engine() override;

    juce::AudioDeviceManager deviceManager;
    juce::AudioPluginFormatManager formats;
    juce::KnownPluginList knownPlugins;
    juce::AudioFormatManager audioFormats;
    std::unique_ptr<juce::PropertiesFile> settings;
    juce::File deadMansPedal;
    juce::MidiKeyboardState keyboard;
    Transport transport;

    std::vector<std::unique_ptr<Track>> tracks;
    juce::AudioProcessorGraph::Node::Ptr masterStrip;
    std::vector<Slot> masterInserts;
    int selected = 0;

    // project
    Track& addTrack (bool audio, const juce::String& name = {});
    void removeTrack (int index);
    juce::String setInstrument (Track&, const juce::String& builtInId, const juce::PluginDescription* desc, const juce::MemoryBlock* state = nullptr);
    juce::String addInsert (std::vector<Slot>& chain, const juce::String& builtInId, const juce::PluginDescription* desc, const juce::MemoryBlock* state = nullptr);
    void removeInsert (std::vector<Slot>& chain, int index);
    void rewire();
    void updateMix();
    bool addAudioFile (Track&, const juce::File&, double startBeat);
    // drops a library loop on a track at a beat (a new audio track if that one is MIDI or the spot is taken); returns the track index
    int placeLoop (const LoopInfo&, int trackIndex, double beat, int semis = 0);

    // ---- song tools (message thread) ----
    struct Marker { double beat; juce::String name; };
    struct Section { double start, len; juce::String name; juce::Colour colour; };
    struct ChordMark { double beat; juce::String name; };
    std::vector<Marker> markers; std::vector<Section> sections; std::vector<ChordMark> chords;
    // splits every clip on every track at a beat (looped clips keep every repeat)
    void splitAllAt (double beat);
    static void splitAudio (std::vector<AudioClip>&, size_t index, double at, const Transport&);
    static void splitMidi (std::vector<MidiClip>&, size_t index, double at);
    void insertTime (double at, double len);
    void removeTime (double from, double to);
    void duplicateSection (int i); void deleteSection (int i, bool keepTime); bool moveSection (int i, int dir);
    void addMarker (double beat, const juce::String& name = {});
    void detectChords();

    // ---- analysis tap: the master output, for the meters and analyzers (audio thread writes, UI reads) ----
    juce::AbstractFifo tapFifo { 1 << 16 }; juce::AudioBuffer<float> tapBuf { 2, 1 << 16 };
    int readTap (juce::AudioBuffer<float>& dest);   // UI: drains everything new; returns samples read
    juce::AbstractFifo inFifo { 1 << 15 }; std::vector<float> inBuf = std::vector<float> (1 << 15);   // first audio input, for the tuner
    int readInput (std::vector<float>& dest);

    // ---- reference track A/B ----
    bool loadReference (const juce::File&);
    void clearReference();
    std::atomic<bool> refOn { false }; std::atomic<float> refGainDb { 0.0f }; std::atomic<double> refOffsetSec { 0.0 };
    juce::File referenceFile; double referenceLufs = -100;
    bool hasReference() const { const juce::SpinLock::ScopedLockType l (refLock); return reference != nullptr; }
    // audition a library loop at the song tempo (and key), looping; nullptr stops
    void previewLoop (const LoopInfo*, int semis = 0);
    juce::String previewingId() const { const juce::SpinLock::ScopedLockType l (previewLock); return preview ? preview->id : juce::String(); }
    void selectTrack (int i);
    double songEndBeats() const;

    // transport
    void play(); void stop(); void toStart(); void record();
    double positionBeats() const { return transport.beatsAt (transport.pos.load()); }

    // files
    bool saveSession (const juce::File&);
    bool loadSession (const juce::File&);
    bool bounce (const juce::File&, std::function<void (double)> progress);
    // song templates (templates/templates.json, shared with the web app): replaces the session
    bool applyTemplate (const juce::var& tpl, juce::StringArray& problems);
    static void setParam (juce::AudioProcessor&, const juce::String& id, const juce::var& value);
    void scanDefaultsIfEmpty();
    juce::File recordingsFolder() const;
    juce::AudioProcessorGraph& getGraph() { return *graph; }
    juce::String debugGraph() const { juce::String s; for (auto& c : graph->getConnections()) s << (int) c.source.nodeID.uid << ":" << c.source.channelIndex << "->" << (int) c.destination.nodeID.uid << ":" << c.destination.channelIndex << " "; return s; }

    // AudioIODeviceCallback
    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n, const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;

    // live MIDI for the selected track (filled on the audio thread before the graph runs)
    juce::MidiBuffer liveMidi;
    juce::MidiMessageCollector collector;
    const float* const* currentInput = nullptr; int currentNumInputs = 0;

private:
    std::shared_ptr<juce::AudioBuffer<float>> reference; double referenceRate = 44100; mutable juce::SpinLock refLock;

    struct Preview { juce::String id; juce::AudioBuffer<float> data; double rate = 1, pos = 0, end = 0; PitchCore::Params pr; PitchCore core[2]; bool shift = false; };
    std::unique_ptr<Preview> preview; juce::SpinLock previewLock;

    void handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage&) override;
    juce::AudioProcessorGraph::Node::Ptr makeNode (std::unique_ptr<juce::AudioProcessor>);
    std::unique_ptr<juce::AudioProcessor> createProcessor (const juce::String& builtInId, const juce::PluginDescription* desc, juce::String& error);
    void finishRecording();

    std::unique_ptr<juce::AudioProcessorGraph> graph;
    juce::AudioProcessorPlayer player;
    juce::AudioProcessorGraph::Node::Ptr audioOut, masterIn;
    juce::TimeSliceThread writerThread { "Rose recorder" };
    juce::int64 recordStartSample = 0; juce::Array<juce::File> recordingFiles;
    double metroPhase = 0; int metroLeft = 0; bool metroAccent = false; double lastBeat = -1;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Engine)
};
} // namespace rose
