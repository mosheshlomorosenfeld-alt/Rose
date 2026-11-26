#include <JuceHeader.h>
#include "MainComponent.h"

class RoseApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "Rose Studio"; }
    const juce::String getApplicationVersion() override { return ProjectInfo::versionString; }
    bool moreThanOneInstanceAllowed() override { return false; }
    void initialise (const juce::String&) override { window = std::make_unique<Window>(); }
    void shutdown() override { window = nullptr; }
    void systemRequestedQuit() override { quit(); }

    struct Window : juce::DocumentWindow
    {
        Window() : DocumentWindow ("Rose Studio", juce::Colour (0xff121014), DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true); setContentOwned (new rose::MainComponent(), true);
            setResizable (true, true); setResizeLimits (900, 600, 10000, 10000); centreWithSize (getWidth(), getHeight()); setVisible (true);
        }
        void closeButtonPressed() override { juce::JUCEApplication::getInstance()->systemRequestedQuit(); }
    };
    std::unique_ptr<Window> window;
};

START_JUCE_APPLICATION (RoseApp)
