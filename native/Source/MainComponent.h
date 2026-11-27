// Rose Desktop — user interface.
#pragma once
#include <JuceHeader.h>
#include "Engine.h"
#include "Updater.h"

namespace rose
{
namespace col
{
    // Graphite console: mid-grey chassis, darker deck, colour only where it means something
    const juce::Colour bg (0xff1d1e21), panel (0xff2b2c30), panel2 (0xff323338), line (0xff3b3c42), ink (0xffe6e4df), mute (0xff9a978f), rose (0xffe0708a), lane (0xff212226), lane2 (0xff24252a);
}

} // namespace rose
#include "Browser.h"
#include "ToolWindows.h"
namespace rose
{

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
        setAlwaysOnTop (true);   // plugin windows float above the studio (released while Rose is in the background)
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
class Timeline : public juce::Component, public juce::FileDragAndDropTarget, public juce::DragAndDropTarget
{
public:
    // loops and effects dragged from the Browser
    bool isInterestedInDragSource (const SourceDetails& d) override { return isRoseDrag (d, "loop:") || isRoseDrag (d, "fx:"); }
    void itemDragMove (const SourceDetails& d) override { dropTrack = (d.localPosition.y - RULER) / LANE; dropBeat = juce::jmax (0.0, std::floor ((double) d.localPosition.x / ppb / 4) * 4); dropIsLoop = isRoseDrag (d, "loop:"); repaint(); }
    void itemDragExit (const SourceDetails&) override { dropTrack = -2; repaint(); }
    void itemDropped (const SourceDetails&) override;
    int dropTrack = -2; double dropBeat = 0; bool dropIsLoop = false; std::function<int (const LoopInfo&)> loopSemis;
    void pitchSelected (int semis);
    explicit Timeline (Engine& e) : engine (e) {}
    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    bool isInterestedInFileDrag (const juce::StringArray&) override { return true; }
    void filesDropped (const juce::StringArray&, int x, int y) override;
    void updateSize();

    static inline int RULER = 28; static constexpr int LANE = 72;   // RULER grows to 72 when the arranger & chord rows are shown
    static inline bool songRows = false;
    float ppb = 32.0f;
    struct Sel { int track = -1, clip = -1; bool audio = false; } sel;
    std::function<void (int track, int clip)> openPianoRoll, openAudioEditor, openStepSeq;
    std::function<void()> changed;
    void deleteSelected(); void duplicateSelected(); void splitSelected();
    void splitAt (double beat); void copySelected (bool cut); void paste(); void toggleClipLoop(); void loopToSelection();
    void setFade (bool in, double beats);
    enum class Tool { pointer, scissors } tool = Tool::pointer;
    std::function<void (const juce::String&)> notify;
private:
    double snap (double b, bool fine) const { return fine ? b : std::round (b * 4) / 4; }
    Engine& engine;
    enum class Drag { none, move, resize, loop, seek, fadeIn, fadeOut, clipLoop, section } drag = Drag::none;
    double secA = 0, secB = 0;
    void rulerClick (const juce::MouseEvent&); void sectionMenu (int i); void chordMenu (double beat, int existing); void rename (std::function<juce::String&()> get, const juce::String& title);
    double fade0 = 0;
    struct Clipboard { bool has = false, audio = false; AudioClip a; MidiClip m; } clipboard;
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
class TrackHeader : public juce::Component, public juce::DragAndDropTarget
{
public:
    TrackHeader (Engine& e, int i);
    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseDown (const juce::MouseEvent&) override;
    bool isInterestedInDragSource (const SourceDetails& d) override { return isRoseDrag (d, "fx:") || isRoseDrag (d, "loop:"); }
    void itemDragEnter (const SourceDetails&) override { hover = true; repaint(); }
    void itemDragExit (const SourceDetails&) override { hover = false; repaint(); }
    void itemDropped (const SourceDetails&) override;
    std::function<void()> changed; std::function<double()> playhead; std::function<int (const LoopInfo&)> loopSemis;
    bool hover = false;
    void refresh();
    int index;
private:
    Engine& engine;
    juce::Label name; juce::TextButton m { "M" }, s { "S" }, r { "R" }, i { "I" }, del { "x" };
    juce::Slider vol, pan;
};

//==============================================================================
class DevicePanel : public juce::Component, public juce::DragAndDropTarget
{
public:
    explicit DevicePanel (Engine& e) : engine (e) {}
    bool isInterestedInDragSource (const SourceDetails& d) override { return isRoseDrag (d, "fx:"); }
    void itemDragEnter (const SourceDetails&) override { hover = true; repaint(); }
    void itemDragExit (const SourceDetails&) override { hover = false; repaint(); }
    void itemDropped (const SourceDetails& d) override { hover = false; addFxTo (engine, chain(), d.description.toString().fromFirstOccurrenceOf ("fx:", false, false)); refresh(); }
    void paintOverChildren (juce::Graphics& g) override { if (hover) { g.setColour (col::rose); g.drawRect (getLocalBounds(), 2); } }
    bool hover = false;
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
class MainComponent : public juce::Component, public juce::DragAndDropContainer, private juce::Timer, private juce::ChangeListener
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
    void showScanner(); void showAudioSettings(); void save(); void open(); void bounce(); void templatesMenu(); void addInstrumentMenu(); void offerUpdate (Updater::Release, bool askNow); void installUpdate();
    Updater::Release pendingUpdate; bool updating = false;

    RoseLook look;
    Engine engine;
    juce::TextButton bHome { "|<" }, bPlay { "Play" }, bStop { "Stop" }, bRec { "Rec" }, bLoop { "Loop" }, bClick { "Click" },
                     bAddAudio { "+ Audio" }, bAddInst { "+ Instrument" }, bMaster { "Master FX" }, bPlugins { "Plugins..." }, bAudio { "Audio/MIDI..." },
                     bOpen { "Open" }, bSave { "Save" }, bBounce { "Bounce WAV" }, bAbout { "?" }, bTemplates { "Templates" }, bUpdate { "Update" }, bBrowser { "Browser" }, bFile { "File" }, bWindows { "Windows" }, bPointer { "Pointer" }, bScissors { "Scissors" };
    juce::Slider bpm; juce::Label time, bpmLabel { {}, "BPM" };
    juce::Component headerHolder; juce::OwnedArray<TrackHeader> headers;
    struct SyncViewport : juce::Viewport { std::function<void()> moved; void visibleAreaChanged (const juce::Rectangle<int>&) override { if (moved) moved(); } } viewport;
    Timeline timeline { engine }; PlayheadLine playhead;
    DevicePanel devices { engine };
    BrowserPanel browser { engine }; bool showBrowser = true;   // declared after engine: it reads the loop library
    AnalysisHub hub; juce::OwnedArray<ToolWindow> toolWindows;
    void toggleWindow (const juce::String& key, const juce::String& title, std::function<juce::Component*()> make);
    void windowsMenu(); void setSongRows (bool); void jumpMarker (int dir);
    juce::MidiKeyboardComponent keys { engine.keyboard, juce::MidiKeyboardComponent::horizontalKeyboard };
    juce::OwnedArray<PluginWindow> pluginWindows;
    std::unique_ptr<juce::DocumentWindow> pianoRollWindow;
    std::unique_ptr<juce::FileChooser> chooser;
    juce::File sessionFile;
    int lastTrackCount = -1; int floatCheck = 0;
    juce::String statusText; juce::uint32 statusUntil = 0;
};
} // namespace rose
