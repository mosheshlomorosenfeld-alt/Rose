#include "MainComponent.h"

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
    for (int b = 0; b * ppb < W; ++b)
    {
        g.setColour (b % 4 == 0 ? col::line : col::panel2); g.drawVerticalLine ((int) (b * ppb), (float) RULER, (float) getHeight());
        if (b % 4 == 0) { g.setColour (col::mute); g.setFont (11.0f); g.drawText (juce::String (b / 4 + 1), (int) (b * ppb) + 3, 12, 40, 14, juce::Justification::left); }
    }
    g.setColour (col::panel); g.fillRect (0, 0, getWidth(), RULER - 1);
    for (int b = 0; b * ppb < W; b += 4) { g.setColour (col::mute); g.setFont (11.0f); g.drawText (juce::String (b / 4 + 1), (int) (b * ppb) + 3, 12, 40, 14, juce::Justification::left); }
    const float ls = (float) tr.loopStart.load() * ppb, le = (float) tr.loopEnd.load() * ppb;
    g.setColour (col::rose.withAlpha (tr.looping.load() ? 0.35f : 0.12f)); g.fillRoundedRectangle (ls, 3, le - ls, 10, 3);
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
            auto r = box (c.start, c.length, sel.track == ti && sel.clip == ci && sel.audio, c.file.getFileNameWithoutExtension());
            auto& pk = peaksFor (c); if (pk.empty()) continue;
            g.setColour (t.colour); const float mid = r.getCentreY() + 6, amp = (r.getHeight() - 18) / 2;
            for (int x = 0; x < (int) r.getWidth(); ++x)
            {
                const double sec = c.offsetSec + (x / ppb) * 60.0 / tr.bpm.load(); const size_t i = (size_t) (sec * c.fileRate / 256);
                if (i >= pk.size()) break;
                const float a = pk[i] * amp * juce::Decibels::decibelsToGain (c.gainDb);
                g.drawVerticalLine ((int) r.getX() + x, mid - a, mid + a + 1);
            }
        }
        for (int ci = 0; ci < (int) s->midiClips.size(); ++ci)
        {
            auto& c = s->midiClips[(size_t) ci];
            auto r = box (c.start, c.length, sel.track == ti && sel.clip == ci && ! sel.audio, c.name);
            if (c.notes.empty()) continue;
            int lo = 127, hi = 0; for (auto& n : c.notes) { lo = juce::jmin (lo, n.pitch); hi = juce::jmax (hi, n.pitch); }
            const float rh = juce::jlimit (2.0f, 5.0f, (r.getHeight() - 16) / (float) (hi - lo + 1)); g.setColour (t.colour);
            for (auto& n : c.notes)
                if (n.start < c.length)
                    g.fillRect (r.getX() + (float) n.start * ppb, r.getBottom() - 3 - (float) (n.pitch - lo + 1) * (r.getHeight() - 18) / (float) (hi - lo + 1), juce::jmax (2.0f, (float) n.length * ppb - 1), rh);
        }
    }
}
void Timeline::mouseDown (const juce::MouseEvent& e)
{
    const double b = e.x / (double) ppb; drag = Drag::none;
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
            juce::PopupMenu m; m.addItem (1, "Duplicate"); m.addItem (2, "Split at playhead"); m.addItem (3, "Delete");
            if (! sel.audio) m.addItem (4, "Edit notes...");
            m.showMenuAsync ({}, [this] (int r) { if (r == 1) duplicateSelected(); else if (r == 2) splitSelected(); else if (r == 3) deleteSelected(); else if (r == 4 && openPianoRoll) openPianoRoll (sel.track, sel.clip); });
            repaint(); return;
        }
        drag = (e.x > (st + ln) * ppb - 8) ? Drag::resize : Drag::move; dragStartBeat = b; clipStart0 = st; clipLen0 = ln;
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
    if (sel.clip < 0 || (drag != Drag::move && drag != Drag::resize)) return;
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    double& st = sel.audio ? s->audioClips[(size_t) sel.clip].start : s->midiClips[(size_t) sel.clip].start;
    double& ln = sel.audio ? s->audioClips[(size_t) sel.clip].length : s->midiClips[(size_t) sel.clip].length;
    if (drag == Drag::move) st = juce::jmax (0.0, snap (clipStart0 + b - dragStartBeat, fine));
    else ln = juce::jmax (0.25, snap (clipLen0 + b - dragStartBeat, fine));
    repaint();
}
void Timeline::mouseUp (const juce::MouseEvent&) { drag = Drag::none; updateSize(); if (changed) changed(); }
void Timeline::mouseDoubleClick (const juce::MouseEvent& e)
{
    if (e.y < RULER) return;
    const int ti = (e.y - RULER) / LANE; if (ti < 0 || ti >= (int) engine.tracks.size()) return;
    auto& t = *engine.tracks[(size_t) ti];
    if (sel.clip >= 0 && ! sel.audio) { if (openPianoRoll) openPianoRoll (sel.track, sel.clip); return; }
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
    if (sel.clip < 0) return; const double at = std::round (engine.positionBeats() * 4) / 4;
    auto* s = engine.tracks[(size_t) sel.track]->src(); const juce::ScopedLock sl (s->lock);
    if (sel.audio)
    {
        auto& c = s->audioClips[(size_t) sel.clip]; if (at <= c.start || at >= c.start + c.length) return;
        auto d = c; const double cut = at - c.start; d.start = at; d.length = c.length - cut; d.offsetSec += cut * 60.0 / engine.transport.bpm.load(); c.length = cut; s->audioClips.push_back (d);
    }
    else
    {
        auto& c = s->midiClips[(size_t) sel.clip]; if (at <= c.start || at >= c.start + c.length) return;
        auto d = c; const double cut = at - c.start; d.start = at; d.length = c.length - cut; d.notes.clear();
        for (auto& n : c.notes) if (n.start >= cut) d.notes.push_back ({ n.pitch, n.start - cut, n.length, n.vel });
        c.notes.erase (std::remove_if (c.notes.begin(), c.notes.end(), [cut] (auto& n) { return n.start >= cut; }), c.notes.end()); c.length = cut;
        s->midiClips.push_back (d);
    }
    repaint();
}

//============================================================================== TrackHeader
TrackHeader::TrackHeader (Engine& e, int idx) : index (idx), engine (e)
{
    auto& t = *engine.tracks[(size_t) idx];
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
    g.drawText (t.isAudio ? "Audio" : (t.instrument.node ? t.instrument.displayName() : "No instrument"), 10, getHeight() - 18, getWidth() - 20, 14, juce::Justification::left);
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
    juce::PopupMenu m, built, plug; const auto types = engine.knownPlugins.getTypes();
    int i = 1; for (auto& b : builtIns()) { if (! b.instrument) built.addItem (i, b.name); ++i; }
    addPluginItems (plug, types, false, 1000);
    m.addSubMenu ("Rose effects", built); m.addSubMenu ("VST3 / AU effects", plug);
    m.showMenuAsync ({}, [this, types] (int r)
    {
        juce::String err;
        if (r >= 1000) { const auto d = types[r - 1000]; err = engine.addInsert (chain(), {}, &d); }
        else if (r >= 1) err = engine.addInsert (chain(), builtIns()[(size_t) r - 1].id, nullptr);
        if (err.isNotEmpty()) juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Couldn't load plugin", err);
        refresh();
    });
}
void DevicePanel::instrumentMenu()
{
    if (engine.tracks.empty()) return;
    juce::PopupMenu m, plug; const auto types = engine.knownPlugins.getTypes();
    m.addItem (1, "Rose Synth"); addPluginItems (plug, types, true, 1000); m.addSubMenu ("VST3 / AU instruments", plug);
    m.showMenuAsync ({}, [this, types] (int r)
    {
        auto& t = *engine.tracks[(size_t) engine.selected]; juce::String err;
        if (r >= 1000) { const auto d = types[r - 1000]; err = engine.setInstrument (t, {}, &d); }
        else if (r == 1) err = engine.setInstrument (t, "synth", nullptr);
        if (err.isNotEmpty()) juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Couldn't load instrument", err);
        refresh();
    });
}

//============================================================================== MainComponent
MainComponent::MainComponent()
{
    setLookAndFeel (&look);
    for (auto* b : { &bHome, &bPlay, &bStop, &bRec, &bLoop, &bClick, &bAddAudio, &bAddInst, &bMaster, &bPlugins, &bAudio, &bOpen, &bSave, &bBounce }) addAndMakeVisible (b);
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
    bAddInst.onClick = [this] { engine.addTrack (false); engine.selectTrack ((int) engine.tracks.size() - 1); };
    bMaster.onClick = [this] { devices.showMaster = bMaster.getToggleState(); devices.refresh(); };
    bPlugins.onClick = [this] { showScanner(); }; bAudio.onClick = [this] { showAudioSettings(); };
    bSave.onClick = [this] { save(); }; bOpen.onClick = [this] { open(); }; bBounce.onClick = [this] { bounce(); };

    bpm.setSliderStyle (juce::Slider::IncDecButtons); bpm.setRange (40, 240, 1); bpm.setValue (engine.transport.bpm.load(), juce::dontSendNotification);
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
        vp->setSize (1000, 480); w->setContentOwned (vp, true); w->setUsingNativeTitleBar (true); w->setResizable (true, false); w->centreWithSize (1000, 480); w->setVisible (true);
        struct Closer { static void install (juce::DocumentWindow* win, std::unique_ptr<juce::DocumentWindow>& slot) { slot.reset (win); } };
        Closer::install (w, pianoRollWindow);
    };
    timeline.changed = [this] { repaint(); };
    devices.openEditor = [this] (juce::AudioProcessor& p) { openEditor (p); };
    keys.setAvailableRange (24, 108); keys.setLowestVisibleKey (48);
    engine.addChangeListener (this);
    rebuildHeaders(); devices.refresh(); timeline.updateSize();
    setWantsKeyboardFocus (true);
    setSize (1360, 860);
    startTimerHz (30);
    if (engine.knownPlugins.getNumTypes() == 0)
        juce::MessageManager::callAsync ([this] { showScanner(); });
}
MainComponent::~MainComponent() { engine.removeChangeListener (this); pianoRollWindow = nullptr; pluginWindows.clear(); setLookAndFeel (nullptr); }

void MainComponent::paint (juce::Graphics& g)
{
    g.fillAll (col::bg); g.setColour (col::panel); g.fillRect (0, 0, getWidth(), 48);
    g.setColour (col::rose); g.setFont (juce::FontOptions (24.0f, juce::Font::bold)); g.drawText ("Rose", 12, 8, 70, 32, juce::Justification::left);
}
void MainComponent::resized()
{
    auto r = getLocalBounds(); auto top = r.removeFromTop (48).reduced (8, 8); top.removeFromLeft (70);
    for (auto* b : { &bHome, &bPlay, &bStop, &bRec, &bLoop, &bClick }) { b->setBounds (top.removeFromLeft (b == &bHome ? 36 : 54)); top.removeFromLeft (4); }
    top.removeFromLeft (6); time.setBounds (top.removeFromLeft (120)); top.removeFromLeft (8);
    bpmLabel.setBounds (top.removeFromLeft (36)); bpm.setBounds (top.removeFromLeft (110)); top.removeFromLeft (10);
    for (auto* b : { &bBounce, &bSave, &bOpen, &bAudio, &bPlugins, &bMaster, &bAddInst, &bAddAudio }) { b->setBounds (top.removeFromRight (b == &bAddInst ? 104 : b == &bAudio ? 100 : 82)); top.removeFromRight (4); }
    keys.setBounds (r.removeFromBottom (64));
    devices.setBounds (r.removeFromBottom (170));
    headerHolder.setBounds (r.removeFromLeft (240));
    viewport.setBounds (r);
    for (auto* h : headers) h->setBounds (0, Timeline::RULER + h->index * Timeline::LANE - viewport.getViewPositionY(), 240, Timeline::LANE);
}
void MainComponent::rebuildHeaders()
{
    headers.clear();
    for (int i = 0; i < (int) engine.tracks.size(); ++i) { auto* h = headers.add (new TrackHeader (engine, i)); headerHolder.addAndMakeVisible (h); }
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
    const double b = engine.positionBeats(); const int bar = (int) (b / 4) + 1, beat = (int) std::fmod (b, 4.0) + 1, six = (int) (std::fmod (b, 1.0) * 4) + 1;
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
}
bool MainComponent::keyPressed (const juce::KeyPress& k)
{
    if (k == juce::KeyPress::spaceKey) { bPlay.triggerClick(); return true; }
    if (k == juce::KeyPress::deleteKey || k == juce::KeyPress::backspaceKey) { timeline.deleteSelected(); return true; }
    if (k == juce::KeyPress ('d', juce::ModifierKeys::commandModifier, 0)) { timeline.duplicateSelected(); return true; }
    if (k == juce::KeyPress ('e', juce::ModifierKeys::commandModifier, 0)) { timeline.splitSelected(); return true; }
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
