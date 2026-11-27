#include "MainComponent.h"
#include "BinaryData.h"

namespace rose
{
//============================================================================== PianoRoll
void PianoRoll::paint (juce::Graphics& g)
{
    g.fillAll (col::lane);
    auto* c = clip(); if (c == nullptr) return;
    const juce::ScopedLock sl (track.src()->lock);
    for (int p = LO; p <= HI; ++p)
    {
        const bool black = juce::MidiMessage::isMidiNoteBlack (p);
        g.setColour (black ? col::lane2 : col::lane); g.fillRect (KW, yOf (p), (float) getWidth(), RH);
        if (p % 12 == 0) { g.setColour (col::line); g.drawHorizontalLine ((int) (yOf (p) + RH), KW, (float) getWidth()); }
    }
    for (double b = 0; b <= c->length + 1e-9; b += grid)
    {
        g.setColour (std::fmod (b, 4.0) < 1e-9 ? col::mute : std::fmod (b, 1.0) < 1e-9 ? col::line : col::panel2);
        g.drawVerticalLine ((int) xOf (b), 0, (float) getHeight());
    }
    for (auto& n : c->notes)
    {
        juce::Rectangle<float> r (xOf (n.start) + 1, yOf (n.pitch) + 0.5f, juce::jmax (3.0f, (float) n.length * ppb() - 2), RH - 1);
        g.setColour (track.colour.withAlpha (0.45f + 0.55f * n.vel)); g.fillRect (r);
        g.setColour (col::ink); g.drawRect (r, 0.7f);
    }
    for (int p = LO; p <= HI; ++p)
    {
        const bool black = juce::MidiMessage::isMidiNoteBlack (p);
        g.setColour (black ? juce::Colour (0xff222222) : juce::Colour (0xfff4f1ec)); g.fillRect (0.0f, yOf (p), KW, RH);
        if (p % 12 == 0) { g.setColour (juce::Colours::black); g.setFont (9.0f); g.drawText (juce::MidiMessage::getMidiNoteName (p, true, true, 4), 2, (int) yOf (p) - 3, (int) KW, 10, juce::Justification::left); }
    }
}
void PianoRoll::mouseDown (const juce::MouseEvent& e)
{
    auto* c = clip(); if (c == nullptr) return;
    const int p = pOf ((float) e.y);
    if (e.x < KW) { engine.keyboard.noteOn (1, p, 0.8f); lastHeard = p; return; }
    const double b = bOf ((float) e.x);
    const juce::ScopedLock sl (track.src()->lock);
    dragNote = -1;
    for (int i = 0; i < (int) c->notes.size(); ++i)
    { auto& n = c->notes[(size_t) i]; if (n.pitch == p && b >= n.start && b <= n.start + n.length) { dragNote = i; break; } }
    if (dragNote >= 0 && (e.mods.isPopupMenu() || e.mods.isAltDown())) { c->notes.erase (c->notes.begin() + dragNote); dragNote = -1; repaint(); return; }
    if (e.mods.isPopupMenu()) return;
    if (dragNote < 0)
    {
        c->notes.push_back ({ p, juce::jmax (0.0, std::floor (b / grid) * grid), grid, 0.8f });
        dragNote = (int) c->notes.size() - 1; resizing = false; grabOffset = 0;
        engine.keyboard.noteOn (1, p, 0.8f); lastHeard = p;
    }
    else { auto& n = c->notes[(size_t) dragNote]; resizing = e.x > xOf (n.start + n.length) - 6; grabOffset = b - n.start; }
    repaint();
}
void PianoRoll::mouseDrag (const juce::MouseEvent& e)
{
    auto* c = clip(); if (c == nullptr || dragNote < 0) return;
    const juce::ScopedLock sl (track.src()->lock);
    auto& n = c->notes[(size_t) dragNote]; const double b = bOf ((float) e.x);
    if (resizing) n.length = juce::jmax (grid, std::round ((b - n.start) / grid) * grid);
    else { n.start = juce::jlimit (0.0, c->length - grid, std::round ((b - grabOffset) / grid) * grid); n.pitch = juce::jlimit (LO, HI, pOf ((float) e.y)); }
    repaint();
}
void PianoRoll::mouseUp (const juce::MouseEvent&) { if (lastHeard >= 0) engine.keyboard.noteOff (1, lastHeard, 0.0f); lastHeard = -1; dragNote = -1; }
void PianoRoll::mouseDoubleClick (const juce::MouseEvent& e)
{
    auto* c = clip(); if (c == nullptr) return;
    const juce::ScopedLock sl (track.src()->lock);
    const int p = pOf ((float) e.y); const double b = bOf ((float) e.x);
    c->notes.erase (std::remove_if (c->notes.begin(), c->notes.end(), [&] (auto& n) { return n.pitch == p && b >= n.start && b <= n.start + n.length; }), c->notes.end());
    repaint();
}

//============================================================================== Timeline
const std::vector<float>& Timeline::peaksFor (const AudioClip& c)
{
    auto& v = peaks[c.data.get()];
    if (v.empty() && c.data)
    {
        const auto& d = *c.data; const int step = 256; v.resize ((size_t) (d.getNumSamples() / step + 1));
        for (size_t i = 0; i < v.size(); ++i)
        { float m = 0; for (int ch = 0; ch < d.getNumChannels(); ++ch) m = juce::jmax (m, d.getMagnitude (ch, (int) i * step, juce::jmin (step, d.getNumSamples() - (int) i * step))); v[i] = m; }
    }
    return v;
}
void Timeline::updateSize()
{
    const double beats = juce::jmax (engine.songEndBeats() + 32.0, engine.transport.loopEnd.load() + 16.0, 128.0);
    setSize ((int) (beats * ppb), RULER + LANE * juce::jmax (1, (int) engine.tracks.size()));
}
void Timeline::paint (juce::Graphics& g)
{
    g.fillAll (col::lane);
    const auto& tr = engine.transport; const float W = (float) getWidth();
    for (int i = 0; i < (int) engine.tracks.size(); ++i)
    { g.setColour (i % 2 ? col::lane2 : col::lane); g.fillRect (0, RULER + i * LANE, getWidth(), LANE); g.setColour (col::line); g.drawHorizontalLine (RULER + (i + 1) * LANE - 1, 0, W); }
    for (int b = 0; b * ppb < W; ++b) { g.setColour (col::panel2); g.drawVerticalLine ((int) (b * ppb), (float) RULER, (float) getHeight()); }
    for (int k = 0; tr.barStart (k) * ppb < W; ++k) { g.setColour (col::line); g.drawVerticalLine ((int) (tr.barStart (k) * ppb), (float) RULER, (float) getHeight()); }
    g.setColour (col::panel); g.fillRect (0, 0, getWidth(), RULER - 1);
    const int every = ppb * 4 < 26 ? 4 : ppb * 4 < 44 ? 2 : 1;
    for (int k = 0; tr.barStart (k) * ppb < W; ++k) if (k % every == 0) { g.setColour (col::mute); g.setFont (11.0f); g.drawText (juce::String (k + 1), (int) (tr.barStart (k) * ppb) + 3, 13, 40, 14, juce::Justification::left); }
    {   // tempo & meter flags, markers
        const auto map = tr.currentMap(); g.setFont (10.0f);
        for (auto& x : map.tempo) { const int px = (int) (x.beat * ppb); g.setColour (col::bg); g.fillRect (px + 16, 14, 46, 13); g.setColour (col::mute); g.drawText (juce::String::fromUTF8 ("\xe2\x99\xa9") + juce::String (x.bpm, x.bpm == std::round (x.bpm) ? 0 : 1), px + 18, 14, 44, 13, juce::Justification::left); }
        for (auto& x : map.meter) { const int px = (int) (x.beat * ppb); g.setColour (col::bg); g.fillRect (px + 64, 14, 26, 13); g.setColour (col::mute); g.drawText (juce::String (x.num) + "/4", px + 66, 14, 24, 13, juce::Justification::left); }
        for (auto& m : engine.markers)
        {
            const int px = (int) (m.beat * ppb), w2 = juce::jmin (130, (int) juce::Font (juce::FontOptions (11.0f)).getStringWidthFloat (m.name) + 12);
            g.setColour (col::ink); g.fillRect (px, 14, w2, 14); g.drawVerticalLine (px, 14.0f, (float) RULER); g.setColour (col::bg); g.setFont (11.0f); g.drawText (m.name, px + 5, 14, w2 - 6, 14, juce::Justification::left, true);
        }
    }
    if (songRows)
    {
        g.setColour (col::line); g.drawHorizontalLine (28, 0, W); g.drawHorizontalLine (50, 0, W);
        for (auto& s : engine.sections)
        {
            auto r = juce::Rectangle<float> ((float) s.start * ppb + 1, 30, (float) s.len * ppb - 2, 18); g.setColour (s.colour.withAlpha (0.75f)); g.fillRoundedRectangle (r, 3);
            g.setColour (juce::Colours::white); g.setFont (juce::FontOptions (11.0f, juce::Font::bold)); g.drawText (s.name, r.reduced (6, 0), juce::Justification::left, true);
        }
        if (drag == Drag::section) { g.setColour (col::rose.withAlpha (0.4f)); g.fillRoundedRectangle (juce::Rectangle<float> ((float) secA * ppb, 30, (float) (secB - secA) * ppb, 18), 3); }
        auto cs = engine.chords; std::sort (cs.begin(), cs.end(), [] (auto& a, auto& b) { return a.beat < b.beat; });
        for (size_t i = 0; i < cs.size(); ++i)
        {
            const float x0 = (float) cs[i].beat * ppb, x1 = i + 1 < cs.size() ? (float) cs[i + 1].beat * ppb : x0 + 4 * ppb;
            g.setColour (col::rose.withAlpha (0.14f)); g.fillRect (x0, 52.0f, x1 - x0, 18.0f); g.setColour (col::rose); g.fillRect (x0, 52.0f, 2.0f, 18.0f);
            g.setColour (col::ink); g.setFont (juce::FontOptions (12.0f, juce::Font::bold)); g.drawText (cs[i].name, (int) x0 + 6, 52, (int) (x1 - x0) - 8, 18, juce::Justification::left, true);
        }
    }
    const float ls = (float) tr.loopStart.load() * ppb, le = (float) tr.loopEnd.load() * ppb;
    g.setColour (col::rose.withAlpha (tr.looping.load() ? 0.35f : 0.12f)); g.fillRoundedRectangle (ls, 2, le - ls, 10, 3);
    if (tr.looping.load()) { g.setColour (col::rose.withAlpha (0.05f)); g.fillRect (ls, (float) RULER, le - ls, (float) getHeight()); }

    for (int ti = 0; ti < (int) engine.tracks.size(); ++ti)
    {
        auto& t = *engine.tracks[(size_t) ti]; auto* s = t.src(); const juce::ScopedLock sl (s->lock);
        const int y = RULER + ti * LANE + 4, h = LANE - 8;
        auto box = [&] (double start, double len, bool selected, const juce::String& nm)
        {
            juce::Rectangle<float> r ((float) start * ppb, (float) y, juce::jmax (6.0f, (float) len * ppb), (float) h);
            g.setColour (t.colour.withAlpha (0.25f)); g.fillRoundedRectangle (r, 5);
            g.setColour (selected ? col::ink : t.colour); g.drawRoundedRectangle (r, 5, selected ? 2.0f : 1.0f);
            g.setColour (col::ink); g.setFont (11.0f); g.drawText (nm, r.reduced (5, 2).toNearestInt(), juce::Justification::topLeft);
            return r;
        };
        for (int ci = 0; ci < (int) s->audioClips.size(); ++ci)
        {
            auto& c = s->audioClips[(size_t) ci];
            juce::String nm = c.name.isNotEmpty() ? c.name : c.file.getFileNameWithoutExtension();
            if (std::abs (c.pitch) > 0.004f) nm << "  " << (c.pitch > 0 ? "+" : "") << juce::String (c.pitch, std::abs (c.pitch - std::round (c.pitch)) > 0.004f ? 2 : 0) << " st";
            if (c.srcBpm > 0) nm << juce::String::fromUTF8 ("  \xe2\x9f\xb2");
            auto r = box (c.start, c.length, sel.track == ti && sel.clip == ci && sel.audio, nm);
            auto& pk = peaksFor (c); if (pk.empty()) continue;
            g.setColour (t.colour); const float mid = r.getCentreY() + 6, amp = (r.getHeight() - 18) / 2;
            const double L = c.loopLen > 0 && c.loopLen < c.length ? c.loopLen : c.length;
            for (int x = 0; x < (int) r.getWidth(); ++x)
            {
                const double within = std::fmod (x / ppb, L);
                if (L < c.length && within < 1.0 / ppb) { g.setColour (col::ink.withAlpha (0.5f)); g.drawVerticalLine ((int) r.getX() + x, r.getY(), r.getBottom()); g.setColour (t.colour); }
                const double sec = c.offsetSec + (c.srcBpm > 0 ? within * 60.0 / c.srcBpm : tr.secAt (c.start + within) - tr.secAt (c.start)); const size_t i = (size_t) (sec * c.fileRate / 256);
                if (i >= pk.size()) continue;
                const float a = pk[i] * amp * juce::Decibels::decibelsToGain (c.gainDb);
                g.drawVerticalLine ((int) r.getX() + x, mid - a, mid + a + 1);
            }
            g.setColour (col::ink);
            if (c.fadeIn > 0) g.drawLine (r.getX(), r.getBottom(), r.getX() + (float) c.fadeIn * ppb, r.getY(), 1.5f);
            if (c.fadeOut > 0) g.drawLine (r.getRight() - (float) c.fadeOut * ppb, r.getY(), r.getRight(), r.getBottom(), 1.5f);
            g.setColour (col::ink.withAlpha (0.6f)); g.fillRect (r.getX(), r.getY(), 6.0f, 6.0f); g.fillRect (r.getRight() - 6, r.getY(), 6.0f, 6.0f);
            g.setColour (col::rose); g.fillRect (r.getRight() - 8, r.getBottom() - 8, 8.0f, 8.0f);
        }
        for (int ci = 0; ci < (int) s->midiClips.size(); ++ci)
        {
            auto& c = s->midiClips[(size_t) ci];
            auto r = box (c.start, c.length, sel.track == ti && sel.clip == ci && ! sel.audio, c.transpose && ! s->drumKit.load() ? c.name + "  " + (c.transpose > 0 ? "+" : "") + juce::String (c.transpose) + " st" : c.name);
            if (c.notes.empty()) continue;
            int lo = 127, hi = 0; for (auto& n : c.notes) { lo = juce::jmin (lo, n.pitch); hi = juce::jmax (hi, n.pitch); }
            const float rh = juce::jlimit (2.0f, 5.0f, (r.getHeight() - 16) / (float) (hi - lo + 1)); g.setColour (t.colour);
            const double L = c.loopLen > 0 && c.loopLen < c.length ? c.loopLen : c.length;
            for (double o = 0; o < c.length - 1e-9; o += L)
            {
                if (o > 0) { g.setColour (col::ink.withAlpha (0.5f)); g.drawVerticalLine ((int) (r.getX() + (float) o * ppb), r.getY(), r.getBottom()); g.setColour (t.colour.withAlpha (0.75f)); }
                for (auto& n : c.notes)
                    if (n.start < L && o + n.start < c.length)
                        g.fillRect (r.getX() + (float) (o + n.start) * ppb, r.getBottom() - 3 - (float) (n.pitch - lo + 1) * (r.getHeight() - 18) / (float) (hi - lo + 1), juce::jmax (2.0f, (float) juce::jmin (n.length, L - n.start) * ppb - 1), rh);
            }
            g.setColour (col::rose); g.fillRect (r.getRight() - 8, r.getBottom() - 8, 8.0f, 8.0f);
        }
    }
    if (dropTrack >= -1)   // where a dragged loop / effect will land
    {
        const int n = (int) engine.tracks.size(), lane = juce::jlimit (0, n, dropTrack); g.setColour (col::rose);
        if (dropIsLoop) { const float x = (float) dropBeat * ppb; g.drawRect (juce::Rectangle<float> (x, (float) (RULER + lane * LANE + 4), 4 * ppb, (float) LANE - 8), 2.0f); }
        else if (lane < n) g.drawRect (juce::Rectangle<int> (0, RULER + lane * LANE, getWidth(), LANE), 2);
    }
}
void Timeline::itemDropped (const SourceDetails& d)
{
    const auto desc = d.description.toString(); const int ti = (d.localPosition.y - RULER) / LANE; dropTrack = -2;
    if (desc.startsWith ("fx:")) { if (juce::isPositiveAndBelow (ti, (int) engine.tracks.size())) { addFxTo (engine, engine.tracks[(size_t) ti]->inserts, desc.fromFirstOccurrenceOf ("fx:", false, false)); engine.selectTrack (ti); if (notify) notify ("Added to " + engine.tracks[(size_t) ti]->name); } }
    else if (auto* L = findLoop (desc.fromFirstOccurrenceOf ("loop:", false, false)))
    {
        engine.previewLoop (nullptr);
        const int used = engine.placeLoop (*L, ti, juce::jmax (0.0, std::floor ((double) d.localPosition.x / ppb / 4) * 4), loopSemis ? loopSemis (*L) : 0);
        if (used >= 0) { engine.selectTrack (used); if (notify) notify (L->name + (L->bpm > 0 ? " - follows the song tempo" : "")); }
    }
    updateSize(); repaint(); if (changed) changed();
}
void Timeline::pitchSelected (int semis)
{
    if (! juce::isPositiveAndBelow (sel.track, (int) engine.tracks.size())) return;
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock); float now = 0;
    if (sel.audio && juce::isPositiveAndBelow (sel.clip, (int) s->audioClips.size())) { auto& c = s->audioClips[(size_t) sel.clip]; c.pitch = semis == 0 ? 0.0f : juce::jlimit (-48.0f, 48.0f, c.pitch + (float) semis); now = c.pitch; }
    else if (! sel.audio && juce::isPositiveAndBelow (sel.clip, (int) s->midiClips.size()))
    {
        if (s->drumKit.load()) { if (notify) notify ("Drum kits don't transpose - each note is a different drum"); return; }
        auto& c = s->midiClips[(size_t) sel.clip]; c.transpose = semis == 0 ? 0 : juce::jlimit (-48, 48, c.transpose + semis); now = (float) c.transpose;
    }
    else return;
    if (notify) notify ("Clip pitch " + juce::String (now > 0 ? "+" : "") + juce::String (now, 0) + " st");
    repaint();
}
void Timeline::mouseDown (const juce::MouseEvent& e)
{
    const double b = e.x / (double) ppb; drag = Drag::none;
    if (e.y < RULER && (e.y >= 28 || (e.y >= 14 && [&] { for (auto& m : engine.markers) if (e.x >= m.beat * ppb && e.x < m.beat * ppb + 130 && e.x < m.beat * ppb + juce::Font (juce::FontOptions (11.0f)).getStringWidthFloat (m.name) + 12) return true; return false; }())))
    { rulerClick (e); return; }
    if (e.y < RULER)
    {
        if (e.y < 14) { drag = Drag::loop; dragStartBeat = snap (b, false); }
        else { drag = Drag::seek; engine.transport.pos = engine.transport.samplesAt (juce::jmax (0.0, b)); }
        return;
    }
    const int ti = (e.y - RULER) / LANE; sel = {};
    if (ti < 0 || ti >= (int) engine.tracks.size()) { repaint(); return; }
    engine.selectTrack (ti);
    auto* s = engine.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock);
    auto hit = [&] (double st, double len) { return b >= st && b <= st + len; };
    for (int ci = (int) s->audioClips.size() - 1; ci >= 0 && sel.clip < 0; --ci) if (hit (s->audioClips[(size_t) ci].start, s->audioClips[(size_t) ci].length)) sel = { ti, ci, true };
    for (int ci = (int) s->midiClips.size() - 1; ci >= 0 && sel.clip < 0; --ci) if (hit (s->midiClips[(size_t) ci].start, s->midiClips[(size_t) ci].length)) sel = { ti, ci, false };
    if (sel.clip >= 0)
    {
        const double st = sel.audio ? s->audioClips[(size_t) sel.clip].start : s->midiClips[(size_t) sel.clip].start;
        const double ln = sel.audio ? s->audioClips[(size_t) sel.clip].length : s->midiClips[(size_t) sel.clip].length;
        if (e.mods.isPopupMenu())
        {
            const double here = snap (b, false); const bool looped = sel.audio ? s->audioClips[(size_t) sel.clip].loopLen > 0 : s->midiClips[(size_t) sel.clip].loopLen > 0;
            juce::PopupMenu m;
            m.addItem (10, "Cut\tCmd+X"); m.addItem (11, "Copy\tCmd+C"); m.addItem (12, "Paste at playhead\tCmd+V", clipboard.has);
            m.addItem (1, "Duplicate\tCmd+D"); m.addSeparator();
            m.addItem (13, "Split here"); m.addItem (2, "Split at playhead\tCmd+E / B");
            m.addItem (14, looped ? "Loop clip: turn off" : "Loop clip"); m.addItem (15, "Set loop region to clip\tCmd+L");
            if (sel.audio) { m.addSeparator(); m.addItem (16, "Fade in (1/4 beat)"); m.addItem (17, "Fade out (1 beat)"); m.addItem (18, "Remove fades"); }
            if (! sel.audio) m.addItem (4, "Edit notes...");
            { juce::PopupMenu p; p.addItem (20, "Up a semitone\tAlt+Up"); p.addItem (21, "Down a semitone\tAlt+Down"); p.addItem (22, "Up an octave\tAlt+Shift+Up"); p.addItem (23, "Down an octave\tAlt+Shift+Down"); p.addItem (24, "Reset pitch");
              m.addSubMenu ("Pitch", p); }
            m.addSeparator(); m.addItem (3, "Delete\tDel");
            m.showMenuAsync ({}, [this, here] (int r)
            {
                switch (r) { case 1: duplicateSelected(); break; case 2: splitSelected(); break; case 3: deleteSelected(); break;
                    case 4: if (openPianoRoll) openPianoRoll (sel.track, sel.clip); break;
                    case 10: copySelected (true); break; case 11: copySelected (false); break; case 12: paste(); break; case 13: splitAt (here); break;
                    case 14: toggleClipLoop(); break; case 15: loopToSelection(); break; case 16: setFade (true, 0.25); break; case 17: setFade (false, 1.0); break;
                    case 18: setFade (true, 0); setFade (false, 0); break;
                    case 20: pitchSelected (1); break; case 21: pitchSelected (-1); break; case 22: pitchSelected (12); break; case 23: pitchSelected (-12); break; case 24: pitchSelected (0); break; default: break; }
            });
            repaint(); return;
        }
        if (tool == Tool::scissors || e.mods.isAltDown()) { const double at = snap (b, e.mods.isShiftDown()); juce::MessageManager::callAsync ([this, at] { splitAt (at); }); return; }
        const int clipTop = RULER + ti * LANE + 4, clipBottom = RULER + (ti + 1) * LANE - 4; const float x0 = (float) (st * ppb), x1 = (float) ((st + ln) * ppb);
        if (sel.audio && e.y < clipTop + 10 && e.x < x0 + 10) { drag = Drag::fadeIn; fade0 = s->audioClips[(size_t) sel.clip].fadeIn; dragStartBeat = b; return; }
        if (sel.audio && e.y < clipTop + 10 && e.x > x1 - 10) { drag = Drag::fadeOut; fade0 = s->audioClips[(size_t) sel.clip].fadeOut; dragStartBeat = b; return; }
        if (e.y > clipBottom - 10 && e.x > x1 - 10)
        {
            double& lp = sel.audio ? s->audioClips[(size_t) sel.clip].loopLen : s->midiClips[(size_t) sel.clip].loopLen;
            if (lp <= 0) lp = ln;
            drag = Drag::clipLoop; dragStartBeat = b; clipStart0 = st; clipLen0 = ln; return;
        }
        drag = (e.x > x1 - 8) ? Drag::resize : Drag::move; dragStartBeat = b; clipStart0 = st; clipLen0 = ln;
    }
    repaint();
}
void Timeline::mouseDrag (const juce::MouseEvent& e)
{
    const double b = juce::jmax (0.0, e.x / (double) ppb); const bool fine = e.mods.isShiftDown();
    if (drag == Drag::loop)
    {
        const double x = snap (b, false); engine.transport.loopStart = juce::jmin (dragStartBeat, x);
        engine.transport.loopEnd = juce::jmax (juce::jmax (dragStartBeat, x), engine.transport.loopStart.load() + 0.25); engine.transport.looping = true; repaint(); return;
    }
    if (drag == Drag::seek) { engine.transport.pos = engine.transport.samplesAt (b); return; }
    if (drag == Drag::section) { const auto bi = engine.transport.barAt (b); secB = juce::jmax (engine.transport.barStart (engine.transport.barAt (secA).bar + 1), bi.start + (bi.beat > 0.01 ? bi.num : 0)); repaint(); return; }
    if (sel.clip < 0 || drag == Drag::none) return;
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    if (drag == Drag::fadeIn || drag == Drag::fadeOut)
    {
        auto& c = s->audioClips[(size_t) sel.clip]; const double d = (b - dragStartBeat) * (drag == Drag::fadeIn ? 1 : -1);
        (drag == Drag::fadeIn ? c.fadeIn : c.fadeOut) = juce::jlimit (0.0, c.length / 2, std::round ((fade0 + d) * 16) / 16);
        repaint(); return;
    }
    if (drag == Drag::clipLoop) drag = Drag::resize;
    double& st = sel.audio ? s->audioClips[(size_t) sel.clip].start : s->midiClips[(size_t) sel.clip].start;
    double& ln = sel.audio ? s->audioClips[(size_t) sel.clip].length : s->midiClips[(size_t) sel.clip].length;
    if (drag == Drag::move) st = juce::jmax (0.0, snap (clipStart0 + b - dragStartBeat, fine));
    else ln = juce::jmax (0.25, snap (clipLen0 + b - dragStartBeat, fine));
    repaint();
}
void Timeline::mouseUp (const juce::MouseEvent&)
{
    if (drag == Drag::section)
    {
        bool overlap = false; for (auto& s : engine.sections) overlap |= s.start < secB - 1e-9 && s.start + s.len > secA + 1e-9;
        if (overlap) { if (notify) notify ("Sections can't overlap"); }
        else
        {
            static const char* names[] { "Intro", "Verse", "Pre-chorus", "Chorus", "Verse 2", "Chorus 2", "Bridge", "Drop", "Breakdown", "Outro" };
            static const juce::uint32 colours[] { 0xff5b8def, 0xff3fb68b, 0xffd9a441, 0xffe0708a, 0xff9b7be0, 0xff46b5c8, 0xffe07d4f, 0xff8fb04a };
            const auto n = engine.sections.size(); engine.sections.push_back ({ secA, secB - secA, names[n % 10], juce::Colour (colours[n % 8]) });
        }
    }
    drag = Drag::none; updateSize(); repaint(); if (changed) changed();
}
void Timeline::rulerClick (const juce::MouseEvent& e)
{
    auto& tr = engine.transport; const double b = juce::jmax (0.0, e.x / (double) ppb);
    if (e.y < 28)   // a marker
    {
        for (int i = (int) engine.markers.size() - 1; i >= 0; --i) { auto& m = engine.markers[(size_t) i]; if (e.x >= m.beat * ppb)
        {
            if (e.mods.isPopupMenu()) { juce::PopupMenu menu; menu.addItem (1, "Rename"); menu.addItem (2, "Delete marker");
                menu.showMenuAsync ({}, [this, i] (int r) { if (r == 1) rename ([this, i]() -> juce::String& { return engine.markers[(size_t) i].name; }, "Marker name"); if (r == 2) { engine.markers.erase (engine.markers.begin() + i); repaint(); } }); }
            else if (e.getNumberOfClicks() > 1) rename ([this, i]() -> juce::String& { return engine.markers[(size_t) i].name; }, "Marker name");
            else tr.pos = tr.samplesAt (m.beat);
            repaint(); return; } }
        return;
    }
    if (e.y < 50)   // arranger row
    {
        for (int i = 0; i < (int) engine.sections.size(); ++i)
        {
            auto& s = engine.sections[(size_t) i]; if (b < s.start || b >= s.start + s.len) continue;
            if (e.mods.isPopupMenu()) sectionMenu (i); else if (e.getNumberOfClicks() > 1) rename ([this, i]() -> juce::String& { return engine.sections[(size_t) i].name; }, "Section name"); else tr.pos = tr.samplesAt (s.start);
            return;
        }
        drag = Drag::section; secA = tr.barAt (b).start; secB = tr.barStart (tr.barAt (b).bar + 1); repaint(); return;
    }
    // chord row
    int hit = -1; double best = -1; for (int i = 0; i < (int) engine.chords.size(); ++i) if (engine.chords[(size_t) i].beat <= b && engine.chords[(size_t) i].beat > best) { best = engine.chords[(size_t) i].beat; hit = i; }
    if (hit >= 0 && b - best > 16) hit = -1;
    chordMenu (tr.barAt (b).start, e.mods.isPopupMenu() || hit >= 0 ? hit : -1);
}
void Timeline::sectionMenu (int i)
{
    juce::PopupMenu m; m.addItem (1, "Loop this section"); m.addItem (2, "Duplicate (moves the rest of the song later)"); m.addItem (3, "Move earlier"); m.addItem (4, "Move later");
    m.addItem (5, "Rename"); m.addItem (6, "Clear contents (keep the bars)"); m.addItem (7, "Delete section (close the gap)");
    m.showMenuAsync ({}, [this, i] (int r)
    {
        if (! juce::isPositiveAndBelow (i, (int) engine.sections.size())) return; auto s = engine.sections[(size_t) i];
        switch (r)
        {
            case 1: engine.transport.loopStart = s.start; engine.transport.loopEnd = s.start + s.len; engine.transport.looping = true; break;
            case 2: engine.duplicateSection (i); if (notify) notify (s.name + " duplicated"); break;
            case 3: if (! engine.moveSection (i, -1) && notify) notify ("Already the first section"); break;
            case 4: if (! engine.moveSection (i, 1) && notify) notify ("Already the last section"); break;
            case 5: rename ([this, i]() -> juce::String& { return engine.sections[(size_t) i].name; }, "Section name"); break;
            case 6: engine.deleteSection (i, true); break;
            case 7: engine.deleteSection (i, false); break;
            default: return;
        }
        updateSize(); repaint(); if (changed) changed();
    });
}
void Timeline::chordMenu (double beat, int existing)
{
    static const juce::StringArray roots { "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B" }, quals { "", "m", "7", "maj7", "m7", "sus2", "sus4", "dim", "aug", "9", "m9" };
    juce::PopupMenu m; m.addSectionHeader (existing >= 0 ? "Change " + engine.chords[(size_t) existing].name : "Add a chord at bar " + juce::String (engine.transport.barAt (beat).bar + 1));
    for (int r = 0; r < 12; ++r) { juce::PopupMenu q; for (int k = 0; k < quals.size(); ++k) q.addItem (1000 + r * 100 + k, roots[r] + quals[k]); m.addSubMenu (roots[r], q); }
    if (existing >= 0) { m.addSeparator(); m.addItem (1, "Delete chord"); }
    m.showMenuAsync ({}, [this, beat, existing] (int r)
    {
        if (r == 1 && existing >= 0) engine.chords.erase (engine.chords.begin() + existing);
        else if (r >= 1000) { const auto name = roots[(r - 1000) / 100] + quals[(r - 1000) % 100];
            if (existing >= 0) engine.chords[(size_t) existing].name = name; else { engine.chords.push_back ({ beat, name }); std::sort (engine.chords.begin(), engine.chords.end(), [] (auto& a, auto& b) { return a.beat < b.beat; }); } }
        repaint();
    });
}
void Timeline::rename (std::function<juce::String&()> get, const juce::String& title)
{
    auto* w = new juce::AlertWindow (title, {}, juce::MessageBoxIconType::NoIcon); w->addTextEditor ("n", get()); w->addButton ("Save", 1, juce::KeyPress (juce::KeyPress::returnKey)); w->addButton ("Cancel", 0);
    w->enterModalState (true, juce::ModalCallbackFunction::create ([this, w, get] (int ok) { if (ok) { const auto t = w->getTextEditorContents ("n").trim(); if (t.isNotEmpty()) get() = t; } repaint(); }), true);
}
void Timeline::mouseDoubleClick (const juce::MouseEvent& e)
{
    if (e.y < RULER) return;
    const int ti = (e.y - RULER) / LANE; if (ti < 0 || ti >= (int) engine.tracks.size()) return;
    auto& t = *engine.tracks[(size_t) ti];
    if (sel.clip >= 0 && ! sel.audio) { if (t.src()->drumKit.load() && openStepSeq) openStepSeq (sel.track, sel.clip); else if (openPianoRoll) openPianoRoll (sel.track, sel.clip); return; }
    if (sel.clip >= 0 && sel.audio) { if (openAudioEditor) openAudioEditor (sel.track, sel.clip); return; }
    if (t.isAudio) return;
    MidiClip c; c.name = t.name; c.start = std::floor (e.x / (double) ppb / 4) * 4; c.length = 4;
    { const juce::ScopedLock sl (t.src()->lock); t.src()->midiClips.push_back (c); sel = { ti, (int) t.src()->midiClips.size() - 1, false }; }
    updateSize(); repaint(); if (openPianoRoll) openPianoRoll (sel.track, sel.clip);
}
void Timeline::filesDropped (const juce::StringArray& files, int x, int y)
{
    int ti = (y - RULER) / LANE; double beat = juce::jmax (0.0, x / (double) ppb);
    Track* t = (ti >= 0 && ti < (int) engine.tracks.size() && engine.tracks[(size_t) ti]->isAudio) ? engine.tracks[(size_t) ti].get() : nullptr;
    for (auto& f : files)
    {
        juce::File file (f);
        if (t == nullptr) t = &engine.addTrack (true, file.getFileNameWithoutExtension());
        if (engine.addAudioFile (*t, file, beat)) beat = t->src()->audioClips.back().start + t->src()->audioClips.back().length;
    }
    updateSize(); repaint(); if (changed) changed();
}
void Timeline::deleteSelected()
{
    if (sel.clip < 0 || sel.track >= (int) engine.tracks.size()) return;
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    if (sel.audio) s->audioClips.erase (s->audioClips.begin() + sel.clip); else s->midiClips.erase (s->midiClips.begin() + sel.clip);
    sel = {}; repaint();
}
void Timeline::duplicateSelected()
{
    if (sel.clip < 0) return; auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    if (sel.audio) { auto c = s->audioClips[(size_t) sel.clip]; c.start += c.length; s->audioClips.push_back (c); sel.clip = (int) s->audioClips.size() - 1; }
    else { auto c = s->midiClips[(size_t) sel.clip]; c.start += c.length; s->midiClips.push_back (c); sel.clip = (int) s->midiClips.size() - 1; }
    updateSize(); repaint();
}
void Timeline::splitSelected()
{
    if (sel.clip < 0) { if (notify) notify ("Select a clip first"); return; }
    splitAt (std::round (engine.positionBeats() * 4) / 4);
}
void Timeline::splitAt (double at)
{
    if (sel.clip < 0 || sel.track >= (int) engine.tracks.size()) return;
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    if (sel.audio)
    {
        auto& c = s->audioClips[(size_t) sel.clip]; if (at <= c.start || at >= c.start + c.length) return;
        auto d = c; const double cut = at - c.start, L = c.loopLen > 0 && c.loopLen < c.length ? c.loopLen : 0;
        d.start = at; d.length = c.length - cut; d.offsetSec += (L > 0 ? std::fmod (cut, L) : cut) * 60.0 / engine.transport.bpm.load();
        d.loopLen = 0; if (L > 0) d.length = juce::jmin (d.length, L - std::fmod (cut, L));
        c.length = cut; if (L > 0 && c.length <= L) c.loopLen = 0; c.fadeOut = 0; d.fadeIn = 0;
        s->audioClips.push_back (d); sel.clip = (int) s->audioClips.size() - 1;
    }
    else
    {
        auto& c = s->midiClips[(size_t) sel.clip]; if (at <= c.start || at >= c.start + c.length) return;
        if (c.loopLen > 0 && c.loopLen < c.length)   // expand the loop into real notes first so both halves sound the same
        {
            std::vector<Note> all; for (double o = 0; o < c.length - 1e-9; o += c.loopLen) for (auto& n : c.notes) if (n.start < c.loopLen && o + n.start < c.length) all.push_back ({ n.pitch, o + n.start, juce::jmin (n.length, c.loopLen - n.start), n.vel });
            c.notes = all; c.loopLen = 0;
        }
        auto d = c; const double cut = at - c.start; d.start = at; d.length = c.length - cut; d.notes.clear();
        for (auto& n : c.notes) if (n.start >= cut) d.notes.push_back ({ n.pitch, n.start - cut, n.length, n.vel });
        c.notes.erase (std::remove_if (c.notes.begin(), c.notes.end(), [cut] (auto& n) { return n.start >= cut; }), c.notes.end()); c.length = cut;
        for (auto& n : c.notes) n.length = juce::jmin (n.length, cut - n.start);
        s->midiClips.push_back (d); sel.clip = (int) s->midiClips.size() - 1;
    }
    repaint(); if (changed) changed();
}
void Timeline::copySelected (bool cut)
{
    if (sel.clip < 0) { if (notify) notify ("Select a clip first"); return; }
    {
        auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
        clipboard.has = true; clipboard.audio = sel.audio;
        if (sel.audio) clipboard.a = s->audioClips[(size_t) sel.clip]; else clipboard.m = s->midiClips[(size_t) sel.clip];
    }
    if (cut) deleteSelected();
    if (notify) notify (cut ? "Cut - select a track and press Cmd+V" : "Copied - press Cmd+V to paste at the playhead");
}
void Timeline::paste()
{
    if (! clipboard.has) { if (notify) notify ("Nothing copied yet"); return; }
    int ti = engine.selected;
    auto fits = [&] (int i) { return i >= 0 && i < (int) engine.tracks.size() && engine.tracks[(size_t) i]->isAudio == clipboard.audio; };
    if (! fits (ti)) { ti = -1; for (int i = 0; i < (int) engine.tracks.size(); ++i) if (fits (i)) { ti = i; break; } }
    if (ti < 0) { if (notify) notify ("No track can hold this clip"); return; }
    const double at = std::round (engine.positionBeats() * 4) / 4;
    auto* s = engine.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock);
    if (clipboard.audio) { auto c = clipboard.a; c.start = at; s->audioClips.push_back (c); sel = { ti, (int) s->audioClips.size() - 1, true }; }
    else { auto c = clipboard.m; c.start = at; s->midiClips.push_back (c); sel = { ti, (int) s->midiClips.size() - 1, false }; }
    updateSize(); repaint(); if (changed) changed();
}
void Timeline::toggleClipLoop()
{
    if (sel.clip < 0) return; auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    double& lp = sel.audio ? s->audioClips[(size_t) sel.clip].loopLen : s->midiClips[(size_t) sel.clip].loopLen;
    double& ln = sel.audio ? s->audioClips[(size_t) sel.clip].length : s->midiClips[(size_t) sel.clip].length;
    if (lp > 0) lp = 0; else { lp = ln; ln *= 2; }
    updateSize(); repaint(); if (notify) notify (lp > 0 ? "Clip loop on - drag the pink corner to repeat it more" : "Clip loop off");
}
void Timeline::loopToSelection()
{
    if (sel.clip < 0) { engine.transport.looping = ! engine.transport.looping.load(); repaint(); if (changed) changed(); return; }
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    const double st = sel.audio ? s->audioClips[(size_t) sel.clip].start : s->midiClips[(size_t) sel.clip].start;
    const double ln = sel.audio ? s->audioClips[(size_t) sel.clip].length : s->midiClips[(size_t) sel.clip].length;
    engine.transport.loopStart = st; engine.transport.loopEnd = st + ln; engine.transport.looping = true; repaint(); if (changed) changed();
}
void Timeline::setFade (bool in, double beats)
{
    if (sel.clip < 0 || ! sel.audio) return; auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    auto& c = s->audioClips[(size_t) sel.clip]; (in ? c.fadeIn : c.fadeOut) = juce::jlimit (0.0, c.length / 2, beats); repaint();
}

//============================================================================== TrackHeader
TrackHeader::TrackHeader (Engine& e, int idx) : index (idx), engine (e)
{
    auto& t = *engine.tracks[(size_t) idx];
    name.addMouseListener (this, false);   // right-click the name for the transpose menu
    name.setText (t.name, juce::dontSendNotification); name.setEditable (false, true); name.setFont (juce::FontOptions (14.0f, juce::Font::bold));
    name.onTextChange = [this] { engine.tracks[(size_t) index]->name = name.getText(); };
    for (auto* b : { &m, &s, &r, &i }) { b->setClickingTogglesState (true); addAndMakeVisible (b); }
    m.setColour (juce::TextButton::buttonOnColourId, juce::Colour (0xfff59e0b)); s.setColour (juce::TextButton::buttonOnColourId, juce::Colour (0xff3b82f6)); r.setColour (juce::TextButton::buttonOnColourId, juce::Colour (0xffe11d48));
    m.setTooltip ("Mute"); s.setTooltip ("Solo"); r.setTooltip ("Arm for recording"); i.setTooltip ("Monitor input");
    m.onClick = [this] { engine.tracks[(size_t) index]->mute = m.getToggleState(); engine.updateMix(); };
    s.onClick = [this] { engine.tracks[(size_t) index]->solo = s.getToggleState(); engine.updateMix(); };
    r.onClick = [this] { engine.tracks[(size_t) index]->src()->armed = r.getToggleState(); };
    i.onClick = [this] { engine.tracks[(size_t) index]->src()->monitor = i.getToggleState(); };
    i.setVisible (t.isAudio);
    del.onClick = [this] { const int k = index; juce::MessageManager::callAsync ([eng = &engine, k] { eng->removeTrack (k); }); };
    vol.setSliderStyle (juce::Slider::LinearHorizontal); vol.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0); vol.setRange (-60, 6, 0.1); vol.setDoubleClickReturnValue (true, 0);
    vol.onValueChange = [this] { engine.tracks[(size_t) index]->volDb = (float) vol.getValue(); engine.updateMix(); };
    pan.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag); pan.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0); pan.setRange (-1, 1, 0.01); pan.setDoubleClickReturnValue (true, 0);
    pan.onValueChange = [this] { engine.tracks[(size_t) index]->pan = (float) pan.getValue(); engine.updateMix(); };
    for (juce::Component* c : { (juce::Component*) &name, (juce::Component*) &del, (juce::Component*) &vol, (juce::Component*) &pan }) addAndMakeVisible (c);
    refresh();
}
void TrackHeader::refresh()
{
    auto& t = *engine.tracks[(size_t) index];
    m.setToggleState (t.mute, juce::dontSendNotification); s.setToggleState (t.solo, juce::dontSendNotification); r.setToggleState (t.src()->armed.load(), juce::dontSendNotification);
    vol.setValue (t.volDb, juce::dontSendNotification); pan.setValue (t.pan, juce::dontSendNotification); name.setText (t.name, juce::dontSendNotification);
    repaint();
}
void TrackHeader::paint (juce::Graphics& g)
{
    auto& t = *engine.tracks[(size_t) index];
    g.fillAll (engine.selected == index ? col::panel2 : col::panel);
    g.setColour (t.colour); g.fillRect (0, 0, 5, getHeight());
    g.setColour (col::line); g.drawHorizontalLine (getHeight() - 1, 0, (float) getWidth());
    const float pk = t.str()->peak.load(), db = juce::Decibels::gainToDecibels (pk, -60.0f), f = juce::jlimit (0.0f, 1.0f, (db + 60) / 66);
    g.setColour (db > -1 ? juce::Colours::red : db > -9 ? juce::Colours::orange : juce::Colour (0xff22c55e)); g.fillRect (getWidth() - 8, (int) (getHeight() * (1 - f)), 4, (int) (getHeight() * f));
    g.setColour (col::mute); g.setFont (11.0f);
    juce::String sub = t.isAudio ? "Audio" : (t.instrument.node ? t.instrument.displayName() : "No instrument");
    if (const int tp = t.src()->transpose.load(); tp != 0 && ! t.src()->drumKit.load()) sub << "   " << (tp > 0 ? "+" : "") << tp << " st";
    g.drawText (sub, 10, getHeight() - 18, getWidth() - 20, 14, juce::Justification::left);
    if (hover) { g.setColour (col::rose); g.drawRect (getLocalBounds(), 2); }
}
void TrackHeader::mouseDown (const juce::MouseEvent& e)
{
    if (e.eventComponent != this && ! e.mods.isPopupMenu()) return;   // buttons/sliders handle their own clicks
    engine.selectTrack (index);
    if (! e.mods.isPopupMenu()) return;
    auto* s = engine.tracks[(size_t) index]->src(); const int tp = s->transpose.load(); const bool drums = s->drumKit.load();
    juce::PopupMenu m; m.addSectionHeader ("Transpose track" + juce::String (tp ? juce::String (" (now ") + (tp > 0 ? "+" : "") + juce::String (tp) + ")" : juce::String()));
    m.addItem (1, "Up a semitone", ! drums); m.addItem (2, "Down a semitone", ! drums); m.addItem (3, "Up an octave", ! drums); m.addItem (4, "Down an octave", ! drums); m.addItem (5, "Reset", tp != 0);
    if (drums) m.addItem (-1, "Drum kits don't transpose (each note is a different drum)", false);
    m.showMenuAsync ({}, [this, s] (int r) { static const int d[] { 0, 1, -1, 12, -12 }; if (r >= 1 && r <= 4) s->transpose = juce::jlimit (-36, 36, s->transpose.load() + d[r]); else if (r == 5) s->transpose = 0; else return; repaint(); if (changed) changed(); });
}
void TrackHeader::itemDropped (const SourceDetails& d)
{
    hover = false; repaint(); const auto desc = d.description.toString();
    if (desc.startsWith ("fx:")) addFxTo (engine, engine.tracks[(size_t) index]->inserts, desc.fromFirstOccurrenceOf ("fx:", false, false));
    else if (auto* L = findLoop (desc.fromFirstOccurrenceOf ("loop:", false, false))) { engine.previewLoop (nullptr); engine.placeLoop (*L, index, playhead ? playhead() : 0, loopSemis ? loopSemis (*L) : 0); }
    engine.selectTrack (index); if (changed) changed();
}
void TrackHeader::resized()
{
    name.setBounds (8, 2, getWidth() - 44, 22); del.setBounds (getWidth() - 34, 4, 22, 20);
    int x = 10; for (auto* b : { &m, &s, &r, &i }) { if (b->isVisible() || b != &i) { b->setBounds (x, 26, 24, 20); x += 26; } }
    vol.setBounds (x + 2, 26, getWidth() - x - 50, 20); pan.setBounds (getWidth() - 44, 24, 26, 26);
}

//============================================================================== DevicePanel
std::vector<Slot>& DevicePanel::chain() { return showMaster || engine.tracks.empty() ? engine.masterInserts : engine.tracks[(size_t) engine.selected]->inserts; }
void DevicePanel::refresh()
{
    items.clear();
    const bool hasTrack = ! engine.tracks.empty() && ! showMaster; Track* t = hasTrack ? engine.tracks[(size_t) engine.selected].get() : nullptr;
    title.setText (showMaster ? "Master chain" : (t ? t->name + " — device chain" : "No track"), juce::dontSendNotification);
    title.setFont (juce::FontOptions (15.0f, juce::Font::bold)); addAndMakeVisible (title);
    auto card = [this] (const juce::String& nm, juce::AudioProcessor* proc, std::function<void()> onRemove, std::function<void()> onBypass, bool bypass, std::function<void (int)> onMove, bool isInst)
    {
        struct Card : juce::Component
        {
            juce::Label l; juce::TextButton edit { "Edit" }, by { "On" }, left { "<" }, right { ">" }, x { "x" }; bool inst = false;
            void paint (juce::Graphics& g) override { g.setColour (col::panel); g.fillRoundedRectangle (getLocalBounds().toFloat(), 8); g.setColour (inst ? col::rose : col::line); g.drawRoundedRectangle (getLocalBounds().toFloat().reduced (0.5f), 8, 1); }
            void resized() override { l.setBounds (8, 6, getWidth() - 16, 36); int bx = 8; for (auto* b : { &edit, &by, &left, &right, &x }) if (b->isVisible()) { b->setBounds (bx, getHeight() - 30, b == &edit ? 46 : 30, 22); bx += b == &edit ? 50 : 34; } }
        };
        auto* c = new Card(); c->inst = isInst; c->l.setText (nm, juce::dontSendNotification); c->l.setFont (juce::FontOptions (13.0f, juce::Font::bold)); c->l.setJustificationType (juce::Justification::topLeft);
        c->addAndMakeVisible (c->l); for (auto* b : { &c->edit, &c->by, &c->left, &c->right, &c->x }) c->addAndMakeVisible (b);
        c->edit.onClick = [this, proc] { if (proc && openEditor) openEditor (*proc); };
        c->by.setButtonText (bypass ? "Off" : "On"); c->by.onClick = onBypass; c->x.onClick = onRemove;
        c->left.onClick = [onMove] { if (onMove) onMove (-1); }; c->right.onClick = [onMove] { if (onMove) onMove (1); };
        if (isInst) { c->by.setVisible (false); c->left.setVisible (false); c->right.setVisible (false); c->x.setButtonText ("Change"); }
        items.add (c); addAndMakeVisible (c);
    };
    if (t && ! t->isAudio)
        card ("Instrument: " + (t->instrument.node ? t->instrument.displayName() : juce::String ("none")), t->instrument.node ? t->instrument.node->getProcessor() : nullptr,
              [this] { juce::MessageManager::callAsync ([this] { instrumentMenu(); }); }, {}, false, {}, true);
    auto& ch = chain();
    for (int k = 0; k < (int) ch.size(); ++k)
    {
        auto& s = ch[(size_t) k];
        card (s.displayName(), s.node ? s.node->getProcessor() : nullptr,
              [this, k] { juce::MessageManager::callAsync ([this, k] { engine.removeInsert (chain(), k); }); },
              [this, k] { juce::MessageManager::callAsync ([this, k] { chain()[(size_t) k].bypass = ! chain()[(size_t) k].bypass; engine.rewire(); refresh(); }); },
              s.bypass,
              [this, k] (int d) { juce::MessageManager::callAsync ([this, k, d] { auto& c = chain(); const int j = k + d; if (j < 0 || j >= (int) c.size()) return; std::swap (c[(size_t) k], c[(size_t) j]); engine.rewire(); refresh(); }); }, false);
    }
    auto* add = new juce::TextButton ("+ Add effect"); add->onClick = [this] { addEffectMenu(); }; items.add (add); addAndMakeVisible (add);
    resized(); repaint();
}
void DevicePanel::resized()
{
    title.setBounds (10, 4, getWidth() - 20, 22); int x = 10;
    for (auto* c : items) { const int w = dynamic_cast<juce::TextButton*> (c) ? 130 : 210; c->setBounds (x, 30, w, getHeight() - 40); x += w + 8; }
}
static void addPluginItems (juce::PopupMenu& m, const juce::Array<juce::PluginDescription>& types, bool instruments, int base)
{
    std::map<juce::String, juce::PopupMenu> byMaker;
    for (int i = 0; i < types.size(); ++i) if (types[i].isInstrument == instruments) byMaker[types[i].manufacturerName.isEmpty() ? "Other" : types[i].manufacturerName].addItem (base + i, types[i].name + " (" + types[i].pluginFormatName + ")");
    if (byMaker.empty()) m.addItem (-1, "No plugins found — use Plugins... to scan", false);
    for (auto& [maker, sub] : byMaker) m.addSubMenu (maker, sub);
}
void DevicePanel::addEffectMenu()
{
    juce::PopupMenu m, built, vocal, plug; const auto types = engine.knownPlugins.getTypes();
    static const juce::StringArray vocalIds { "tune", "deesser", "harmonizer", "doubler", "pitch" };
    vocal.addItem (900, "Vocal chain (Tune, EQ, De-esser, Compressor, Reverb)"); vocal.addSeparator();
    int i = 1; for (auto& b : builtIns()) { if (! b.instrument) (vocalIds.contains (b.id) ? vocal : built).addItem (i, b.name); ++i; }
    addPluginItems (plug, types, false, 1000);
    m.addSubMenu ("Vocal tools", vocal); m.addSubMenu ("Rose effects", built); m.addSubMenu ("VST3 / AU effects", plug);
    m.showMenuAsync ({}, [this, types] (int r)
    {
        juce::String err;
        if (r == 900)
        {
            auto& ch = chain(); auto has = [&] (const char* id) { for (auto& s : ch) if (s.builtInId == id) return true; return false; };
            auto add = [&] (const char* id, std::initializer_list<std::pair<const char*, float>> ps)
            { if (has (id) || engine.addInsert (ch, id, nullptr).isNotEmpty()) return; for (auto& [k, v] : ps) Engine::setParam (*ch.back().node->getProcessor(), k, v); };
            add ("tune", { { "speed", 20.0f } }); add ("eq", { { "lc", 90.0f }, { "mf", 300.0f }, { "mg", -2.0f }, { "hsg", 2.5f } });
            add ("deesser", { { "th", -32.0f } }); add ("comp", { { "th", -22.0f }, { "ra", 3.5f }, { "at", 6.0f }, { "re", 120.0f }, { "mk", 4.0f } });
            add ("reverb", { { "sz", 0.55f }, { "mx", 0.15f } });
        }
        else if (r >= 1000) { const auto d = types[r - 1000]; err = engine.addInsert (chain(), {}, &d); }
        else if (r >= 1) err = engine.addInsert (chain(), builtIns()[(size_t) r - 1].id, nullptr);
        if (err.isNotEmpty()) juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Couldn't load plugin", err);
        refresh();
    });
}
void DevicePanel::instrumentMenu()
{
    if (engine.tracks.empty()) return;
    juce::PopupMenu m, plug; const auto types = engine.knownPlugins.getTypes();
    juce::PopupMenu sounds; for (int k = 0; k < (int) soundLibrary().size(); ++k) sounds.addItem (100 + k, soundLibrary()[(size_t) k].name);
    m.addItem (1, "Rose Synth"); m.addItem (2, "Rose Drums"); m.addSubMenu ("Rose Sounds (real instruments)", sounds);
    addPluginItems (plug, types, true, 1000); m.addSubMenu ("VST3 / AU instruments", plug);
    m.showMenuAsync ({}, [this, types] (int r)
    {
        auto& t = *engine.tracks[(size_t) engine.selected]; juce::String err;
        if (r >= 1000) { const auto d = types[r - 1000]; err = engine.setInstrument (t, {}, &d); }
        else if (r == 1) err = engine.setInstrument (t, "synth", nullptr);
        else if (r == 2) err = engine.setInstrument (t, "drums", nullptr);
        else if (r >= 100) { err = engine.setInstrument (t, "sounds", nullptr); if (err.isEmpty()) Engine::setParam (*t.instrument.node->getProcessor(), "patch", juce::var (soundLibrary()[(size_t) r - 100].name)); }
        if (err.isNotEmpty()) juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Couldn't load instrument", err);
        refresh();
    });
}

//============================================================================== MainComponent
MainComponent::MainComponent()
{
    setLookAndFeel (&look);
    for (auto* b : { &bHome, &bPlay, &bStop, &bRec, &bLoop, &bClick, &bAddAudio, &bAddInst, &bMaster, &bPlugins, &bAudio, &bAbout, &bFile }) addAndMakeVisible (b);
    for (auto* b : { &bPointer, &bScissors }) { addAndMakeVisible (b); b->setClickingTogglesState (true); b->setRadioGroupId (77); }
    bPointer.setToggleState (true, juce::dontSendNotification);
    bPointer.setTooltip ("Pointer (1): move, resize, fade and loop clips"); bScissors.setTooltip ("Scissors (3): click a clip to split it - or Alt-click with any tool");
    bPointer.onClick = [this] { timeline.tool = Timeline::Tool::pointer; timeline.setMouseCursor (juce::MouseCursor::NormalCursor); };
    bScissors.onClick = [this] { timeline.tool = Timeline::Tool::scissors; timeline.setMouseCursor (juce::MouseCursor::CrosshairCursor); };
    timeline.notify = [this] (const juce::String& m) { statusText = m; statusUntil = juce::Time::getMillisecondCounter() + 2500; repaint(); };
    bAbout.setTooltip ("About Rose Studio");
    bAbout.onClick = [] { juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::InfoIcon, "Rose Studio " + juce::String (ProjectInfo::versionString) + " (build " + juce::String (Updater::currentBuild()) + ")",
        "by Moshe Rosenfeld\n\nHosts VST3" + juce::String ((juce::SystemStats::getOperatingSystemType() & juce::SystemStats::MacOSX) != 0 ? " and Audio Unit" : "") + " plugins, with 19 built-in effects (Rose Tune pitch correction, de-esser, harmonizer, doubler and more), Rose Synth, Rose Drums, Rose Sounds, templates, recording, piano roll and offline bounce.\n\n"
        "Rose Sounds uses the FluidR3 GM SoundFont by Frank Wen (MIT licence), rendered by the midi-js-soundfonts project (CC BY 3.0).\n\n"
        "Free open-source plugins that work in Rose: Surge XT, Vital, Dexed, OB-Xd, Odin 2, Helm. Install one, then press Plugins... to scan.\n\n"
        "Shortcuts: Space play, R record, Cmd+D duplicate, Cmd+E split, Cmd+S save, Delete remove clip.\nDouble-click a fader or knob to reset it."); };
    bLoop.setClickingTogglesState (true); bClick.setClickingTogglesState (true); bMaster.setClickingTogglesState (true);
    bLoop.setToggleState (true, juce::dontSendNotification); bRec.setColour (juce::TextButton::buttonOnColourId, juce::Colour (0xffe11d48));
    bHome.onClick = [this] { engine.toStart(); };
    bPlay.onClick = [this] { engine.transport.playing.load() ? engine.stop() : engine.play(); };
    bStop.onClick = [this] { engine.stop(); timeline.updateSize(); timeline.repaint(); };
    bRec.onClick = [this] { engine.record(); bool any = false; for (auto& t : engine.tracks) any |= t->src()->armed.load();
                            if (! any) juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::InfoIcon, "Arm a track", "Press R on a track header to arm it for recording."); };
    bLoop.onClick = [this] { engine.transport.looping = bLoop.getToggleState(); timeline.repaint(); };
    bClick.onClick = [this] { engine.transport.metronome = bClick.getToggleState(); };
    bAddAudio.onClick = [this] { engine.addTrack (true); };
    bAddInst.onClick = [this] { addInstrumentMenu(); };
    bTemplates.onClick = [this] { templatesMenu(); };
    addChildComponent (bUpdate); bUpdate.setColour (juce::TextButton::buttonColourId, col::rose);
    bUpdate.onClick = [this] { offerUpdate (pendingUpdate, true); };
    // look for a newer release a few seconds after launch (silent when offline or up to date)
    juce::Timer::callAfterDelay (3000, [w = juce::Component::SafePointer<MainComponent> (this)] { Updater::check ([w] (Updater::Release r) { if (w && r.build > 0) w->offerUpdate (r, true); }); });
    bTemplates.setTooltip ("Start a new session from a template: EDM, pop, trap, R&B, simcha, orchestral, podcast");
    bMaster.onClick = [this] { devices.showMaster = bMaster.getToggleState(); devices.refresh(); };
    bPlugins.onClick = [this] { showScanner(); }; bAudio.onClick = [this] { showAudioSettings(); };
    bSave.onClick = [this] { save(); }; bOpen.onClick = [this] { open(); }; bBounce.onClick = [this] { bounce(); };
    bFile.setTooltip ("Templates, open, save and bounce");
    bFile.onClick = [this]
    {
        juce::PopupMenu m; m.addItem (1, "New from template..."); m.addSeparator();
        m.addItem (2, "Open session...\tCmd+O"); m.addItem (3, "Save session\tCmd+S"); m.addSeparator(); m.addItem (4, "Bounce to WAV...");
        m.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (&bFile), [this] (int r) { if (r == 1) templatesMenu(); else if (r == 2) open(); else if (r == 3) save(); else if (r == 4) bounce(); });
    };

    bpm.setSliderStyle (juce::Slider::IncDecButtons); bpm.setRange (40, 240, 1); bpm.setDoubleClickReturnValue (true, 120); bpm.setValue (engine.transport.bpm.load(), juce::dontSendNotification);
    bpm.setTextBoxStyle (juce::Slider::TextBoxLeft, false, 46, 26);
    bpm.onValueChange = [this] { engine.transport.bpm = bpm.getValue(); timeline.updateSize(); timeline.repaint(); };
    time.setFont (juce::FontOptions (20.0f, juce::Font::bold)); time.setColour (juce::Label::backgroundColourId, juce::Colours::black); time.setColour (juce::Label::textColourId, juce::Colour (0xffffd6e5)); time.setJustificationType (juce::Justification::centred);
    for (juce::Component* c : { (juce::Component*) &bpm, (juce::Component*) &time, (juce::Component*) &bpmLabel, (juce::Component*) &headerHolder, (juce::Component*) &viewport, (juce::Component*) &devices, (juce::Component*) &keys }) addAndMakeVisible (c);

    viewport.setViewedComponent (&timeline, false); viewport.setScrollBarsShown (true, true);
    timeline.addAndMakeVisible (playhead);
    viewport.moved = [this] { for (auto* h : headers) h->setTopLeftPosition (0, Timeline::RULER + h->index * Timeline::LANE - viewport.getViewPositionY()); };
    timeline.openPianoRoll = [this] (int ti, int ci)
    {
        engine.selectTrack (ti);
        auto* w = new juce::DocumentWindow ("Piano roll — " + engine.tracks[(size_t) ti]->name, col::panel, juce::DocumentWindow::closeButton);
        struct Holder : juce::Viewport { };
        auto* vp = new juce::Viewport(); auto* pr = new PianoRoll (engine, *engine.tracks[(size_t) ti], ci); pr->setSize (1000, (108 - 24 + 1) * 6); vp->setViewedComponent (pr, true);
        vp->setSize (1000, 480); w->setContentOwned (vp, true); w->setUsingNativeTitleBar (true); w->setResizable (true, false); w->centreWithSize (1000, 480); w->setAlwaysOnTop (true); w->setVisible (true);
        struct Closer { static void install (juce::DocumentWindow* win, std::unique_ptr<juce::DocumentWindow>& slot) { slot.reset (win); } };
        Closer::install (w, pianoRollWindow);
    };
    timeline.changed = [this] { repaint(); for (auto* h : headers) h->repaint(); devices.refresh(); };
    timeline.openAudioEditor = [this] (int ti, int ci) { toggleWindow ("audio:" + juce::String (ti) + ":" + juce::String (ci), "Audio - " + engine.tracks[(size_t) ti]->name, [this, ti, ci] { return new AudioEditorPanel (engine, ti, ci); }); };
    timeline.openStepSeq = [this] (int ti, int ci) { toggleWindow ("steps:" + juce::String (ti) + ":" + juce::String (ci), "Step sequencer - " + engine.tracks[(size_t) ti]->name, [this, ti, ci] { return new StepSeqPanel (engine, ti, ci); }); };
    addAndMakeVisible (bWindows); bWindows.onClick = [this] { windowsMenu(); };
    bWindows.setTooltip ("Mixer, chord generator, tuner, spectrum, loudness, stereo scope, reference A/B, tempo");
    // Browser: loops and effects to drag anywhere
    addAndMakeVisible (browser); addAndMakeVisible (bBrowser); bBrowser.setClickingTogglesState (true); bBrowser.setToggleState (true, juce::dontSendNotification);
    bBrowser.setTooltip ("Show the loop and effect browser");
    bBrowser.onClick = [this] { showBrowser = bBrowser.getToggleState(); if (! showBrowser) engine.previewLoop (nullptr); resized(); };
    browser.selectedTrack = [this] { return engine.selected; };
    browser.playhead = [this] { return engine.transport.beatsAt (engine.transport.pos.load()); };
    browser.changed = [this] { timeline.updateSize(); timeline.repaint(); devices.refresh(); };
    timeline.loopSemis = [this] (const LoopInfo& L) { return browser.keySemis (L); };
    devices.openEditor = [this] (juce::AudioProcessor& p) { openEditor (p); };
    keys.setAvailableRange (24, 108); keys.setLowestVisibleKey (48);
    engine.addChangeListener (this);
    rebuildHeaders(); devices.refresh(); timeline.updateSize();
    setWantsKeyboardFocus (true);
    setSize (1360, 860);
    if (engine.settings != nullptr && engine.settings->getBoolValue ("songRows", false)) juce::MessageManager::callAsync ([this] { setSongRows (true); });
    startTimerHz (30);
    if (engine.knownPlugins.getNumTypes() == 0)
        juce::MessageManager::callAsync ([this] { showScanner(); });
}
MainComponent::~MainComponent() { engine.removeChangeListener (this); toolWindows.clear(); pianoRollWindow = nullptr; pluginWindows.clear(); setLookAndFeel (nullptr); }

void MainComponent::paint (juce::Graphics& g)
{
    g.fillAll (col::bg); g.setColour (col::panel); g.fillRect (0, 0, getWidth(), 48);
    g.setColour (col::ink); g.setFont (juce::FontOptions (17.0f, juce::Font::bold)); g.drawText ("Rose", 12, 8, 70, 32, juce::Justification::left);
    if (Timeline::songRows)   // labels for the arranger and chord rows, beside the timeline
    {
        const auto h = headerHolder.getBounds(); g.setColour (col::mute); g.setFont (11.0f);
        g.drawText ("Markers & tempo", h.getX(), h.getY() + 14, h.getWidth() - 10, 14, juce::Justification::right);
        g.drawText ("Arranger - drag to add", h.getX(), h.getY() + 30, h.getWidth() - 10, 18, juce::Justification::right);
        g.drawText ("Chords - click to add", h.getX(), h.getY() + 52, h.getWidth() - 10, 18, juce::Justification::right);
    }
    if (statusText.isNotEmpty() && juce::Time::getMillisecondCounter() < statusUntil)
    {
        auto r = juce::Rectangle<int> (0, 0, 420, 30).withCentre ({ getWidth() / 2, getHeight() - 90 });
        g.setColour (col::ink); g.fillRoundedRectangle (r.toFloat(), 15); g.setColour (col::bg); g.setFont (14.0f); g.drawText (statusText, r, juce::Justification::centred);
    }
}
void MainComponent::resized()
{
    auto r = getLocalBounds(); auto top = r.removeFromTop (48).reduced (8, 8); top.removeFromLeft (70);
    for (auto* b : { &bHome, &bPlay, &bStop, &bRec, &bLoop, &bClick }) { b->setBounds (top.removeFromLeft (b == &bHome ? 36 : 50)); top.removeFromLeft (4); }
    top.removeFromLeft (6); bPointer.setBounds (top.removeFromLeft (62)); top.removeFromLeft (2); bScissors.setBounds (top.removeFromLeft (70)); top.removeFromLeft (8);
    time.setBounds (top.removeFromLeft (104)); top.removeFromLeft (8);
    bpmLabel.setBounds (top.removeFromLeft (36)); bpm.setBounds (top.removeFromLeft (110)); top.removeFromLeft (10);
    bBrowser.setBounds (top.removeFromLeft (72)); top.removeFromLeft (4); bWindows.setBounds (top.removeFromLeft (78)); top.removeFromLeft (6);
    bAbout.setBounds (top.removeFromRight (32)); top.removeFromRight (4);
    if (bUpdate.isVisible()) { bUpdate.setBounds (top.removeFromRight (150)); top.removeFromRight (4); }
    {   // right-hand buttons share what's left, shrinking together on small windows
        juce::Button* rb[] { &bFile, &bAudio, &bPlugins, &bMaster, &bAddInst, &bAddAudio }; const int want[] { 64, 100, 82, 76, 104, 82 };
        int total = 0; for (int w : want) total += w + 4; const float k = juce::jmin (1.0f, (float) top.getWidth() / (float) total);
        for (int i = 0; i < 6; ++i) { rb[i]->setBounds (top.removeFromRight (juce::roundToInt (want[i] * k))); top.removeFromRight (4); }
    }
    keys.setBounds (r.removeFromBottom (64));
    devices.setBounds (r.removeFromBottom (170));
    browser.setVisible (showBrowser); if (showBrowser) browser.setBounds (r.removeFromLeft (250));
    headerHolder.setBounds (r.removeFromLeft (240));
    viewport.setBounds (r);
    for (auto* h : headers) h->setBounds (0, Timeline::RULER + h->index * Timeline::LANE - viewport.getViewPositionY(), 240, Timeline::LANE);
}
void MainComponent::rebuildHeaders()
{
    headers.clear();
    for (int i = 0; i < (int) engine.tracks.size(); ++i)
    {
        auto* h = headers.add (new TrackHeader (engine, i)); headerHolder.addAndMakeVisible (h);
        h->changed = [this] { timeline.updateSize(); timeline.repaint(); devices.refresh(); };
        h->playhead = [this] { return engine.transport.beatsAt (engine.transport.pos.load()); };
        h->loopSemis = [this] (const LoopInfo& L) { return browser.keySemis (L); };
    }
    lastTrackCount = (int) engine.tracks.size(); resized();
}
void MainComponent::changeListenerCallback (juce::ChangeBroadcaster*)
{
    if ((int) engine.tracks.size() != lastTrackCount) rebuildHeaders(); else for (auto* h : headers) h->refresh();
    devices.refresh(); timeline.updateSize(); timeline.repaint();
    bLoop.setToggleState (engine.transport.looping.load(), juce::dontSendNotification);
    bpm.setValue (engine.transport.bpm.load(), juce::dontSendNotification);
}
void MainComponent::timerCallback()
{
    const double b = engine.positionBeats(); const auto bi = engine.transport.barAt (b); const int bar = bi.bar + 1, beat = (int) (bi.beat + 1e-6) + 1, six = (int) (std::fmod (bi.beat, 1.0) * 4 + 1e-6) + 1;
    time.setText (juce::String (bar) + "." + juce::String (beat) + "." + juce::String (six), juce::dontSendNotification);
    bPlay.setButtonText (engine.transport.playing.load() ? "Pause" : "Play");
    bRec.setToggleState (engine.transport.recording.load(), juce::dontSendNotification);
    const int x = (int) (b * timeline.ppb); playhead.setBounds (x, 0, 2, timeline.getHeight());
    if (engine.transport.playing.load())
    {
        const auto view = viewport.getViewArea();
        if (x > view.getRight() - 40 || x < view.getX()) viewport.setViewPosition (juce::jmax (0, x - 80), view.getY());
        if (engine.transport.recording.load()) timeline.repaint();
    }
    for (auto* h : headers) h->repaint (h->getWidth() - 10, 0, 10, h->getHeight());
    hub.pump (engine);
    {
        const bool fg = juce::Process::isForegroundProcess();
        for (auto* w : toolWindows) { if (w->isAlwaysOnTop() != fg) w->setAlwaysOnTop (fg); if (auto* t = dynamic_cast<Ticking*> (w->getContentComponent())) t->tick(); }
    }
    if (statusText.isNotEmpty() && juce::Time::getMillisecondCounter() >= statusUntil) { statusText = {}; repaint(); }
    // keep plugin and piano-roll windows above Rose, but not above other apps when Rose is in the background
    if (++floatCheck % 10 == 0)
    {
        const bool fg = juce::Process::isForegroundProcess();
        for (auto* w : pluginWindows) if (w->isAlwaysOnTop() != fg) w->setAlwaysOnTop (fg);
        if (pianoRollWindow != nullptr && pianoRollWindow->isAlwaysOnTop() != fg) pianoRollWindow->setAlwaysOnTop (fg);
    }
}
bool MainComponent::keyPressed (const juce::KeyPress& k)
{
    if (k == juce::KeyPress::spaceKey) { bPlay.triggerClick(); return true; }
    if (k.getModifiers().isShiftDown() && ! k.getModifiers().isCommandDown() && ! k.getModifiers().isAltDown())
    {
        const auto ch = juce::CharacterFunctions::toLowerCase ((juce::juce_wchar) k.getKeyCode());
        if (ch == 'x') { toggleWindow ("mixer", "Mixer", [this] { return new MixerPanel (engine, [this] (juce::AudioProcessor& p) { openEditor (p); }); }); return true; }
        if (ch == 'g') { toggleWindow ("chordgen", "Chord generator", [this] { return new ChordGenPanel (engine, [this] { timeline.updateSize(); timeline.repaint(); }); }); return true; }
        if (ch == 'b') { if (! engine.hasReference()) { statusText = "Load a reference track first (Windows > Reference A/B)"; statusUntil = juce::Time::getMillisecondCounter() + 2500; repaint(); return true; }
                         engine.refOn = ! engine.refOn.load(); statusText = engine.refOn.load() ? "B - reference" : "A - your mix"; statusUntil = juce::Time::getMillisecondCounter() + 1500; repaint(); return true; }
        if (ch == 'm') { engine.addMarker (engine.positionBeats()); timeline.repaint(); return true; }
    }
    if (! k.getModifiers().isAnyModifierKeyDown() && (k.getTextCharacter() == ',' || k.getTextCharacter() == '.')) { jumpMarker (k.getTextCharacter() == '.' ? 1 : -1); return true; }
    if ((k.getKeyCode() == juce::KeyPress::upKey || k.getKeyCode() == juce::KeyPress::downKey) && k.getModifiers().isAltDown())
    { timeline.pitchSelected ((k.getKeyCode() == juce::KeyPress::upKey ? 1 : -1) * (k.getModifiers().isShiftDown() ? 12 : 1)); return true; }
    if (k == juce::KeyPress::deleteKey || k == juce::KeyPress::backspaceKey) { timeline.deleteSelected(); return true; }
    if (k == juce::KeyPress ('d', juce::ModifierKeys::commandModifier, 0)) { timeline.duplicateSelected(); return true; }
    if (k == juce::KeyPress ('e', juce::ModifierKeys::commandModifier, 0)) { timeline.splitSelected(); return true; }
    if (k == juce::KeyPress ('x', juce::ModifierKeys::commandModifier, 0)) { timeline.copySelected (true); return true; }
    if (k == juce::KeyPress ('c', juce::ModifierKeys::commandModifier, 0)) { timeline.copySelected (false); return true; }
    if (k == juce::KeyPress ('v', juce::ModifierKeys::commandModifier, 0)) { timeline.paste(); return true; }
    if (k == juce::KeyPress ('l', juce::ModifierKeys::commandModifier, 0)) { timeline.loopToSelection(); bLoop.setToggleState (engine.transport.looping.load(), juce::dontSendNotification); return true; }
    if (! k.getModifiers().isAnyModifierKeyDown())
    {
        const auto ch = juce::CharacterFunctions::toLowerCase (k.getTextCharacter());
        if (ch == 'b') { timeline.splitSelected(); return true; }
        if (ch == 'c') { bLoop.triggerClick(); return true; }
        if (ch == '1') { bPointer.triggerClick(); return true; }
        if (ch == '3') { bScissors.triggerClick(); return true; }
    }
    if (k == juce::KeyPress ('s', juce::ModifierKeys::commandModifier, 0)) { save(); return true; }
    if (k == juce::KeyPress ('o', juce::ModifierKeys::commandModifier, 0)) { open(); return true; }
    if (k.getTextCharacter() == 'r' && ! k.getModifiers().isAnyModifierKeyDown()) { bRec.triggerClick(); return true; }
    if (k == juce::KeyPress::homeKey) { engine.toStart(); return true; }
    return false;
}
void MainComponent::openEditor (juce::AudioProcessor& p)
{
    for (auto* w : pluginWindows) if (w->proc == &p) { w->toFront (true); return; }
    pluginWindows.add (new PluginWindow (p, [this] (PluginWindow* w) { juce::MessageManager::callAsync ([this, w] { pluginWindows.removeObject (w); }); }));
}
void MainComponent::showScanner()
{
    juce::DialogWindow::LaunchOptions o;
    auto* list = new juce::PluginListComponent (engine.formats, engine.knownPlugins, engine.deadMansPedal, engine.settings.get(), true);
    list->setSize (720, 520); o.content.setOwned (list);
    o.dialogTitle = "Plugins — click Options... > Scan for new or updated VST3 / AudioUnit plug-ins"; o.dialogBackgroundColour = col::panel; o.useNativeTitleBar = true; o.resizable = true;
    o.launchAsync();
}
void MainComponent::showAudioSettings()
{
    juce::DialogWindow::LaunchOptions o;
    auto* sel = new juce::AudioDeviceSelectorComponent (engine.deviceManager, 0, 8, 2, 8, true, false, true, false);
    sel->setSize (560, 440); o.content.setOwned (sel); o.dialogTitle = "Audio & MIDI settings"; o.dialogBackgroundColour = col::panel; o.useNativeTitleBar = true; o.launchAsync();
}
void MainComponent::save()
{
    chooser = std::make_unique<juce::FileChooser> ("Save Rose session", sessionFile.exists() ? sessionFile : juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("Rose").getChildFile ("Song.rose"), "*.rose");
    chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::warnAboutOverwriting, [this] (const juce::FileChooser& fc)
    { auto f = fc.getResult(); if (f == juce::File()) return; f = f.withFileExtension ("rose"); f.getParentDirectory().createDirectory(); if (engine.saveSession (f)) sessionFile = f; });
}
void MainComponent::open()
{
    chooser = std::make_unique<juce::FileChooser> ("Open Rose session", juce::File::getSpecialLocation (juce::File::userMusicDirectory), "*.rose");
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles, [this] (const juce::FileChooser& fc)
    {
        auto f = fc.getResult(); if (! f.existsAsFile()) return;
        pluginWindows.clear(); pianoRollWindow = nullptr;
        if (engine.loadSession (f)) { sessionFile = f; rebuildHeaders(); devices.refresh(); timeline.updateSize(); timeline.repaint(); }
        else juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Couldn't open", "That file isn't a Rose session.");
    });
}
void MainComponent::bounce()
{
    chooser = std::make_unique<juce::FileChooser> ("Bounce to WAV", juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("Rose").getChildFile ("Bounce.wav"), "*.wav");
    chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::warnAboutOverwriting, [this] (const juce::FileChooser& fc)
    {
        auto f = fc.getResult(); if (f == juce::File()) return; f = f.withFileExtension ("wav"); f.getParentDirectory().createDirectory();
        struct Job : juce::ThreadWithProgressWindow
        {
            Job (Engine& e, juce::File fl) : ThreadWithProgressWindow ("Bouncing...", true, false), engine (e), file (fl) {}
            void run() override { ok = engine.bounce (file, [this] (double p) { setProgress (p); }); }
            void threadComplete (bool) override
            {
                juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::InfoIcon, ok ? "Bounce finished" : "Bounce failed", ok ? file.getFullPathName() : "Couldn't write the file.");
                delete this;
            }
            Engine& engine; juce::File file; bool ok = false;
        };
        pluginWindows.clear();
        (new Job (engine, f))->launchThread();
    });
}
} // namespace rose

namespace rose
{
void MainComponent::addInstrumentMenu()
{
    juce::PopupMenu m, sounds;
    for (int k = 0; k < (int) soundLibrary().size(); ++k) sounds.addItem (100 + k, soundLibrary()[(size_t) k].name);
    m.addItem (1, "Rose Synth"); m.addItem (2, "Rose Drums"); m.addSubMenu ("Rose Sounds (real instruments)", sounds);
    m.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (&bAddInst), [this] (int r)
    {
        if (r <= 0) return;
        const juce::String name = r >= 100 ? juce::String (soundLibrary()[(size_t) r - 100].name) : r == 2 ? "Drums" : juce::String();
        auto& t = engine.addTrack (false, name);
        if (r == 2) engine.setInstrument (t, "drums", nullptr);
        if (r >= 100 && engine.setInstrument (t, "sounds", nullptr).isEmpty()) Engine::setParam (*t.instrument.node->getProcessor(), "patch", juce::var (name));
        engine.selectTrack ((int) engine.tracks.size() - 1);
    });
}

void MainComponent::templatesMenu()
{
    const auto json = juce::JSON::parse (juce::String::fromUTF8 (BinaryData::templates_json, BinaryData::templates_jsonSize));
    auto* list = json["templates"].getArray(); if (list == nullptr) return;
    juce::PopupMenu m; m.addSectionHeader ("New session from a template");
    for (int i = 0; i < list->size(); ++i) m.addItem (i + 1, (*list)[i]["name"].toString() + "   -   " + (*list)[i]["desc"].toString());
    m.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (&bFile), [this, json] (int r)
    {
        if (r <= 0) return;
        auto tpl = (*json["templates"].getArray())[r - 1];
        auto load = [this, tpl]
        {
            juce::StringArray problems;
            if (! engine.applyTemplate (tpl, problems)) return;
            sessionFile = juce::File(); bpm.setValue (engine.transport.bpm.load(), juce::dontSendNotification);
            statusText = tpl["name"].toString() + " template ready - press Space"; statusUntil = juce::Time::getMillisecondCounter() + 4000;
            if (findSoundsDir() == juce::File()) statusText = "Template loaded, but the Rose Sounds sample folder is missing - reinstall Rose Studio";
            if (! problems.isEmpty()) juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Template", problems.joinIntoString ("\n"));
            repaint();
        };
        if (engine.tracks.empty()) { load(); return; }
        juce::AlertWindow::showOkCancelBox (juce::MessageBoxIconType::QuestionIcon, "Start from " + tpl["name"].toString() + "?",
            "This replaces the current session. Save first if you want to keep it.", "Replace", "Cancel", nullptr,
            juce::ModalCallbackFunction::create ([load] (int ok) { if (ok) load(); }));
    });
}
} // namespace rose

namespace rose
{
void MainComponent::offerUpdate (Updater::Release r, bool askNow)
{
    if (r.build <= 0 || updating) return;
    pendingUpdate = r; bUpdate.setButtonText ("Update to 1.0." + juce::String (r.build)); bUpdate.setVisible (true); resized();
    if (! askNow) return;
    juce::AlertWindow::showOkCancelBox (juce::MessageBoxIconType::InfoIcon, "Rose Studio 1.0." + juce::String (r.build) + " is available",
        "You have build " + juce::String (Updater::currentBuild()) + ". Rose will download the update, close, install it and reopen.\n\nSave your session first if you have unsaved changes.",
        "Update now", "Later", nullptr, juce::ModalCallbackFunction::create ([w = juce::Component::SafePointer<MainComponent> (this)] (int ok) { if (ok && w) w->installUpdate(); }));
}
void MainComponent::installUpdate()
{
    updating = true; bUpdate.setEnabled (false); bUpdate.setButtonText ("Downloading...");
    Updater::downloadAndPrepare (
        [w = juce::Component::SafePointer<MainComponent> (this)] (float p) { if (w) w->bUpdate.setButtonText ("Downloading " + juce::String (juce::roundToInt (p * 100)) + "%"); },
        [w = juce::Component::SafePointer<MainComponent> (this)] (juce::String err)
        {
            if (w == nullptr) return;
            if (err.isEmpty() && Updater::launchInstaller()) { w->engine.stop(); juce::JUCEApplication::getInstance()->systemRequestedQuit(); return; }
            w->updating = false; w->bUpdate.setEnabled (true); w->bUpdate.setButtonText ("Retry update");
            juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Update", (err.isNotEmpty() ? err : juce::String ("Couldn't start the installer."))
                + "\n\nYou can always download the latest version from github.com/mosheshlomorosenfeld-alt/Rose/releases/latest");
        });
}
} // namespace rose

namespace rose
{
void MainComponent::toggleWindow (const juce::String& key, const juce::String& title, std::function<juce::Component*()> make)
{
    for (auto* w : toolWindows) if (w->key == key) { if (key.startsWith ("audio:") || key.startsWith ("steps:") || key == "chordgen") w->toFront (true); else toolWindows.removeObject (w); return; }
    auto* w = toolWindows.add (new ToolWindow (key, title, make(), [this] (ToolWindow* tw) { juce::MessageManager::callAsync ([this, tw] { toolWindows.removeObject (tw); }); }));
    // keep windows from stacking exactly on top of each other
    const int n = toolWindows.size() - 1; w->setTopLeftPosition (getScreenX() + 80 + (n % 6) * 36, getScreenY() + 90 + (n % 6) * 30);
}
void MainComponent::setSongRows (bool on)
{
    Timeline::songRows = on; Timeline::RULER = on ? 72 : 28; timeline.updateSize(); timeline.repaint(); resized(); repaint();
    if (engine.settings) engine.settings->setValue ("songRows", on);
}
void MainComponent::jumpMarker (int dir)
{
    const double b = engine.positionBeats(); std::vector<double> pts; for (auto& m : engine.markers) pts.push_back (m.beat); for (auto& s : engine.sections) pts.push_back (s.start); std::sort (pts.begin(), pts.end());
    if (dir > 0) { for (double p : pts) if (p > b + 0.05) { engine.transport.pos = engine.transport.samplesAt (p); return; } }
    else for (auto it = pts.rbegin(); it != pts.rend(); ++it) if (*it < b - 0.25) { engine.transport.pos = engine.transport.samplesAt (*it); return; }
}
void MainComponent::windowsMenu()
{
    const bool on = Timeline::songRows; const auto& s = timeline.sel;
    juce::PopupMenu m;
    m.addItem (1, "Mixer\tShift+X"); m.addItem (2, "Chord generator\tShift+G");
    m.addItem (3, "Edit selected clip in a window", s.clip >= 0); m.addSeparator();
    m.addItem (4, "Tuner"); m.addItem (5, "Spectrum analyzer"); m.addItem (6, "Loudness (LUFS)"); m.addItem (7, "Stereo scope"); m.addItem (8, "Reference A/B\tShift+B"); m.addSeparator();
    m.addItem (9, "Tempo & time signature"); m.addItem (10, on ? "Hide arranger & chord rows" : "Show arranger & chord rows");
    m.addItem (11, "Add marker at playhead\tShift+M"); m.addItem (12, "Detect chords from MIDI");
    m.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (&bWindows), [this, on] (int r)
    {
        auto win = [this] (const juce::String& k, const juce::String& t, std::function<juce::Component*()> f) { toggleWindow (k, t, std::move (f)); };
        switch (r)
        {
            case 1: win ("mixer", "Mixer", [this] { return new MixerPanel (engine, [this] (juce::AudioProcessor& p) { openEditor (p); }); }); break;
            case 2: win ("chordgen", "Chord generator", [this] { return new ChordGenPanel (engine, [this] { timeline.updateSize(); timeline.repaint(); }); }); break;
            case 3: { const auto sl = timeline.sel; if (sl.clip < 0) break; if (sl.audio) timeline.openAudioEditor (sl.track, sl.clip); else if (engine.tracks[(size_t) sl.track]->src()->drumKit.load()) timeline.openStepSeq (sl.track, sl.clip); else timeline.openPianoRoll (sl.track, sl.clip); break; }
            case 4: win ("tuner", "Tuner", [this] { return new TunerPanel (hub); }); break;
            case 5: win ("spectrum", "Spectrum analyzer", [this] { return new SpectrumPanel (hub); }); break;
            case 6: win ("loud", "Loudness (LUFS)", [this] { return new LoudnessPanel (hub, engine); }); break;
            case 7: win ("scope", "Stereo scope", [this] { return new ScopePanel (hub); }); break;
            case 8: win ("ref", "Reference A/B", [this] { return new ReferencePanel (engine); }); break;
            case 9: win ("tempo", "Tempo & time signature", [this] { return new TempoPanel (engine, [this] { timeline.updateSize(); timeline.repaint(); }); }); break;
            case 10: setSongRows (! on); break;
            case 11: engine.addMarker (engine.positionBeats()); timeline.repaint(); break;
            case 12: engine.detectChords(); if (! Timeline::songRows) setSongRows (true); timeline.repaint(); break;
            default: break;
        }
    });
}
} // namespace rose
