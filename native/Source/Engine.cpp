#include "Engine.h"

namespace rose
{
using Graph = juce::AudioProcessorGraph;
static const juce::Colour palette[] = { juce::Colour (0xffff2d87), juce::Colour (0xffffb020), juce::Colour (0xff22c55e), juce::Colour (0xff3b82f6),
                                        juce::Colour (0xffa855f7), juce::Colour (0xff14b8a6), juce::Colour (0xfff43f5e), juce::Colour (0xffeab308) };

//==============================================================================
TrackSource::TrackSource (Engine& e, bool audio)
    : AudioProcessor (BusesProperties().withOutput ("Out", juce::AudioChannelSet::stereo())), isAudio (audio), engine (e)
{ sounding.reserve (128); }

void TrackSource::processBlock (juce::AudioBuffer<float>& buf, juce::MidiBuffer& midi)
{
    buf.clear(); midi.clear();
    auto& tr = engine.transport; const int n = buf.getNumSamples();
    const auto start = tr.pos.load(); const double sr = tr.sampleRate;

    auto noteOn  = [&] (int p, float v, int at) { midi.addEvent (juce::MidiMessage::noteOn (1, p, v), at); sounding.push_back (p); };
    auto noteOff = [&] (int p, int at) { midi.addEvent (juce::MidiMessage::noteOff (1, p), at); auto it = std::find (sounding.begin(), sounding.end(), p); if (it != sounding.end()) sounding.erase (it); };
    auto allOff  = [&] (int at) { for (int p : sounding) midi.addEvent (juce::MidiMessage::noteOff (1, p), at); sounding.clear(); };

    if (tr.playing.load())
    {
        const juce::ScopedTryLock sl (lock);
        if (sl.isLocked())
        {
            const auto loopEndS = tr.samplesAt (tr.loopEnd.load());
            tr.segments (start, n, [&] (juce::int64 s, int off, int len)
            {
                const auto e = s + len;
                if (isAudio)
                {
                    for (auto& c : audioClips)
                    {
                        if (! c.data) continue;
                        const auto cs = tr.samplesAt (c.start), ce = tr.samplesAt (c.start + c.length);
                        const auto a = juce::jmax (cs, s), b = juce::jmin (ce, e);
                        if (a >= b) continue;
                        const float g = juce::Decibels::decibelsToGain (c.gainDb); const auto& d = *c.data; const int len2 = d.getNumSamples();
                        const double ratio = c.fileRate / sr, base = c.offsetSec * c.fileRate;
                        const auto loopS = c.loopLen > 0 && c.loopLen < c.length ? tr.samplesAt (c.loopLen) : (juce::int64) 0;
                        const double fiS = (double) tr.samplesAt (c.fadeIn), foS = (double) tr.samplesAt (c.fadeOut), clipS = (double) (ce - cs);
                        for (auto t = a; t < b; ++t)
                        {
                            const auto rel = t - cs, relL = loopS > 0 ? rel % loopS : rel;
                            const double idx = base + (double) relL * ratio; const int i0 = (int) idx;
                            if (i0 + 1 >= len2) { if (loopS > 0) continue; break; }
                            const float fr = (float) (idx - i0);
                            float env = g;
                            if (fiS > 0 && rel < fiS) env *= (float) (rel / fiS);
                            if (foS > 0 && rel > clipS - foS) env *= (float) juce::jmax (0.0, (clipS - rel) / foS);
                            for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                            {
                                const auto* sp = d.getReadPointer (juce::jmin (ch, d.getNumChannels() - 1));
                                buf.addSample (ch, off + (int) (t - s), (sp[i0] + (sp[i0 + 1] - sp[i0]) * fr) * env);
                            }
                        }
                    }
                }
                else
                {
                    for (auto& c : midiClips)
                    {
                        const double L = c.loopLen > 0 && c.loopLen < c.length ? c.loopLen : c.length;
                        for (double o = 0; o < c.length - 1e-9; o += L)
                            for (auto& nt : c.notes)
                            {
                                if (nt.start >= L || o + nt.start >= c.length) continue;
                                const auto on = tr.samplesAt (c.start + o + nt.start), off2 = tr.samplesAt (c.start + juce::jmin (o + nt.start + nt.length, juce::jmin (o + L, c.length)));
                                if (on >= s && on < e) noteOn (nt.pitch, nt.vel, off + (int) (on - s));
                                if (off2 >= s && off2 < e) noteOff (nt.pitch, off + (int) (off2 - s));
                            }
                    }
                    if (tr.looping.load() && ! tr.recording.load() && e == loopEndS) allOff (juce::jmax (0, off + len - 1));
                }
            });
        }
    }
    else if (! sounding.empty()) allOff (0);

    // live MIDI (keyboard / controller) goes to the selected track, and is captured when recording
    if (liveTarget.load() && ! isAudio)
    {
        for (const auto m : engine.liveMidi)
        {
            const auto msg = m.getMessage(); midi.addEvent (msg, m.samplePosition);
            if (tr.recording.load() && armed.load() && (msg.isNoteOn() || msg.isNoteOff()))
            {
                int s1, n1, s2, n2; recFifo.prepareToWrite (1, s1, n1, s2, n2);
                if (n1 > 0) { recBuf[(size_t) s1] = { msg.isNoteOn(), msg.getNoteNumber(), msg.getFloatVelocity(), tr.beatsAt (start + m.samplePosition) }; recFifo.finishedWrite (1); }
            }
        }
    }

    // audio input: monitoring and recording
    if (isAudio && armed.load() && engine.currentInput != nullptr && engine.currentNumInputs > 0)
    {
        const float* chans[2] = { engine.currentInput[0], engine.currentInput[juce::jmin (1, engine.currentNumInputs - 1)] };
        if (chans[0] != nullptr && chans[1] != nullptr)
        {
            if (monitor.load()) for (int ch = 0; ch < juce::jmin (2, buf.getNumChannels()); ++ch) buf.addFrom (ch, 0, chans[ch], n);
            if (tr.recording.load())
            {
                const juce::ScopedTryLock wl (writerLock);
                if (wl.isLocked() && writer != nullptr) writer->write (chans, n);
            }
        }
    }
}

//==============================================================================
Engine::Engine()
{
    audioFormats.registerBasicFormats();
    formats.addDefaultFormats();   // VST3 everywhere, Audio Units on macOS

    juce::PropertiesFile::Options o; o.applicationName = "Rose"; o.filenameSuffix = "settings"; o.folderName = "Rose"; o.osxLibrarySubFolder = "Application Support";
    settings = std::make_unique<juce::PropertiesFile> (o);
    deadMansPedal = settings->getFile().getSiblingFile ("RoseScanCrash.txt");
    if (auto xml = settings->getXmlValue ("plugins")) knownPlugins.recreateFromXml (*xml);

    graph = std::make_unique<Graph>();
    graph->setPlayConfigDetails (2, 2, 44100.0, 512);   // so output connections are legal before an audio device starts
    audioOut = graph->addNode (std::make_unique<Graph::AudioGraphIOProcessor> (Graph::AudioGraphIOProcessor::audioOutputNode));
    masterIn = makeNode (std::make_unique<StripProcessor>());
    masterStrip = makeNode (std::make_unique<StripProcessor>());
    dynamic_cast<StripProcessor*> (masterIn->getProcessor())->gainDb = 0.0f;
    dynamic_cast<StripProcessor*> (masterStrip->getProcessor())->gainDb = -1.0f;
    addInsert (masterInserts, "limiter", nullptr);

    auto audioState = settings->getXmlValue ("audio");
    deviceManager.initialise (2, 2, audioState.get(), true);
    for (auto& d : juce::MidiInput::getAvailableDevices()) deviceManager.setMidiInputDeviceEnabled (d.identifier, true);
    deviceManager.addMidiInputDeviceCallback ({}, this);
    player.setProcessor (graph.get());
    deviceManager.addAudioCallback (this);
    writerThread.startThread();

    auto& drums = addTrack (false, "Synth 1"); juce::ignoreUnused (drums);
    addTrack (true, "Audio 1");
    selectTrack (0);
}

Engine::~Engine()
{
    if (auto xml = knownPlugins.createXml()) settings->setValue ("plugins", xml.get());
    if (auto xml = deviceManager.createStateXml()) settings->setValue ("audio", xml.get());
    settings->saveIfNeeded();
    transport.playing = false; transport.recording = false;
    for (auto& t : tracks) { const juce::ScopedLock sl (t->src()->writerLock); t->src()->writer.reset(); }
    deviceManager.removeMidiInputDeviceCallback ({}, this);
    deviceManager.removeAudioCallback (this);
    player.setProcessor (nullptr);
    writerThread.stopThread (2000);
    tracks.clear(); graph = nullptr;
}

Graph::Node::Ptr Engine::makeNode (std::unique_ptr<juce::AudioProcessor> p)
{
    p->setPlayHead (&transport);
    return graph->addNode (std::move (p));
}

std::unique_ptr<juce::AudioProcessor> Engine::createProcessor (const juce::String& id, const juce::PluginDescription* desc, juce::String& error)
{
    if (id.isNotEmpty())
    {
        for (auto& b : builtIns()) if (b.id == id) return b.make();
        error = "Unknown built-in: " + id; return nullptr;
    }
    if (desc == nullptr) { error = "No plugin chosen"; return nullptr; }
    auto* dev = deviceManager.getCurrentAudioDevice();
    auto inst = formats.createPluginInstance (*desc, transport.sampleRate, dev ? dev->getCurrentBufferSizeSamples() : 512, error);
    if (inst != nullptr)
    {
        // ask for stereo where the plugin allows it
        auto layout = inst->getBusesLayout();
        if (layout.outputBuses.size() > 0) layout.outputBuses.getReference (0) = juce::AudioChannelSet::stereo();
        if (layout.inputBuses.size() > 0) layout.inputBuses.getReference (0) = juce::AudioChannelSet::stereo();
        if (inst->checkBusesLayoutSupported (layout)) inst->setBusesLayout (layout);
    }
    return inst;
}

Track& Engine::addTrack (bool audio, const juce::String& name)
{
    auto t = std::make_unique<Track>();
    t->isAudio = audio; t->colour = palette[tracks.size() % 8];
    t->name = name.isNotEmpty() ? name : (audio ? "Audio " : "Instrument ") + juce::String (tracks.size() + 1);
    t->source = makeNode (std::make_unique<TrackSource> (*this, audio));
    t->strip = makeNode (std::make_unique<StripProcessor>());
    tracks.push_back (std::move (t));
    auto& tr = *tracks.back();
    if (! audio) setInstrument (tr, "synth", nullptr);
    rewire(); sendChangeMessage();
    return tr;
}

void Engine::removeTrack (int i)
{
    if (i < 0 || i >= (int) tracks.size()) return;
    auto& t = *tracks[(size_t) i];
    { const juce::ScopedLock sl (t.src()->writerLock); t.src()->writer.reset(); }
    for (auto& s : t.inserts) graph->removeNode (s.node.get());
    if (t.instrument.node) graph->removeNode (t.instrument.node.get());
    graph->removeNode (t.source.get()); graph->removeNode (t.strip.get());
    tracks.erase (tracks.begin() + i);
    selectTrack (juce::jlimit (0, juce::jmax (0, (int) tracks.size() - 1), selected));
    rewire(); sendChangeMessage();
}

juce::String Engine::setInstrument (Track& t, const juce::String& id, const juce::PluginDescription* desc, const juce::MemoryBlock* state)
{
    juce::String err; auto p = createProcessor (id, desc, err);
    if (p == nullptr) return err.isEmpty() ? "Couldn't load that instrument" : err;
    if (state != nullptr) p->setStateInformation (state->getData(), (int) state->getSize());
    if (t.instrument.node) graph->removeNode (t.instrument.node.get());
    t.instrument = { makeNode (std::move (p)), id, desc ? *desc : juce::PluginDescription(), false };
    rewire(); sendChangeMessage(); return {};
}

juce::String Engine::addInsert (std::vector<Slot>& chain, const juce::String& id, const juce::PluginDescription* desc, const juce::MemoryBlock* state)
{
    juce::String err; auto p = createProcessor (id, desc, err);
    if (p == nullptr) return err.isEmpty() ? "Couldn't load that effect" : err;
    if (state != nullptr) p->setStateInformation (state->getData(), (int) state->getSize());
    chain.push_back ({ makeNode (std::move (p)), id, desc ? *desc : juce::PluginDescription(), false });
    rewire(); sendChangeMessage(); return {};
}

void Engine::removeInsert (std::vector<Slot>& chain, int i)
{
    if (i < 0 || i >= (int) chain.size()) return;
    graph->removeNode (chain[(size_t) i].node.get()); chain.erase (chain.begin() + i);
    rewire(); sendChangeMessage();
}

void Engine::rewire()
{
    for (auto& c : graph->getConnections()) graph->removeConnection (c, Graph::UpdateKind::none);
    auto link = [this] (Graph::Node::Ptr a, Graph::Node::Ptr b)
    {
        const int outs = a->getProcessor()->getTotalNumOutputChannels(), ins = b->getProcessor()->getTotalNumInputChannels();
        if (outs == 0 || ins == 0) return;
        for (int ch = 0; ch < juce::jmin (2, ins); ++ch)
            graph->addConnection ({ { a->nodeID, juce::jmin (ch, outs - 1) }, { b->nodeID, ch } }, Graph::UpdateKind::none);
    };
    auto chain = [&] (Graph::Node::Ptr from, std::vector<Slot>& ins, Graph::Node::Ptr to)
    {
        auto cur = from;
        for (auto& s : ins) if (s.node && ! s.bypass) { link (cur, s.node); cur = s.node; }
        link (cur, to);
    };
    for (auto& t : tracks)
    {
        if (t->isAudio || ! t->instrument.node) chain (t->source, t->inserts, t->strip);
        else
        {
            graph->addConnection ({ { t->source->nodeID, Graph::midiChannelIndex }, { t->instrument.node->nodeID, Graph::midiChannelIndex } }, Graph::UpdateKind::none);
            chain (t->instrument.node, t->inserts, t->strip);
        }
        link (t->strip, masterIn);
    }
    chain (masterIn, masterInserts, masterStrip);
    link (masterStrip, audioOut);
    graph->rebuild();
    updateMix();
}

void Engine::updateMix()
{
    bool anySolo = false; for (auto& t : tracks) anySolo |= t->solo;
    for (auto& t : tracks) { auto* s = t->str(); s->gainDb = t->volDb; s->panPos = t->pan; s->muted = t->mute || (anySolo && ! t->solo); }
}

void Engine::selectTrack (int i)
{
    selected = juce::jlimit (0, juce::jmax (0, (int) tracks.size() - 1), i);
    for (int k = 0; k < (int) tracks.size(); ++k) tracks[(size_t) k]->src()->liveTarget = (k == selected);
    sendChangeMessage();
}

bool Engine::addAudioFile (Track& t, const juce::File& f, double startBeat)
{
    std::unique_ptr<juce::AudioFormatReader> r (audioFormats.createReaderFor (f));
    if (r == nullptr) return false;
    auto data = std::make_shared<juce::AudioBuffer<float>> ((int) juce::jmin (2u, r->numChannels), (int) r->lengthInSamples);
    r->read (data.get(), 0, (int) r->lengthInSamples, 0, true, data->getNumChannels() > 1);
    AudioClip c; c.file = f; c.start = startBeat; c.data = data; c.fileRate = r->sampleRate;
    c.length = (double) r->lengthInSamples / r->sampleRate * transport.bpm.load() / 60.0;
    { const juce::ScopedLock sl (t.src()->lock); t.src()->audioClips.push_back (std::move (c)); }
    sendChangeMessage(); return true;
}

double Engine::songEndBeats() const
{
    double end = 0;
    for (auto& t : tracks)
    {
        for (auto& c : t->src()->audioClips) end = juce::jmax (end, c.start + c.length);
        for (auto& c : t->src()->midiClips) end = juce::jmax (end, c.start + c.length);
    }
    return juce::jmax (4.0, end);
}

//==============================================================================
void Engine::play()
{
    if (transport.playing.load()) return;
    const double b = positionBeats();
    if (transport.looping.load() && (b < transport.loopStart.load() || b >= transport.loopEnd.load())) transport.pos = transport.samplesAt (transport.loopStart.load());
    transport.playing = true; sendChangeMessage();
}
void Engine::stop()
{
    if (transport.recording.load()) finishRecording();
    if (transport.playing.load()) transport.playing = false; else transport.pos = 0;
    sendChangeMessage();
}
void Engine::toStart() { transport.pos = 0; sendChangeMessage(); }

juce::File Engine::recordingsFolder() const
{
    auto f = juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("Rose").getChildFile ("Recordings");
    f.createDirectory(); return f;
}

void Engine::record()
{
    if (transport.recording.load()) { stop(); return; }
    bool any = false; recordingFiles.clear();
    for (auto& t : tracks)
    {
        auto* s = t->src(); if (! s->armed.load()) continue; any = true;
        s->recFifo.reset();
        if (t->isAudio)
        {
            auto file = recordingsFolder().getNonexistentChildFile (t->name + " " + juce::Time::getCurrentTime().formatted ("%Y-%m-%d %H-%M-%S"), ".wav");
            std::unique_ptr<juce::OutputStream> os (file.createOutputStream().release());
            juce::WavAudioFormat wav;
            auto w = wav.createWriterFor (os, juce::AudioFormatWriterOptions{}.withSampleRate (transport.sampleRate).withNumChannels (2).withBitsPerSample (24));
            if (w != nullptr) { const juce::ScopedLock sl (s->writerLock); s->writer = std::make_unique<juce::AudioFormatWriter::ThreadedWriter> (w.release(), writerThread, 65536); }
            recordingFiles.add (file);
        }
        else recordingFiles.add ({});
    }
    if (! any) return;
    recordStartSample = transport.pos.load();
    transport.recording = true; transport.playing = true; sendChangeMessage();
}

void Engine::finishRecording()
{
    transport.recording = false;
    const double startBeat = transport.beatsAt (recordStartSample), endBeat = positionBeats();
    int k = 0;
    for (auto& t : tracks)
    {
        auto* s = t->src(); if (! s->armed.load()) continue;
        const auto file = recordingFiles[k++];
        if (t->isAudio)
        {
            { const juce::ScopedLock sl (s->writerLock); s->writer.reset(); }
            if (file.existsAsFile()) addAudioFile (*t, file, startBeat);
        }
        else
        {
            MidiClip clip; clip.name = "Recording"; clip.start = std::floor (startBeat); clip.length = juce::jmax (1.0, std::ceil (endBeat - clip.start));
            std::map<int, std::pair<double, float>> open;
            int s1, n1, s2, n2; const int ready = s->recFifo.getNumReady(); s->recFifo.prepareToRead (ready, s1, n1, s2, n2);
            auto take = [&] (int idx) { auto& e = s->recBuf[(size_t) idx];
                if (e.on) open[e.pitch] = { e.beat, e.vel };
                else if (open.count (e.pitch)) { auto [b, v] = open[e.pitch]; clip.notes.push_back ({ e.pitch, b - clip.start, juce::jmax (0.05, e.beat - b), v }); open.erase (e.pitch); } };
            for (int i = 0; i < n1; ++i) take (s1 + i);
            for (int i = 0; i < n2; ++i) take (s2 + i);
            s->recFifo.finishedRead (n1 + n2);
            for (auto& [p, bv] : open) clip.notes.push_back ({ p, bv.first - clip.start, juce::jmax (0.05, endBeat - bv.first), bv.second });
            if (! clip.notes.empty()) { const juce::ScopedLock sl (s->lock); s->midiClips.push_back (std::move (clip)); }
        }
    }
    sendChangeMessage();
}

//==============================================================================
void Engine::audioDeviceAboutToStart (juce::AudioIODevice* d)
{
    transport.sampleRate = d->getCurrentSampleRate();
    collector.reset (transport.sampleRate);
    player.audioDeviceAboutToStart (d);
    juce::MessageManager::callAsync ([this] { if (graph != nullptr) rewire(); });
}
void Engine::audioDeviceStopped() { player.audioDeviceStopped(); }
void Engine::handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& m) { collector.addMessageToQueue (m); }

void Engine::audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n, const juce::AudioIODeviceCallbackContext& ctx)
{
    liveMidi.clear();
    collector.removeNextBlockOfMessages (liveMidi, n);
    keyboard.processNextMidiBuffer (liveMidi, 0, n, true);
    currentInput = in; currentNumInputs = numIn;
    player.audioDeviceIOCallbackWithContext (in, numIn, out, numOut, n, ctx);
    currentInput = nullptr;

    if (transport.playing.load())
    {
        const auto start = transport.pos.load(); const double sr = transport.sampleRate, spb = transport.spb();
        if (transport.metronome.load())
            transport.segments (start, n, [&] (juce::int64 s, int off, int len)
            {
                for (int i = 0; i < len; ++i)
                {
                    const double b = (double) (s + i) / spb;
                    if (std::floor (b) != std::floor (lastBeat) || lastBeat < 0 || b < lastBeat) { metroLeft = (int) (0.035 * sr); metroAccent = ((juce::int64) std::floor (b)) % 4 == 0; metroPhase = 0; }
                    lastBeat = b;
                    if (metroLeft > 0)
                    {
                        const float env = (float) metroLeft / (float) (0.035 * sr), v = (float) std::sin (metroPhase) * 0.3f * env;
                        metroPhase += juce::MathConstants<double>::twoPi * (metroAccent ? 1760.0 : 1100.0) / sr; --metroLeft;
                        for (int ch = 0; ch < numOut; ++ch) if (out[ch] != nullptr) out[ch][off + i] += v;
                    }
                }
            });
        transport.pos = transport.advance (start, n);
    }
    else lastBeat = -1;
}

//==============================================================================
static juce::String b64 (juce::AudioProcessor* p) { juce::MemoryBlock mb; p->getStateInformation (mb); return mb.toBase64Encoding(); }
static void writeSlot (juce::XmlElement& parent, const char* tag, const Slot& s)
{
    auto* e = parent.createNewChildElement (tag);
    e->setAttribute ("builtin", s.builtInId); e->setAttribute ("bypass", s.bypass);
    if (s.builtInId.isEmpty()) if (auto d = s.desc.createXml()) e->addChildElement (d.release());
    if (s.node) e->setAttribute ("state", b64 (s.node->getProcessor()));
}

bool Engine::saveSession (const juce::File& f)
{
    juce::XmlElement root ("RoseSession");
    root.setAttribute ("bpm", transport.bpm.load()); root.setAttribute ("loopStart", transport.loopStart.load()); root.setAttribute ("loopEnd", transport.loopEnd.load()); root.setAttribute ("looping", transport.looping.load());
    for (auto& t : tracks)
    {
        auto* e = root.createNewChildElement ("Track");
        e->setAttribute ("name", t->name); e->setAttribute ("audio", t->isAudio); e->setAttribute ("vol", t->volDb); e->setAttribute ("pan", t->pan);
        e->setAttribute ("mute", t->mute); e->setAttribute ("solo", t->solo); e->setAttribute ("colour", t->colour.toString());
        if (t->instrument.node) writeSlot (*e, "Instrument", t->instrument);
        for (auto& s : t->inserts) writeSlot (*e, "Insert", s);
        const juce::ScopedLock sl (t->src()->lock);
        for (auto& c : t->src()->audioClips)
        { auto* x = e->createNewChildElement ("AudioClip"); x->setAttribute ("file", c.file.getFullPathName()); x->setAttribute ("start", c.start); x->setAttribute ("length", c.length); x->setAttribute ("offset", c.offsetSec); x->setAttribute ("gain", c.gainDb); x->setAttribute ("fadeIn", c.fadeIn); x->setAttribute ("fadeOut", c.fadeOut); x->setAttribute ("loopLen", c.loopLen); }
        for (auto& c : t->src()->midiClips)
        {
            auto* x = e->createNewChildElement ("MidiClip"); x->setAttribute ("name", c.name); x->setAttribute ("start", c.start); x->setAttribute ("length", c.length); x->setAttribute ("loopLen", c.loopLen);
            for (auto& n : c.notes) { auto* ne = x->createNewChildElement ("N"); ne->setAttribute ("p", n.pitch); ne->setAttribute ("s", n.start); ne->setAttribute ("l", n.length); ne->setAttribute ("v", n.vel); }
        }
    }
    auto* m = root.createNewChildElement ("Master"); m->setAttribute ("vol", (double) dynamic_cast<StripProcessor*> (masterStrip->getProcessor())->gainDb.load());
    for (auto& s : masterInserts) writeSlot (*m, "Insert", s);
    return root.writeTo (f);
}

bool Engine::loadSession (const juce::File& f)
{
    auto root = juce::parseXML (f);
    if (root == nullptr || ! root->hasTagName ("RoseSession")) return false;
    stop(); transport.playing = false; transport.pos = 0;
    while (! tracks.empty()) removeTrack ((int) tracks.size() - 1);
    while (! masterInserts.empty()) removeInsert (masterInserts, 0);
    transport.bpm = root->getDoubleAttribute ("bpm", 124); transport.loopStart = root->getDoubleAttribute ("loopStart", 0);
    transport.loopEnd = root->getDoubleAttribute ("loopEnd", 16); transport.looping = root->getBoolAttribute ("looping", true);
    juce::StringArray problems;
    auto loadSlot = [&] (juce::XmlElement* e, auto&& apply)
    {
        juce::MemoryBlock st; st.fromBase64Encoding (e->getStringAttribute ("state"));
        juce::PluginDescription d; if (auto* dx = e->getChildByName ("PLUGIN")) d.loadFromXml (*dx);
        const auto id = e->getStringAttribute ("builtin");
        const auto err = apply (id, id.isEmpty() ? &d : nullptr, &st);
        if (err.isNotEmpty()) problems.add ((id.isEmpty() ? d.name : id) + ": " + err);
    };
    for (auto* e : root->getChildWithTagNameIterator ("Track"))
    {
        auto& t = addTrack (e->getBoolAttribute ("audio"), e->getStringAttribute ("name"));
        t.volDb = (float) e->getDoubleAttribute ("vol", -6); t.pan = (float) e->getDoubleAttribute ("pan"); t.mute = e->getBoolAttribute ("mute"); t.solo = e->getBoolAttribute ("solo");
        t.colour = juce::Colour::fromString (e->getStringAttribute ("colour", "ffff2d87"));
        if (auto* ie = e->getChildByName ("Instrument")) loadSlot (ie, [&] (auto id, auto d, auto st) { return setInstrument (t, id, d, st); });
        for (auto* x : e->getChildWithTagNameIterator ("Insert"))
        { loadSlot (x, [&] (auto id, auto d, auto st) { return addInsert (t.inserts, id, d, st); }); if (! t.inserts.empty()) t.inserts.back().bypass = x->getBoolAttribute ("bypass"); }
        for (auto* x : e->getChildWithTagNameIterator ("AudioClip"))
        {
            juce::File af (x->getStringAttribute ("file"));
            if (addAudioFile (t, af, x->getDoubleAttribute ("start")))
            { const juce::ScopedLock sl (t.src()->lock); auto& c = t.src()->audioClips.back(); c.length = x->getDoubleAttribute ("length", c.length); c.offsetSec = x->getDoubleAttribute ("offset"); c.gainDb = (float) x->getDoubleAttribute ("gain");
              c.fadeIn = x->getDoubleAttribute ("fadeIn"); c.fadeOut = x->getDoubleAttribute ("fadeOut"); c.loopLen = x->getDoubleAttribute ("loopLen"); }
            else problems.add ("Missing audio: " + af.getFileName());
        }
        for (auto* x : e->getChildWithTagNameIterator ("MidiClip"))
        {
            MidiClip c; c.name = x->getStringAttribute ("name", "MIDI"); c.start = x->getDoubleAttribute ("start"); c.length = x->getDoubleAttribute ("length", 4); c.loopLen = x->getDoubleAttribute ("loopLen");
            for (auto* ne : x->getChildWithTagNameIterator ("N")) c.notes.push_back ({ ne->getIntAttribute ("p"), ne->getDoubleAttribute ("s"), ne->getDoubleAttribute ("l"), (float) ne->getDoubleAttribute ("v", 0.8) });
            const juce::ScopedLock sl (t.src()->lock); t.src()->midiClips.push_back (std::move (c));
        }
    }
    if (auto* m = root->getChildByName ("Master"))
    {
        dynamic_cast<StripProcessor*> (masterStrip->getProcessor())->gainDb = (float) m->getDoubleAttribute ("vol", -1);
        for (auto* x : m->getChildWithTagNameIterator ("Insert")) loadSlot (x, [&] (auto id, auto d, auto st) { return addInsert (masterInserts, id, d, st); });
    }
    rewire(); selectTrack (0);
    if (! problems.isEmpty())
        juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Some items couldn't load", problems.joinIntoString ("\n"));
    return true;
}

bool Engine::bounce (const juce::File& f, std::function<void (double)> progress)
{
    transport.playing = false; transport.recording = false;
    deviceManager.removeAudioCallback (this);
    const double sr = transport.sampleRate; const int bs = 512;
    const bool wasLooping = transport.looping.load(); transport.looping = false;
    graph->setNonRealtime (true);
    graph->setPlayConfigDetails (juce::jmax (2, graph->getTotalNumInputChannels()), juce::jmax (2, graph->getTotalNumOutputChannels()), sr, bs);
    graph->prepareToPlay (sr, bs);

    f.deleteFile();
    std::unique_ptr<juce::OutputStream> os (f.createOutputStream().release());
    juce::WavAudioFormat wav;
    auto writer = wav.createWriterFor (os, juce::AudioFormatWriterOptions{}.withSampleRate (sr).withNumChannels (2).withBitsPerSample (24));
    bool ok = writer != nullptr;
    if (ok)
    {
        transport.pos = 0; transport.playing = true;
        const juce::int64 total = transport.samplesAt (songEndBeats()) + (juce::int64) (sr * 3);
        juce::AudioBuffer<float> buf (juce::jmax (2, graph->getTotalNumOutputChannels()), bs); juce::MidiBuffer midi;
        for (juce::int64 done = 0; done < total; done += bs)
        {
            liveMidi.clear(); buf.clear(); midi.clear();
            graph->processBlock (buf, midi);
            writer->writeFromAudioSampleBuffer (buf, 0, (int) juce::jmin ((juce::int64) bs, total - done));
            transport.pos = transport.pos.load() + bs;
            if (progress) progress ((double) done / (double) total);
        }
        transport.playing = false;
    }
    writer.reset();
    graph->releaseResources(); graph->setNonRealtime (false);
    transport.looping = wasLooping; transport.pos = 0;
    deviceManager.addAudioCallback (this);
    return ok;
}
} // namespace rose

namespace rose
{
void Engine::setParam (juce::AudioProcessor& proc, const juce::String& id, const juce::var& v)
{
    for (auto* prm : proc.getParameters())
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (prm); r != nullptr && r->getParameterID() == id)
        {
            float val = 0;
            if (v.isString())
            {
                if (auto* c = dynamic_cast<juce::AudioParameterChoice*> (r)) val = (float) juce::jmax (0, c->choices.indexOf (v.toString()));
                else val = v.toString().getFloatValue();
            }
            else if (v.isBool()) val = (bool) v ? 1.0f : 0.0f;
            else val = (float) (double) v;
            r->setValueNotifyingHost (r->convertTo0to1 (val));
            return;
        }
}

bool Engine::applyTemplate (const juce::var& t, juce::StringArray& problems)
{
    if (! t.isObject() || ! t["tracks"].isArray()) return false;
    stop(); transport.playing = false; transport.pos = 0;
    while (! tracks.empty()) removeTrack ((int) tracks.size() - 1);
    while (! masterInserts.empty()) removeInsert (masterInserts, 0);
    transport.bpm = (double) t.getProperty ("bpm", 120);
    if (auto* loop = t["loop"].getArray(); loop != nullptr && loop->size() == 2) { transport.loopStart = (double) (*loop)[0]; transport.loopEnd = (double) (*loop)[1]; }
    transport.looping = true;

    auto applyParams = [] (juce::AudioProcessor* proc, const juce::var& params)
    {
        if (proc == nullptr) return;
        if (auto* o = params.getDynamicObject()) for (auto& kv : o->getProperties()) setParam (*proc, kv.name.toString(), kv.value);
    };
    auto addFx = [&] (std::vector<Slot>& chain, const juce::var& list)
    {
        if (auto* a = list.getArray())
            for (auto& fx : *a)
            {
                const auto err = addInsert (chain, fx["type"].toString(), nullptr);
                if (err.isNotEmpty()) { problems.add (err); continue; }
                applyParams (chain.back().node->getProcessor(), fx["params"]);
            }
    };
    for (auto& x : *t["tracks"].getArray())
    {
        const auto type = x["type"].toString(); const bool audio = type == "audio";
        auto& tr = addTrack (audio, x["name"].toString());
        tr.volDb = (float) (double) x.getProperty ("vol", -6); tr.pan = (float) (double) x.getProperty ("pan", 0);
        if (! audio)
        {
            const auto err = setInstrument (tr, type, nullptr);
            if (err.isNotEmpty()) problems.add (err);
            else
            {
                auto* proc = tr.instrument.node->getProcessor();
                if (type == "sounds") setParam (*proc, "patch", x["patch"]);
                applyParams (proc, x["nparams"]); applyParams (proc, x["params"]);
            }
            if (auto* clips = x["clips"].getArray())
            {
                const juce::ScopedLock sl (tr.src()->lock);
                for (auto& c : *clips)
                {
                    MidiClip mc; mc.name = c["name"].toString(); mc.start = c["start"]; mc.length = c["len"];
                    if (auto* ns = c["notes"].getArray())
                        for (auto& n : *ns) if (auto* a = n.getArray(); a != nullptr && a->size() == 4)
                            mc.notes.push_back ({ (int) (*a)[0], (double) (*a)[1], (double) (*a)[2], (float) (double) (*a)[3] });
                    tr.src()->midiClips.push_back (std::move (mc));
                }
            }
        }
        addFx (tr.inserts, x["nfx"]);
    }
    addFx (masterInserts, t["master"]["nfx"]);
    selected = 0; updateMix(); rewire(); sendChangeMessage();
    return true;
}
} // namespace rose
