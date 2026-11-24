// Rose Desktop — built-in effects and instrument (juce::dsp). They behave like plugins: parameters, state, and a generic editor.
#pragma once
#include <JuceHeader.h>

namespace rose
{
using APVTS = juce::AudioProcessorValueTreeState;

//==============================================================================
// Base for every built-in: stereo in/out, parameter tree, generic editor, state save/load.
class BuiltIn : public juce::AudioProcessor
{
public:
    BuiltIn (const juce::String& n, APVTS::ParameterLayout layout, bool isSynth = false)
        : AudioProcessor (isSynth ? BusesProperties().withOutput ("Out", juce::AudioChannelSet::stereo())
                                  : BusesProperties().withInput ("In", juce::AudioChannelSet::stereo()).withOutput ("Out", juce::AudioChannelSet::stereo())),
          name (n), synth (isSynth), state (*this, nullptr, "params", std::move (layout)) {}

    const juce::String getName() const override { return name; }
    bool acceptsMidi() const override { return synth; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 4.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override { return new juce::GenericAudioProcessorEditor (*this); }
    void releaseResources() override {}
    void getStateInformation (juce::MemoryBlock& d) override { if (auto x = state.copyState().createXml()) copyXmlToBinary (*x, d); }
    void setStateInformation (const void* d, int n) override { if (auto x = getXmlFromBinary (d, n)) state.replaceState (juce::ValueTree::fromXml (*x)); }
    float p (const char* id) const { return state.getRawParameterValue (id)->load(); }
    double bpm() const
    {
        if (auto* ph = getPlayHead()) if (auto pos = ph->getPosition()) if (auto b = pos->getBpm()) return *b;
        return 120.0;
    }
    juce::dsp::ProcessSpec spec (double sr, int bs) const { return { sr, (juce::uint32) bs, 2 }; }

    const juce::String name;
    const bool synth;
    APVTS state;
};

using Layout = APVTS::ParameterLayout;
inline auto fp (const char* id, const char* nm, float lo, float hi, float def, float skew = 1.0f, const char* unit = "")
{
    juce::NormalisableRange<float> r (lo, hi);
    if (skew > lo && skew < hi && std::abs (skew - (lo + hi) / 2) > 1e-6f) r.setSkewForCentre (skew);   // log-style feel for frequency/time knobs; linear otherwise
    return std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { id, 1 }, nm, r, def, juce::AudioParameterFloatAttributes().withLabel (unit));
}
inline auto cp (const char* id, const char* nm, juce::StringArray opts, int def)
{ return std::make_unique<juce::AudioParameterChoice> (juce::ParameterID { id, 1 }, nm, opts, def); }
inline auto bp (const char* id, const char* nm, bool def) { return std::make_unique<juce::AudioParameterBool> (juce::ParameterID { id, 1 }, nm, def); }
template <typename... P> Layout layout (P&&... ps) { Layout l; (l.add (std::forward<P> (ps)), ...); return l; }

//==============================================================================
class EqFx : public BuiltIn
{
public:
    EqFx() : BuiltIn ("Rose EQ", layout (fp ("lc", "Low cut", 20, 1000, 20, 120, "Hz"), fp ("lsf", "Low freq", 40, 500, 120, 120, "Hz"), fp ("lsg", "Low gain", -18, 18, 0, 0, "dB"),
                                          fp ("mf", "Mid freq", 150, 8000, 1000, 1000, "Hz"), fp ("mg", "Mid gain", -18, 18, 0, 0, "dB"), fp ("mq", "Mid Q", 0.2f, 10, 1, 1),
                                          fp ("hsf", "High freq", 2000, 16000, 8000, 6000, "Hz"), fp ("hsg", "High gain", -18, 18, 0, 0, "dB"), fp ("hc", "High cut", 1000, 20000, 20000, 6000, "Hz"))) {}
    void prepareToPlay (double sr, int bs) override { rate = sr; for (auto& f : chain) { f.prepare (spec (sr, bs)); f.reset(); } }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        using C = juce::dsp::IIR::Coefficients<float>;
        auto set = [] (Filter& f, C::Ptr c) { *f.state = *c; };
        set (chain[0], C::makeHighPass (rate, p ("lc")));
        set (chain[1], C::makeLowShelf (rate, p ("lsf"), 0.707f, juce::Decibels::decibelsToGain (p ("lsg"))));
        set (chain[2], C::makePeakFilter (rate, p ("mf"), p ("mq"), juce::Decibels::decibelsToGain (p ("mg"))));
        set (chain[3], C::makeHighShelf (rate, p ("hsf"), 0.707f, juce::Decibels::decibelsToGain (p ("hsg"))));
        set (chain[4], C::makeLowPass (rate, juce::jmin (p ("hc"), (float) rate * 0.49f)));
        juce::dsp::AudioBlock<float> blk (b); juce::dsp::ProcessContextReplacing<float> ctx (blk);
        for (auto& f : chain) f.process (ctx);
    }
private:
    using Filter = juce::dsp::ProcessorDuplicator<juce::dsp::IIR::Filter<float>, juce::dsp::IIR::Coefficients<float>>;
    Filter chain[5]; double rate = 44100;
};

class CompFx : public BuiltIn
{
public:
    CompFx() : BuiltIn ("Rose Compressor", layout (fp ("th", "Threshold", -60, 0, -18, -20, "dB"), fp ("ra", "Ratio", 1, 20, 4, 4), fp ("at", "Attack", 0.1f, 200, 10, 10, "ms"),
                                                   fp ("re", "Release", 10, 1000, 150, 150, "ms"), fp ("mk", "Makeup", 0, 24, 0, 0, "dB"), fp ("mx", "Mix", 0, 1, 1))) {}
    void prepareToPlay (double sr, int bs) override { c.prepare (spec (sr, bs)); dry.setSize (2, bs); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        c.setThreshold (p ("th")); c.setRatio (p ("ra")); c.setAttack (p ("at")); c.setRelease (p ("re"));
        const float mix = p ("mx"); dry.makeCopyOf (b, true);
        juce::dsp::AudioBlock<float> blk (b); c.process (juce::dsp::ProcessContextReplacing<float> (blk));
        b.applyGain (juce::Decibels::decibelsToGain (p ("mk")) * mix);
        for (int ch = 0; ch < b.getNumChannels(); ++ch) b.addFrom (ch, 0, dry, ch, 0, b.getNumSamples(), 1.0f - mix);
    }
private:
    juce::dsp::Compressor<float> c; juce::AudioBuffer<float> dry;
};

class LimiterFx : public BuiltIn
{
public:
    LimiterFx() : BuiltIn ("Rose Limiter", layout (fp ("in", "Input gain", 0, 24, 0, 0, "dB"), fp ("ce", "Ceiling", -12, 0, -0.3f, -1, "dB"), fp ("re", "Release", 1, 500, 60, 60, "ms"))) {}
    void prepareToPlay (double sr, int bs) override { l.prepare (spec (sr, bs)); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        b.applyGain (juce::Decibels::decibelsToGain (p ("in")));
        l.setThreshold (p ("ce")); l.setRelease (p ("re"));
        juce::dsp::AudioBlock<float> blk (b); l.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
private:
    juce::dsp::Limiter<float> l;
};

class GateFx : public BuiltIn
{
public:
    GateFx() : BuiltIn ("Rose Gate", layout (fp ("th", "Threshold", -80, 0, -40, -40, "dB"), fp ("ra", "Ratio", 1, 50, 10, 10), fp ("at", "Attack", 0.1f, 50, 1, 2, "ms"), fp ("re", "Release", 5, 1000, 120, 120, "ms"))) {}
    void prepareToPlay (double sr, int bs) override { g.prepare (spec (sr, bs)); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        g.setThreshold (p ("th")); g.setRatio (p ("ra")); g.setAttack (p ("at")); g.setRelease (p ("re"));
        juce::dsp::AudioBlock<float> blk (b); g.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
private:
    juce::dsp::NoiseGate<float> g;
};

class ReverbFx : public BuiltIn
{
public:
    ReverbFx() : BuiltIn ("Rose Reverb", layout (fp ("sz", "Size", 0, 1, 0.6f), fp ("dm", "Damping", 0, 1, 0.5f), fp ("wd", "Width", 0, 1, 1), fp ("mx", "Mix", 0, 1, 0.3f), bp ("fr", "Freeze", false))) {}
    void prepareToPlay (double sr, int bs) override { r.prepare (spec (sr, bs)); r.reset(); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        juce::dsp::Reverb::Parameters pr; pr.roomSize = p ("sz"); pr.damping = p ("dm"); pr.width = p ("wd");
        pr.wetLevel = p ("mx"); pr.dryLevel = 1.0f - p ("mx"); pr.freezeMode = p ("fr") > 0.5f ? 1.0f : 0.0f; r.setParameters (pr);
        juce::dsp::AudioBlock<float> blk (b); r.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
private:
    juce::dsp::Reverb r;
};

class DelayFx : public BuiltIn
{
public:
    DelayFx() : BuiltIn ("Rose Delay", layout (cp ("sy", "Time", { "1/16", "1/8", "1/8 dotted", "1/4", "1/4 dotted", "1/2", "ms" }, 2), fp ("ms", "Time (ms)", 1, 2000, 375, 375, "ms"),
                                               fp ("fb", "Feedback", 0, 0.95f, 0.35f), bp ("pp", "Ping-pong", true), fp ("tone", "Tone", 1000, 20000, 9000, 5000, "Hz"), fp ("mx", "Mix", 0, 1, 0.25f))) {}
    void prepareToPlay (double sr, int bs) override
    {
        rate = sr; for (auto& d : line) { d.prepare ({ sr, (juce::uint32) bs, 1 }); d.setMaximumDelayInSamples ((int) (sr * 4)); d.reset(); }
        for (auto& f : lp) { f.prepare ({ sr, (juce::uint32) bs, 1 }); f.setType (juce::dsp::FirstOrderTPTFilterType::lowpass); }
    }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        static const float beats[] = { 0.25f, 0.5f, 0.75f, 1.0f, 1.5f, 2.0f };
        const int sy = (int) p ("sy");
        const float secs = sy == 6 ? p ("ms") / 1000.0f : (float) (60.0 / bpm() * beats[sy]);
        const float d = juce::jlimit (1.0f, (float) rate * 3.9f, secs * (float) rate), fb = p ("fb"), mx = p ("mx");
        const bool pp = p ("pp") > 0.5f; for (auto& f : lp) f.setCutoffFrequency (p ("tone"));
        auto* L = b.getWritePointer (0); auto* R = b.getNumChannels() > 1 ? b.getWritePointer (1) : L;
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            const float inL = L[i], inR = R[i];
            const float dl = lp[0].processSample (0, line[0].popSample (0, d)), dr = lp[1].processSample (0, line[1].popSample (0, d));
            if (pp) { line[0].pushSample (0, (inL + inR) * 0.5f + dr * fb); line[1].pushSample (0, dl * fb); }
            else    { line[0].pushSample (0, inL + dl * fb); line[1].pushSample (0, inR + dr * fb); }
            L[i] = inL * (1 - mx) + dl * mx; if (R != L) R[i] = inR * (1 - mx) + dr * mx;
        }
    }
private:
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> line[2];
    juce::dsp::FirstOrderTPTFilter<float> lp[2]; double rate = 44100;
};

class ChorusFx : public BuiltIn
{
public:
    ChorusFx (bool flanger = false) : BuiltIn (flanger ? "Rose Flanger" : "Rose Chorus",
        layout (fp ("ra", "Rate", 0.05f, 5, flanger ? 0.25f : 0.8f, 1, "Hz"), fp ("de", "Depth", 0, 1, flanger ? 0.7f : 0.4f), fp ("cd", "Centre delay", 1, 30, flanger ? 2.0f : 7.0f, 7, "ms"),
                fp ("fb", "Feedback", -0.95f, 0.95f, flanger ? 0.6f : 0.0f, 0), fp ("mx", "Mix", 0, 1, 0.5f))) {}
    void prepareToPlay (double sr, int bs) override { c.prepare (spec (sr, bs)); c.reset(); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        c.setRate (p ("ra")); c.setDepth (p ("de")); c.setCentreDelay (p ("cd")); c.setFeedback (p ("fb")); c.setMix (p ("mx"));
        juce::dsp::AudioBlock<float> blk (b); c.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
private:
    juce::dsp::Chorus<float> c;
};

class PhaserFx : public BuiltIn
{
public:
    PhaserFx() : BuiltIn ("Rose Phaser", layout (fp ("ra", "Rate", 0.02f, 8, 0.5f, 1, "Hz"), fp ("de", "Depth", 0, 1, 0.7f), fp ("cf", "Centre", 200, 4000, 900, 900, "Hz"), fp ("fb", "Feedback", -0.9f, 0.9f, 0.4f, 0), fp ("mx", "Mix", 0, 1, 0.5f))) {}
    void prepareToPlay (double sr, int bs) override { ph.prepare (spec (sr, bs)); ph.reset(); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        ph.setRate (p ("ra")); ph.setDepth (p ("de")); ph.setCentreFrequency (p ("cf")); ph.setFeedback (p ("fb")); ph.setMix (p ("mx"));
        juce::dsp::AudioBlock<float> blk (b); ph.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
private:
    juce::dsp::Phaser<float> ph;
};

class FilterFx : public BuiltIn
{
public:
    FilterFx() : BuiltIn ("Rose Filter", layout (cp ("ty", "Type", { "Low-pass 12", "High-pass 12", "Band-pass 12", "Low-pass 24", "High-pass 24", "Band-pass 24" }, 3),
                                                 fp ("co", "Cutoff", 40, 20000, 2000, 1000, "Hz"), fp ("re", "Resonance", 0, 1, 0.2f), fp ("dr", "Drive", 1, 10, 1, 2))) {}
    void prepareToPlay (double sr, int bs) override { f.prepare (spec (sr, bs)); f.reset(); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        using M = juce::dsp::LadderFilterMode;
        static const M modes[] = { M::LPF12, M::HPF12, M::BPF12, M::LPF24, M::HPF24, M::BPF24 };
        f.setMode (modes[(int) p ("ty")]); f.setCutoffFrequencyHz (p ("co")); f.setResonance (p ("re")); f.setDrive (p ("dr"));
        juce::dsp::AudioBlock<float> blk (b); f.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
private:
    juce::dsp::LadderFilter<float> f;
};

class DistortionFx : public BuiltIn
{
public:
    DistortionFx() : BuiltIn ("Rose Distortion", layout (cp ("ty", "Type", { "Soft", "Tube", "Hard", "Fuzz" }, 0), fp ("dr", "Drive", 0, 40, 6, 8, "dB"),
                                                         fp ("to", "Tone", 500, 20000, 8000, 4000, "Hz"), fp ("ou", "Output", -24, 6, -3, -3, "dB"), fp ("mx", "Mix", 0, 1, 1))) {}
    void prepareToPlay (double sr, int bs) override { tone.prepare (spec (sr, bs)); tone.setType (juce::dsp::FirstOrderTPTFilterType::lowpass); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        const int ty = (int) p ("ty"); const float g = juce::Decibels::decibelsToGain (p ("dr")), out = juce::Decibels::decibelsToGain (p ("ou")), mx = p ("mx");
        tone.setCutoffFrequency (p ("to"));
        for (int ch = 0; ch < b.getNumChannels(); ++ch)
        {
            auto* d = b.getWritePointer (ch);
            for (int i = 0; i < b.getNumSamples(); ++i)
            {
                const float x = d[i] * g; float y;
                switch (ty) { case 1: y = x >= 0 ? std::tanh (x) : std::tanh (x * 0.7f) * 0.9f; break;
                              case 2: y = juce::jlimit (-1.0f, 1.0f, x); break;
                              case 3: y = (x >= 0 ? 1.0f : -1.0f) * (1.0f - std::exp (-std::abs (x) * 2)); break;
                              default: y = std::tanh (x); }
                d[i] = d[i] * (1 - mx) + tone.processSample (ch, y) * out * mx;
            }
        }
    }
private:
    juce::dsp::FirstOrderTPTFilter<float> tone;
};

class CrusherFx : public BuiltIn
{
public:
    CrusherFx() : BuiltIn ("Rose Bitcrusher", layout (fp ("bi", "Bits", 1, 16, 8, 8), fp ("ds", "Downsample", 1, 40, 4, 6, "x"), fp ("mx", "Mix", 0, 1, 1))) {}
    void prepareToPlay (double, int) override { cnt = 0; hold[0] = hold[1] = 0; }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        const float steps = std::pow (2.0f, p ("bi") - 1), mx = p ("mx"); const int ds = juce::jmax (1, (int) p ("ds"));
        for (int i = 0; i < b.getNumSamples(); ++i, ++cnt)
            for (int ch = 0; ch < juce::jmin (2, b.getNumChannels()); ++ch)
            {
                auto* d = b.getWritePointer (ch);
                if (cnt % ds == 0) hold[ch] = std::round (d[i] * steps) / steps;
                d[i] = d[i] * (1 - mx) + hold[ch] * mx;
            }
    }
private:
    juce::int64 cnt = 0; float hold[2] {};
};

class WidthFx : public BuiltIn
{
public:
    WidthFx() : BuiltIn ("Rose Width & Utility", layout (fp ("wi", "Width", 0, 2, 1, 1, "x"), fp ("ga", "Gain", -36, 24, 0, 0, "dB"), fp ("pa", "Pan", -1, 1, 0, 0), bp ("mo", "Mono", false), bp ("inv", "Invert phase", false))) {}
    void prepareToPlay (double, int) override {}
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        if (b.getNumChannels() < 2) return;
        const float w = p ("mo") > 0.5f ? 0.0f : p ("wi"), g = juce::Decibels::decibelsToGain (p ("ga")) * (p ("inv") > 0.5f ? -1.0f : 1.0f), pan = p ("pa");
        const float gl = g * std::cos ((pan + 1) * juce::MathConstants<float>::pi / 4) * juce::MathConstants<float>::sqrt2,
                    gr = g * std::sin ((pan + 1) * juce::MathConstants<float>::pi / 4) * juce::MathConstants<float>::sqrt2;
        auto* L = b.getWritePointer (0); auto* R = b.getWritePointer (1);
        for (int i = 0; i < b.getNumSamples(); ++i) { const float m = (L[i] + R[i]) * 0.5f, s = (L[i] - R[i]) * 0.5f * w; L[i] = (m + s) * gl; R[i] = (m - s) * gr; }
    }
};

//==============================================================================
// Rose Synth: polyphonic supersaw / pluck / pad synth so instrument tracks work with no plugins installed.
class RoseSynth : public BuiltIn
{
public:
    RoseSynth() : BuiltIn ("Rose Synth", layout (cp ("wa", "Wave", { "Saw", "Square", "Triangle", "Sine" }, 0), fp ("un", "Unison", 1, 7, 5, 4), fp ("dt", "Detune", 0, 60, 22, 20, "ct"),
                                                fp ("co", "Cutoff", 60, 18000, 5000, 1500, "Hz"), fp ("re", "Resonance", 0.1f, 10, 1.2f, 1.5f), fp ("fe", "Filter env", 0, 10000, 2000, 2000, "Hz"),
                                                fp ("a", "Attack", 0.001f, 3, 0.005f, 0.2f, "s"), fp ("d", "Decay", 0.01f, 3, 0.3f, 0.5f, "s"), fp ("s", "Sustain", 0, 1, 0.7f),
                                                fp ("r", "Release", 0.01f, 5, 0.3f, 0.5f, "s"), fp ("vo", "Volume", 0, 1, 0.5f)), true)
    {
        for (int i = 0; i < 16; ++i) synthEngine.addVoice (new Voice (*this));
        synthEngine.addSound (new Sound());
    }
    void prepareToPlay (double sr, int) override { synthEngine.setCurrentPlaybackSampleRate (sr); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer& m) override { b.clear(); synthEngine.renderNextBlock (b, m, 0, b.getNumSamples()); }
private:
    struct Sound : juce::SynthesiserSound { bool appliesToNote (int) override { return true; } bool appliesToChannel (int) override { return true; } };
    struct Voice : juce::SynthesiserVoice
    {
        explicit Voice (RoseSynth& o) : owner (o) {}
        bool canPlaySound (juce::SynthesiserSound*) override { return true; }
        void startNote (int note, float vel, juce::SynthesiserSound*, int) override
        {
            freq = juce::MidiMessage::getMidiNoteInHertz (note); velocity = vel; const double sr = getSampleRate();
            for (int i = 0; i < 7; ++i) phase[i] = juce::Random::getSystemRandom().nextDouble();
            adsr.setSampleRate (sr); fenv.setSampleRate (sr);
            adsr.setParameters ({ owner.p ("a"), owner.p ("d"), owner.p ("s"), owner.p ("r") });
            fenv.setParameters ({ 0.001f, owner.p ("d"), 0.0f, owner.p ("r") });
            filt.prepare ({ sr, 512, 1 }); filt.reset(); filt.setType (juce::dsp::StateVariableTPTFilterType::lowpass);
            adsr.noteOn(); fenv.noteOn();
        }
        void stopNote (float, bool tail) override { if (tail) { adsr.noteOff(); fenv.noteOff(); } else { adsr.reset(); clearCurrentNote(); } }
        void pitchWheelMoved (int) override {}
        void controllerMoved (int, int) override {}
        void renderNextBlock (juce::AudioBuffer<float>& out, int start, int n) override
        {
            if (! isVoiceActive()) return;
            const int wave = (int) owner.p ("wa"), uni = juce::jlimit (1, 7, (int) owner.p ("un")); const float det = owner.p ("dt"), co = owner.p ("co"), fe = owner.p ("fe");
            const float lvl = owner.p ("vo") * velocity * 0.3f / std::sqrt ((float) uni); const double sr = getSampleRate();
            filt.setResonance (owner.p ("re") * 0.1f + 0.5f);
            for (int i = 0; i < n; ++i)
            {
                float s = 0;
                for (int u = 0; u < uni; ++u)
                {
                    const double cents = uni == 1 ? 0.0 : (u / (double) (uni - 1) * 2 - 1) * det;
                    phase[u] += freq * std::pow (2.0, cents / 1200.0) / sr; phase[u] -= std::floor (phase[u]);
                    const float ph = (float) phase[u];
                    s += wave == 0 ? 2 * ph - 1 : wave == 1 ? (ph < 0.5f ? 1.0f : -1.0f) : wave == 2 ? 4 * std::abs (ph - 0.5f) - 1 : std::sin (ph * juce::MathConstants<float>::twoPi);
                }
                if ((i & 15) == 0) filt.setCutoffFrequency (juce::jlimit (30.0f, (float) sr * 0.45f, co + fe * velocity * fenv.getNextSample()));
                const float y = filt.processSample (0, s) * adsr.getNextSample() * lvl;
                for (int ch = 0; ch < out.getNumChannels(); ++ch) out.addSample (ch, start + i, y);
            }
            if (! adsr.isActive()) clearCurrentNote();
        }
        RoseSynth& owner; double freq = 440, phase[7] {}; float velocity = 1;
        juce::ADSR adsr, fenv; juce::dsp::StateVariableTPTFilter<float> filt;
    };
    juce::Synthesiser synthEngine;
};

//==============================================================================
struct BuiltInInfo { juce::String id, name; bool instrument; std::function<std::unique_ptr<BuiltIn>()> make; };
inline const std::vector<BuiltInInfo>& builtIns()
{
    static const std::vector<BuiltInInfo> list {
        { "synth", "Rose Synth", true, [] { return std::make_unique<RoseSynth>(); } },
        { "eq", "Rose EQ", false, [] { return std::make_unique<EqFx>(); } },
        { "filter", "Rose Filter", false, [] { return std::make_unique<FilterFx>(); } },
        { "comp", "Rose Compressor", false, [] { return std::make_unique<CompFx>(); } },
        { "limiter", "Rose Limiter", false, [] { return std::make_unique<LimiterFx>(); } },
        { "gate", "Rose Gate", false, [] { return std::make_unique<GateFx>(); } },
        { "reverb", "Rose Reverb", false, [] { return std::make_unique<ReverbFx>(); } },
        { "delay", "Rose Delay", false, [] { return std::make_unique<DelayFx>(); } },
        { "chorus", "Rose Chorus", false, [] { return std::make_unique<ChorusFx> (false); } },
        { "flanger", "Rose Flanger", false, [] { return std::make_unique<ChorusFx> (true); } },
        { "phaser", "Rose Phaser", false, [] { return std::make_unique<PhaserFx>(); } },
        { "distortion", "Rose Distortion", false, [] { return std::make_unique<DistortionFx>(); } },
        { "crusher", "Rose Bitcrusher", false, [] { return std::make_unique<CrusherFx>(); } },
        { "width", "Rose Width & Utility", false, [] { return std::make_unique<WidthFx>(); } },
    };
    return list;
}
} // namespace rose
