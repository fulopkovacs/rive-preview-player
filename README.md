# rive-video-preview

A video-style preview player for Rive CLI projects: a scrubbable timeline, synced
audio, frame stepping and copyable timecodes. It runs in a resizable Chrome app window.

```bash
rive-video-preview                      # preview the project in the current directory
rive-video-preview path/to/project      # …or another project
rive-video-preview build/scene.riv      # …or a prebuilt .riv
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
| S | screenshot the current frame and open its note |
| N | show / hide the screenshots & notes panel |
| ↑ / ↓ | move the selected sound effect up / down a track |
| A | hide / show the audio tracks |

To copy the playhead time you can also click the timecode. Each copied timecode is also
printed in the terminal running the player. Scroll on the timeline to zoom, Shift-scroll
or a horizontal scroll pans, and a double-click on the ruler resets the zoom.

## Audio tracks and sound-effect levels

Below the stage, every sound effect (each `AudioEvent` keyframe) is a clip on an audio track,
with its waveform drawn at the level it plays at.

- **+ Track** adds a track, up to 3. Each track has a name, **M** (mute), **S** (solo), a volume
  slider (0–150%, double-click resets) and a remove button. Removing a track moves its sound
  effects to the track above it.
- **Click a clip** to select it. A bar below the timeline then sets its volume with a stepped
  slider (0–100% in steps of 10, with dB), applies its track and volume to every occurrence of that
  sound effect, or resets it. Double-click a clip to jump to it.
- **Drag a clip** up or down to move it to another track, or press **↑ / ↓** while it is selected.
  ↓ on the last track adds a new one. Esc deselects.
- **Collapse** the tracks with the *Audio tracks* toggle (or **A**) to get the space back. The
  timeline then shows only the ruler and a tick wherever a sound effect fires.

A sound effect plays at *asset volume × clip volume × track volume*. Changes apply to sounds
that are already playing, without restarting them. The mix is saved to
`<project>/.rive-preview/mix.json`, so it survives reloads and rebuilds. Each clip is keyed by
artboard, animation, event name and occurrence (`["Artboard","Bounce","whoosh",1]`), so retiming a
keyframe keeps its settings. The preview never changes the Rive project. To keep the levels,
the agent can read them with the `get_audio_mix` MCP tool. They are also attached to every
feedback bundle that has a non-default mix, with the resulting volume for each sound effect.

## Screenshots, notes and the coding agent

Press **S** (or the camera button) to screenshot the frame under the playhead. The panel on
the right lists every screenshot with its timecode and a note field: write what should change,
and edit it as often as you like (notes save as you type; Esc leaves the field). Click a
thumbnail or its timecode to jump back to that frame. When you are done, add an optional
overall note and press **Send to agent** (Cmd+Enter in the overall note does the same).

Sending writes a bundle to `<project>/.rive-preview/feedback/<date_time>/`:
`feedback.md` (notes, timecodes and image paths), `feedback.json`, and the PNGs, each cropped to
the artboard. A ready-made prompt for the agent is copied to the clipboard, and the panel shows
when the agent has read the bundle. `.rive-preview/` gets its own `.gitignore`, so nothing in it is committed.
For a bare `.riv`, everything goes in `.rive-preview/<file>.riv/` beside it, so several `.riv` files
in one folder keep their screenshots apart.

### MCP server

`rive-video-preview mcp` is a stdio MCP server that gives the agent the bundles, images included:

| Tool | |
|---|---|
| `get_feedback` | unread bundles (notes, timecodes, artboard/animation, images); marks them read |
| `wait_for_feedback` | blocks until you press Send to agent (default timeout 600s), then returns it |
| `seek_player` | moves the open player to a time, e.g. to show the frame it changed |
| `get_audio_mix` | the tracks and per-sound-effect levels set in the player, and the level each plays at |

```bash
claude mcp add rive-preview -- rive-video-preview mcp            # Claude Code, project in cwd
claude mcp add rive-preview -- rive-video-preview mcp path/to/project
```

```json
{ "mcpServers": { "rive-preview": { "command": "rive-video-preview", "args": ["mcp"] } } }
```

It finds the project from the tool's `project` argument, the dir given after `mcp`, a
`rive.yaml` at or above the working directory, one directly below it, or the only running player.
It reads bundles from disk, so the player does not have to be running; only `seek_player` needs it.
Agents without MCP can read the `feedback.md` path from the copied prompt.

## Snippet for a project's AGENTS.md

```md
## Showing the user a video preview

- Run `rive-video-preview .` in the background to open a scrubbable player with sound.
  It rebuilds on save, so start it once and leave it running.
- To point the user at a moment, run `rive-video-preview . --at <time>` (12.5, 1:02.25,
  f741). This moves the playhead of the player that is already open.
- Timecodes the user pastes look like `00:12.350 (frame 741)`, which is seconds into
  the animation and the frame at its fps.
- The user can screenshot frames, add notes and press "Send to agent". Read that with the
  `get_feedback` MCP tool (or `wait_for_feedback` after asking for a review), or from
  `.rive-preview/feedback/*/feedback.md`.
```

## Limits

- Audio is synced only for `AudioEvent`s keyed on the animation timeline, which is how
  video scenes are built. A sound fired by a state machine transition or a script is not
  played.
- The player bypasses the state machine and drives the chosen animation directly, so
  inputs, listeners and data-bound logic do not run. Use `rive .` to test interactivity.
- For a bare `.riv` there is no project to inspect, so the player reads the artboards,
  animations and `AudioEvent` keyframes from the file itself (`lib/riv-audio.mjs`). The property
  types it needs come from `lib/riv-schema.json`; regenerate that with
  `node scripts/gen-riv-schema.mjs` after a Rive CLI update. If the file cannot be read that
  way, the duration is measured, the fps is assumed to be 60, and there is no audio timing.
- Scripted (Luau) projects may fail to load: web runtimes reject the unsigned scripts
  that local builds carry.

## Install

```bash
pnpm install && pnpm link --global    # puts `rive-video-preview` on PATH
```
