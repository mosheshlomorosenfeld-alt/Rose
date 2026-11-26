// Rose Desktop — self-updater. Checks GitHub Releases, downloads the new build and swaps it in after Rose quits.
// Every CI build is tagged v1.0.<build>; the app knows its own build number (ROSE_BUILD_NUMBER, set by CI).
#pragma once
#include <JuceHeader.h>

#ifndef ROSE_BUILD_NUMBER
 #define ROSE_BUILD_NUMBER 0
#endif

namespace rose
{
class Updater
{
public:
    static constexpr const char* repo = "mosheshlomorosenfeld-alt/Rose";
    static int currentBuild() { return ROSE_BUILD_NUMBER; }
    static bool isMac() { return (juce::SystemStats::getOperatingSystemType() & juce::SystemStats::MacOSX) != 0; }

    struct Release { int build = 0; juce::String name, notes; };

    // Background check. Calls back on the message thread with the newer release, or build 0 if none / offline.
    static void check (std::function<void (Release)> done)
    {
        juce::Thread::launch ([done]
        {
            Release r;
            auto in = juce::URL (juce::String ("https://api.github.com/repos/") + repo + "/releases/latest")
                          .createInputStream (juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                                                  .withExtraHeaders ("Accept: application/vnd.github+json\r\nUser-Agent: RoseStudio")
                                                  .withConnectionTimeoutMs (10000));
            if (in != nullptr)
            {
                const auto json = juce::JSON::parse (in->readEntireStreamAsString());
                const auto tag = json["tag_name"].toString();                       // "v1.0.17"
                const int build = tag.fromLastOccurrenceOf (".", false, false).getIntValue();
                if (build > currentBuild()) { r.build = build; r.name = json["name"].toString(); r.notes = json["body"].toString(); }
            }
            juce::MessageManager::callAsync ([done, r] { done (r); });
        });
    }

    // Downloads the new build, prepares an install script that runs once Rose has quit, then calls back.
    // progress is 0..1; result is an empty string on success or an error message.
    static void downloadAndPrepare (std::function<void (float)> progress, std::function<void (juce::String)> finished)
    {
        juce::Thread::launch ([progress, finished]
        {
            auto fail = [finished] (juce::String m) { juce::MessageManager::callAsync ([finished, m] { finished (m); }); };
            const auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("RoseUpdate");
            dir.deleteRecursively(); dir.createDirectory();
            const auto zip = dir.getChildFile (isMac() ? "Rose-mac.zip" : "Rose-windows.zip");
            int status = 0; juce::int64 total = 0;
            auto in = juce::URL (juce::String ("https://github.com/") + repo + "/releases/latest/download/" + zip.getFileName())
                          .createInputStream (juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                                                  .withConnectionTimeoutMs (20000).withNumRedirectsToFollow (10).withStatusCode (&status));
            if (in == nullptr || (status != 0 && status != 200)) return fail ("Couldn't download the update (check your internet connection).");
            total = in->getTotalLength();
            {
                juce::FileOutputStream out (zip); if (! out.openedOk()) return fail ("Couldn't save the update to " + dir.getFullPathName());
                juce::HeapBlock<char> buf (1 << 16); juce::int64 got = 0;
                for (;;)
                {
                    const int n = in->read (buf, 1 << 16); if (n <= 0) break;
                    out.write (buf, (size_t) n); got += n;
                    if (total > 0) { const float p = (float) got / (float) total; juce::MessageManager::callAsync ([progress, p] { progress (p); }); }
                }
                out.flush();
                if (got < 1000000) return fail ("The download was incomplete - please try again.");
            }
            const auto script = isMac() ? writeMacScript (dir, zip) : writeWindowsScript (dir, zip);
            if (! script.existsAsFile()) return fail ("Couldn't prepare the installer.");
            juce::MessageManager::callAsync ([finished] { finished ({}); });
        });
    }

    // Starts the installer (it waits for Rose to quit, replaces the app, then reopens it).
    static bool launchInstaller()
    {
        const auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("RoseUpdate");
        if (isMac())
        {
            const auto s = dir.getChildFile ("install.sh");
            return s.existsAsFile() && std::system (("/bin/sh " + s.getFullPathName().quoted() + " >/dev/null 2>&1 &").toRawUTF8()) == 0;
        }
        const auto s = dir.getChildFile ("install.ps1");
        return s.existsAsFile() && juce::File ("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
                                       .startAsProcess ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " + s.getFullPathName().quoted());
    }

private:
    static juce::File writeMacScript (const juce::File& dir, const juce::File& zip)
    {
        const auto app = juce::File::getSpecialLocation (juce::File::currentApplicationFile);   // .../Rose Studio.app
        const auto s = dir.getChildFile ("install.sh");
        juce::String sh;
        sh << "#!/bin/sh\n"
           << "APP=" << app.getFullPathName().quoted() << "\nDIR=" << dir.getFullPathName().quoted() << "\n"
           << "while pgrep -x \"Rose Studio\" >/dev/null; do sleep 0.5; done\n"
           << "ditto -x -k " << zip.getFullPathName().quoted() << " \"$DIR/new\" || { open \"$DIR\"; exit 1; }\n"
           << "NEW=\"$DIR/new/Rose Studio.app\"\n"
           << "rm -rf \"$APP.old\"\n"
           << "if mv \"$APP\" \"$APP.old\" && ditto \"$NEW\" \"$APP\"; then rm -rf \"$APP.old\"; else rm -rf \"$APP\"; mv \"$APP.old\" \"$APP\"; open \"$DIR/new\"; exit 1; fi\n"
           << "xattr -dr com.apple.quarantine \"$APP\" 2>/dev/null\n"
           << "open \"$APP\"\n";
        s.replaceWithText (sh); return s;
    }
    static juce::File writeWindowsScript (const juce::File& dir, const juce::File& zip)
    {
        const auto appDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
        const auto s = dir.getChildFile ("install.ps1");
        auto q = [] (const juce::File& f) { return "'" + f.getFullPathName().replace ("'", "''") + "'"; };
        juce::String ps;
        ps << "$ErrorActionPreference = 'Stop'\n"
           << "while (Get-Process -Name 'Rose Studio' -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }\n"
           << "try {\n"
           << "  Expand-Archive -LiteralPath " << q (zip) << " -DestinationPath " << q (dir.getChildFile ("new")) << " -Force\n"
           << "  Copy-Item -Path (Join-Path " << q (dir.getChildFile ("new").getChildFile ("Rose Studio")) << " '*') -Destination " << q (appDir) << " -Recurse -Force\n"
           << "  Start-Process -FilePath " << q (appDir.getChildFile ("Rose Studio.exe")) << "\n"
           << "} catch { Start-Process explorer.exe " << q (dir) << " }\n";
        s.replaceWithText (ps); return s;
    }
};
} // namespace rose
