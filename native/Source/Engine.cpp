#include "Engine.h"
#include <numeric>

namespace rose
{
using Graph = juce::AudioProcessorGraph;
static const juce::Colour palette[] = { juce::Colour (0xffff2d87), juce::Colour (0xffffb020), juce::Colour (0xff22c55e), juce::Colour (0xff3b82f6),
                                        juce::Colour (0xffa855f7), juce::Colour (0xff14b8a6), juce::Colour (0xfff43f5e), juce::Colour (0xffeab308) };

//==============================================================================
TrackSource::TrackSource (Engine& e, bool audio)
    : AudioProcessor (BusesProperties().withOutput ("Out", juce::AudioChannelSet::stereo())), isAudio (audio), engine (e)
{ sounding.reserve (128); }

void TrackSource::prepareToPlay (double sr, int bs)
{
    for (auto& s : shifter) s.prepare (sr);
    pitched.setSize (2, juce::jmax (bs, 512) * 2); pitched.clear(); pitchedHold = 0;
}

void TrackSource::processBlock (juce::AudioBuffer<float>& buf, juce::MidiBuffer& midi)
{
    buf.clear(); midi.clear();
    if (pitched.getNumSamples() < buf.getNumSamples()) pitched.setSize (2, buf.getNumSamples(), false, false, true);
    pitched.clear(); bool anyPitched = false;
    const int tp = drumKit.load() ? 0 : transpose.load();
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
                        const double tempo = c.srcBpm > 0 ? tr.bpmAt (tr.beatsAt (s)) / c.srcBpm : 1.0;   // loops follow the song tempo (and tempo changes)
                        // independent pitch: shifted through the pitch engine, read ~20 ms early to cancel its latency
                        const float semis = c.pitch + (float) tp - (c.srcBpm > 0 ? (float) (12.0 * std::log2 (tempo)) : 0.0f);
                        const bool shift = std::abs (semis) > 0.004f; const juce::int64 leadIn = shift ? (juce::int64) (sr * 0.02) : 0;
                        const auto cs = tr.samplesAt (c.start) - leadIn, ce = tr.samplesAt (c.start + c.length) - leadIn;
                        const auto a = juce::jmax (cs, s), b = juce::jmin (ce, e);
                        if (a >= b) continue;
                        const float g = juce::Decibels::decibelsToGain (c.gainDb); const auto& d = *c.data; const int len2 = d.getNumSamples();
                        const double ratio = c.fileRate / sr * tempo, base = c.offsetSec * c.fileRate;
                        auto& dst = shift ? pitched : buf; if (shift) { anyPitched = true; pitchedSemis = semis; }
                        const auto loopS = c.loopLen > 0 && c.loopLen < c.length ? tr.samplesAt (c.loopLen) : (juce::int64) 0;
                        const double fiS = (double) tr.samplesAt (c.fadeIn), foS = (double) tr.samplesAt (c.fadeOut), clipS = (double) (ce - cs);
                        for (auto t = a; t < b; ++t)
                        {
                            const auto rel = t - cs; double idx;
                            if (c.srcBpm > 0)   // tempo-following loop: read by musical position, so it stays locked through tempo changes
                            {
                                const double rb = tr.beatsAt (t + leadIn) - c.start, rl = c.loopLen > 0 && c.loopLen < c.length ? std::fmod (juce::jmax (0.0, rb), c.loopLen) : rb;
                                idx = base + rl * 60.0 / c.srcBpm * c.fileRate;
                            }
                            else { const auto relL = loopS > 0 ? rel % loopS : rel; idx = base + (double) relL * ratio; }
                            const int i0 = (int) idx; if (i0 < 0) continue;
                            if (i0 + 1 >= len2) { if (loopS > 0) continue; break; }
                            const float fr = (float) (idx - i0);
                            float env = g;
                            if (fiS > 0 && rel < fiS) env *= (float) (rel / fiS);
                            if (foS > 0 && rel > clipS - foS) env *= (float) juce::jmax (0.0, (clipS - rel) / foS);
                            for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                            {
                                const auto* sp = d.getReadPointer (juce::jmin (ch, d.getNumChannels() - 1));
                                dst.addSample (juce::jmin (ch, dst.getNumChannels() - 1), off + (int) (t - s), (sp[i0] + (sp[i0 + 1] - sp[i0]) * fr) * env);
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
                                const int q = juce::jlimit (0, 127, nt.pitch + (drumKit.load() ? 0 : c.transpose + tp));
                                if (on >= s && on < e) noteOn (q, nt.vel, off + (int) (on - s));
                                if (off2 >= s && off2 < e) noteOff (q, off + (int) (off2 - s));
                            }
                    }
                    if (tr.looping.load() && ! tr.recording.load() && e == loopEndS) allOff (juce::jmax (0, off + len - 1));
                }
            });
        }
    }
    else if (! sounding.empty()) allOff (0);

    // pitched clips: run through the shifter (kept running ~1 s after the last pitched clip so its tail plays out)
    if (anyPitched) pitchedHold = (int) (tr.sampleRate * 1.0);
    if (isAudio && pitchedHold > 0)
    {
        PitchCore::Params pr; pr.tune = false; pr.shiftSemis = std::trunc (pitchedSemis); pr.detuneCents = (pitchedSemis - std::trunc (pitchedSemis)) * 100.0f;
        const int nch = juce::jmin (2, buf.getNumChannels());
        for (int ch = 0; ch < nch; ++ch)
        {
            auto* in = pitched.getReadPointer (ch); auto* out = buf.getWritePointer (ch);
            for (int i = 0; i < n; ++i) out[i] += shifter[ch].process (in[i], pr);
        }
        pitchedHold -= n;
    }

    // live MIDI (keyboard / controller) goes to the selected track, and is captured when recording
    if (liveTarget.load() && ! isAudio)
    {
        for (const auto m : engine.liveMidi)
        {
            auto msg = m.getMessage();
            if (tp != 0 && (msg.isNoteOn() || msg.isNoteOff())) { auto out = msg; out.setNoteNumber (juce::jlimit (0, 127, msg.getNoteNumber() + tp)); midi.addEvent (out, m.samplePosition); }   // sounds transposed, records as played
            else midi.addEvent (msg, m.samplePosition);
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
    t.src()->drumKit = id == "drums";
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
    c.length = transport.beatAtSec (transport.secAt (startBeat) + (double) r->lengthInSamples / r->sampleRate) - startBeat;
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
    if (numIn > 0 && in[0] != nullptr)   // input tap for the tuner
    { int s1, n1, s2, n2; inFifo.prepareToWrite (n, s1, n1, s2, n2); if (n1 > 0) std::copy (in[0], in[0] + n1, inBuf.begin() + s1); if (n2 > 0) std::copy (in[0] + n1, in[0] + n1 + n2, inBuf.begin() + s2); inFifo.finishedWrite (n1 + n2); }
    {   // analysis tap (the mix, before A/B)
        int s1, n1, s2, n2; tapFifo.prepareToWrite (n, s1, n1, s2, n2);
        for (int ch = 0; ch < 2; ++ch) { const float* src = out[juce::jmin (ch, numOut - 1)]; if (src == nullptr) continue;
            if (n1 > 0) tapBuf.copyFrom (ch, s1, src, n1); if (n2 > 0) tapBuf.copyFrom (ch, s2, src + n1, n2); }
        tapFifo.finishedWrite (n1 + n2);
    }
    {   // reference track: plays in sync with the playhead; B replaces the mix with it
        const juce::SpinLock::ScopedTryLockType l (refLock);
        if (l.isLocked() && reference != nullptr && (refOn.load()))
        {
            const auto& r = *reference; const float g = juce::Decibels::decibelsToGain (refGainDb.load());
            const double sec0 = transport.secAt (transport.beatsAt (transport.pos.load())) + refOffsetSec.load(), step = referenceRate / transport.sampleRate;
            for (int ch = 0; ch < numOut; ++ch) if (out[ch] != nullptr) juce::FloatVectorOperations::clear (out[ch], n);
            if (transport.playing.load())
                for (int i = 0; i < n; ++i)
                {
                    const double idx = sec0 * referenceRate + i * step; const int i0 = (int) idx; if (i0 < 0 || i0 + 1 >= r.getNumSamples()) continue; const float fr = (float) (idx - i0);
                    for (int ch = 0; ch < juce::jmin (2, numOut); ++ch) { const float* d = r.getReadPointer (juce::jmin (ch, r.getNumChannels() - 1)); if (out[ch] != nullptr) out[ch][i] = (d[i0] + (d[i0 + 1] - d[i0]) * fr) * g; }
                }
        }
    }
    {
        const juce::SpinLock::ScopedTryLockType l (previewLock);
        if (l.isLocked() && preview != nullptr)
        {
            auto& p = *preview; const int len = p.data.getNumSamples();
            for (int i = 0; i < n; ++i)
            {
                const int i0 = (int) p.pos; const float fr = (float) (p.pos - i0);
                for (int ch = 0; ch < juce::jmin (2, numOut); ++ch)
                {
                    const auto* d = p.data.getReadPointer (juce::jmin (ch, p.data.getNumChannels() - 1));
                    float v = (d[i0] + (d[juce::jmin (i0 + 1, len - 1)] - d[i0]) * fr) * 0.8f;
                    if (p.shift) v = p.core[ch].process (v, p.pr);
                    if (out[ch] != nullptr) out[ch][i] += v;
                }
                p.pos += p.rate; if (p.pos >= p.end - 1) p.pos = 0;
            }
        }
    }

    if (transport.playing.load())
    {
        const auto start = transport.pos.load(); const double sr = transport.sampleRate;
        if (transport.metronome.load())
            transport.segments (start, n, [&] (juce::int64 s, int off, int len)
            {
                for (int i = 0; i < len; ++i)
                {
                    const double b = transport.beatsAt (s + i);
                    if (std::floor (b) != std::floor (lastBeat) || lastBeat < 0 || b < lastBeat) { metroLeft = (int) (0.035 * sr); metroAccent = transport.barAt (std::floor (b + 1e-9)).beat < 0.01; metroPhase = 0; }
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
        e->setAttribute ("mute", t->mute); e->setAttribute ("solo", t->solo); e->setAttribute ("colour", t->colour.toString()); e->setAttribute ("transpose", t->src()->transpose.load());
        if (t->instrument.node) writeSlot (*e, "Instrument", t->instrument);
        for (auto& s : t->inserts) writeSlot (*e, "Insert", s);
        const juce::ScopedLock sl (t->src()->lock);
        for (auto& c : t->src()->audioClips)
        { auto* x = e->createNewChildElement ("AudioClip"); x->setAttribute ("file", c.file.getFullPathName()); x->setAttribute ("start", c.start); x->setAttribute ("length", c.length); x->setAttribute ("offset", c.offsetSec); x->setAttribute ("gain", c.gainDb); x->setAttribute ("fadeIn", c.fadeIn); x->setAttribute ("fadeOut", c.fadeOut); x->setAttribute ("loopLen", c.loopLen); x->setAttribute ("pitch", c.pitch); x->setAttribute ("srcBpm", c.srcBpm); x->setAttribute ("name", c.name); }
        for (auto& c : t->src()->midiClips)
        {
            auto* x = e->createNewChildElement ("MidiClip"); x->setAttribute ("name", c.name); x->setAttribute ("start", c.start); x->setAttribute ("length", c.length); x->setAttribute ("loopLen", c.loopLen); x->setAttribute ("transpose", c.transpose);
            for (auto& n : c.notes) { auto* ne = x->createNewChildElement ("N"); ne->setAttribute ("p", n.pitch); ne->setAttribute ("s", n.start); ne->setAttribute ("l", n.length); ne->setAttribute ("v", n.vel); }
        }
    }
    {   // song tools
        auto* sg = root.createNewChildElement ("Song"); sg->setAttribute ("sig", transport.sig.load());
        const auto map = transport.currentMap();
        for (auto& x : map.tempo) { auto* e = sg->createNewChildElement ("Tempo"); e->setAttribute ("b", x.beat); e->setAttribute ("bpm", x.bpm); }
        for (auto& x : map.meter) { auto* e = sg->createNewChildElement ("Meter"); e->setAttribute ("b", x.beat); e->setAttribute ("n", x.num); }
        for (auto& x : markers) { auto* e = sg->createNewChildElement ("Marker"); e->setAttribute ("b", x.beat); e->setAttribute ("name", x.name); }
        for (auto& x : sections) { auto* e = sg->createNewChildElement ("Section"); e->setAttribute ("b", x.start); e->setAttribute ("len", x.len); e->setAttribute ("name", x.name); e->setAttribute ("colour", x.colour.toString()); }
        for (auto& x : chords) { auto* e = sg->createNewChildElement ("Chord"); e->setAttribute ("b", x.beat); e->setAttribute ("name", x.name); }
        if (referenceFile.existsAsFile()) { auto* e = sg->createNewChildElement ("Reference"); e->setAttribute ("file", referenceFile.getFullPathName()); e->setAttribute ("gain", refGainDb.load()); e->setAttribute ("offset", refOffsetSec.load()); }
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
    markers.clear(); sections.clear(); chords.clear(); clearReference();
    {
        Transport::SongMap map;
        if (auto* sg = root->getChildByName ("Song"))
        {
            transport.sig = sg->getIntAttribute ("sig", 4);
            for (auto* e : sg->getChildWithTagNameIterator ("Tempo")) map.tempo.push_back ({ e->getDoubleAttribute ("b"), e->getDoubleAttribute ("bpm", 120) });
            for (auto* e : sg->getChildWithTagNameIterator ("Meter")) map.meter.push_back ({ e->getDoubleAttribute ("b"), e->getIntAttribute ("n", 4) });
            for (auto* e : sg->getChildWithTagNameIterator ("Marker")) markers.push_back ({ e->getDoubleAttribute ("b"), e->getStringAttribute ("name") });
            for (auto* e : sg->getChildWithTagNameIterator ("Section")) sections.push_back ({ e->getDoubleAttribute ("b"), e->getDoubleAttribute ("len", 8), e->getStringAttribute ("name"), juce::Colour::fromString (e->getStringAttribute ("colour", "ff5b8def")) });
            for (auto* e : sg->getChildWithTagNameIterator ("Chord")) chords.push_back ({ e->getDoubleAttribute ("b"), e->getStringAttribute ("name") });
            if (auto* e = sg->getChildByName ("Reference")) if (loadReference (juce::File (e->getStringAttribute ("file")))) { refGainDb = (float) e->getDoubleAttribute ("gain"); refOffsetSec = e->getDoubleAttribute ("offset"); }
        }
        transport.setMap (map);
    }
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
        t.volDb = (float) e->getDoubleAttribute ("vol", -6); t.pan = (float) e->getDoubleAttribute ("pan"); t.mute = e->getBoolAttribute ("mute"); t.solo = e->getBoolAttribute ("solo"); t.src()->transpose = e->getIntAttribute ("transpose");
        t.colour = juce::Colour::fromString (e->getStringAttribute ("colour", "ffff2d87"));
        if (auto* ie = e->getChildByName ("Instrument")) loadSlot (ie, [&] (auto id, auto d, auto st) { return setInstrument (t, id, d, st); });
        for (auto* x : e->getChildWithTagNameIterator ("Insert"))
        { loadSlot (x, [&] (auto id, auto d, auto st) { return addInsert (t.inserts, id, d, st); }); if (! t.inserts.empty()) t.inserts.back().bypass = x->getBoolAttribute ("bypass"); }
        for (auto* x : e->getChildWithTagNameIterator ("AudioClip"))
        {
            juce::File af (x->getStringAttribute ("file"));
            if (addAudioFile (t, af, x->getDoubleAttribute ("start")))
            { const juce::ScopedLock sl (t.src()->lock); auto& c = t.src()->audioClips.back(); c.length = x->getDoubleAttribute ("length", c.length); c.offsetSec = x->getDoubleAttribute ("offset"); c.gainDb = (float) x->getDoubleAttribute ("gain");
              c.fadeIn = x->getDoubleAttribute ("fadeIn"); c.fadeOut = x->getDoubleAttribute ("fadeOut"); c.loopLen = x->getDoubleAttribute ("loopLen");
              c.pitch = (float) x->getDoubleAttribute ("pitch"); c.srcBpm = x->getDoubleAttribute ("srcBpm"); c.name = x->getStringAttribute ("name"); }
            else problems.add ("Missing audio: " + af.getFileName());
        }
        for (auto* x : e->getChildWithTagNameIterator ("MidiClip"))
        {
            MidiClip c; c.name = x->getStringAttribute ("name", "MIDI"); c.start = x->getDoubleAttribute ("start"); c.length = x->getDoubleAttribute ("length", 4); c.loopLen = x->getDoubleAttribute ("loopLen"); c.transpose = x->getIntAttribute ("transpose");
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
    markers.clear(); sections.clear(); chords.clear(); transport.setMap ({}); transport.sig = 4;
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

namespace rose
{
const std::vector<LoopInfo>& loopLibrary()
{
    static std::vector<LoopInfo> lib; static bool loaded = false;
    if (! loaded)
    {
        loaded = true;
        const auto json = juce::JSON::parse (findResourceDir ("loops").getChildFile ("index.json"));
        if (auto* a = json["loops"].getArray())
            for (auto& L : *a)
                lib.push_back ({ L["id"].toString(), L["name"].toString(), L["cat"].toString(), L["key"].isString() ? L["key"].toString() : juce::String(),
                                 L["bpm"].isVoid() ? 0.0 : (double) L["bpm"], L["beats"].isVoid() ? 0.0 : (double) L["beats"] });
    }
    return lib;
}
juce::File loopFile (const LoopInfo& L) { return findResourceDir ("loops").getChildFile (L.id + ".mp3"); }
int keyShift (const juce::String& from, const juce::String& to)
{
    static const juce::StringArray k { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    if (from.isEmpty() || to.isEmpty() || ! k.contains (from) || ! k.contains (to)) return 0;
    int d = (k.indexOf (to) - k.indexOf (from) + 12) % 12; return d > 6 ? d - 12 : d;
}

int Engine::placeLoop (const LoopInfo& L, int trackIndex, double beat, int semis)
{
    const auto f = loopFile (L); if (! f.existsAsFile()) return -1;
    beat = std::round (beat * 4) / 4;
    const double len = L.bpm > 0 && L.beats > 0 ? L.beats : 0;
    Track* t = juce::isPositiveAndBelow (trackIndex, (int) tracks.size()) && tracks[(size_t) trackIndex]->isAudio ? tracks[(size_t) trackIndex].get() : nullptr;
    if (t != nullptr && len > 0)
    {
        const juce::ScopedLock sl (t->src()->lock);
        for (auto& c : t->src()->audioClips) if (c.start < beat + len - 1e-6 && c.start + c.length > beat + 1e-6) { t = nullptr; break; }   // never stack clips
    }
    if (t == nullptr)
    {
        auto& nt = addTrack (true, (L.cat == "Drums" || L.cat == "Percussion" ? L.name.upToFirstOccurrenceOf (juce::String::fromUTF8 (" \xc2\xb7"), false, false) : L.name).substring (0, 24));
        t = &nt; trackIndex = (int) tracks.size() - 1;
    }
    else for (int i = 0; i < (int) tracks.size(); ++i) if (tracks[(size_t) i].get() == t) trackIndex = i;
    if (! addAudioFile (*t, f, beat)) return -1;
    {
        const juce::ScopedLock sl (t->src()->lock); auto& c = t->src()->audioClips.back();
        c.name = L.name; c.pitch = (float) semis;
        if (len > 0) { c.srcBpm = L.bpm; c.length = len; c.loopLen = len; }
    }
    sendChangeMessage(); return trackIndex;
}
} // namespace rose

namespace rose
{
void Engine::previewLoop (const LoopInfo* L, int semis)
{
    std::unique_ptr<Preview> next;
    if (L != nullptr)
    {
        std::unique_ptr<juce::AudioFormatReader> r (audioFormats.createReaderFor (loopFile (*L)));
        if (r != nullptr)
        {
            next = std::make_unique<Preview>(); next->id = L->id;
            next->data.setSize ((int) juce::jmin (2u, r->numChannels), (int) r->lengthInSamples); r->read (&next->data, 0, (int) r->lengthInSamples, 0, true, true);
            const double tempo = L->bpm > 0 ? transport.bpmAt (transport.beatsAt (transport.pos.load())) / L->bpm : 1.0, sr = transport.sampleRate;
            next->rate = r->sampleRate / sr * tempo;
            next->end = L->bpm > 0 && L->beats > 0 ? juce::jmin ((double) r->lengthInSamples, L->beats * 60.0 / L->bpm * r->sampleRate) : (double) r->lengthInSamples;
            const float s = (float) semis - (float) (12.0 * std::log2 (tempo));
            next->shift = std::abs (s) > 0.004f; next->pr.tune = false; next->pr.shiftSemis = std::trunc (s); next->pr.detuneCents = (s - std::trunc (s)) * 100.0f;
            for (auto& c : next->core) c.prepare (sr);
        }
    }
    const juce::SpinLock::ScopedLockType l (previewLock); std::swap (preview, next);
}
} // namespace rose

namespace rose
{
//============================================================================== song tools
void Engine::splitAudio (std::vector<AudioClip>& clips, size_t index, double at, const Transport& tr)
{
    auto& c = clips[index]; if (at <= c.start + 1e-6 || at >= c.start + c.length - 1e-6) return;
    const double cut = at - c.start, L = c.loopLen > 0 && c.loopLen < c.length + 1e-9 ? c.loopLen : 0, ph = L > 0 ? std::fmod (cut, L) : cut;
    // source seconds for a span of beats from the clip start: loops read at their own tempo, other clips in real time
    auto secs = [&] (double b) { return c.srcBpm > 0 ? b * 60.0 / c.srcBpm : tr.secAt (c.start + b) - tr.secAt (c.start); };
    auto d = c; d.start = at; d.length = c.length - cut; d.loopLen = 0; d.fadeIn = 0; d.offsetSec = c.offsetSec + secs (ph);
    std::vector<AudioClip> extra;
    if (L > 0)
    {
        if (ph < 1e-9) { d.offsetSec = c.offsetSec; d.loopLen = L; }
        else
        {
            const double rest = d.length, first = juce::jmin (rest, L - ph); d.length = first;
            if (rest - first > 1e-9) { auto e = c; e.start = at + first; e.length = rest - first; e.loopLen = L; e.fadeIn = 0; d.fadeOut = 0; extra.push_back (e); }
        }
    }
    c.length = cut; if (L > 0 && c.length <= L + 1e-9) c.loopLen = 0; c.fadeOut = 0;
    clips.push_back (d); for (auto& e : extra) clips.push_back (e);
}
void Engine::splitMidi (std::vector<MidiClip>& clips, size_t index, double at)
{
    auto& c = clips[index]; if (at <= c.start + 1e-6 || at >= c.start + c.length - 1e-6) return;
    if (c.loopLen > 0 && c.loopLen < c.length)
    {
        std::vector<Note> all; for (double o = 0; o < c.length - 1e-9; o += c.loopLen) for (auto& n : c.notes) if (n.start < c.loopLen && o + n.start < c.length) all.push_back ({ n.pitch, o + n.start, juce::jmin (n.length, c.loopLen - n.start), n.vel });
        c.notes = all; c.loopLen = 0;
    }
    auto d = c; const double cut = at - c.start; d.start = at; d.length = c.length - cut; d.notes.clear();
    for (auto& n : c.notes) if (n.start >= cut) d.notes.push_back ({ n.pitch, n.start - cut, n.length, n.vel });
    c.notes.erase (std::remove_if (c.notes.begin(), c.notes.end(), [cut] (auto& n) { return n.start >= cut; }), c.notes.end()); c.length = cut;
    for (auto& n : c.notes) n.length = juce::jmin (n.length, cut - n.start);
    clips.push_back (d);
}
void Engine::splitAllAt (double at)
{
    for (auto& t : tracks)
    {
        auto* s = t->src(); const juce::ScopedLock sl (s->lock);
        for (size_t i = 0, n = s->audioClips.size(); i < n; ++i) splitAudio (s->audioClips, i, at, transport);
        for (size_t i = 0, n = s->midiClips.size(); i < n; ++i) splitMidi (s->midiClips, i, at);
    }
}
void Engine::insertTime (double at, double len)
{
    for (auto& t : tracks) { auto* s = t->src(); const juce::ScopedLock sl (s->lock); for (auto& c : s->audioClips) if (c.start >= at - 1e-9) c.start += len; for (auto& c : s->midiClips) if (c.start >= at - 1e-9) c.start += len; }
    for (auto& m : markers) if (m.beat >= at - 1e-9) m.beat += len;
    for (auto& x : chords) if (x.beat >= at - 1e-9) x.beat += len;
    for (auto& x : sections) if (x.start >= at - 1e-9) x.start += len;
    auto map = transport.currentMap(); for (auto& x : map.tempo) if (x.beat >= at - 1e-9) x.beat += len; for (auto& x : map.meter) if (x.beat >= at - 1e-9) x.beat += len; transport.setMap (map);
    if (transport.loopStart.load() >= at) { transport.loopStart = transport.loopStart.load() + len; transport.loopEnd = transport.loopEnd.load() + len; }
}
void Engine::removeTime (double from, double to)
{
    const double len = to - from; auto inside = [&] (double b) { return b >= from - 1e-9 && b < to - 1e-9; };
    for (auto& t : tracks)
    {
        auto* s = t->src(); const juce::ScopedLock sl (s->lock);
        s->audioClips.erase (std::remove_if (s->audioClips.begin(), s->audioClips.end(), [&] (auto& c) { return inside (c.start); }), s->audioClips.end());
        s->midiClips.erase (std::remove_if (s->midiClips.begin(), s->midiClips.end(), [&] (auto& c) { return inside (c.start); }), s->midiClips.end());
        for (auto& c : s->audioClips) if (c.start >= to - 1e-9) c.start -= len; for (auto& c : s->midiClips) if (c.start >= to - 1e-9) c.start -= len;
    }
    auto prune = [&] (auto& v, auto get) { v.erase (std::remove_if (v.begin(), v.end(), [&] (auto& x) { return inside (get (x)); }), v.end()); for (auto& x : v) if (get (x) >= to - 1e-9) get (x) -= len; };
    prune (markers, [] (Marker& m) -> double& { return m.beat; }); prune (chords, [] (ChordMark& m) -> double& { return m.beat; }); prune (sections, [] (Section& m) -> double& { return m.start; });
    auto map = transport.currentMap(); prune (map.tempo, [] (Transport::TempoPoint& x) -> double& { return x.beat; }); prune (map.meter, [] (Transport::MeterPoint& x) -> double& { return x.beat; }); transport.setMap (map);
}
// everything inside [from, to), copied with positions relative to `from`
struct RegionCopy { std::vector<std::pair<int, AudioClip>> audio; std::vector<std::pair<int, MidiClip>> midi; std::vector<Engine::Marker> markers; std::vector<Engine::ChordMark> chords; };
static RegionCopy copyRegion (Engine& e, double from, double to)
{
    RegionCopy r; auto inside = [&] (double b) { return b >= from - 1e-9 && b < to - 1e-9; };
    for (int ti = 0; ti < (int) e.tracks.size(); ++ti)
    {
        auto* s = e.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock);
        for (auto c : s->audioClips) if (inside (c.start)) { c.start -= from; r.audio.push_back ({ ti, c }); }
        for (auto c : s->midiClips) if (inside (c.start)) { c.start -= from; r.midi.push_back ({ ti, c }); }
    }
    for (auto m : e.markers) if (inside (m.beat)) { m.beat -= from; r.markers.push_back (m); }
    for (auto m : e.chords) if (inside (m.beat)) { m.beat -= from; r.chords.push_back (m); }
    return r;
}
static void pasteRegion (Engine& e, const RegionCopy& r, double at)
{
    for (auto [ti, c] : r.audio) { auto* s = e.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock); c.start += at; s->audioClips.push_back (c); }
    for (auto [ti, c] : r.midi) { auto* s = e.tracks[(size_t) ti]->src(); const juce::ScopedLock sl (s->lock); c.start += at; s->midiClips.push_back (c); }
    for (auto m : r.markers) { m.beat += at; e.markers.push_back (m); }
    for (auto m : r.chords) { m.beat += at; e.chords.push_back (m); }
}
void Engine::duplicateSection (int i)
{
    if (! juce::isPositiveAndBelow (i, (int) sections.size())) return;
    const auto x = sections[(size_t) i]; const double a = x.start, b = x.start + x.len;
    splitAllAt (a); splitAllAt (b); const auto cp = copyRegion (*this, a, b); insertTime (b, x.len); pasteRegion (*this, cp, b);
    auto copy = x; copy.start = b; copy.name = x.name + " 2"; sections.push_back (copy); sendChangeMessage();
}
void Engine::deleteSection (int i, bool keepTime)
{
    if (! juce::isPositiveAndBelow (i, (int) sections.size())) return;
    const auto x = sections[(size_t) i]; const double a = x.start, b = x.start + x.len; splitAllAt (a); splitAllAt (b);
    if (keepTime)
        for (auto& t : tracks) { auto* s = t->src(); const juce::ScopedLock sl (s->lock); auto in = [&] (double v) { return v >= a - 1e-9 && v < b - 1e-9; };
            s->audioClips.erase (std::remove_if (s->audioClips.begin(), s->audioClips.end(), [&] (auto& c) { return in (c.start); }), s->audioClips.end());
            s->midiClips.erase (std::remove_if (s->midiClips.begin(), s->midiClips.end(), [&] (auto& c) { return in (c.start); }), s->midiClips.end()); }
    else removeTime (a, b);
    if (keepTime) sections.erase (sections.begin() + i);
    sendChangeMessage();
}
bool Engine::moveSection (int i, int dir)
{
    if (! juce::isPositiveAndBelow (i, (int) sections.size())) return false;
    std::vector<int> order ((size_t) sections.size()); std::iota (order.begin(), order.end(), 0);
    std::sort (order.begin(), order.end(), [&] (int a, int b) { return sections[(size_t) a].start < sections[(size_t) b].start; });
    const int k = (int) (std::find (order.begin(), order.end(), i) - order.begin()), j = k + dir; if (! juce::isPositiveAndBelow (j, (int) order.size())) return false;
    const auto x = sections[(size_t) i]; const auto other = sections[(size_t) order[(size_t) j]];
    const double a = x.start, b = x.start + x.len; splitAllAt (a); splitAllAt (b); const auto cp = copyRegion (*this, a, b);
    removeTime (a, b);   // also removes this section
    double target = dir < 0 ? other.start : other.start + other.len; if (dir > 0) target -= x.len;   // positions shifted by the removal
    splitAllAt (target); insertTime (target, x.len); pasteRegion (*this, cp, target);
    auto moved = x; moved.start = target; sections.push_back (moved); sendChangeMessage(); return true;
}
void Engine::addMarker (double beat, const juce::String& name)
{
    markers.push_back ({ std::round (beat * 4) / 4, name.isNotEmpty() ? name : "Marker " + juce::String ((int) markers.size() + 1) });
    std::sort (markers.begin(), markers.end(), [] (auto& a, auto& b) { return a.beat < b.beat; }); sendChangeMessage();
}
void Engine::detectChords()
{
    static const juce::StringArray K { "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B" };
    static const std::vector<std::pair<const char*, std::vector<int>>> Q { { "", { 0, 4, 7 } }, { "m", { 0, 3, 7 } }, { "7", { 0, 4, 7, 10 } }, { "maj7", { 0, 4, 7, 11 } }, { "m7", { 0, 3, 7, 10 } },
        { "sus2", { 0, 2, 7 } }, { "sus4", { 0, 5, 7 } }, { "dim", { 0, 3, 6 } }, { "aug", { 0, 4, 8 } } };
    double end = songEndBeats(); std::vector<ChordMark> out;
    for (int k = 0; transport.barStart (k) < end; ++k)
    {
        const double b0 = transport.barStart (k), b1 = transport.barStart (k + 1); double w[12] {};
        for (auto& t : tracks)
        {
            auto* s = t->src(); if (t->isAudio || t->mute || s->drumKit.load()) continue; const juce::ScopedLock sl (s->lock);
            for (auto& c : s->midiClips) { const double L = c.loopLen > 0 && c.loopLen < c.length ? c.loopLen : c.length;
                for (double o = 0; o < c.length - 1e-9; o += L) for (auto& n : c.notes) { if (n.start >= L) continue; const double s0 = c.start + o + n.start, s1 = s0 + juce::jmin (n.length, L - n.start);
                    const double ov = juce::jmin (s1, b1) - juce::jmax (s0, b0); if (ov > 0) w[((n.pitch + c.transpose + s->transpose.load()) % 12 + 12) % 12] += ov * n.vel; } }
        }
        double tot = 0; for (double v : w) tot += v; if (tot <= 0) continue;
        double best = 0.2; juce::String name;
        for (int r = 0; r < 12; ++r) for (auto& [q, iv] : Q)
        {
            bool in[12] {}; for (int x : iv) in[(r + x) % 12] = true; double hit = 0, miss = 0;
            for (int pc = 0; pc < 12; ++pc) (in[pc] ? hit : miss) += w[pc] / tot;
            const double score = hit - miss * 0.6 - (iv.size() > 3 ? 0.06 : 0) + (w[r] > 0 ? 0.08 : 0);
            if (score > best) { best = score; name = K[r] + q; }
        }
        if (name.isNotEmpty() && (out.empty() || out.back().name != name)) out.push_back ({ b0, name });
    }
    if (! out.empty()) chords = out;
    sendChangeMessage();
}
int Engine::readTap (juce::AudioBuffer<float>& dest)
{
    int s1, n1, s2, n2; tapFifo.prepareToRead (tapFifo.getNumReady(), s1, n1, s2, n2); const int n = n1 + n2;
    if (dest.getNumSamples() < n) dest.setSize (2, n, false, false, true);
    for (int ch = 0; ch < 2; ++ch) { if (n1 > 0) dest.copyFrom (ch, 0, tapBuf, ch, s1, n1); if (n2 > 0) dest.copyFrom (ch, n1, tapBuf, ch, s2, n2); }
    tapFifo.finishedRead (n); return n;
}
int Engine::readInput (std::vector<float>& dest)
{
    int s1, n1, s2, n2; inFifo.prepareToRead (inFifo.getNumReady(), s1, n1, s2, n2); dest.resize ((size_t) (n1 + n2));
    std::copy (inBuf.begin() + s1, inBuf.begin() + s1 + n1, dest.begin()); std::copy (inBuf.begin() + s2, inBuf.begin() + s2 + n2, dest.begin() + n1);
    inFifo.finishedRead (n1 + n2); return n1 + n2;
}
bool Engine::loadReference (const juce::File& f)
{
    std::unique_ptr<juce::AudioFormatReader> r (audioFormats.createReaderFor (f)); if (r == nullptr) return false;
    auto data = std::make_shared<juce::AudioBuffer<float>> ((int) juce::jmin (2u, r->numChannels), (int) r->lengthInSamples);
    r->read (data.get(), 0, (int) r->lengthInSamples, 0, true, data->getNumChannels() > 1);
    referenceLufs = measureLoudness (*data, r->sampleRate).integrated; referenceFile = f;
    const juce::SpinLock::ScopedLockType l (refLock); reference = data; referenceRate = r->sampleRate; return true;
}
void Engine::clearReference() { refOn = false; std::shared_ptr<juce::AudioBuffer<float>> old; { const juce::SpinLock::ScopedLockType l (refLock); std::swap (old, reference); } referenceFile = juce::File(); }
} // namespace rose

namespace rose
{
Loudness measureLoudness (const juce::AudioBuffer<float>& b, double sr)
{
    KWeight k; k.prepare (sr); std::vector<double> blocks; float pk = 0;
    for (int ch = 0; ch < b.getNumChannels(); ++ch) pk = juce::jmax (pk, b.getMagnitude (ch, 0, b.getNumSamples()));
    k.process (b.getReadPointer (0), b.getNumChannels() > 1 ? b.getReadPointer (1) : nullptr, b.getNumSamples(), [&] (double ms) { blocks.push_back (ms); });
    return { KWeight::integrated (blocks), juce::Decibels::gainToDecibels (pk, -100.0f) };
}
} // namespace rose
