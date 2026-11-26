cmake_minimum_required(VERSION 3.22)
project(Rose VERSION 1.0.0)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

# JUCE: uses ../JUCE or a local checkout if you pass -DJUCE_DIR=..., otherwise downloads it.
include(FetchContent)
if(DEFINED JUCE_DIR)
    add_subdirectory(${JUCE_DIR} JUCE)
else()
    FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.10 GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

juce_add_gui_app(Rose
    PRODUCT_NAME "Rose Studio"
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/Resources/icon.png"
    COMPANY_NAME "Rosenfeld Productions"
    BUNDLE_ID com.rosenfeldproductions.rose
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Rose records audio from your microphone or audio interface.")

juce_generate_juce_header(Rose)
target_sources(Rose PRIVATE Source/Main.cpp Source/Engine.cpp Source/MainComponent.cpp)

target_compile_definitions(Rose PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=1
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Rose,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Rose,JUCE_VERSION>")

if(APPLE)
    target_link_libraries(Rose PRIVATE "-framework CoreAudioKit" "-framework AudioUnit")
endif()
if(MSVC)
    target_compile_options(Rose PRIVATE /bigobj)
endif()

target_link_libraries(Rose PRIVATE
    juce::juce_audio_utils juce::juce_audio_processors juce::juce_dsp
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
