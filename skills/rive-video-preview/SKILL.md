---
name: rive-video-preview
description: Preview Rive CLI projects or .riv files as a scrubbable video with sound, point the user at exact moments, and read the screenshots + notes they send back. Also covers the sound-effect mix the user sets in the player (tracks, per-sound volume levels). Use when working on a Rive animation (a project with rive.yaml, or a .riv) and the user wants to see it, review it, or gives feedback on specific frames or on audio and sound levels ("make the pops quieter", "the whoosh is too loud"); also when the user pastes a timecode like "00:12.350 (frame 741)" or mentions "Send to agent", wait-feedback, get_feedback, get_audio_mix or rive-video-preview.
license: MIT
---

# rive-video-preview

`rive-video-preview` opens a video-style player for a Rive project: a scrubbable timeline,
synced audio, audio tracks with per-sound-effect levels, frame stepping and copyable
timecodes. The user can screenshot frames, write a note on each, and press **Send to agent**.
You hear about it through a background listener (`wait-feedback`) or the MCP server.

## Setup check

1. `command -v rive-video-preview`. If it is missing, tell the user to install it from
   https://github.com/fulopkovacs/rive-preview-player (`pnpm install && pnpm link --global`).
2. If you have no `get_feedback` / `wait_for_feedback` / `seek_player` / `get_audio_mix` tools,
   the MCP server is not registered. Suggest (for Claude Code, run in the project):
   `claude mcp add rive-preview -- rive-video-preview mcp`
   then restart the session. `wait-feedback` and the files below work without it.

## Showing the user the animation

- Start the player in the background, once: `rive-video-preview .` (or `rive-video-preview path/to/file.riv`).
  It rebuilds on every save and never exits; leave it running. Running it again reuses the open player.
- To point the user at a moment, call `seek_player` with a time (`12.5`, `1:02.25`, `f741`),
  or run `rive-video-preview . --at <time>`.
- `rive-video-preview . --status` shows whether it is running; `--stop` stops it.

## Hearing the user's feedback: start the listener

Pressing **Send to agent** only writes a bundle to disk. It reaches you only if you are
listening, so:

- **After starting or showing the player, and after every round of fixes, start
  `rive-video-preview wait-feedback .` as a background command** (Claude Code: Bash with
  `run_in_background: true`; use the same target as the player, e.g. `path/to/file.riv`).
  It waits without blocking your session. When the user presses Send, it prints the feedback,
  marks it read and exits, and its exit wakes you with the output.
- Run one at a time. Once it has exited and you have handled the feedback, start it again.
  It returns at once if unread feedback is already waiting.
- While it runs, the player tells the user "the agent is listening". Without it, the player
  tells them to paste a prompt into the chat. Only tell the user you will pick their feedback
  up automatically when the listener is running.
- Exit codes: 0 feedback printed, 124 `--timeout` reached (default: no timeout),
  130 interrupted, 1 error. `--no-mark-read` leaves bundles unread.

Alternatives, through the MCP server: `get_feedback` reads unread bundles now (images
included); `wait_for_feedback` blocks your session until the user sends (default 600 s), so
prefer the background listener. Both mark bundles read.

## Reading a feedback bundle

- Each bundle has an optional overall note and, per screenshot: the image path, the note, the
  timecode (`00:12.350 (frame 741)` = seconds into the animation and the frame at its fps), and
  the **artboard and animation name**. Fix that animation, at that frame, unless the note says
  otherwise. Open the images to see the frames.
- A screenshot may carry a highlighted **region** (Shift+S in the player): the image keeps the full
  artboard with that box outlined and the rest dimmed, and the shot lists
  `Region: x, y, width × height in artboard units` (from the artboard's top-left, with the artboard
  size). The note is about what is inside that box: match it to the elements at those coordinates.
- A bundle includes an **Audio mix** section when the user changed the levels (see below).
- Reading marks a bundle as read; the player then shows the user "✓ The agent read it".
  `get_feedback` with `include_read: true` shows older bundles.
- Files: `.rive-preview/feedback/*/feedback.md` (for a bare `.riv`:
  `.rive-preview/<file>.riv/feedback/*/`) lists notes and image paths. A bundle is complete once
  its `feedback.json` exists; `consumed.json` marks it read.
- After fixing, `seek_player` to the frame you changed, ask the user to check it, and restart
  the listener.

## The audio mix

Below the stage, every sound effect (each `AudioEvent` keyframe) is a clip on an audio track.
The user can add up to 3 tracks (volume, mute, solo) and set each sound effect's own volume.
In the preview a sound plays at *asset volume × clip gain × track volume*.

- The player never changes the project. When the user asks to keep the levels ("make the pops
  quieter like I set them"), read them and carry them into the project, e.g. the asset's
  `volume`, or a separate asset for a sound that needs a different level in one place.
- Read them with the `get_audio_mix` MCP tool, from the bundle's Audio mix section, or from
  `.rive-preview/mix.json` (for a bare `.riv`: `.rive-preview/<file>.riv/mix.json`). Clips are
  keyed by artboard, animation, event name and occurrence, and carry the frame and time.
- Look up the RML properties with `rive schema` before editing them.

## Limits

- The player drives one animation directly, bypassing the state machine: inputs, listeners and
  data-bound logic do not run. Use `rive .` to test interactivity.
- Audio is synced only for `AudioEvent`s keyed on the animation timeline.
- A bare `.riv` gets its artboards, animations and audio timing from the file itself. Only if it
  cannot be read that way is the fps assumed to be 60, with no audio timing.
- Do not preview with `rive push` (it uploads to the user's Rive account).
