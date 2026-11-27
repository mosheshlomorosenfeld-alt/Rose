// Rose Desktop — chord generator. A line-for-line port of js/chordgen.js so both apps make the same chords from the same settings.
#pragma once
#include <JuceHeader.h>

namespace rose::chordgen
{
inline const juce::StringArray& keys() { static const juce::StringArray k { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }; return k; }
inline const juce::StringArray& names() { static const juce::StringArray k { "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B" }; return k; }
struct Mode { const char* name; std::array<int, 7> steps; };
inline const std::vector<Mode>& modes()
{
    static const std::vector<Mode> m { { "Major", { 0, 2, 4, 5, 7, 9, 11 } }, { "Minor", { 0, 2, 3, 5, 7, 8, 10 } }, { "Harmonic minor", { 0, 2, 3, 5, 7, 8, 11 } },
        { "Freygish (Ahava Raba)", { 0, 1, 4, 5, 7, 8, 10 } }, { "Dorian", { 0, 2, 3, 5, 7, 9, 10 } }, { "Mixolydian", { 0, 2, 4, 5, 7, 9, 10 } } };
    return m;
}
struct Style { const char* name; std::vector<const char*> steps; };
inline const std::map<juce::String, std::vector<Style>>& styles()
{
    static const std::map<juce::String, std::vector<Style>> s {
        { "Major", { { "Pop anthem (I-V-vi-IV)", { "1", "5", "6", "4" } }, { "Emotional (vi-IV-I-V)", { "6", "4", "1", "5" } }, { "Doo-wop (I-vi-IV-V)", { "1", "6", "4", "5" } },
                     { "Festival EDM (IV-V-vi-vi)", { "4", "5", "6", "6" } }, { "Royal road (IV-V-iii-vi)", { "4", "5", "3", "6" } }, { "Gospel lift (I-iii-IV-iv)", { "1", "3", "4", "4m" } },
                     { "Neo-soul (ii-V-I-vi)", { "2", "5", "1", "6" } }, { "Rock (I-bVII-IV-I)", { "1", "b7", "4", "1" } }, { "Ballad (I-V-vi-iii-IV-I-IV-V)", { "1", "5", "6", "3", "4", "1", "4", "5" } } } },
        { "Minor", { { "Epic (i-VI-III-VII)", { "1", "6", "3", "7" } }, { "Dark trap (i-iv-VI-V)", { "1", "4", "6", "5M" } }, { "Andalusian (i-VII-VI-V)", { "1", "7", "6", "5M" } },
                     { "Sad pop (i-VI-VII-i)", { "1", "6", "7", "1" } }, { "Drill (i-VI-iv-V)", { "1", "6", "4", "5M" } }, { "Deep house (i-v-VI-iv)", { "1", "5", "6", "4" } }, { "R&B minor (i-iv-VII-III)", { "1", "4", "7", "3" } } } },
        { "Harmonic minor", { { "Cinematic (i-iv-V-i)", { "1", "4", "5", "1" } }, { "Tango (i-VI-V-i)", { "1", "6", "5", "1" } }, { "Mystic (i-ii-V-i)", { "1", "2", "5", "1" } } } },
        { "Freygish (Ahava Raba)", { { "Simcha (I-bII-I-iv)", { "1", "2", "1", "4" } }, { "Chassidic (I-iv-bII-I)", { "1", "4", "2", "1" } }, { "Klezmer (I-vii-bII-I)", { "1", "7", "2", "1" } }, { "Niggun (iv-I-bII-I)", { "4", "1", "2", "1" } } } },
        { "Dorian", { { "Funk (i-IV)", { "1", "4", "1", "4" } }, { "Santana (i-IV-i-VII)", { "1", "4", "1", "7" } } } },
        { "Mixolydian", { { "Anthem rock (I-bVII-IV-I)", { "1", "7", "4", "1" } }, { "Celtic (I-bVII-I-v)", { "1", "7", "1", "5m" } } } } };
    return s;
}
inline const juce::StringArray& extensions() { static const juce::StringArray e { "Triads", "7ths", "9ths", "Sus" }; return e; }
inline const juce::StringArray& voicings() { static const juce::StringArray v { "Close", "Open", "Drop 2", "Piano (two hands)", "Wide pad" }; return v; }
inline const juce::StringArray& rhythms() { static const juce::StringArray r { "Sustained", "Half notes", "Quarter pulse", "Eighth pulse", "Off-beat stabs (house)", "Charleston", "Dembow (3-3-2)", "Arp up", "Arp up-down", "Guitar strum", "Oom-pah (simcha)" }; return r; }
inline const juce::StringArray& basses() { static const juce::StringArray b { "Off", "Roots", "Driving eighths", "Octaves", "Root-fifth", "Walking" }; return b; }

struct Rng { uint32_t s; explicit Rng (uint32_t seed) : s (seed ? seed : 1) {} double next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s / 4294967296.0; } };

inline juce::String qualityOf (const std::vector<int>& iv)
{
    auto has = [&] (int x) { for (int v : iv) if (v % 12 == x) return true; return false; };
    const char third = has (4) ? 'M' : has (3) ? 'm' : has (5) ? '4' : has (2) ? '2' : 'M'; const int fifth = has (7) ? 7 : has (6) ? 6 : has (8) ? 8 : 7;
    const int sev = has (11) ? 11 : has (10) ? 10 : (has (9) && fifth == 6) ? 9 : 0; bool nine = false; for (int v : iv) nine |= v == 14;
    if (third == '4') return sev == 10 ? "7sus4" : "sus4"; if (third == '2') return "sus2";
    if (third == 'M') { if (fifth == 8) return "aug"; if (! sev) return ""; if (sev == 11) return nine ? "maj9" : "maj7"; return nine ? "9" : "7"; }
    if (fifth == 6) return sev == 9 ? "dim7" : sev == 10 ? "m7b5" : "dim";
    if (! sev) return "m"; if (sev == 11) return "mmaj7"; return nine ? "m9" : "m7";
}
struct Chord { int root = 0; std::vector<int> iv; juce::String name; };
inline bool buildChord (const juce::String& step, int key, const Mode& mode, const juce::String& ext, Chord& out)
{
    static const std::map<juce::String, std::vector<int>> Q { { "", { 0, 4, 7 } }, { "m", { 0, 3, 7 } }, { "dim", { 0, 3, 6 } }, { "aug", { 0, 4, 8 } }, { "7", { 0, 4, 7, 10 } }, { "maj7", { 0, 4, 7, 11 } },
        { "m7", { 0, 3, 7, 10 } }, { "sus2", { 0, 2, 7 } }, { "sus4", { 0, 5, 7 } } };
    const bool flat = step.startsWith ("b"); const auto body = flat ? step.substring (1) : step; if (body.isEmpty() || ! juce::CharacterFunctions::isDigit (body[0])) return false;
    const int deg = body[0] - '1'; const auto force = body.substring (1); const auto& sc = mode.steps;
    static const int major[7] { 0, 2, 4, 5, 7, 9, 11 };
    const int rootOff = flat ? (deg == 6 ? 10 : (major[deg] + 11) % 12) : sc[(size_t) deg];
    std::vector<int> iv;
    if (flat) iv = { 0, 4, 7 };
    else { const int n = ext == "9ths" ? 5 : ext == "7ths" ? 4 : 3; for (int k = 0; k < n; ++k) { const int d = deg + 2 * k; iv.push_back (sc[(size_t) (d % 7)] + (d / 7) * 12 - sc[(size_t) deg]); } }
    if (force.isNotEmpty()) { const auto f = force == "M" ? juce::String() : force; if (auto it = Q.find (f); it != Q.end()) iv = it->second; }
    if ((flat || force.isNotEmpty()) && iv.size() == 3 && iv[2] == 7) { if (ext == "7ths") iv.push_back (10); if (ext == "9ths") { iv.push_back (10); iv.push_back (14); } }
    if (ext == "Sus" && force.isEmpty() && iv.size() >= 3 && iv[2] == 7 && (deg == 0 || deg == 3 || deg == 4)) iv[1] = deg == 4 ? 5 : 2;
    out.root = (key + rootOff) % 12; out.iv = iv; out.name = names()[out.root] + qualityOf (iv); return true;
}
inline juce::StringArray surprise (const juce::String& mode, int len, uint32_t seed)
{
    Rng r (seed); const auto& st = styles().at (styles().count (mode) ? mode : "Major");
    juce::StringArray out;
    if (r.next() < 0.45 || mode.startsWith ("Freygish")) { for (auto* s : st[(size_t) (r.next() * st.size())].steps) out.add (s); return out; }
    static const std::map<int, std::vector<int>> next { { 1, { 4, 5, 6, 2, 3, 7 } }, { 2, { 5, 7, 4 } }, { 3, { 6, 4, 2 } }, { 4, { 5, 1, 2, 6 } }, { 5, { 1, 6, 4 } }, { 6, { 4, 2, 5, 3 } }, { 7, { 1, 3, 6 } } };
    out.add ("1");
    while (out.size() < len) { const auto& o = next.at (out[out.size() - 1].getIntValue()); int n = o[(size_t) (std::pow (r.next(), 1.6) * o.size())]; if (out.size() == len - 1 && r.next() < 0.6) n = r.next() < 0.5 ? 4 : 5; out.add (juce::String (n)); }
    return out;
}
inline std::vector<int> voice (const Chord& ch, const std::vector<int>* prev, const juce::String& style, int center)
{
    std::vector<int> pcs; for (int x : ch.iv) pcs.push_back (ch.root + x);
    std::vector<std::vector<int>> cands;
    for (size_t inv = 0; inv < pcs.size(); ++inv)
    {
        std::vector<int> v; for (size_t i = 0; i < pcs.size(); ++i) v.push_back (pcs[i] + (i < inv ? 12 : 0)); std::sort (v.begin(), v.end());
        for (int o = -2; o <= 2; ++o) { std::vector<int> w; for (int x : v) w.push_back (x + 12 * o + 48); if (w[0] >= center - 9 && w[0] <= center + 5) cands.push_back (w); }
    }
    auto cost = [&] (const std::vector<int>& w)
    {
        if (prev == nullptr) { double s = 0; for (int x : w) s += x; return std::abs (s / w.size() - center - 4); }
        double c = 0; for (int x : w) { int m = 999; for (int y : *prev) m = juce::jmin (m, std::abs (x - y)); c += m; } return c + std::abs (w[0] - center) * 0.05;
    };
    std::vector<int> best; double bc = 1e9; for (auto& w : cands) { const double c = cost (w); if (c < bc) { bc = c; best = w; } }
    if (best.empty()) for (int x : pcs) best.push_back (x + 48);
    if (style == "Open" && best.size() >= 3) { auto b = best; const int mid = b[1]; b.erase (b.begin() + 1); b.push_back (mid + 12); std::sort (b.begin(), b.end()); best = b; }
    if (style == "Drop 2" && best.size() >= 3) { const size_t i = best.size() - 2; const int x = best[i] - 12; best.erase (best.begin() + (long) i); best.push_back (x); std::sort (best.begin(), best.end()); }
    const int lh = 36 + ch.root - (ch.root > 7 ? 12 : 0) + 12;
    if (style == "Piano (two hands)") { std::vector<int> b { lh, lh + 7 }; for (int x : best) if (x > lh + 7) b.push_back (x); best = b; }
    if (style == "Wide pad") { std::vector<int> b { best[0] - 12 }; for (int x : best) b.push_back (x); b.push_back (best[1] + 12); std::sort (b.begin(), b.end()); b.erase (std::unique (b.begin(), b.end()), b.end()); best = b; }
    while (best[0] < center - 12) for (auto& x : best) x += 12;
    while (best.back() > center + 26) for (auto& x : best) x -= 12;
    return best;
}
struct Settings { int key = 0; juce::String mode { "Major" }; juce::StringArray steps; int bars = 4; double perBar = 1; juce::String ext { "Triads" }, voicing { "Close" }, rhythm { "Sustained" }, bass { "Off" }; bool lead = true; int octave = 0; double humanize = 0.3; uint32_t seed = 1; };
struct Ev { int p; double s, l; float v; };
struct Result { std::vector<std::pair<juce::String, double>> chords; std::vector<std::vector<int>> voicings; std::vector<Ev> notes, bass; double len = 0; };
inline Result generate (const Settings& o)
{
    Result res; const Mode* mode = &modes()[0]; for (auto& m : modes()) if (o.mode == m.name) mode = &m;
    const double beatsPer = 4.0 / o.perBar; const int n = juce::jmax (1, (int) std::lround (o.bars * o.perBar)); Rng r (o.seed * 7919u + 13u);
    std::vector<Chord> chords; for (int i = 0; i < n; ++i) { Chord c; if (o.steps.size() && buildChord (o.steps[i % o.steps.size()], o.key, *mode, o.ext, c)) chords.push_back (c); }
    const int center = 57 + 12 * o.octave; std::vector<int> prev; bool hasPrev = false;
    auto hum = [&] (double x, double a) { return x + (o.humanize > 0 ? (r.next() - 0.5) * a * o.humanize : 0.0); };
    for (size_t i = 0; i < chords.size(); ++i)
    {
        const auto& ch = chords[i]; auto v = voice (ch, hasPrev && o.lead ? &prev : nullptr, o.voicing, center); prev = v; hasPrev = true;
        const double s = (double) i * beatsPer, L = beatsPer; res.chords.push_back ({ ch.name, s }); res.voicings.push_back (v);
        auto hit = [&] (double t, double len, double vel, const std::vector<int>& which) { if (t >= L - 1e-9) return; for (int p : which) res.notes.push_back ({ p, juce::jmax (0.0, hum (s + t, 0.03)), juce::jmin (len, L - t) * 0.98, (float) juce::jlimit (0.15, 1.0, hum (vel, 0.16)) }); };
        auto each = [&] (double step, auto fn) { int k = 0; for (double t = 0; t < L - 1e-9; t += step, ++k) fn (t, k); };
        const auto& rh = o.rhythm;
        if (rh == "Half notes") each (2, [&] (double t, int) { hit (t, 2, 0.72, v); });
        else if (rh == "Quarter pulse") each (1, [&] (double t, int k) { hit (t, 0.9, k % 2 ? 0.62 : 0.75, v); });
        else if (rh == "Eighth pulse") each (0.5, [&] (double t, int k) { hit (t, 0.42, k % 2 ? 0.55 : 0.75, v); });
        else if (rh == "Off-beat stabs (house)") each (1, [&] (double t, int) { hit (t + 0.5, 0.3, 0.8, v); });
        else if (rh == "Charleston") each (4, [&] (double t, int) { hit (t, 0.6, 0.8, v); hit (t + 1.5, 0.45, 0.7, v); });
        else if (rh == "Dembow (3-3-2)") each (4, [&] (double t, int) { const double xs[] { 0, 0.75, 1.5, 2, 2.75, 3.5 }; for (int k = 0; k < 6; ++k) hit (t + xs[k], 0.3, k % 3 ? 0.62 : 0.8, v); });
        else if (rh == "Arp up" || rh == "Arp up-down")
        {
            auto seq = v; seq.push_back (v[0] + 12); auto pat = seq; if (rh == "Arp up-down") for (int k = (int) seq.size() - 2; k >= 1; --k) pat.push_back (seq[(size_t) k]);
            each (0.5, [&] (double t, int k) { res.notes.push_back ({ pat[(size_t) k % pat.size()], hum (s + t, 0.02), 0.45, (float) juce::jmax (0.2, hum (k % 2 ? 0.6 : 0.75, 0.14)) }); });
        }
        else if (rh == "Guitar strum")
            each (4, [&] (double t, int) { const double pat[6][3] { { 0, 1, 0.8 }, { 1, 1, 0.7 }, { 1.5, -1, 0.55 }, { 2.5, -1, 0.6 }, { 3, 1, 0.7 }, { 3.5, -1, 0.55 } };
                for (auto& p : pat) { auto ord = v; if (p[1] < 0) std::reverse (ord.begin(), ord.end()); for (size_t k = 0; k < ord.size(); ++k) if (t + p[0] < L) res.notes.push_back ({ ord[k], s + t + p[0] + (double) k * 0.02, juce::jmin (0.5, L - t - p[0]) * 0.95, (float) hum (p[2], 0.1) }); } });
        else if (rh == "Oom-pah (simcha)") each (2, [&] (double t, int) { hit (t + 1, 0.4, 0.72, v); });
        else hit (0, L, 0.72, v);
        const int b0 = 36 + ch.root - (ch.root > 7 ? 12 : 0), b5 = b0 + 7, nextRoot = i + 1 < chords.size() ? 36 + chords[i + 1].root - (chords[i + 1].root > 7 ? 12 : 0) : b0;
        auto bn = [&] (int p, double t, double len, float vel) { if (t < L - 1e-9) res.bass.push_back ({ p, s + t, juce::jmin (len, L - t) * 0.95, vel }); };
        const auto& bs = o.bass;
        if (bs == "Roots") bn (b0, 0, L, 0.85f);
        else if (bs == "Driving eighths") each (0.5, [&] (double t, int k) { bn (b0, t, 0.45, k % 2 ? 0.7f : 0.85f); });
        else if (bs == "Octaves") each (0.5, [&] (double t, int k) { bn (k % 2 ? b0 + 12 : b0, t, 0.45, 0.8f); });
        else if (bs == "Root-fifth") each (2, [&] (double t, int k) { bn (k % 2 ? b5 : b0, t, 1.8, 0.82f); });
        else if (bs == "Walking") each (1, [&] (double t, int k) { const bool last = t + 1 >= L - 1e-9; const int seq[4] { b0, b0 + ch.iv[1], b5, b0 + ch.iv[1] }; bn (last ? nextRoot + (nextRoot > b0 ? -1 : 1) : seq[k % 4], t, 0.9, 0.8f); });
    }
    res.len = n * beatsPer; return res;
}
} // namespace rose::chordgen
