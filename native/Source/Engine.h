// Rose Desktop — engine: project model, plugin hosting (VST3 / AU), processing graph, transport, recording, bounce.
#pragma once
#include <JuceHeader.h>
#include "BuiltIns.h"

namespace rose
{
struct Note { int pitch; double start, length; float vel; };
struct AudioClip
{
    juce::File file; double start = 0, length = 4, offsetSec = 0, fadeIn = 0, fadeOut = 0, loopLen = 0; float gainDb = 0;   // fades and loop in beats (loopLen 0 = no loop)
    std::shared_ptr<juce::AudioBuffer<float>> data; double fileRate = 44100;
};
struct MidiClip { juce::String name { "MIDI" }; double start = 0, length = 4, loopLen = 0; std::vector<Note> notes; };

class Engine;

//==============================================================================
// Shared transport, read by every processor on the audio thread.
struct Transport : juce::AudioPlayHead
{
    std::atomic<bool> playing { false }, recording { false }, looping { true }, metronome { false };
    std::atomic<double> bpm { 124.0 }, loopStart { 0.0 }, loopEnd { 16.0 };
    std::atomic<juce::int64> pos { 0 };   // samples
    double sampleRate = 44100;

    double spb() const { return 60.0 / bpm.load() * sampleRate; }     // samples per beat
    double beatsAt (juce::int64 s) const { return (double) s / spb(); }
    juce::int64 samplesAt (double beat) const { return (juce::int64) std::llround (beat * spb()); }
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo i; const auto p = pos.load(); const double b = beatsAt (p);
        i.setBpm (bpm.load()); i.setTimeInSamples (p); i.setTimeInSeconds (p / sampleRate); i.setPpqPosition (b);
        i.setPpqPositionOfLastBarStart (std::floor (b / 4) * 4); i.setTimeSignature (TimeSignature { 4, 4 });
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
    void prepareToPlay (double, int) override {}
    void releaseResources() override {}
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    double getTailLengthSeconds() const override { return 0; }
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
    void selectTrack (int i);
    double songEndBeats() const;

    // transport
    void play(); void stop(); void toStart(); void record();
    double positionBeats() const { return transport.beatsAt (transport.pos.load()); }

    // files
    bool saveSession (const juce::File&);
    bool loadSession (const juce::File&);
    bool bounce (const juce::File&, std::function<void (double)> progress);
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
