// Rose Desktop — Browser: the CC0 loop library and every effect, ready to drag.
// Drag descriptions: "loop:<id>" and "fx:<builtInId>" ("fx:chain" = the one-click vocal chain).
#pragma once
#include "Engine.h"

namespace rose
{
inline const LoopInfo* findLoop (const juce::String& id) { for (auto& L : loopLibrary()) if (L.id == id) return &L; return nullptr; }

// adds an effect (or the vocal chain) to a chain; shared by every drop target and menu
inline void addFxTo (Engine& engine, std::vector<Slot>& chain, const juce::String& id)
{
    if (id != "chain") { engine.addInsert (chain, id, nullptr); return; }
    auto has = [&] (const char* x) { for (auto& s : chain) if (s.builtInId == x) return true; return false; };
    auto add = [&] (const char* x, std::initializer_list<std::pair<const char*, float>> ps)
    { if (has (x) || engine.addInsert (chain, x, nullptr).isNotEmpty()) return; for (auto& [k, v] : ps) Engine::setParam (*chain.back().node->getProcessor(), k, v); };
    add ("tune", { { "speed", 20.0f } }); add ("eq", { { "lc", 90.0f }, { "mf", 300.0f }, { "mg", -2.0f }, { "hsg", 2.5f } });
    add ("deesser", { { "th", -32.0f } }); add ("comp", { { "th", -22.0f }, { "ra", 3.5f }, { "at", 6.0f }, { "re", 120.0f }, { "mk", 4.0f } });
    add ("reverb", { { "sz", 0.55f }, { "mx", 0.15f } });
}
inline bool isRoseDrag (const juce::DragAndDropTarget::SourceDetails& d, const char* kind) { return d.description.toString().startsWith (kind); }

class BrowserPanel : public juce::Component, private juce::ListBoxModel
{
public:
    explicit BrowserPanel (Engine& e) : engine (e)
    {
        for (auto* b : { &tLoops, &tFx }) { addAndMakeVisible (b); b->setClickingTogglesState (true); b->setRadioGroupId (77); b->onClick = [this] { refilter(); }; }
        tLoops.setToggleState (true, juce::dontSendNotification);
        addAndMakeVisible (search); search.setTextToShowWhenEmpty ("Search", col::mute); search.onTextChange = [this] { refilter(); };
        addAndMakeVisible (cat); addAndMakeVisible (key);
        cat.addItem ("All types", 1); { juce::StringArray cs; for (auto& L : loopLibrary()) cs.addIfNotAlreadyThere (L.cat); for (int i = 0; i < cs.size(); ++i) cat.addItem (cs[i], i + 2); }
        cat.setSelectedId (1, juce::dontSendNotification); cat.onChange = [this] { refilter(); };
        key.addItem ("Original key", 1); for (int i = 0; i < 12; ++i) key.addItem (juce::StringArray { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }[i], i + 2);
        key.setSelectedId (1, juce::dontSendNotification); key.setTooltip ("Pitch melodic loops into this key (speed stays the same)"); key.onChange = [this] { list.repaint(); };
        addAndMakeVisible (list); list.setModel (this); list.setRowHeight (24); list.setColour (juce::ListBox::backgroundColourId, col::bg);
        addAndMakeVisible (hint); hint.setFont (11.0f); hint.setColour (juce::Label::textColourId, col::mute); hint.setJustificationType (juce::Justification::topLeft);
        refilter();
    }
    void paint (juce::Graphics& g) override { g.fillAll (col::panel); g.setColour (col::line); g.drawVerticalLine (getWidth() - 1, 0, (float) getHeight()); }
    void resized() override
    {
        auto r = getLocalBounds().reduced (8).withTrimmedRight (1);
        auto tabs = r.removeFromTop (26); tLoops.setBounds (tabs.removeFromLeft (tabs.getWidth() / 2)); tFx.setBounds (tabs); r.removeFromTop (6);
        search.setBounds (r.removeFromTop (24)); r.removeFromTop (4);
        const bool loops = tLoops.getToggleState(); cat.setVisible (loops); key.setVisible (loops);
        if (loops) { auto row = r.removeFromTop (24); cat.setBounds (row.removeFromLeft (row.getWidth() / 2 - 2)); row.removeFromLeft (4); key.setBounds (row); r.removeFromTop (4); }
        hint.setBounds (r.removeFromBottom (44)); list.setBounds (r);
    }
    std::function<int()> selectedTrack; std::function<double()> playhead; std::function<void()> changed;
    int keySemis (const LoopInfo& L) const { return key.getSelectedId() > 1 ? keyShift (L.key, key.getText()) : 0; }

private:
    struct Item { juce::String drag, name, meta; const LoopInfo* loop = nullptr; };
    void refilter()
    {
        items.clear(); const auto q = search.getText().toLowerCase(); const bool loops = tLoops.getToggleState();
        if (loops)
        {
            for (auto& L : loopLibrary())
                if ((cat.getSelectedId() <= 1 || L.cat == cat.getText()) && (q.isEmpty() || (L.name + " " + L.cat + " " + L.key + " " + juce::String ((int) L.bpm)).toLowerCase().contains (q)))
                    {
                    // "Bass · A Major" shows as "A Major" (the type is in the meta column); "Drums 95 · 15/16" stays whole
                    const auto dot = juce::String::fromUTF8 (" \xc2\xb7 "); const auto pre = L.name.upToFirstOccurrenceOf (dot, false, false);
                    items.push_back ({ "loop:" + L.id, L.name.contains (dot) && (pre == L.cat || pre + "s" == L.cat) && L.name.fromFirstOccurrenceOf (dot, false, false).length() > 2 ? L.name.fromFirstOccurrenceOf (dot, false, false) : L.name, L.cat, &L });
                }
            hint.setText (juce::String (loopLibrary().size()) + " free CC0 loops. Click to preview, double-click to add at the playhead, or drag onto a track. They follow the song tempo.", juce::dontSendNotification);
        }
        else
        {
            if (q.isEmpty() || juce::String ("vocal chain").contains (q)) items.push_back ({ "fx:chain", "Vocal chain (one click)", "Vocal" });
            for (auto& b : builtIns()) if (! b.instrument && (q.isEmpty() || juce::String (b.name).toLowerCase().contains (q))) items.push_back ({ "fx:" + juce::String (b.id), juce::String (b.name).replace ("Rose ", ""), "" });
            hint.setText ("Drag an effect onto a track, the timeline or the device rack. Double-click adds it to the selected track.", juce::dontSendNotification);
        }
        list.updateContent(); list.repaint(); resized();
    }
    int getNumRows() override { return (int) items.size(); }
    void paintListBoxItem (int row, juce::Graphics& g, int w, int h, bool selected) override
    {
        if (! juce::isPositiveAndBelow (row, (int) items.size())) return; const auto& it = items[(size_t) row];
        const bool playing = it.loop != nullptr && engine.previewingId() == it.loop->id;
        if (selected || playing) g.fillAll (col::panel2);
        if (playing) { g.setColour (col::rose); g.fillRect (0, 0, 2, h); }
        g.setColour (col::mute); g.setFont (10.0f); g.drawText (it.loop ? (playing ? juce::String::fromUTF8 ("\xe2\x96\xa0") : juce::String::fromUTF8 ("\xe2\x96\xb6")) : juce::String(), 4, 0, 14, h, juce::Justification::centred);
        g.setColour (col::ink); g.setFont (12.5f); g.drawText (it.name, 22, 0, w - 100, h, juce::Justification::centredLeft, true);
        juce::String meta = it.meta;
        if (it.loop) { if (it.loop->bpm > 0) meta << "  " << juce::roundToInt (it.loop->bpm); if (it.loop->key.isNotEmpty()) meta << "  " << (keySemis (*it.loop) ? key.getText() : it.loop->key); }
        g.setColour (col::mute); g.setFont (11.0f); g.drawText (meta, w - 96, 0, 92, h, juce::Justification::centredRight);
    }
    void listBoxItemClicked (int row, const juce::MouseEvent&) override
    {
        if (! juce::isPositiveAndBelow (row, (int) items.size()) || items[(size_t) row].loop == nullptr) return;
        auto* L = items[(size_t) row].loop;
        engine.previewLoop (engine.previewingId() == L->id ? nullptr : L, keySemis (*L)); list.repaint();
    }
    void listBoxItemDoubleClicked (int row, const juce::MouseEvent&) override
    {
        if (! juce::isPositiveAndBelow (row, (int) items.size())) return; const auto& it = items[(size_t) row];
        const int ti = selectedTrack ? selectedTrack() : -1;
        if (it.loop) { engine.previewLoop (nullptr); engine.placeLoop (*it.loop, ti, playhead ? playhead() : 0, keySemis (*it.loop)); }
        else if (juce::isPositiveAndBelow (ti, (int) engine.tracks.size())) addFxTo (engine, engine.tracks[(size_t) ti]->inserts, it.drag.fromFirstOccurrenceOf ("fx:", false, false));
        if (changed) changed();
    }
    juce::var getDragSourceDescription (const juce::SparseSet<int>& rows) override
    {
        if (rows.isEmpty() || ! juce::isPositiveAndBelow (rows[0], (int) items.size())) return {};
        return items[(size_t) rows[0]].drag;
    }
    Engine& engine; std::vector<Item> items;
    juce::TextButton tLoops { "Loops" }, tFx { "Effects" };
    juce::TextEditor search; juce::ComboBox cat, key; juce::ListBox list; juce::Label hint;
};
} // namespace rose
