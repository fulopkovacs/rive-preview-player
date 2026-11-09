# rive-video-preview

A video-style preview player for Rive CLI projects: a scrubbable timeline, synced
audio, frame stepping and copyable timecodes. It runs in a resizable Chrome app window.

```bash
rive-video-preview                      # preview the project in the current directory
rive-video-preview path/to/project      # …or another project
rive-video-preview build/scene.riv      # …or a prebuilt .riv (no audio timing, see below)
rive-video-preview . --at 12.5          # jump to 12.5s (also 1:02.25, f741)
rive-video-preview . --stop             # stop the player for this project
```

## How it works

1. `rive . --once --format=json` builds an unsigned `.riv` (about 0.7s). No account and no upload.
2. `rive inspect . --json` supplies the timeline: artboards, animations, fps and work area,
   plus every `AudioEvent` keyframe (`KeyFrameCallback`) with its asset and volume.
3. A local server (127.0.0.1, port 4810+) serves the player. The page draws frames with
   `@rive-app/webgl2-advanced`, using `LinearAnimationInstance.time` and `apply()`, so any
   frame can be shown exactly.
4. Audio bytes come out of the `.riv` through a custom asset loader. The runtime's own
   audio stays silent. Each sound plays through Web Audio, scheduled against the playhead,
   so sounds already under way when you press play start partway through, at the correct offset.
5. Saving any project file (`gen/build.py` writing `scene.rml` counts) triggers a rebuild,
   and the window reloads in place without moving the playhead. A build error
   appears over the stage, and the player keeps showing the last good build.

Running the command a second time for the same project reuses the player that is already
running. With `--at`, the open window jumps to that time.

## Player

| Key | |
|---|---|
| Space / K | play / pause |
| ← / → | step one frame · Shift: one second |
| Home / End | start / end (of the in–out range if set) |
| I / O / X | set in point / set out point / clear (playback loops inside the range) |
| C | copy timecode: `00:12.350 (frame 741)` |
| Shift+C | copy range: `00:10.000–00:12.500 (frames 600–750)` |
| G | go to time (or double-click the timecode) |
| L / M / F | loop / mute / fullscreen |

To copy the playhead time you can also click the timecode. Each copied timecode is also
printed in the terminal running the player. Scroll on the timeline to zoom, Shift-scroll
or a horizontal scroll pans, and a double-click on the ruler resets the zoom. The waveform
lane is a mix of all audio events, and the coloured ticks mark where each event fires.

## Snippet for a project's AGENTS.md

```md
## Showing the user a video preview

- Run `rive-video-preview .` in the background to open a scrubbable player with sound.
  It rebuilds on save, so start it once and leave it running.
- To point the user at a moment, run `rive-video-preview . --at <time>` (12.5, 1:02.25,
  f741). This moves the playhead of the player that is already open.
- Timecodes the user pastes look like `00:12.350 (frame 741)`, which is seconds into
  the animation and the frame at its fps.
```

## Limits

- Audio is synced only for `AudioEvent`s keyed on the animation timeline, which is how
  video scenes are built. A sound fired by a state machine transition or a script is not
  played.
- The player bypasses the state machine and drives the chosen animation directly, so
  inputs, listeners and data-bound logic do not run. Use `rive .` to test interactivity.
- For a bare `.riv`, the duration is measured and the fps assumed to be 60, and the
  audio timing is unavailable.
- Scripted (Luau) projects may fail to load: web runtimes reject the unsigned scripts
  that local builds carry.

## Install

```bash
npm install && npm link    # puts `rive-video-preview` on PATH
```
