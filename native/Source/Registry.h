// Rose Desktop — registry of built-in instruments and effects.
#pragma once
#include "BuiltIns.h"
#include "VocalTools.h"
#include "Instruments.h"

namespace rose
{
struct BuiltInInfo { juce::String id, name; bool instrument; std::function<std::unique_ptr<BuiltIn>()> make; };
inline const std::vector<BuiltInInfo>& builtIns()
{
    static const std::vector<BuiltInInfo> list {
        { "synth", "Rose Synth", true, [] { return std::make_unique<RoseSynth>(); } },
        { "sounds", "Rose Sounds (piano, strings, choir...)", true, [] { return std::make_unique<RoseSounds>(); } },
        { "drums", "Rose Drums", true, [] { return std::make_unique<RoseDrums>(); } },
        { "eq", "Rose EQ", false, [] { return std::make_unique<EqFx>(); } },
        { "filter", "Rose Filter", false, [] { return std::make_unique<FilterFx>(); } },
        { "comp", "Rose Compressor", false, [] { return std::make_unique<CompFx>(); } },
        { "limiter", "Rose Limiter", false, [] { return std::make_unique<LimiterFx>(); } },
        { "gate", "Rose Gate", false, [] { return std::make_unique<GateFx>(); } },
        { "reverb", "Rose Reverb", false, [] { return std::make_unique<ReverbFx>(); } },
        { "delay", "Rose Delay", false, [] { return std::make_unique<DelayFx>(); } },
        { "chorus", "Rose Chorus", false, [] { return std::make_unique<ChorusFx> (false); } },
        { "flanger", "Rose Flanger", false, [] { return std::make_unique<ChorusFx> (true); } },
        { "phaser", "Rose Phaser", false, [] { return std::make_unique<PhaserFx>(); } },
        { "distortion", "Rose Distortion", false, [] { return std::make_unique<DistortionFx>(); } },
        { "crusher", "Rose Bitcrusher", false, [] { return std::make_unique<CrusherFx>(); } },
        { "width", "Rose Width & Utility", false, [] { return std::make_unique<WidthFx>(); } },
        { "tune", "Rose Tune (pitch correction)", false, [] { return std::make_unique<TuneFx>(); } },
        { "pitch", "Rose Pitch Shifter", false, [] { return std::make_unique<PitchFx>(); } },
        { "harmonizer", "Rose Harmonizer", false, [] { return std::make_unique<HarmonizerFx>(); } },
        { "deesser", "Rose De-esser", false, [] { return std::make_unique<DeEsserFx>(); } },
        { "doubler", "Rose Vocal Doubler", false, [] { return std::make_unique<DoublerFx>(); } },
    };
    return list;
}
} // namespace rose
