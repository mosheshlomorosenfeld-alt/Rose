// Rose Desktop — user interface.
#pragma once
#include <JuceHeader.h>
#include "Engine.h"

namespace rose
{
namespace col
{
    const juce::Colour bg (0xff121014), panel (0xff1b181e), panel2 (0xff232026), line (0xff332f37), ink (0xfff3eee7), mute (0xffa39ca6), rose (0xffff4f8b), lane (0xff17151a), lane2 (0xff1c1a1f);
}

//==============================================================================
class RoseLook : public juce::LookAndFeel_V4
{
public:
    RoseLook()
    {
        setColourScheme ({ col::bg, col::panel, col::panel2, col::line, col::ink, col::rose, col::ink, col::rose, col::ink });
        setColour (juce::TextButton::buttonColourId, col::panel2); setColour (juce::TextButton::buttonOnColourId, col::rose);
        setColour (juce::Slider::thumbColourId, col::rose); setColour (juce::Slider::trackColourId, col::rose.withAlpha (0.6f));
        setColour (juce::Slider::backgroundColourId, col::line);
        setColour (juce::ResizableWindow::backgroundColourId, col::bg);
    }
};

//==============================================================================
class PluginWindow : public juce::DocumentWindow
{
public:
    PluginWindow (juce::AudioProcessor& p, std::function<void (PluginWindow*)> onClose)
        : DocumentWindow (p.getName(), col::panel, DocumentWindow::closeButton), closed (std::move (onClose)), proc (&p)
    {
        auto* ed = p.hasEditor() ? p.createEditorIfNeeded() : nullptr;
        if (ed == nullptr) ed = new juce::GenericAudioProcessorEditor (p);
        setContentOwned (ed, true); setUsingNativeTitleBar (true); setResizable (ed->isResizable(), false);
        centreWithSize (juce::jmax (300, getWidth()), juce::jmax (200, getHeight())); setVisible (true);
    }
    void closeButtonPressed() override { closed (this); }
    juce::AudioProcessor* proc;
private:
    std::function<void (PluginWindow*)> closed;
};

//==============================================================================
class PianoRoll : public juce::Component
{
public:
    PianoRoll (Engine& e, Track& t, int clipIndex) : engine (e), track (t), index (clipIndex) { setSize (900, 520); }
    void paint (juce::Graphics& g) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
private:
    MidiClip* clip() { auto& v = track.src()->midiClips; return index < (int) v.size() ? &v[(size_t) index] : nullptr; }
    float yOf (int p) const { return (float) (HI - p) * RH; }
    int pOf (float y) const { return HI - (int) (y / RH); }
    float xOf (double b) const { return KW + (float) b * ppb(); }
    double bOf (float x) const { return (x - KW) / ppb(); }
    float ppb() const { auto* c = const_cast<PianoRoll*> (this)->clip(); return c ? juce::jmax (30.0f, (getWidth() - KW) / (float) c->length) : 60.0f; }
    static constexpr int LO = 24, HI = 108; static constexpr float RH = 6.0f, KW = 44.0f;
    Engine& engine; Track& track; int index; int dragNote = -1; bool resizing = false; double grabOffset = 0; double grid = 0.25; int lastHeard = -1;
};

//==============================================================================
class Timeline : public juce::Component, public juce::FileDragAndDropTarget
{
public:
    explicit Timeline (Engine& e) : engine (e) {}
    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    bool isInterestedInFileDrag (const juce::StringArray&) override { return true; }
    void filesDropped (const juce::StringArray&, int x, int y) override;
    void updateSize();

    static constexpr int RULER = 28, LANE = 72;
    float ppb = 32.0f;
    struct Sel { int track = -1, clip = -1; bool audio = false; } sel;
    std::function<void (int track, int clip)> openPianoRoll;
    std::function<void()> changed;
    void deleteSelected(); void duplicateSelected(); void splitSelected();
private:
    double snap (double b, bool fine) const { return fine ? b : std::round (b * 4) / 4; }
    Engine& engine;
    enum class Drag { none, move, resize, loop, seek } drag = Drag::none;
    double dragStartBeat = 0, clipStart0 = 0, clipLen0 = 0;
    std::map<const void*, std::vector<float>> peaks;
    const std::vector<float>& peaksFor (const AudioClip&);
};

class PlayheadLine : public juce::Component
{
public:
    PlayheadLine() { setInterceptsMouseClicks (false, false); }
    void paint (juce::Graphics& g) override { g.fillAll (col::rose); }
};

//==============================================================================
class TrackHeader : public juce::Component
{
public:
    TrackHeader (Engine& e, int i);
    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseDown (const juce::MouseEvent&) override { engine.selectTrack (index); }
    void refresh();
    int index;
private:
    Engine& engine;
    juce::Label name; juce::TextButton m { "M" }, s { "S" }, r { "R" }, i { "I" }, del { "x" };
    juce::Slider vol, pan;
};

//==============================================================================
class DevicePanel : public juce::Component
{
public:
    explicit DevicePanel (Engine& e) : engine (e) {}
    void refresh();
    void resized() override;
    void paint (juce::Graphics& g) override { g.fillAll (col::panel2); }
    bool showMaster = false;
    std::function<void (juce::AudioProcessor&)> openEditor;
private:
    std::vector<Slot>& chain();
    void addEffectMenu(); void instrumentMenu();
    Engine& engine;
    juce::OwnedArray<juce::Component> items;
    juce::Label title;
};

//==============================================================================
class MainComponent : public juce::Component, private juce::Timer, private juce::ChangeListener
{
public:
    MainComponent();
    ~MainComponent() override;
    void paint (juce::Graphics&) override;
    void resized() override;
    bool keyPressed (const juce::KeyPress&) override;
private:
    void timerCallback() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;
    void rebuildHeaders();
    void openEditor (juce::AudioProcessor&);
    void showScanner(); void showAudioSettings(); void save(); void open(); void bounce();

    RoseLook look;
    Engine engine;
    juce::TextButton bHome { "|<" }, bPlay { "Play" }, bStop { "Stop" }, bRec { "Rec" }, bLoop { "Loop" }, bClick { "Click" },
                     bAddAudio { "+ Audio" }, bAddInst { "+ Instrument" }, bMaster { "Master FX" }, bPlugins { "Plugins..." }, bAudio { "Audio/MIDI..." },
                     bOpen { "Open" }, bSave { "Save" }, bBounce { "Bounce WAV" };
    juce::Slider bpm; juce::Label time, bpmLabel { {}, "BPM" };
    juce::Component headerHolder; juce::OwnedArray<TrackHeader> headers;
    struct SyncViewport : juce::Viewport { std::function<void()> moved; void visibleAreaChanged (const juce::Rectangle<int>&) override { if (moved) moved(); } } viewport;
    Timeline timeline { engine }; PlayheadLine playhead;
    DevicePanel devices { engine };
    juce::MidiKeyboardComponent keys { engine.keyboard, juce::MidiKeyboardComponent::horizontalKeyboard };
    juce::OwnedArray<PluginWindow> pluginWindows;
    std::unique_ptr<juce::DocumentWindow> pianoRollWindow;
    std::unique_ptr<juce::FileChooser> chooser;
    juce::File sessionFile;
    int lastTrackCount = -1;
};
} // namespace rose
