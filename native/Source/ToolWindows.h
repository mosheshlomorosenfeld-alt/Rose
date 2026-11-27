// Rose Desktop — floating tool windows: mixer, audio editor, step sequencer, tuner, spectrum, loudness, stereo scope,
// reference A/B, chord generator, tempo & time signature. Every panel is a plain Component hosted in a ToolWindow.
#pragma once
#include "Engine.h"
#include "Browser.h"
#include "ChordGen.h"

namespace rose
{
namespace col { const juce::Colour play (0xff4cc38a); }   // "in tune / on target" green
//============================================================================== window
class ToolWindow : public juce::DocumentWindow
{
public:
    ToolWindow (const juce::String& k, const juce::String& title, juce::Component* content, std::function<void (ToolWindow*)> onClose, bool resizable = true)
        : DocumentWindow (title, col::panel, DocumentWindow::closeButton), key (k), closed (std::move (onClose))
    {
        setContentOwned (content, true); setUsingNativeTitleBar (true); setResizable (resizable, false);
        setAlwaysOnTop (true); centreWithSize (getWidth(), getHeight()); setVisible (true);
    }
    void closeButtonPressed() override { closed (this); }
    const juce::String key;
private:
    std::function<void (ToolWindow*)> closed;
};
struct Ticking { virtual ~Ticking() = default; virtual void tick() = 0; };   // panels refreshed 30 times a second

//============================================================================== analysis hub: everything the meters need, fed from the engine's master tap
struct AnalysisHub
{
    static constexpr int N = 1 << 15;
    std::vector<float> L = std::vector<float> (N), R = std::vector<float> (N), in = std::vector<float> (N); int w = 0, wi = 0; double sr = 44100;
    KWeight kw; double kwRate = 0; std::vector<double> blocks; float peak = 0; juce::AudioBuffer<float> scratch { 2, 8192 }; std::vector<float> inScratch;
    void pump (Engine& e)
    {
        sr = e.transport.sampleRate; if (kwRate != sr) { kw.prepare (sr); kwRate = sr; }
        const int n = e.readTap (scratch); const float* l = scratch.getReadPointer (0); const float* r = scratch.getReadPointer (1);
        for (int i = 0; i < n; ++i) { L[(size_t) w] = l[i]; R[(size_t) w] = r[i]; w = (w + 1) % N; peak = juce::jmax (peak, std::abs (l[i]), std::abs (r[i])); }
        if (n > 0 && e.transport.playing.load()) kw.process (l, r, n, [&] (double ms) { blocks.push_back (ms); if (blocks.size() > 36000) blocks.erase (blocks.begin(), blocks.begin() + 6000); });
        const int m = e.readInput (inScratch); for (int i = 0; i < m; ++i) { in[(size_t) wi] = inScratch[(size_t) i]; wi = (wi + 1) % N; }
    }
    void latest (std::vector<float>& l, std::vector<float>& r, int n) const { l.resize ((size_t) n); r.resize ((size_t) n); for (int i = 0; i < n; ++i) { const int k = (w - n + i + N) % N; l[(size_t) i] = L[(size_t) k]; r[(size_t) i] = R[(size_t) k]; } }
    void latestInput (std::vector<float>& d, int n) const { d.resize ((size_t) n); for (int i = 0; i < n; ++i) d[(size_t) i] = in[(size_t) ((wi - n + i + N) % N)]; }
    double avg (size_t n) const { if (blocks.empty()) return -100; double s = 0; size_t k = 0; for (size_t i = blocks.size() > n ? blocks.size() - n : 0; i < blocks.size(); ++i, ++k) s += blocks[i]; return KWeight::lufs (s / (double) k); }
    double momentary() const { return avg (4); } double shortTerm() const { return avg (30); } double integrated() const { return KWeight::integrated (blocks); }
    void reset() { blocks.clear(); peak = 0; }
};
// YIN pitch detection (Hz, 0 = no clear pitch) on a mono buffer
inline double detectPitch (const std::vector<float>& d, double sr)
{
    const int N = (int) d.size() / 2; std::vector<float> x ((size_t) N); for (int i = 0; i < N; ++i) x[(size_t) i] = (d[(size_t) (2 * i)] + d[(size_t) (2 * i + 1)]) * 0.5f;
    const double fs = sr / 2; const int W = 1024, tmax = juce::jmin ((int) (fs / 50), N - W - 1), tmin = (int) (fs / 1500); if (tmax <= tmin) return 0;
    double rms = 0; for (int i = 0; i < W; ++i) rms += x[(size_t) i] * x[(size_t) i]; if (std::sqrt (rms / W) < 0.004) return 0;
    std::vector<double> dd ((size_t) tmax + 2, 1.0); double run = 0;
    for (int t = 1; t <= tmax; ++t)
    {
        double s = 0; for (int i = 0; i < W; ++i) { const double a = x[(size_t) i] - x[(size_t) (i + t)]; s += a * a; }
        run += s; dd[(size_t) t] = run > 0 ? s * t / run : 1;
        if (t > tmin + 1 && dd[(size_t) t - 1] < 0.12 && dd[(size_t) t] > dd[(size_t) t - 1]) { const int b = t - 1; const double a = dd[(size_t) b - 1], c = dd[(size_t) b + 1], den = a - 2 * dd[(size_t) b] + c; return fs / (den != 0 ? b + 0.5 * (a - c) / den : b); }
    }
    return 0;
}
inline juce::String noteName (int midi) { static const juce::StringArray n { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }; return n[(midi % 12 + 12) % 12] + juce::String (midi / 12 - 1); }

//============================================================================== tuner
class TunerPanel : public juce::Component, public Ticking
{
public:
    explicit TunerPanel (AnalysisHub& h) : hub (h)
    {
        addAndMakeVisible (src); src.addItem ("Audio input", 1); src.addItem ("Master output", 2); src.setSelectedId (1, juce::dontSendNotification);
        addAndMakeVisible (ref); ref.setRange (415, 466, 1); ref.setValue (440); ref.setTextValueSuffix (" Hz"); ref.setSliderStyle (juce::Slider::IncDecButtons); ref.setTextBoxStyle (juce::Slider::TextBoxLeft, false, 60, 24);
        setSize (340, 250);
    }
    void resized() override { auto r = getLocalBounds().reduced (12).removeFromBottom (28); src.setBounds (r.removeFromLeft (160)); r.removeFromLeft (8); ref.setBounds (r); }
    void tick() override
    {
        std::vector<float> d; if (src.getSelectedId() == 1) hub.latestInput (d, 4096); else { std::vector<float> r; hub.latest (d, r, 4096); for (size_t i = 0; i < d.size(); ++i) d[i] = (d[i] + r[i]) * 0.5f; }
        const double hz = detectPitch (d, hub.sr);
        if (hz <= 0) { hasPitch = false; repaint(); return; }
        const double m = 69 + 12 * std::log2 (hz / ref.getValue()); const int n = (int) std::lround (m); const double c = (m - n) * 100;
        cents = hasPitch ? cents * 0.6 + c * 0.4 : c; note = noteName (n); freq = hz; hasPitch = true; repaint();
    }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); auto r = getLocalBounds().reduced (12); g.setColour (col::ink);
        g.setFont (juce::FontOptions (56.0f, juce::Font::bold)); g.drawText (hasPitch ? note : "-", r.removeFromTop (70), juce::Justification::centred);
        auto meter = r.removeFromTop (44).reduced (10, 4); const float cx = (float) meter.getCentreX(), sc = meter.getWidth() / 100.0f;
        g.setColour (col::line); for (int k = -50; k <= 50; k += 10) g.fillRect (cx + k * sc, (float) meter.getY() + (k % 50 ? 18 : 8), 1.0f, k % 50 ? 18.0f : 30.0f);
        g.setColour (col::play); g.fillRect (cx - 1, (float) meter.getY(), 2.0f, (float) meter.getHeight());
        if (hasPitch) { g.setColour (std::abs (cents) < 4 ? col::play : col::rose); g.fillRect (cx + (float) juce::jlimit (-50.0, 50.0, cents) * sc - 3, (float) meter.getY(), 6.0f, (float) meter.getHeight()); }
        g.setColour (col::mute); g.setFont (13.0f);
        g.drawText (hasPitch ? juce::String (freq, 1) + " Hz   " + (cents >= 0 ? "+" : "-") + juce::String (std::abs (cents), 0) + " cents" + (std::abs (cents) < 4 ? "   in tune" : cents > 0 ? "   sharp" : "   flat") : "Play or sing a single note",
                    r.removeFromTop (24), juce::Justification::centred);
    }
private:
    AnalysisHub& hub; juce::ComboBox src; juce::Slider ref; bool hasPitch = false; double cents = 0, freq = 0; juce::String note;
};

//============================================================================== spectrum
class SpectrumPanel : public juce::Component, public Ticking
{
public:
    explicit SpectrumPanel (AnalysisHub& h) : hub (h), fft (13), window ((size_t) (1 << 13), juce::dsp::WindowingFunction<float>::hann) { setSize (780, 340); }
    void tick() override
    {
        std::vector<float> l, r; hub.latest (l, r, 1 << 13); std::vector<float> data ((size_t) (1 << 14), 0.0f);
        for (size_t i = 0; i < l.size(); ++i) data[i] = (l[i] + r[i]) * 0.5f;
        window.multiplyWithWindowingTable (data.data(), (size_t) (1 << 13)); fft.performFrequencyOnlyForwardTransform (data.data());
        if (spec.size() != 4096) { spec.assign (4096, -120.0f); hold.assign (4096, -120.0f); holdT.assign (4096, 0); }
        const double now = juce::Time::getMillisecondCounterHiRes();
        for (size_t i = 0; i < 4096; ++i)
        {
            const float db = juce::Decibels::gainToDecibels (data[i] / 2048.0f, -120.0f); spec[i] = spec[i] * 0.6f + db * 0.4f;
            if (spec[i] > hold[i]) { hold[i] = spec[i]; holdT[i] = now; } else if (now - holdT[i] > 2000) hold[i] = juce::jmax (spec[i], hold[i] - 0.6f);
        }
        repaint();
    }
    void mouseMove (const juce::MouseEvent& e) override { hoverX = e.x; }
    void mouseExit (const juce::MouseEvent&) override { hoverX = -1; }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::bg); auto area = getLocalBounds().reduced (10).toFloat(); const float W = area.getWidth(), H = area.getHeight() - 20;
        auto fx = [&] (double f) { return area.getX() + (float) (std::log (f / 20.0) / std::log (1000.0)) * W; }; auto dy = [&] (float v) { return area.getY() + (1 - (juce::jlimit (-90.0f, 0.0f, v) + 90) / 90) * H; };
        g.setFont (11.0f);
        for (double f : { 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0 }) { g.setColour (col::line); g.drawVerticalLine ((int) fx (f), area.getY(), area.getY() + H); g.setColour (col::mute); g.drawText (f >= 1000 ? juce::String (f / 1000) + "k" : juce::String ((int) f), (int) fx (f) + 3, (int) (area.getY() + H), 40, 16, juce::Justification::left); }
        for (int v = -12; v > -90; v -= 12) { g.setColour (col::line); g.drawHorizontalLine ((int) dy ((float) v), area.getX(), area.getRight()); g.setColour (col::mute); g.drawText (juce::String (v) + " dB", (int) area.getX() + 3, (int) dy ((float) v) - 14, 50, 12, juce::Justification::left); }
        if (spec.empty()) return; const double binHz = hub.sr / (1 << 13);
        juce::Path p, hp; bool started = false;
        for (size_t i = 1; i < 4096; ++i) { const double f = i * binHz; if (f < 20 || f > 20000) continue; const float x = fx (f);
            if (! started) { p.startNewSubPath (x, area.getY() + H); p.lineTo (x, dy (spec[i])); hp.startNewSubPath (x, dy (hold[i])); started = true; } else { p.lineTo (x, dy (spec[i])); hp.lineTo (x, dy (hold[i])); } }
        juce::Path fill (p); fill.lineTo (area.getRight(), area.getY() + H); fill.closeSubPath();
        g.setColour (col::rose.withAlpha (0.25f)); g.fillPath (fill); g.setColour (col::rose); g.strokePath (p, juce::PathStrokeType (1.4f)); g.setColour (col::ink.withAlpha (0.5f)); g.strokePath (hp, juce::PathStrokeType (1.0f));
        if (hoverX >= area.getX())
        {
            const double f = 20 * std::pow (1000.0, (hoverX - area.getX()) / W); const int n = (int) std::lround (69 + 12 * std::log2 (f / 440)); const size_t bin = (size_t) juce::jlimit (1, 4095, (int) std::lround (f / binHz));
            g.setColour (col::ink); g.drawVerticalLine (hoverX, area.getY(), area.getY() + H);
            g.drawText ((f < 1000 ? juce::String (f, 0) + " Hz" : juce::String (f / 1000, 2) + " kHz") + "  " + noteName (n) + "  " + juce::String (spec[bin], 1) + " dB", (int) area.getRight() - 230, (int) area.getY(), 226, 16, juce::Justification::right);
        }
    }
private:
    AnalysisHub& hub; juce::dsp::FFT fft; juce::dsp::WindowingFunction<float> window; std::vector<float> spec, hold; std::vector<double> holdT; int hoverX = -1;
};

//============================================================================== loudness
class LoudnessPanel : public juce::Component, public Ticking
{
public:
    LoudnessPanel (AnalysisHub& h, Engine& e) : hub (h), engine (e)
    {
        addAndMakeVisible (reset); reset.onClick = [this] { hub.reset(); hist.clear(); };
        addAndMakeVisible (song); song.onClick = [this] { measureSong(); };
        addAndMakeVisible (target); target.addItem ("Streaming (-14)", 14); target.addItem ("Club / EDM (-9)", 9); target.addItem ("Podcast (-16)", 16); target.addItem ("Broadcast (-23)", 23); target.setSelectedId (14, juce::dontSendNotification);
        addAndMakeVisible (note); note.setColour (juce::Label::textColourId, col::mute); note.setFont (12.0f); note.setJustificationType (juce::Justification::topLeft);
        note.setText ("Measures the master while you play. Spotify, Apple Music and YouTube turn songs down to about -14 LUFS.", juce::dontSendNotification);
        hub.reset(); setSize (480, 300);
    }
    void resized() override
    {
        auto r = getLocalBounds().reduced (12); r.removeFromTop (70); r.removeFromTop (100);
        auto row = r.removeFromTop (28); reset.setBounds (row.removeFromLeft (70)); row.removeFromLeft (6); song.setBounds (row.removeFromLeft (150)); row.removeFromLeft (6); target.setBounds (row.removeFromLeft (150));
        r.removeFromTop (6); note.setBounds (r);
    }
    void tick() override { if (engine.transport.playing.load()) { hist.push_back ((float) hub.shortTerm()); if (hist.size() > 456) hist.erase (hist.begin()); } repaint(); }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); auto r = getLocalBounds().reduced (12); auto boxes = r.removeFromTop (62); const int bw = (boxes.getWidth() - 18) / 4;
        const double vals[] { hub.momentary(), hub.shortTerm(), hub.integrated(), juce::Decibels::gainToDecibels ((double) hub.peak, -100.0) };
        const char* labels[] { "Momentary", "Short-term", "Integrated", "Peak" };
        for (int i = 0; i < 4; ++i)
        {
            auto b = boxes.removeFromLeft (bw); boxes.removeFromLeft (6); g.setColour (col::bg); g.fillRoundedRectangle (b.toFloat(), 3);
            g.setColour (col::mute); g.setFont (11.0f); g.drawText (labels[i], b.reduced (8, 4).removeFromTop (14), juce::Justification::left);
            g.setColour (i == 3 && vals[i] > -1 ? juce::Colour (0xffe5484d) : col::ink); g.setFont (juce::FontOptions (24.0f, juce::Font::bold));
            g.drawText (vals[i] > -99 ? juce::String (vals[i], 1) : juce::String ("-"), b.reduced (8, 4).withTrimmedTop (16), juce::Justification::left);
        }
        r.removeFromTop (8); auto plot = r.removeFromTop (92).toFloat(); g.setColour (col::bg); g.fillRoundedRectangle (plot, 3);
        auto y = [&] (double v) { return plot.getBottom() - (float) ((juce::jlimit (-40.0, 0.0, v) + 40) / 40) * plot.getHeight(); };
        g.setColour (col::play.withAlpha (0.4f)); g.fillRect (plot.getX(), y (-target.getSelectedId()) - 1, plot.getWidth(), 2.0f);
        juce::Path p; for (size_t i = 0; i < hist.size(); ++i) { const float x = plot.getX() + (float) i; if (i == 0) p.startNewSubPath (x, y (hist[i])); else p.lineTo (x, y (hist[i])); }
        g.setColour (col::rose); g.strokePath (p, juce::PathStrokeType (1.2f));
    }
private:
    void measureSong()
    {
        note.setText ("Rendering the song...", juce::dontSendNotification);
        auto f = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("rose-measure.wav");
        if (! engine.bounce (f, {})) { note.setText ("Couldn't render the song.", juce::dontSendNotification); return; }
        juce::AudioFormatManager fm; fm.registerBasicFormats(); std::unique_ptr<juce::AudioFormatReader> rd (fm.createReaderFor (f)); if (rd == nullptr) return;
        juce::AudioBuffer<float> b ((int) rd->numChannels, (int) rd->lengthInSamples); rd->read (&b, 0, b.getNumSamples(), 0, true, true);
        const auto m = measureLoudness (b, rd->sampleRate); const double tg = -target.getSelectedId(); f.deleteFile();
        note.setText ("Whole song: " + juce::String (m.integrated, 1) + " LUFS integrated, peak " + juce::String (m.peakDb, 1) + " dBFS. "
                      + (std::abs (m.integrated - tg) < 1 ? juce::String ("Right on target.") : m.integrated > tg ? juce::String (m.integrated - tg, 1) + " dB louder than the target - streaming services will turn it down."
                                                                                                   : juce::String (tg - m.integrated, 1) + " dB quieter than the target - raise the master limiter's gain."), juce::dontSendNotification);
    }
    AnalysisHub& hub; Engine& engine; juce::TextButton reset { "Reset" }, song { "Measure whole song" }; juce::ComboBox target; juce::Label note; std::vector<float> hist;
};

//============================================================================== stereo scope
class ScopePanel : public juce::Component, public Ticking
{
public:
    explicit ScopePanel (AnalysisHub& h) : hub (h) { setSize (520, 300); }
    void tick() override
    {
        hub.latest (l, r, 2048); double lr = 0, ll = 0, rr = 0; for (size_t i = 0; i < l.size(); ++i) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
        const double c = ll > 0 && rr > 0 ? lr / std::sqrt (ll * rr) : 0, b = ll + rr > 0 ? (std::sqrt (rr) - std::sqrt (ll)) / (std::sqrt (rr) + std::sqrt (ll)) : 0;
        corr = corr * 0.85 + c * 0.15; bal = bal * 0.85 + b * 0.15; repaint();
    }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); auto sq = juce::Rectangle<float> (12, 12, 270, 270); g.setColour (col::bg); g.fillRoundedRectangle (sq, 3);
        g.setColour (col::line); g.drawLine (sq.getCentreX(), sq.getY(), sq.getCentreX(), sq.getBottom()); g.drawLine (sq.getX(), sq.getCentreY(), sq.getRight(), sq.getCentreY());
        g.drawLine (sq.getX(), sq.getY(), sq.getRight(), sq.getBottom()); g.drawLine (sq.getRight(), sq.getY(), sq.getX(), sq.getBottom());
        g.setColour (col::rose.withAlpha (0.55f)); const float h = sq.getWidth() / 2;
        for (size_t i = 0; i < l.size(); ++i) { const float m = (l[i] + r[i]) * 0.7071f, s = (r[i] - l[i]) * 0.7071f; g.fillRect (sq.getCentreX() + s * h * 1.3f, sq.getCentreY() - m * h * 1.3f, 1.5f, 1.5f); }
        auto meter = [&] (int y, const juce::String& label, double v, juce::Colour c, const juce::String& txt)
        {
            g.setColour (col::mute); g.setFont (11.0f); g.drawText (label, 300, y, 200, 14, juce::Justification::left);
            auto bar = juce::Rectangle<float> (300, (float) y + 18, 200, 10); g.setColour (col::bg); g.fillRect (bar); g.setColour (col::line); g.fillRect (bar.getCentreX(), bar.getY() - 3, 1.0f, 16.0f);
            g.setColour (c); g.fillRect (bar.getCentreX() + (float) v * 98 - 3, bar.getY() - 2, 6.0f, 14.0f); g.setColour (col::ink); g.setFont (13.0f); g.drawText (txt, 300, y + 32, 200, 16, juce::Justification::left);
        };
        meter (20, "Correlation", corr, corr < 0 ? juce::Colour (0xffe5484d) : col::play, (corr >= 0 ? "+" : "") + juce::String (corr, 2));
        meter (90, "Balance L/R", bal, col::rose, std::abs (bal) < 0.02 ? juce::String ("Centre") : (bal < 0 ? "L " : "R ") + juce::String (juce::roundToInt (std::abs (bal) * 100)) + "%");
        g.setColour (col::mute); g.setFont (12.0f); g.drawFittedText ("+1 = mono-safe, 0 = wide, below 0 = phase problems that vanish on phones and club systems.", 300, 160, 200, 60, juce::Justification::topLeft, 4);
    }
private:
    AnalysisHub& hub; std::vector<float> l, r; double corr = 0, bal = 0;
};

//============================================================================== reference A/B
class ReferencePanel : public juce::Component
{
public:
    explicit ReferencePanel (Engine& e) : engine (e)
    {
        for (auto* b : { &a, &bB }) { addAndMakeVisible (b); b->setClickingTogglesState (true); b->setRadioGroupId (91); }
        a.onClick = [this] { engine.refOn = bB.getToggleState(); }; bB.onClick = a.onClick;
        addAndMakeVisible (level); level.setRange (-24, 6, 0.1); level.setTextValueSuffix (" dB"); level.setDoubleClickReturnValue (true, 0); level.onValueChange = [this] { engine.refGainDb = (float) level.getValue(); };
        addAndMakeVisible (offset); offset.setRange (0, 600, 0.1); offset.setTextValueSuffix (" s"); offset.setDoubleClickReturnValue (true, 0); offset.onValueChange = [this] { engine.refOffsetSec = offset.getValue(); };
        for (auto* l : { &lLevel, &lOffset, &info }) { addAndMakeVisible (l); l->setColour (juce::Label::textColourId, col::mute); l->setFont (12.0f); }
        lLevel.setText ("Reference level", juce::dontSendNotification); lOffset.setText ("Start offset", juce::dontSendNotification);
        addAndMakeVisible (load); load.onClick = [this] { choose(); };
        addAndMakeVisible (match); match.onClick = [this] { matchLoudness(); };
        addAndMakeVisible (remove); remove.onClick = [this] { engine.clearReference(); refresh(); };
        refresh(); setSize (440, 250);
    }
    void refresh()
    {
        const bool has = engine.hasReference(); for (auto* c : std::initializer_list<juce::Component*> { &a, &bB, &level, &offset, &match, &remove, &lLevel, &lOffset }) c->setEnabled (has);
        bB.setButtonText ("B  " + (has ? engine.referenceFile.getFileNameWithoutExtension() : juce::String ("reference"))); bB.setToggleState (engine.refOn.load(), juce::dontSendNotification); a.setToggleState (! engine.refOn.load(), juce::dontSendNotification);
        level.setValue (engine.refGainDb.load(), juce::dontSendNotification); offset.setValue (engine.refOffsetSec.load(), juce::dontSendNotification);
        info.setText (has ? "Press Shift+B to flip between your mix (A) and the reference (B) while the song plays. Reference: " + juce::String (engine.referenceLufs, 1) + " LUFS. It never goes into your bounce."
                          : "Load a finished song you love to compare against yours, in sync with the playhead.", juce::dontSendNotification);
    }
    void resized() override
    {
        auto r = getLocalBounds().reduced (12); auto ab = r.removeFromTop (40); a.setBounds (ab.removeFromLeft (ab.getWidth() / 2 - 3)); ab.removeFromLeft (6); bB.setBounds (ab); r.removeFromTop (8);
        auto row = r.removeFromTop (26); lLevel.setBounds (row.removeFromLeft (110)); level.setBounds (row); r.removeFromTop (4);
        row = r.removeFromTop (26); lOffset.setBounds (row.removeFromLeft (110)); offset.setBounds (row); r.removeFromTop (8);
        row = r.removeFromTop (28); load.setBounds (row.removeFromLeft (130)); row.removeFromLeft (6); match.setBounds (row.removeFromLeft (130)); row.removeFromLeft (6); remove.setBounds (row.removeFromLeft (80));
        r.removeFromTop (6); info.setBounds (r);
    }
    void paint (juce::Graphics& g) override { g.fillAll (col::panel); }
private:
    void choose()
    {
        chooser = std::make_unique<juce::FileChooser> ("Choose a reference track", juce::File(), "*.wav;*.aif;*.aiff;*.mp3;*.flac;*.ogg;*.m4a");
        chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles, [this] (const juce::FileChooser& fc)
        { if (fc.getResult().existsAsFile()) { if (! engine.loadReference (fc.getResult())) info.setText ("Couldn't read that file.", juce::dontSendNotification); refresh(); } });
    }
    void matchLoudness()
    {
        auto f = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("rose-match.wav"); if (! engine.bounce (f, {})) return;
        juce::AudioFormatManager fm; fm.registerBasicFormats(); std::unique_ptr<juce::AudioFormatReader> rd (fm.createReaderFor (f)); if (rd == nullptr) return;
        juce::AudioBuffer<float> b ((int) rd->numChannels, (int) rd->lengthInSamples); rd->read (&b, 0, b.getNumSamples(), 0, true, true); f.deleteFile();
        const double mix = measureLoudness (b, rd->sampleRate).integrated; engine.refGainDb = (float) juce::jlimit (-24.0, 6.0, mix - engine.referenceLufs); refresh();
        info.setText ("Mix " + juce::String (mix, 1) + " LUFS, reference " + juce::String (engine.referenceLufs, 1) + " LUFS - reference set to " + juce::String (engine.refGainDb.load(), 1) + " dB so you compare sound, not volume.", juce::dontSendNotification);
    }
    Engine& engine; juce::TextButton a { "A  Your mix" }, bB { "B  reference" }, load { "Load reference..." }, match { "Match loudness" }, remove { "Remove" };
    juce::Slider level { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight }, offset { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Label lLevel, lOffset, info; std::unique_ptr<juce::FileChooser> chooser;
};

//============================================================================== mixer
class MixerPanel : public juce::Component, public Ticking
{
public:
    MixerPanel (Engine& e, std::function<void (juce::AudioProcessor&)> openEd) : engine (e), openEditor (std::move (openEd)) { rebuild(); setSize (900, 460); }
    void rebuild()
    {
        strips.clear();
        for (int i = 0; i < (int) engine.tracks.size(); ++i) addAndMakeVisible (strips.add (new Strip (*this, i)));
        addAndMakeVisible (strips.add (new Strip (*this, -1))); count = (int) engine.tracks.size(); resized();
    }
    void resized() override { int x = 8; for (auto* s : strips) { const bool master = s->index < 0; s->setBounds (master ? getWidth() - 104 : x, 8, 96, getHeight() - 16); if (! master) x += 100; } }
    void paint (juce::Graphics& g) override { g.fillAll (col::bg); }
    void tick() override { if (count != (int) engine.tracks.size()) rebuild(); for (auto* s : strips) s->tick(); }
private:
    struct Strip : juce::Component, juce::DragAndDropTarget
    {
        Strip (MixerPanel& owner, int i) : mp (owner), index (i)
        {
            auto& e = mp.engine;
            addAndMakeVisible (vol); vol.setSliderStyle (juce::Slider::LinearVertical); vol.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 60, 18); vol.setRange (-60, 6, 0.1); vol.setDoubleClickReturnValue (true, 0); vol.setTextValueSuffix (" dB");
            addAndMakeVisible (pan); pan.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag); pan.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0); pan.setRange (-1, 1, 0.01); pan.setDoubleClickReturnValue (true, 0);
            addAndMakeVisible (m); addAndMakeVisible (s); addAndMakeVisible (fx); m.setClickingTogglesState (true); s.setClickingTogglesState (true);
            if (index >= 0)
            {
                auto& t = *e.tracks[(size_t) index]; vol.setValue (t.volDb, juce::dontSendNotification); pan.setValue (t.pan, juce::dontSendNotification); m.setToggleState (t.mute, juce::dontSendNotification); s.setToggleState (t.solo, juce::dontSendNotification);
                vol.onValueChange = [this] { auto& tt = *mp.engine.tracks[(size_t) index]; tt.volDb = (float) vol.getValue(); mp.engine.updateMix(); };
                pan.onValueChange = [this] { auto& tt = *mp.engine.tracks[(size_t) index]; tt.pan = (float) pan.getValue(); mp.engine.updateMix(); };
                m.onClick = [this] { mp.engine.tracks[(size_t) index]->mute = m.getToggleState(); mp.engine.updateMix(); };
                s.onClick = [this] { mp.engine.tracks[(size_t) index]->solo = s.getToggleState(); mp.engine.updateMix(); };
            }
            else
            {
                pan.setVisible (false); m.setVisible (false); s.setVisible (false);
                vol.setValue (dynamic_cast<StripProcessor*> (e.masterStrip->getProcessor())->gainDb.load(), juce::dontSendNotification);
                vol.onValueChange = [this] { dynamic_cast<StripProcessor*> (mp.engine.masterStrip->getProcessor())->gainDb = (float) vol.getValue(); };
            }
            fx.onClick = [this] { fxMenu(); };
            refreshInserts();
        }
        std::vector<Slot>& chain() { return index >= 0 ? mp.engine.tracks[(size_t) index]->inserts : mp.engine.masterInserts; }
        void refreshInserts()
        {
            inserts.clear(); auto& ch = chain();
            for (int k = 0; k < (int) ch.size(); ++k)
            {
                auto* b = inserts.add (new juce::TextButton (ch[(size_t) k].displayName().replace ("Rose ", ""))); addAndMakeVisible (b);
                b->setColour (juce::TextButton::buttonColourId, ch[(size_t) k].bypass ? col::bg : col::panel2); b->setTooltip ("Click to open, right-click to bypass or remove");
                b->onClick = [this, k]
                {
                    auto& c = chain(); if (! juce::isPositiveAndBelow (k, (int) c.size())) return;
                    if (juce::ModifierKeys::currentModifiers.isPopupMenu())
                    {
                        juce::PopupMenu menu; menu.addItem (1, c[(size_t) k].bypass ? "Turn on" : "Bypass"); menu.addItem (2, "Remove");
                        menu.showMenuAsync ({}, [this, k] (int r) { auto& cc = chain(); if (r == 1) { cc[(size_t) k].bypass = ! cc[(size_t) k].bypass; mp.engine.rewire(); } else if (r == 2) mp.engine.removeInsert (cc, k); refreshInserts(); });
                    }
                    else if (c[(size_t) k].node) mp.openEditor (*c[(size_t) k].node->getProcessor());
                };
            }
            resized();
        }
        void fxMenu()
        {
            juce::PopupMenu menu; int i = 1; menu.addItem (900, "Vocal chain (one click)"); menu.addSeparator();
            for (auto& b : builtIns()) { if (! b.instrument) menu.addItem (i, juce::String (b.name).replace ("Rose ", "")); ++i; }
            menu.showMenuAsync ({}, [this] (int r) { if (r == 900) addFxTo (mp.engine, chain(), "chain"); else if (r > 0) { int k = 1; for (auto& b : builtIns()) { if (! b.instrument && k++ == r) addFxTo (mp.engine, chain(), b.id); } } refreshInserts(); });
        }
        bool isInterestedInDragSource (const SourceDetails& d) override { return isRoseDrag (d, "fx:"); }
        void itemDragEnter (const SourceDetails&) override { hover = true; repaint(); }
        void itemDragExit (const SourceDetails&) override { hover = false; repaint(); }
        void itemDropped (const SourceDetails& d) override { hover = false; addFxTo (mp.engine, chain(), d.description.toString().fromFirstOccurrenceOf ("fx:", false, false)); refreshInserts(); }
        void tick() { if ((int) chain().size() != inserts.size()) refreshInserts(); repaint(); }
        void resized() override
        {
            auto r = getLocalBounds().reduced (4); r.removeFromTop (22);
            for (auto* b : inserts) { b->setBounds (r.removeFromTop (20)); r.removeFromTop (2); }
            fx.setBounds (r.removeFromTop (20)); r.removeFromTop (6);
            if (pan.isVisible()) pan.setBounds (r.removeFromTop (40).withSizeKeepingCentre (40, 40));
            auto bottom = r.removeFromBottom (22); if (m.isVisible()) { m.setBounds (bottom.removeFromLeft (bottom.getWidth() / 2 - 1)); s.setBounds (bottom.withTrimmedLeft (2)); }
            vol.setBounds (r.withTrimmedRight (14));
        }
        void paint (juce::Graphics& g) override
        {
            g.setColour (col::panel); g.fillRoundedRectangle (getLocalBounds().toFloat(), 4);
            const auto colour = index >= 0 ? mp.engine.tracks[(size_t) index]->colour : col::rose; g.setColour (colour); g.fillRect (4, 2, getWidth() - 8, 3);
            g.setColour (col::ink); g.setFont (juce::FontOptions (12.5f, juce::Font::bold)); g.drawText (index >= 0 ? mp.engine.tracks[(size_t) index]->name : juce::String ("Master"), 6, 6, getWidth() - 12, 16, juce::Justification::centred, true);
            const float pk = index >= 0 ? mp.engine.tracks[(size_t) index]->str()->peak.load() : dynamic_cast<StripProcessor*> (mp.engine.masterStrip->getProcessor())->peak.load();
            const float db = juce::Decibels::gainToDecibels (pk, -60.0f), f = juce::jlimit (0.0f, 1.0f, (db + 60) / 66); auto mr = vol.getBounds().withX (vol.getRight() + 3).withWidth (6).withTrimmedBottom (20);
            g.setColour (col::bg); g.fillRect (mr); g.setColour (db > -1 ? juce::Colour (0xffe5484d) : db > -9 ? juce::Colour (0xfff0a020) : juce::Colour (0xff22c55e));
            g.fillRect (mr.withTrimmedTop ((int) (mr.getHeight() * (1 - f))));
            if (hover) { g.setColour (col::rose); g.drawRoundedRectangle (getLocalBounds().toFloat().reduced (1), 4, 2); }
        }
        MixerPanel& mp; const int index; juce::Slider vol, pan; juce::TextButton m { "M" }, s { "S" }, fx { "+ FX" }; juce::OwnedArray<juce::TextButton> inserts; bool hover = false;
    };
    Engine& engine; std::function<void (juce::AudioProcessor&)> openEditor; juce::OwnedArray<Strip> strips; int count = -1;
};

//============================================================================== audio clip editor
class AudioEditorPanel : public juce::Component, public Ticking
{
public:
    AudioEditorPanel (Engine& e, int track, int clip) : engine (e), ti (track), ci (clip)
    {
        struct Row { juce::Slider* s; const char* label; double lo, hi, step; const char* suffix; };
        for (auto r : { Row { &gain, "Gain", -24, 12, 0.1, " dB" }, Row { &pitch, "Pitch", -24, 24, 1, " st" }, Row { &fine, "Fine pitch", -100, 100, 1, " cents" },
                        Row { &fadeIn, "Fade in", 0, 8, 0.0625, " beats" }, Row { &fadeOut, "Fade out", 0, 8, 0.0625, " beats" }, Row { &trim, "Trim start", 0, 60, 0.01, " s" } })
        {
            addAndMakeVisible (r.s); r.s->setRange (r.lo, r.hi, r.step); r.s->setTextValueSuffix (r.suffix); r.s->setSliderStyle (juce::Slider::LinearHorizontal); r.s->setTextBoxStyle (juce::Slider::TextBoxRight, false, 84, 20);
            r.s->setDoubleClickReturnValue (true, 0); auto* l = labels.add (new juce::Label ({}, r.label)); addAndMakeVisible (l); l->setColour (juce::Label::textColourId, col::mute); l->setFont (12.0f);
            r.s->onValueChange = [this] { write(); };
        }
        addAndMakeVisible (zoom); zoom.setRange (1, 16, 0.1); zoom.setValue (1); zoom.setSliderStyle (juce::Slider::LinearHorizontal); zoom.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0); zoom.onValueChange = [this] { repaint(); };
        addAndMakeVisible (normalize); normalize.onClick = [this] { doNormalize(); };
        read(); setSize (820, 420);
    }
    void tick() override { if (clip() == nullptr) return; repaint (wave); }
    void resized() override
    {
        auto r = getLocalBounds().reduced (10); wave = r.removeFromTop (180); auto zr = r.removeFromTop (22); zoom.setBounds (zr.removeFromRight (200)); r.removeFromTop (6);
        juce::Slider* ss[] { &gain, &pitch, &fine, &fadeIn, &fadeOut, &trim }; auto cols = r.removeFromTop (3 * 28);
        for (int i = 0; i < 6; ++i) { auto cell = juce::Rectangle<int> (cols.getX() + (i % 2) * cols.getWidth() / 2, cols.getY() + (i / 2) * 28, cols.getWidth() / 2 - 8, 26); labels[i]->setBounds (cell.removeFromLeft (80)); ss[i]->setBounds (cell); }
        r.removeFromTop (8); auto row = r.removeFromTop (28); normalize.setBounds (row.removeFromLeft (110));
    }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); auto* c = clip(); g.setColour (col::bg); g.fillRoundedRectangle (wave.toFloat(), 3);
        if (c == nullptr || ! c->data) { g.setColour (col::mute); g.drawText ("This clip is gone.", wave, juce::Justification::centred); return; }
        const auto& d = *c->data; const double secs = d.getNumSamples() / c->fileRate, view = secs / zoom.getValue(); const float mid = (float) wave.getCentreY(), amp = wave.getHeight() / 2.0f - 6;
        g.setColour (engine.tracks[(size_t) ti]->colour);
        for (int x = 0; x < wave.getWidth(); ++x)
        {
            const int s0 = (int) (x * view / wave.getWidth() * c->fileRate), s1 = juce::jmin (d.getNumSamples(), (int) ((x + 1) * view / wave.getWidth() * c->fileRate) + 1);
            float pk = 0; if (s1 > s0) pk = d.getMagnitude (0, s0, s1 - s0);
            const float a = pk * amp * juce::Decibels::decibelsToGain (c->gainDb); g.drawVerticalLine (wave.getX() + x, mid - a, mid + a + 1);
        }
        // the part the clip uses
        const double used0 = c->offsetSec, usedLen = c->srcBpm > 0 ? (c->loopLen > 0 ? c->loopLen : c->length) * 60.0 / c->srcBpm : engine.transport.secAt (c->start + c->length) - engine.transport.secAt (c->start);
        const float x0 = wave.getX() + (float) (used0 / view) * wave.getWidth(), x1 = wave.getX() + (float) ((used0 + usedLen) / view) * wave.getWidth();
        g.setColour (col::ink.withAlpha (0.08f)); g.fillRect (juce::Rectangle<float> (x0, (float) wave.getY(), juce::jmax (2.0f, x1 - x0), (float) wave.getHeight()));
        g.setColour (col::ink); g.drawVerticalLine ((int) x0, (float) wave.getY(), (float) wave.getBottom());
        g.setColour (col::mute); g.setFont (11.0f); g.drawText (juce::String (secs, 2) + " s source" + (c->srcBpm > 0 ? "   follows the song tempo (recorded at " + juce::String (c->srcBpm, 1) + " BPM)" : juce::String()), wave.reduced (6, 4), juce::Justification::topLeft);
    }
private:
    AudioClip* clip() { if (! juce::isPositiveAndBelow (ti, (int) engine.tracks.size())) return nullptr; auto& v = engine.tracks[(size_t) ti]->src()->audioClips; return juce::isPositiveAndBelow (ci, (int) v.size()) ? &v[(size_t) ci] : nullptr; }
    void read()
    {
        auto* c = clip(); if (c == nullptr) return; reading = true;
        gain.setValue (c->gainDb); pitch.setValue (std::trunc (c->pitch)); fine.setValue (std::round ((c->pitch - std::trunc (c->pitch)) * 100)); fadeIn.setValue (c->fadeIn); fadeOut.setValue (c->fadeOut);
        if (c->data) trim.setRange (0, juce::jmax (0.01, c->data->getNumSamples() / c->fileRate), 0.01); trim.setValue (c->offsetSec);
        reading = false;
    }
    void write()
    {
        if (reading) return; auto* s = engine.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock); auto* c = clip(); if (c == nullptr) return;
        c->gainDb = (float) gain.getValue(); c->pitch = (float) (pitch.getValue() + fine.getValue() / 100.0); c->fadeIn = fadeIn.getValue(); c->fadeOut = fadeOut.getValue(); c->offsetSec = trim.getValue();
    }
    void doNormalize()
    {
        auto* c = clip(); if (c == nullptr || ! c->data) return; const int s0 = (int) (c->offsetSec * c->fileRate), n = juce::jmax (1, juce::jmin (c->data->getNumSamples() - s0, (int) ((engine.transport.secAt (c->start + c->length) - engine.transport.secAt (c->start)) * c->fileRate)));
        float pk = 0; for (int ch = 0; ch < c->data->getNumChannels(); ++ch) pk = juce::jmax (pk, c->data->getMagnitude (ch, s0, n));
        if (pk > 0) gain.setValue (juce::Decibels::gainToDecibels (pk) * -1 - 0.3);
    }
    Engine& engine; const int ti, ci; juce::Slider gain, pitch, fine, fadeIn, fadeOut, trim, zoom; juce::OwnedArray<juce::Label> labels;
    juce::TextButton normalize { "Normalize" }; juce::Rectangle<int> wave; bool reading = false;
};

//============================================================================== step sequencer (drum clips)
class StepSeqPanel : public juce::Component, public Ticking
{
public:
    StepSeqPanel (Engine& e, int track, int clip) : engine (e), ti (track), ci (clip) { setSize (860, 330); }
    void tick() override { repaint(); }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); auto* c = clip(); if (c == nullptr) return; const int steps = juce::jmax (1, (int) std::lround (c->length * 4)); const float cw = (getWidth() - 120.0f) / steps;
        const double play = std::fmod (engine.transport.beatsAt (engine.transport.pos.load()) - c->start, c->length);
        for (int r = 0; r < (int) rows().size(); ++r)
        {
            const int y = 10 + r * 28; g.setColour (col::ink); g.setFont (12.0f); g.drawText (rows()[(size_t) r].second, 10, y, 100, 24, juce::Justification::left);
            for (int i = 0; i < steps; ++i)
            {
                const auto* n = find (*c, rows()[(size_t) r].first, i / 4.0); juce::Rectangle<float> cell (120 + i * cw + 1, (float) y, cw - 2, 24);
                g.setColour (n ? engine.tracks[(size_t) ti]->colour.withAlpha (n->vel < 0.85f ? 0.6f : 1.0f) : (i % 4 == 0 ? col::panel2 : col::bg)); g.fillRoundedRectangle (cell, 2);
                if (engine.transport.playing.load() && play >= i / 4.0 && play < (i + 1) / 4.0) { g.setColour (col::ink.withAlpha (0.25f)); g.drawRoundedRectangle (cell, 2, 1.5f); }
            }
        }
        g.setColour (col::mute); g.setFont (11.0f); g.drawText ("Click a step to toggle - Shift-click for an accent - click a name to hear it", 10, getHeight() - 20, getWidth() - 20, 16, juce::Justification::left);
    }
    void mouseDown (const juce::MouseEvent& e) override
    {
        auto* c = clip(); if (c == nullptr) return; const int r = (e.y - 10) / 28; if (! juce::isPositiveAndBelow (r, (int) rows().size())) return; const int p = rows()[(size_t) r].first;
        if (e.x < 120) { engine.keyboard.noteOn (1, p, 0.9f); engine.keyboard.noteOff (1, p, 0.0f); return; }
        const int steps = juce::jmax (1, (int) std::lround (c->length * 4)); const int i = (int) ((e.x - 120) / ((getWidth() - 120.0f) / steps)); if (! juce::isPositiveAndBelow (i, steps)) return;
        auto* s = engine.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock);
        auto it = std::find_if (c->notes.begin(), c->notes.end(), [&] (const Note& n) { return n.pitch == p && std::abs (n.start - i / 4.0) < 1e-6; });
        if (it != c->notes.end()) { if (e.mods.isShiftDown()) it->vel = it->vel > 0.85f ? 0.6f : 1.0f; else c->notes.erase (it); }
        else c->notes.push_back ({ p, i / 4.0, 0.25, e.mods.isShiftDown() ? 1.0f : 0.8f });
        repaint();
    }
    static const std::vector<std::pair<int, const char*>>& rows()
    { static const std::vector<std::pair<int, const char*>> r { { 36, "Kick" }, { 38, "Snare" }, { 39, "Clap" }, { 37, "Rim" }, { 42, "Closed hat" }, { 46, "Open hat" }, { 45, "Low tom" }, { 50, "High tom" }, { 49, "Crash" }, { 51, "Ride" }, { 56, "Cowbell" } }; return r; }
private:
    MidiClip* clip() { if (! juce::isPositiveAndBelow (ti, (int) engine.tracks.size())) return nullptr; auto& v = engine.tracks[(size_t) ti]->src()->midiClips; return juce::isPositiveAndBelow (ci, (int) v.size()) ? &v[(size_t) ci] : nullptr; }
    static const Note* find (const MidiClip& c, int p, double s) { for (auto& n : c.notes) if (n.pitch == p && std::abs (n.start - s) < 1e-6) return &n; return nullptr; }
    Engine& engine; const int ti, ci;
};

//============================================================================== chord generator
class ChordGenPanel : public juce::Component
{
public:
    ChordGenPanel (Engine& e, std::function<void()> changed) : engine (e), onChanged (std::move (changed))
    {
        auto addBox = [this] (juce::ComboBox& b, const juce::StringArray& items, const juce::String& label)
        { addAndMakeVisible (b); b.addItemList (items, 1); b.setSelectedItemIndex (0, juce::dontSendNotification); b.onChange = [this, &b] { changedBox (&b); }; auto* l = labels.add (new juce::Label ({}, label)); addAndMakeVisible (l); l->setColour (juce::Label::textColourId, col::mute); l->setFont (11.0f); };
        juce::StringArray modeNames; for (auto& m : chordgen::modes()) modeNames.add (m.name);
        addBox (key, chordgen::keys(), "Key"); addBox (mode, modeNames, "Scale"); addBox (style, {}, "Progression"); addBox (bars, { "2 bars", "4 bars", "8 bars", "16 bars" }, "Length");
        addBox (per, { "Every 2 bars", "1 per bar", "2 per bar" }, "Chord changes"); addBox (ext, chordgen::extensions(), "Colour"); addBox (voicing, chordgen::voicings(), "Voicing"); addBox (rhythm, chordgen::rhythms(), "Rhythm");
        addBox (reg, { "Low", "Middle", "High" }, "Register"); addBox (bass, chordgen::basses(), "Bass line");
        bars.setSelectedItemIndex (1, juce::dontSendNotification); per.setSelectedItemIndex (1, juce::dontSendNotification); reg.setSelectedItemIndex (1, juce::dontSendNotification);
        addAndMakeVisible (lead); lead.setToggleState (true, juce::dontSendNotification); lead.onClick = [this] { update(); };
        addAndMakeVisible (toTrack); toTrack.setToggleState (true, juce::dontSendNotification);
        addAndMakeVisible (surprise); surprise.onClick = [this] { ++seed; custom = chordgen::surprise (mode.getText(), 4, seed); style.setSelectedId (999, juce::dontSendNotification); update(); };
        addAndMakeVisible (play); play.onClick = [this] { preview(); };
        addAndMakeVisible (write); write.onClick = [this] { writeIt(); };
        fillStyles(); update(); setSize (760, 470);
    }
    void resized() override
    {
        auto r = getLocalBounds().reduced (12); juce::ComboBox* boxes[] { &key, &mode, &style, &bars, &per, &ext, &voicing, &rhythm, &reg, &bass }; const int cw = (r.getWidth() - 30) / 4;
        for (int i = 0; i < 10; ++i) { const int cx = r.getX() + (i % 4) * (cw + 10), cy = r.getY() + (i / 4) * 46; labels[i]->setBounds (cx, cy, cw, 14); boxes[i]->setBounds (cx, cy + 15, cw, 24); }
        lead.setBounds (r.getX() + 2 * (cw + 10), r.getY() + 2 * 46 + 15, cw, 24); toTrack.setBounds (r.getX() + 3 * (cw + 10), r.getY() + 2 * 46 + 15, cw, 24);
        chips = juce::Rectangle<int> (r.getX(), r.getY() + 3 * 46, r.getWidth(), 28); roll = juce::Rectangle<int> (r.getX(), chips.getBottom() + 8, r.getWidth(), 130);
        auto row = juce::Rectangle<int> (r.getX(), roll.getBottom() + 10, r.getWidth(), 28); surprise.setBounds (row.removeFromLeft (120)); row.removeFromLeft (6); play.setBounds (row.removeFromLeft (100)); row.removeFromLeft (6); write.setBounds (row.removeFromLeft (300));
    }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); float x = (float) chips.getX();
        for (auto& [name, b] : res.chords) { const float w = juce::jmax (52.0f, g.getCurrentFont().getStringWidthFloat (name) + 20); g.setColour (col::panel2); g.fillRoundedRectangle (x, (float) chips.getY(), w, 26, 3); g.setColour (col::ink); g.setFont (juce::FontOptions (13.0f, juce::Font::bold)); g.drawText (name, juce::Rectangle<float> (x, (float) chips.getY(), w, 26), juce::Justification::centred); x += w + 4; }
        g.setColour (col::bg); g.fillRoundedRectangle (roll.toFloat(), 3); if (res.notes.empty()) return;
        int lo = 127, hi = 0; for (auto* v : { &res.notes, &res.bass }) for (auto& n : *v) { lo = juce::jmin (lo, n.p); hi = juce::jmax (hi, n.p); } lo -= 2; hi += 2;
        auto X = [&] (double b) { return roll.getX() + (float) (b / res.len) * roll.getWidth(); }; auto Y = [&] (int p) { return roll.getBottom() - (float) (p - lo) / (hi - lo) * roll.getHeight(); };
        for (size_t i = 0; i < res.chords.size(); ++i) if (i % 2) { const double b = res.chords[i].second, e = i + 1 < res.chords.size() ? res.chords[i + 1].second : res.len; g.setColour (col::lane2); g.fillRect (juce::Rectangle<float> (X (b), (float) roll.getY(), X (e) - X (b), (float) roll.getHeight())); }
        g.setColour (col::rose); for (auto& n : res.notes) g.fillRect (X (n.s), Y (n.p) - 2, juce::jmax (2.0f, X (n.s + n.l) - X (n.s)), 4.0f);
        g.setColour (col::play); for (auto& n : res.bass) g.fillRect (X (n.s), Y (n.p) - 2, juce::jmax (2.0f, X (n.s + n.l) - X (n.s)), 4.0f);
    }
    void mouseDown (const juce::MouseEvent& e) override   // click a chord name to hear it
    {
        if (! chips.contains (e.getPosition())) return; float x = (float) chips.getX(); juce::Font f (juce::FontOptions (13.0f, juce::Font::bold));
        for (size_t i = 0; i < res.chords.size(); ++i) { const float w = juce::jmax (52.0f, f.getStringWidthFloat (res.chords[i].first) + 20); if (e.x >= x && e.x < x + w) { audition ({ res.voicings[i] }, 900); return; } x += w + 4; }
    }
private:
    chordgen::Settings settings() const
    {
        chordgen::Settings s; s.key = key.getSelectedItemIndex(); s.mode = mode.getText(); s.bars = juce::StringArray { "2", "4", "8", "16" }[bars.getSelectedItemIndex()].getIntValue();
        s.perBar = per.getSelectedItemIndex() == 0 ? 0.5 : per.getSelectedItemIndex() == 1 ? 1.0 : 2.0; s.ext = ext.getText(); s.voicing = voicing.getText(); s.rhythm = rhythm.getText(); s.bass = bass.getText();
        s.lead = lead.getToggleState(); s.octave = reg.getSelectedItemIndex() - 1; s.seed = seed;
        if (style.getSelectedId() == 999) s.steps = custom; else { const auto& st = chordgen::styles().at (chordgen::styles().count (s.mode) ? s.mode : "Major"); const int i = juce::jlimit (0, (int) st.size() - 1, style.getSelectedItemIndex()); for (auto* x : st[(size_t) i].steps) s.steps.add (x); }
        return s;
    }
    void fillStyles() { style.clear (juce::dontSendNotification); const auto& st = chordgen::styles().at (chordgen::styles().count (mode.getText()) ? mode.getText() : "Major"); int id = 1; for (auto& x : st) style.addItem (x.name, id++); style.addItem ("Surprise (generated)", 999); style.setSelectedId (1, juce::dontSendNotification); }
    void changedBox (juce::ComboBox* b) { if (b == &mode) fillStyles(); if (b == &style && style.getSelectedId() == 999) custom = chordgen::surprise (mode.getText(), 4, ++seed); update(); }
    void update() { res = chordgen::generate (settings()); const int ti = target(); write.setButtonText ("Write to " + (ti >= 0 ? engine.tracks[(size_t) ti]->name : juce::String ("a new track")) + " at the playhead"); repaint(); }
    int target() const { const int t = engine.selected; return juce::isPositiveAndBelow (t, (int) engine.tracks.size()) && ! engine.tracks[(size_t) t]->isAudio && ! engine.tracks[(size_t) t]->src()->drumKit.load() ? t : -1; }
    void audition (std::vector<std::vector<int>> chords, int stepMs)
    {
        for (size_t i = 0; i < chords.size(); ++i)
            juce::Timer::callAfterDelay ((int) i * stepMs, [this, v = chords[i], stepMs] { for (int p : v) engine.keyboard.noteOn (1, p, 0.7f); juce::Timer::callAfterDelay ((int) (stepMs * 0.9), [this, v] { for (int p : v) engine.keyboard.noteOff (1, p, 0.0f); }); });
    }
    void preview() { const int beatMs = (int) (60000.0 / engine.transport.bpm.load()); audition (res.voicings, (int) (beatMs * 4 / settings().perBar)); }
    void writeIt()
    {
        int ti = target(); const double at = engine.transport.barAt (engine.transport.beatsAt (engine.transport.pos.load())).start;
        if (ti < 0) { auto& t = engine.addTrack (false, "Chords"); if (engine.setInstrument (t, "sounds", nullptr).isEmpty()) Engine::setParam (*t.instrument.node->getProcessor(), "patch", juce::var ("Electric Piano")); ti = (int) engine.tracks.size() - 1; }
        juce::String name; for (size_t i = 0; i < juce::jmin ((size_t) 4, res.chords.size()); ++i) name << (i ? " " : "") << res.chords[i].first;
        MidiClip mc; mc.name = name; mc.start = at; mc.length = res.len; for (auto& n : res.notes) mc.notes.push_back ({ n.p, n.s, n.l, n.v });
        { auto* s = engine.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock); s->midiClips.push_back (mc); }
        if (! res.bass.empty())
        {
            int bi = -1; for (int i = 0; i < (int) engine.tracks.size(); ++i) if (engine.tracks[(size_t) i]->name == "Bass" && ! engine.tracks[(size_t) i]->isAudio) bi = i;
            if (bi < 0) { auto& t = engine.addTrack (false, "Bass"); if (engine.setInstrument (t, "sounds", nullptr).isEmpty()) Engine::setParam (*t.instrument.node->getProcessor(), "patch", juce::var ("Electric Bass")); bi = (int) engine.tracks.size() - 1; }
            MidiClip bc; bc.name = "Bass - " + name; bc.start = at; bc.length = res.len; for (auto& n : res.bass) bc.notes.push_back ({ n.p, n.s, n.l, n.v });
            auto* s = engine.tracks[(size_t) bi]->src(); const juce::ScopedLock sl (s->lock); s->midiClips.push_back (bc);
        }
        if (toTrack.getToggleState())
        {
            auto& cs = engine.chords; cs.erase (std::remove_if (cs.begin(), cs.end(), [&] (auto& c) { return c.beat >= at - 1e-9 && c.beat < at + res.len - 1e-9; }), cs.end());
            for (auto& [n, b] : res.chords) cs.push_back ({ at + b, n }); std::sort (cs.begin(), cs.end(), [] (auto& a, auto& b) { return a.beat < b.beat; });
        }
        engine.selectTrack (ti); engine.sendChangeMessage(); if (onChanged) onChanged(); update();
    }
    Engine& engine; std::function<void()> onChanged; juce::ComboBox key, mode, style, bars, per, ext, voicing, rhythm, reg, bass; juce::OwnedArray<juce::Label> labels;
    juce::ToggleButton lead { "Smooth voice leading" }, toTrack { "Also fill the chord track" }; juce::TextButton surprise { "Surprise me" }, play { "Preview" }, write { "Write" };
    juce::Rectangle<int> chips, roll; chordgen::Result res; juce::StringArray custom; uint32_t seed = 1;
};

//============================================================================== tempo & time signature
class TempoPanel : public juce::Component
{
public:
    TempoPanel (Engine& e, std::function<void()> changed) : engine (e), onChanged (std::move (changed))
    {
        addAndMakeVisible (atBar); atBar.setRange (2, 999, 1); atBar.setValue (9); atBar.setSliderStyle (juce::Slider::IncDecButtons); atBar.setTextBoxStyle (juce::Slider::TextBoxLeft, false, 50, 24);
        addAndMakeVisible (addTempo); addTempo.onClick = [this] { auto m = engine.transport.currentMap(); const double b = engine.transport.barStart ((int) atBar.getValue() - 1);
            m.tempo.erase (std::remove_if (m.tempo.begin(), m.tempo.end(), [&] (auto& x) { return std::abs (x.beat - b) < 1e-9; }), m.tempo.end()); m.tempo.push_back ({ b, std::round (engine.transport.bpmAt (b) + 10) }); engine.transport.setMap (m); rebuild(); };
        addAndMakeVisible (addSig); addSig.onClick = [this] { auto m = engine.transport.currentMap(); const double b = engine.transport.barStart ((int) atBar.getValue() - 1);
            m.meter.erase (std::remove_if (m.meter.begin(), m.meter.end(), [&] (auto& x) { return std::abs (x.beat - b) < 1e-9; }), m.meter.end()); m.meter.push_back ({ b, engine.transport.barAt (b).num == 3 ? 4 : 3 }); engine.transport.setMap (m); rebuild(); };
        addAndMakeVisible (sig); for (int n = 2; n <= 7; ++n) sig.addItem (juce::String (n) + "/4", n); sig.setSelectedId (engine.transport.sig.load(), juce::dontSendNotification);
        sig.onChange = [this] { engine.transport.sig = sig.getSelectedId(); engine.transport.setMap (engine.transport.currentMap()); if (onChanged) onChanged(); };
        addAndMakeVisible (lSig); lSig.setText ("Starting time signature", juce::dontSendNotification); lSig.setColour (juce::Label::textColourId, col::mute);
        rebuild(); setSize (420, 380);
    }
    void rebuild()
    {
        rows.clear(); const auto m = engine.transport.currentMap(); int y = 50;
        auto addRow = [&] (bool tempo, double beat, double value)
        {
            auto* r = rows.add (new Row()); addAndMakeVisible (r); r->setBounds (12, y, getWidth() - 24, 28); y += 30;
            r->label.setText ("Bar " + juce::String (engine.transport.barAt (beat).bar + 1) + (tempo ? "   tempo" : "   time signature"), juce::dontSendNotification);
            if (tempo) { r->value.setRange (40, 240, 0.5); r->value.setValue (value, juce::dontSendNotification); r->value.onValueChange = [this, r, beat] { auto mm = engine.transport.currentMap(); for (auto& x : mm.tempo) if (std::abs (x.beat - beat) < 1e-9) x.bpm = r->value.getValue(); engine.transport.setMap (mm); if (onChanged) onChanged(); }; }
            else { r->value.setRange (2, 7, 1); r->value.setValue (value, juce::dontSendNotification); r->value.setTextValueSuffix ("/4"); r->value.onValueChange = [this, r, beat] { auto mm = engine.transport.currentMap(); for (auto& x : mm.meter) if (std::abs (x.beat - beat) < 1e-9) x.num = (int) r->value.getValue(); engine.transport.setMap (mm); if (onChanged) onChanged(); }; }
            r->del.onClick = [this, tempo, beat] { juce::MessageManager::callAsync ([this, tempo, beat] { auto mm = engine.transport.currentMap(); if (tempo) mm.tempo.erase (std::remove_if (mm.tempo.begin(), mm.tempo.end(), [&] (auto& x) { return std::abs (x.beat - beat) < 1e-9; }), mm.tempo.end());
                else mm.meter.erase (std::remove_if (mm.meter.begin(), mm.meter.end(), [&] (auto& x) { return std::abs (x.beat - beat) < 1e-9; }), mm.meter.end()); engine.transport.setMap (mm); rebuild(); }); };
        };
        for (auto& x : m.tempo) addRow (true, x.beat, x.bpm); for (auto& x : m.meter) addRow (false, x.beat, x.num);
        if (onChanged) onChanged(); repaint();
    }
    void resized() override
    {
        auto r = getLocalBounds().reduced (12); auto top = r.removeFromTop (28); lSig.setBounds (top.removeFromLeft (170)); sig.setBounds (top.removeFromLeft (80));
        auto bottom = r.removeFromBottom (28); atBar.setBounds (bottom.removeFromLeft (120)); bottom.removeFromLeft (6); addTempo.setBounds (bottom.removeFromLeft (120)); bottom.removeFromLeft (6); addSig.setBounds (bottom.removeFromLeft (130));
    }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (col::panel); g.setColour (col::mute); g.setFont (12.0f);
        if (rows.isEmpty()) g.drawFittedText ("No changes yet - the whole song uses the starting tempo (" + juce::String (engine.transport.bpm.load(), 1) + " BPM) and time signature. Pick a bar below and add a change.", 12, 50, getWidth() - 24, 60, juce::Justification::topLeft, 3);
        g.drawText ("At bar", 12, getHeight() - 58, 100, 16, juce::Justification::left);
    }
private:
    struct Row : juce::Component
    {
        Row() { addAndMakeVisible (label); addAndMakeVisible (value); addAndMakeVisible (del); value.setSliderStyle (juce::Slider::IncDecButtons); value.setTextBoxStyle (juce::Slider::TextBoxLeft, false, 60, 24); label.setColour (juce::Label::textColourId, col::ink); }
        void resized() override { auto r = getLocalBounds(); del.setBounds (r.removeFromRight (28)); value.setBounds (r.removeFromRight (140)); label.setBounds (r); }
        juce::Label label; juce::Slider value; juce::TextButton del { "x" };
    };
    Engine& engine; std::function<void()> onChanged; juce::OwnedArray<Row> rows; juce::Slider atBar; juce::TextButton addTempo { "+ Tempo change" }, addSig { "+ Time signature" }; juce::ComboBox sig; juce::Label lSig;
};
} // namespace rose
