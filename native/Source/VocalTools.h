// Rose Desktop — vocal tools: Rose Tune (pitch correction), Pitch Shifter, Harmonizer, De-esser, Vocal Doubler.
// The pitch engine matches the web app's worklet: YIN detection + a two-head, pitch-synchronous delay-line shifter.
#pragma once
#include "BuiltIns.h"

namespace rose
{
inline const juce::StringArray& noteNames() { static const juce::StringArray n { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }; return n; }
inline const juce::StringArray& scaleNames()
{
    static const juce::StringArray n { "Chromatic", "Major", "Minor", "Harmonic minor", "Freygish (Ahava Raba)", "Major pentatonic", "Minor pentatonic", "Blues", "Dorian", "Mixolydian" };
    return n;
}
inline const std::vector<std::vector<int>>& scales()
{
    static const std::vector<std::vector<int>> s { { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 }, { 0, 2, 4, 5, 7, 9, 11 }, { 0, 2, 3, 5, 7, 8, 10 }, { 0, 2, 3, 5, 7, 8, 11 },
        { 0, 1, 4, 5, 7, 8, 10 }, { 0, 2, 4, 7, 9 }, { 0, 3, 5, 7, 10 }, { 0, 3, 5, 6, 7, 10 }, { 0, 2, 3, 5, 7, 9, 10 }, { 0, 2, 4, 5, 7, 9, 10 } };
    return s;
}
inline const juce::StringArray& harmonyChoices()
{
    static const juce::StringArray h { "Off", "-12 octave down", "-7 fifth down", "-5 fourth down", "-3 minor 3rd down", "+3 minor 3rd", "+4 major 3rd", "+5 fourth", "+7 fifth", "+9 sixth", "+12 octave" };
    return h;
}

//==============================================================================
class PitchCore
{
public:
    struct Params { bool tune = true; float shiftSemis = 0, detuneCents = 0, speedMs = 20, humanizeCents = 0; int key = 0, scale = 0; };

    void prepare (double rate)
    {
        sr = rate; Wn = W = Wt = std::round (sr * 0.04);
        std::fill (buf.begin(), buf.end(), 0.0f); std::fill (dl.begin(), dl.end(), 0.0f);
        w = dn0 = hop = 0; dn = 0; acc = 0; parity = 0; ph = 0; ratio = target = 1; f0 = 0;
    }

    // one sample in, one shifted sample out (mono)
    float process (float v, const Params& p)
    {
        const double sh = std::pow (2.0, (p.shiftSemis + p.detuneCents / 100.0) / 12.0);
        const double k = p.speedMs <= 0.5f ? 0.0 : std::exp (-1.0 / (p.speedMs * sr / 1000.0));
        buf[(size_t) w] = v; acc += v;
        if (parity++ & 1) { dl[(size_t) dn0] = acc * 0.5f; dn0 = (dn0 + 1) % DN; ++dn; acc = 0; }
        if (++hop >= 512)
        {
            hop = 0; const double f = detect(); f0 = (float) f;
            if (f > 0) { const double T = sr / f; Wt = 2.0 * juce::jmax (1.0, std::round (Wn / 2.0 / T)) * T; }
            if (p.tune && f > 0)
            {
                const double m = 69 + 12 * std::log2 (f / 440.0);
                const auto& sc = scales()[(size_t) juce::jlimit (0, (int) scales().size() - 1, p.scale)];
                double best = m, bd = 99;
                for (int oc = -1; oc <= 1; ++oc)
                    for (int s : sc) { const double c = (std::floor ((m - p.key) / 12) + oc) * 12 + p.key + s; if (std::abs (c - m) < bd) { bd = std::abs (c - m); best = c; } }
                double cents = (best - m) * 100; cents = (cents < 0 ? -1 : 1) * juce::jmax (0.0, std::abs (cents) - (double) p.humanizeCents);
                target = std::pow (2.0, cents / 1200.0);
            }
            else if (p.tune) target = 1;
        }
        if (! p.tune) target = 1;
        ratio = k > 0 ? k * ratio + (1 - k) * target : target;
        const double r = ratio * sh;
        W += (Wt - W) * 0.0005;
        ph += (1 - r) / W;
        if (std::abs (1 - r) < 0.0003) { const double tg = ph < 0.25 ? 0.0 : ph < 0.75 ? 0.5 : 1.0; ph += (tg - ph) * 0.00005; }
        ph -= std::floor (ph);
        const double p2 = std::fmod (ph + 0.5, 1.0), g1 = 0.5 - 0.5 * std::cos (juce::MathConstants<double>::twoPi * ph);
        const float y = (float) (g1 * tap (ph) + (1 - g1) * tap (p2));
        w = (w + 1) % N;
        return y;
    }
    float detectedHz() const { return f0.load(); }

private:
    float tap (double phase) const
    {
        const double pos = w - (phase * W + 2) + N; const int i0 = (int) std::floor (pos); const float fr = (float) (pos - i0);
        return buf[(size_t) (i0 % N)] * (1 - fr) + buf[(size_t) ((i0 + 1) % N)] * fr;
    }
    double detect()
    {
        const int Wd = 1024; const double hsr = sr / 2; const int tmin = (int) (hsr / 1000), tmax = juce::jmin ((int) (hsr / 65), Wd - 1);
        if (dn < Wd + tmax) return 0;
        const int st = ((dn0 - Wd - tmax) % DN + DN) % DN;
        auto x = [&] (int i) { return dl[(size_t) ((st + i) % DN)]; };
        double rms = 0; for (int i = 0; i < Wd; ++i) rms += x (i) * x (i);
        if (std::sqrt (rms / Wd) < 0.006) return 0;
        double run = 0; int best = -1; yin[0] = 1;
        for (int t = 1; t <= tmax; ++t)
        {
            double s = 0; for (int i = 0; i < Wd; ++i) { const double a = x (i) - x (i + t); s += a * a; }
            run += s; yin[(size_t) t] = run > 0 ? (float) (s * t / run) : 1.0f;
            if (t > tmin + 1 && yin[(size_t) t - 1] < 0.15f && yin[(size_t) t] > yin[(size_t) t - 1]) { best = t - 1; break; }
        }
        if (best < 1) return 0;
        const double a = yin[(size_t) best - 1], b = yin[(size_t) best], c = yin[(size_t) best + 1], den = a - 2 * b + c;
        return hsr / (den != 0 ? best + 0.5 * (a - c) / den : best);
    }
    static constexpr int N = 16384, DN = 2048;
    std::vector<float> buf = std::vector<float> (N), dl = std::vector<float> (DN), yin = std::vector<float> (1024);
    double sr = 44100, ph = 0, ratio = 1, target = 1, Wn = 1764, W = 1764, Wt = 1764;
    int w = 0, dn0 = 0, hop = 0, parity = 0; juce::int64 dn = 0; float acc = 0;
    std::atomic<float> f0 { 0 };
};

// short fixed delay used to keep a dry signal time-aligned with the shifter's ~22 ms latency
struct AlignDelay
{
    void prepare (double sr) { len = (int) (sr * 0.022); for (auto& b : bufs) b.assign ((size_t) len + 1, 0.0f); pos = 0; }
    float process (int ch, float x) { auto& b = bufs[(size_t) ch]; const float y = b[(size_t) pos]; b[(size_t) pos] = x; return y; }
    void advance() { pos = (pos + 1) % (len + 1); }
    std::array<std::vector<float>, 2> bufs; int len = 1, pos = 0;
};

inline void equalPower (float pan, float& l, float& r)
{
    const float a = (pan + 1) * juce::MathConstants<float>::pi / 4; l = std::cos (a); r = std::sin (a);
}

//==============================================================================
class TuneFx : public BuiltIn
{
public:
    TuneFx() : BuiltIn ("Rose Tune", layout (cp ("key", "Key", noteNames(), 0), cp ("scale", "Scale", scaleNames(), 0), fp ("speed", "Retune speed", 0, 400, 20, 40, "ms"),
                                             fp ("hum", "Humanize", 0, 50, 0, 0, "cents"), fp ("tr", "Transpose", -12, 12, 0, 0, "st"), fp ("fine", "Fine", -100, 100, 0, 0, "cents"),
                                             fp ("mx", "Mix", 0, 1, 1))) {}
    void prepareToPlay (double sr, int) override { core.prepare (sr); align.prepare (sr); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        PitchCore::Params pr; pr.tune = true; pr.key = (int) p ("key"); pr.scale = (int) p ("scale"); pr.speedMs = p ("speed");
        pr.humanizeCents = p ("hum"); pr.shiftSemis = p ("tr"); pr.detuneCents = p ("fine");
        const float mx = p ("mx"); const int nc = juce::jmin (2, b.getNumChannels());
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            float m = 0; for (int c = 0; c < nc; ++c) m += b.getSample (c, i); m /= (float) juce::jmax (1, nc);
            const float y = core.process (m, pr);
            for (int c = 0; c < nc; ++c) b.setSample (c, i, align.process (c, b.getSample (c, i)) * (1 - mx) + y * mx);
            align.advance();
        }
    }
    float detectedHz() const { return core.detectedHz(); }
private:
    PitchCore core; AlignDelay align;
};

class PitchFx : public BuiltIn
{
public:
    PitchFx() : BuiltIn ("Rose Pitch Shifter", layout (fp ("sh", "Pitch", -24, 24, 0, 0, "st"), fp ("fine", "Fine", -100, 100, 0, 0, "cents"), fp ("mx", "Mix", 0, 1, 1))) {}
    void prepareToPlay (double sr, int) override { core.prepare (sr); align.prepare (sr); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        PitchCore::Params pr; pr.tune = false; pr.shiftSemis = std::round (p ("sh")); pr.detuneCents = p ("fine");
        const float mx = p ("mx"); const int nc = juce::jmin (2, b.getNumChannels());
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            float m = 0; for (int c = 0; c < nc; ++c) m += b.getSample (c, i); m /= (float) juce::jmax (1, nc);
            const float y = core.process (m, pr);
            for (int c = 0; c < nc; ++c) b.setSample (c, i, align.process (c, b.getSample (c, i)) * (1 - mx) + y * mx);
            align.advance();
        }
    }
private:
    PitchCore core; AlignDelay align;
};

class HarmonizerFx : public BuiltIn
{
public:
    HarmonizerFx() : BuiltIn ("Rose Harmonizer", layout (cp ("v1", "Voice 1", harmonyChoices(), 6), fp ("l1", "Voice 1 level", 0, 1, 0.6f), fp ("p1", "Voice 1 pan", -1, 1, -0.5f, 0),
                                                         cp ("v2", "Voice 2", harmonyChoices(), 8), fp ("l2", "Voice 2 level", 0, 1, 0.5f), fp ("p2", "Voice 2 pan", -1, 1, 0.5f, 0),
                                                         fp ("sp", "Spread", 0, 30, 8, 0, "cents"), fp ("mx", "Harmony level", 0, 1, 0.5f))) {}
    void prepareToPlay (double sr, int) override { for (auto& c : core) c.prepare (sr); }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        if (b.getNumChannels() < 2) return;
        PitchCore::Params pr[2]; float gl[2], gr[2];
        for (int v = 0; v < 2; ++v)
        {
            const auto idx = (int) p (v ? "v2" : "v1"); const auto choice = harmonyChoices()[idx];
            pr[v].tune = false; pr[v].shiftSemis = (float) choice.trimCharactersAtStart ("+").getIntValue(); pr[v].detuneCents = (v ? 1.0f : -1.0f) * p ("sp");
            float l, r; equalPower (p (v ? "p2" : "p1"), l, r); const float lvl = idx == 0 ? 0.0f : p (v ? "l2" : "l1") * p ("mx");
            gl[v] = l * lvl; gr[v] = r * lvl;
        }
        auto* L = b.getWritePointer (0); auto* R = b.getWritePointer (1);
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            const float m = (L[i] + R[i]) * 0.5f;
            for (int v = 0; v < 2; ++v) { const float y = core[v].process (m, pr[v]); L[i] += y * gl[v]; R[i] += y * gr[v]; }
        }
    }
private:
    PitchCore core[2];
};

class DeEsserFx : public BuiltIn
{
public:
    DeEsserFx() : BuiltIn ("Rose De-esser", layout (fp ("fq", "Frequency", 3000, 12000, 6500, 6500, "Hz"), fp ("th", "Threshold", -60, 0, -30, -30, "dB"),
                                                    fp ("am", "Max reduction", 0, 24, 12, 0, "dB"), bp ("li", "Listen to S", false))) {}
    void prepareToPlay (double sr, int bs) override
    {
        rate = sr;
        lo.prepare (spec (sr, bs)); hi.prepare (spec (sr, bs));
        lo.setType (juce::dsp::LinkwitzRileyFilterType::lowpass); hi.setType (juce::dsp::LinkwitzRileyFilterType::highpass);
        env = 0; gain = 1;
    }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        lo.setCutoffFrequency (p ("fq")); hi.setCutoffFrequency (p ("fq"));
        const float th = p ("th"), am = p ("am"); const bool listen = p ("li") > 0.5f; const int nc = juce::jmin (2, b.getNumChannels());
        const float a = std::exp (-1.0f / (float) (rate * 0.001)), r = std::exp (-1.0f / (float) (rate * 0.06)); float maxRed = 0;
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            float l[2], h[2], pk = 0;
            for (int c = 0; c < nc; ++c) { const float x = b.getSample (c, i); l[c] = lo.processSample (c, x); h[c] = hi.processSample (c, x); pk = juce::jmax (pk, std::abs (h[c])); }
            env = pk > env ? a * env + (1 - a) * pk : r * env + (1 - r) * pk;
            const float over = juce::Decibels::gainToDecibels (env, -100.0f) - th, red = juce::jlimit (0.0f, am, over * 0.8f);
            gain = juce::Decibels::decibelsToGain (-red); maxRed = juce::jmax (maxRed, red);
            for (int c = 0; c < nc; ++c) b.setSample (c, i, (listen ? 0.0f : l[c]) + h[c] * gain);
        }
        reduction.store (maxRed);
    }
    std::atomic<float> reduction { 0 };
private:
    juce::dsp::LinkwitzRileyFilter<float> lo, hi; double rate = 44100; float env = 0, gain = 1;
};

class DoublerFx : public BuiltIn
{
public:
    DoublerFx() : BuiltIn ("Rose Vocal Doubler", layout (fp ("wi", "Width", 0, 1, 0.8f), fp ("dl", "Delay", 5, 40, 18, 18, "ms"), fp ("dt", "Detune", 0, 25, 9, 0, "cents"),
                                                         fp ("mx", "Double level", 0, 1, 0.45f))) {}
    void prepareToPlay (double sr, int bs) override
    {
        rate = sr;
        for (int s = 0; s < 2; ++s) { core[s].prepare (sr); line[s].prepare ({ sr, (juce::uint32) bs, 1 }); line[s].setMaximumDelayInSamples ((int) (sr * 0.1)); line[s].reset(); lfo[s] = 0; }
    }
    void processBlock (juce::AudioBuffer<float>& b, juce::MidiBuffer&) override
    {
        if (b.getNumChannels() < 2) return;
        const float wi = p ("wi"), mx = p ("mx"), dl = p ("dl") / 1000.0f; PitchCore::Params pr[2];
        for (int s = 0; s < 2; ++s) { pr[s].tune = false; pr[s].detuneCents = (s ? -1.0f : 1.0f) * p ("dt"); }
        float gl[2], gr[2]; for (int s = 0; s < 2; ++s) { equalPower ((s ? 1.0f : -1.0f) * wi, gl[s], gr[s]); gl[s] *= mx; gr[s] *= mx; }
        const double rates[2] { 0.31, 0.23 }; const float base[2] { dl, dl * 1.37f };
        auto* L = b.getWritePointer (0); auto* R = b.getWritePointer (1);
        for (int i = 0; i < b.getNumSamples(); ++i)
        {
            const float m = (L[i] + R[i]) * 0.5f;
            for (int s = 0; s < 2; ++s)
            {
                lfo[s] += rates[s] / rate; lfo[s] -= std::floor (lfo[s]);
                const float d = (base[s] + 0.0015f * (float) std::sin (lfo[s] * juce::MathConstants<double>::twoPi)) * (float) rate;
                line[s].pushSample (0, core[s].process (m, pr[s]));
                const float y = line[s].popSample (0, juce::jmax (1.0f, d));
                L[i] += y * gl[s]; R[i] += y * gr[s];
            }
        }
    }
private:
    PitchCore core[2]; juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> line[2]; double lfo[2] {}, rate = 44100;
};
} // namespace rose
