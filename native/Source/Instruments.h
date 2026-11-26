// Rose Desktop — built-in instruments beyond Rose Synth:
//   Rose Drums  — synthesized kit on the General MIDI drum map (same sounds as the web app)
//   Rose Sounds — open-source sampled instruments (FluidR3 GM by Frank Wen, MIT; renders by gleitz, CC BY 3.0)
#pragma once
#include "BuiltIns.h"

namespace rose
{
//==============================================================================
class RoseDrums : public BuiltIn
{
public:
    RoseDrums() : BuiltIn ("Rose Drums", layout (fp ("kt", "Kick tune", 35, 80, 50, 50, "Hz"), fp ("kd", "Kick decay", 0.1f, 1.2f, 0.45f, 0.45f, "s"), fp ("kp", "Kick punch", 0, 1, 0.7f),
                                                fp ("st", "Snare tone", 120, 300, 190, 190, "Hz"), fp ("sd", "Snare decay", 0.05f, 0.5f, 0.18f, 0.18f, "s"),
                                                fp ("hd", "Hat decay", 0.02f, 0.4f, 0.06f, 0.06f, "s"), fp ("vo", "Volume", 0, 1, 0.8f)), true) {}
    void prepareToPlay (double r, int) override { sr = r; hits.clear(); hits.reserve (64); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer& midi) override
    {
        b.clear(); int pos = 0; const int n = b.getNumSamples();
        for (const auto m : midi)
        {
            const auto msg = m.getMessage();
            render (b, pos, m.samplePosition - pos); pos = juce::jmax (pos, m.samplePosition);
            if (msg.isNoteOn()) trigger (msg.getNoteNumber(), msg.getFloatVelocity());
        }
        render (b, pos, n - pos);
    }
private:
    enum Wave { sine, tri, square };
    struct Part { float f0 = 0, f1 = 0, sweep = 0.01f, amp = 0, dec = 0.1f; Wave wave = sine; double ph = 0; };
    struct Biquad   // copyable direct-form-II filter (hits live in a vector)
    {
        float c[5] {}, z1 = 0, z2 = 0;
        void setCoefficients (const juce::IIRCoefficients& k) { std::copy (k.coefficients, k.coefficients + 5, c); }
        float processSingleSampleRaw (float x) { const float y = c[0] * x + z1; z1 = c[1] * x - c[3] * y + z2; z2 = c[2] * x - c[4] * y; return y; }
    };
    struct Hit
    {
        Part tone, tone2; float nAmp = 0, nDec = 0.1f, delay = 0; int bursts = 0; Biquad nf; double t = 0, life = 0.5;
    };
    void addHit (Hit h) { if (hits.size() >= 48) hits.erase (hits.begin()); hits.push_back (std::move (h)); }
    juce::IIRCoefficients filt (int type, float f, float q) const
    {
        f = juce::jmin (f, (float) sr * 0.45f);
        return type == 0 ? juce::IIRCoefficients::makeHighPass (sr, f, q) : type == 1 ? juce::IIRCoefficients::makeBandPass (sr, f, q) : juce::IIRCoefficients::makeLowPass (sr, f, q);
    }
    void trigger (int note, float v)
    {
        const float vo = p ("vo") * v, kt = p ("kt"), kp = p ("kp"), kd = p ("kd"), stn = p ("st"), sd = p ("sd"), hd = p ("hd");
        Hit h; auto noise = [&] (int type, float f, float q, float amp, float dec) { h.nf.setCoefficients (filt (type, f, q)); h.nAmp = amp; h.nDec = dec; };
        auto tone = [&] (Part& t, float f0, float f1, float sweep, float amp, float dec, Wave w = sine) { t = { f0, f1, sweep, amp, dec, w, 0 }; };
        static const int map12[] = { 36, 37, 38, 39, 38, 45, 42, 48, 42, 50, 46, 50 };
        int k = note; if (k < 35 || k > 59) k = map12[((note - 36) % 12 + 12) % 12];
        switch (k)
        {
            case 35: case 36: tone (h.tone, kt * (3 + kp * 4), kt, 0.05f + kp * 0.04f, vo, kd); noise (0, 3000, 0.7f, vo * 0.25f * kp, 0.008f); break;
            case 38: case 40: tone (h.tone, stn * 1.6f, stn, 0.03f, vo * 0.55f, sd * 0.6f, tri); noise (0, 1500, 0.7f, vo * 0.6f, sd); break;
            case 39: noise (1, 1200, 1.2f, vo * 0.7f, 0.18f); h.bursts = 3; break;
            case 37: tone (h.tone, 1700, 900, 0.01f, vo * 0.4f, 0.04f, square); break;
            case 42: noise (0, 7500, 0.8f, vo * 0.45f, hd); break;
            case 44: noise (0, 6500, 0.8f, vo * 0.4f, hd * 0.8f); break;
            case 46: noise (0, 7000, 0.8f, vo * 0.4f, hd * 6); break;
            case 41: case 43: case 45: tone (h.tone, 160, 90, 0.2f, vo * 0.8f, 0.35f); break;
            case 47: case 48: tone (h.tone, 220, 140, 0.2f, vo * 0.8f, 0.3f); break;
            case 50: tone (h.tone, 300, 200, 0.18f, vo * 0.8f, 0.25f); break;
            case 49: case 52: case 55: case 57: noise (0, 5000, 0.5f, vo * 0.4f, 1.6f); break;
            case 51: case 53: case 59: noise (1, 8000, 3, vo * 0.35f, 0.9f); break;
            case 56: tone (h.tone, 800, 800, 0.01f, vo * 0.3f, 0.2f, square); tone (h.tone2, 540, 540, 0.01f, vo * 0.3f, 0.2f, square); break;
            default: tone (h.tone, kt * 4, kt, 0.06f, vo, kd); break;
        }
        h.life = juce::jmax (h.tone.dec, h.tone2.dec, h.nDec) + 0.06;
        addHit (std::move (h));
    }
    static float env (double t, float amp, float dec)   // 1 ms attack, exponential fall to -80 dB over `dec`
    {
        if (amp <= 0 || t > dec + 0.001) return 0;
        return t < 0.001 ? amp * (float) (t / 0.001) : amp * std::pow (1e-4f, (float) ((t - 0.001) / dec));
    }
    float tick (Part& p, double t)
    {
        if (p.amp <= 0) return 0;
        const double f = p.f1 + (p.f0 - p.f1) * std::exp (-t / juce::jmax (0.001f, p.sweep) * 4.6);
        p.ph += f / sr; p.ph -= std::floor (p.ph); const float x = (float) p.ph;
        const float w = p.wave == sine ? std::sin (x * juce::MathConstants<float>::twoPi) : p.wave == tri ? 4 * std::abs (x - 0.5f) - 1 : (x < 0.5f ? 1.0f : -1.0f);
        return w * env (t, p.amp, p.dec);
    }
    void render (juce::AudioBuffer<float>& b, int start, int len)
    {
        for (int i = 0; i < len; ++i)
        {
            float s = 0;
            for (auto& h : hits)
            {
                s += tick (h.tone, h.t) + tick (h.tone2, h.t);
                if (h.nAmp > 0)
                {
                    float e;
                    if (h.bursts) { const double bt = std::fmod (h.t, 0.011); e = h.t < 0.033 ? env (bt, h.nAmp, 0.012f) : env (h.t - 0.03, h.nAmp, h.nDec); }
                    else e = env (h.t, h.nAmp, h.nDec);
                    s += h.nf.processSingleSampleRaw (rng.nextFloat() * 2 - 1) * e;
                }
                h.t += 1.0 / sr;
            }
            for (int c = 0; c < b.getNumChannels(); ++c) b.addSample (c, start + i, s);
        }
        hits.erase (std::remove_if (hits.begin(), hits.end(), [] (const Hit& h) { return h.t > h.life; }), hits.end());
    }
    std::vector<Hit> hits; double sr = 44100; juce::Random rng;
};

//==============================================================================
struct SoundInfo { const char* id; const char* name; float gain; bool sustain; };
inline const std::vector<SoundInfo>& soundLibrary()
{
    static const std::vector<SoundInfo> lib {
        { "acoustic_grand_piano", "Grand Piano", 6.84f, false }, { "electric_piano_1", "Electric Piano", 6.69f, false }, { "rock_organ", "Organ", 4.02f, true },
        { "marimba", "Marimba", 5.02f, false }, { "acoustic_guitar_nylon", "Nylon Guitar", 4.0f, false }, { "electric_bass_finger", "Electric Bass", 4.02f, false },
        { "string_ensemble_1", "Strings", 5.02f, true }, { "pizzicato_strings", "Pizzicato Strings", 3.65f, false }, { "violin", "Violin", 4.51f, true },
        { "brass_section", "Brass Section", 3.22f, true }, { "trumpet", "Trumpet", 4.05f, true }, { "flute", "Flute", 5.38f, true },
        { "clarinet", "Clarinet", 4.44f, true }, { "choir_aahs", "Choir", 4.77f, true } };
    return lib;
}
inline juce::StringArray soundNames() { juce::StringArray s; for (auto& x : soundLibrary()) s.add (x.name); return s; }

// Where the sample folder lives: inside the Mac app (Contents/Resources/sounds), next to the Windows exe, or in the repo while developing.
inline juce::File& soundsDirOverride() { static juce::File f; return f; }
inline juce::File findSoundsDir()
{
    if (soundsDirOverride().getChildFile ("index.json").existsAsFile()) return soundsDirOverride();
    const auto exeDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
    for (auto c : { exeDir.getSiblingFile ("Resources").getChildFile ("sounds"), exeDir.getChildFile ("sounds") })
        if (c.getChildFile ("index.json").existsAsFile()) return c;
    for (auto start : { exeDir, juce::File::getCurrentWorkingDirectory() })
        for (auto d = start; d.getParentDirectory() != d; d = d.getParentDirectory())
            if (d.getChildFile ("sounds/index.json").existsAsFile()) return d.getChildFile ("sounds");
    return {};
}

class RoseSounds : public BuiltIn, private APVTS::Listener
{
public:
    static constexpr int numNotes = 31;
    static int noteAt (int i) { return i == 0 ? 21 : i == numNotes - 1 ? 108 : 22 + (i - 1) * 3; }

    struct Bank
    {
        int patch = -1; float gain = 1; bool sustain = false; double rate = 44100;
        std::array<juce::AudioBuffer<float>, numNotes> notes; std::array<double, numNotes> loopStart {}, loopEnd {};
        bool ok() const { return notes[0].getNumSamples() > 0; }
    };

    RoseSounds() : BuiltIn ("Rose Sounds", layout (cp ("patch", "Instrument", soundNames(), 0), fp ("a", "Attack", 0.001f, 2, 0.003f, 0.2f, "s"), fp ("r", "Release", 0.02f, 4, 0.35f, 0.5f, "s"),
                                                  fp ("tone", "Tone", 300, 20000, 20000, 3000, "Hz"), fp ("vs", "Velocity", 0, 1, 0.7f), fp ("tr", "Transpose", -24, 24, 0, 0, "st"),
                                                  fp ("vo", "Volume", 0, 1.5f, 0.8f)), true)
    {
        for (int i = 0; i < 24; ++i) synthEngine.addVoice (new Voice (*this));
        synthEngine.addSound (new Sound());
        state.addParameterListener ("patch", this);
    }
    ~RoseSounds() override { state.removeParameterListener ("patch", this); }

    void prepareToPlay (double sr, int bs) override
    {
        synthEngine.setCurrentPlaybackSampleRate (sr); tone.prepare (spec (sr, bs)); tone.setType (juce::dsp::StateVariableTPTFilterType::lowpass);
        ensureLoaded();
    }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer& m) override
    {
        { const juce::SpinLock::ScopedTryLockType l (lock); if (l.isLocked() && live != current) current = live; }
        b.clear(); synthEngine.renderNextBlock (b, m, 0, b.getNumSamples());
        tone.setCutoffFrequency (juce::jmin (p ("tone"), (float) getSampleRate() * 0.45f));
        juce::dsp::AudioBlock<float> blk (b); tone.process (juce::dsp::ProcessContextReplacing<float> (blk));
    }
    void setStateInformation (const void* d, int n) override { BuiltIn::setStateInformation (d, n); ensureLoaded(); }

    // Loads the selected instrument's samples now (message thread). Returns false if the sample folder is missing.
    bool ensureLoaded()
    {
        const int want = (int) p ("patch");
        { const juce::SpinLock::ScopedLockType l (lock); if (live && live->patch == want) return live->ok(); }
        auto bank = load (want);
        const juce::SpinLock::ScopedLockType l (lock); live = bank; return bank->ok();
    }

    static std::shared_ptr<Bank> load (int patch)
    {
        // tracks playing the same instrument share one copy of its samples
        static std::map<int, std::weak_ptr<Bank>> cache; static juce::CriticalSection cacheLock;
        const juce::ScopedLock sl (cacheLock);
        if (auto hit = cache[patch].lock(); hit && hit->ok()) return hit;
        auto b = std::make_shared<Bank>(); cache[patch] = b; const auto& info = soundLibrary()[(size_t) juce::jlimit (0, (int) soundLibrary().size() - 1, patch)];
        b->patch = patch; b->gain = info.gain; b->sustain = info.sustain;
        const auto dir = findSoundsDir().getChildFile (info.id); juce::MP3AudioFormat mp3;
        for (int i = 0; i < numNotes; ++i)
        {
            auto in = dir.getChildFile (juce::String (noteAt (i)) + ".mp3").createInputStream();
            if (in == nullptr) continue;
            std::unique_ptr<juce::AudioFormatReader> r (mp3.createReaderFor (in.release(), true));
            if (r == nullptr) continue;
            auto& buf = b->notes[(size_t) i]; const int len = (int) r->lengthInSamples;
            juce::AudioBuffer<float> tmp ((int) juce::jmax (1u, r->numChannels), len); r->read (&tmp, 0, len, 0, true, true);
            buf.setSize (1, len); buf.copyFrom (0, 0, tmp, 0, 0, len);
            if (tmp.getNumChannels() > 1) { buf.addFrom (0, 0, tmp, 1, 0, len); buf.applyGain (0.5f); }
            b->rate = r->sampleRate;
            const float* d = buf.getReadPointer (0);
            auto zc = [&] (double t) { int k = juce::jmin (len - 2, (int) (t * b->rate)); for (int s = 0; s < (int) (b->rate * 0.05) && k < len - 1; ++s, ++k) if (d[k] <= 0 && d[k + 1] > 0) return (double) k; return t * b->rate; };
            b->loopStart[(size_t) i] = zc (0.9); b->loopEnd[(size_t) i] = zc (juce::jmin ((double) len / b->rate - 0.5, 2.5));
        }
        return b;
    }

private:
    void parameterChanged (const juce::String&, float) override
    {
        if (juce::MessageManager::getInstance()->isThisTheMessageThread()) ensureLoaded();
        else juce::MessageManager::callAsync ([w = juce::WeakReference<RoseSounds> (this)] { if (w) w->ensureLoaded(); });
    }
    struct Sound : juce::SynthesiserSound { bool appliesToNote (int) override { return true; } bool appliesToChannel (int) override { return true; } };
    struct Voice : juce::SynthesiserVoice
    {
        explicit Voice (RoseSounds& o) : owner (o) {}
        bool canPlaySound (juce::SynthesiserSound*) override { return true; }
        void startNote (int note, float vel, juce::SynthesiserSound*, int) override
        {
            bank = owner.current; if (bank == nullptr || ! bank->ok()) { clearCurrentNote(); return; }
            const int q = note + (int) owner.p ("tr"); idx = 0; int bd = 999;
            for (int i = 0; i < numNotes; ++i) if (bank->notes[(size_t) i].getNumSamples() > 0 && std::abs (noteAt (i) - q) < bd) { bd = std::abs (noteAt (i) - q); idx = i; }
            inc = std::pow (2.0, (q - noteAt (idx)) / 12.0) * bank->rate / getSampleRate(); pos = 0;
            const float vs = owner.p ("vs"); level = owner.p ("vo") * bank->gain * 0.7f * (1 - vs + vs * vel);
            adsr.setSampleRate (getSampleRate()); adsr.setParameters ({ owner.p ("a"), 0.1f, 1.0f, owner.p ("r") }); adsr.noteOn();
        }
        void stopNote (float, bool tail) override { if (tail) adsr.noteOff(); else { adsr.reset(); bank.reset(); clearCurrentNote(); } }
        void pitchWheelMoved (int) override {}
        void controllerMoved (int, int) override {}
        void renderNextBlock (juce::AudioBuffer<float>& out, int start, int n) override
        {
            if (! isVoiceActive() || bank == nullptr) return;
            const auto& buf = bank->notes[(size_t) idx]; const float* d = buf.getReadPointer (0); const int len = buf.getNumSamples();
            const double ls = bank->loopStart[(size_t) idx], le = bank->loopEnd[(size_t) idx];
            for (int i = 0; i < n; ++i)
            {
                if (bank->sustain && le > ls + 64 && pos >= le) pos -= (le - ls);
                const int i0 = (int) pos; if (i0 >= len - 1) { adsr.reset(); break; }
                const float fr = (float) (pos - i0), y = (d[i0] * (1 - fr) + d[i0 + 1] * fr) * adsr.getNextSample() * level;
                for (int c = 0; c < out.getNumChannels(); ++c) out.addSample (c, start + i, y);
                pos += inc;
            }
            if (! adsr.isActive()) { bank.reset(); clearCurrentNote(); }
        }
        RoseSounds& owner; std::shared_ptr<Bank> bank; int idx = 0; double pos = 0, inc = 1; float level = 1; juce::ADSR adsr;
    };
    juce::SpinLock lock; std::shared_ptr<Bank> live, current;
    juce::Synthesiser synthEngine; juce::dsp::StateVariableTPTFilter<float> tone;
    JUCE_DECLARE_WEAK_REFERENCEABLE (RoseSounds)
};
} // namespace rose
