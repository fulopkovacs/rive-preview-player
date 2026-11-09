---
name: rive-video-preview
description: Preview Rive CLI projects or .riv files as a scrubbable video with sound, point the user at exact moments, and read the screenshots + notes they send back. Use when working on a Rive animation (a project with rive.yaml, or a .riv) and the user wants to see it, review it, or gives feedback on specific frames; also when the user pastes a timecode like "00:12.350 (frame 741)" or mentions "Send to agent", get_feedback or rive-video-preview.
license: MIT
---

# rive-video-preview

`rive-video-preview` opens a video-style player for a Rive project: a scrubbable timeline,
synced audio, frame stepping and copyable timecodes. The user can screenshot frames, write a
note on each, and press **Send to agent**; you read that feedback through its MCP server.

## Setup check

1. `command -v rive-video-preview`. If it is missing, tell the user to install it from
   https://github.com/fulopkovacs/rive-preview-player (`pnpm install && pnpm link --global`).
2. If you have no `get_feedback` / `wait_for_feedback` / `seek_player` tools, the MCP server is
   not registered. Suggest (for Claude Code, run in the project):
   `claude mcp add rive-preview -- rive-video-preview mcp`
   then restart the session. Until then, read feedback from files (see below).

## Showing the user the animation

- Start the player in the background, once: `rive-video-preview .` (or `rive-video-preview path/to/file.riv`).
  It rebuilds on every save and never exits; leave it running. Running it again reuses the open player.
- To point the user at a moment, call `seek_player` with a time (`12.5`, `1:02.25`, `f741`),
  or run `rive-video-preview . --at <time>`.
- `rive-video-preview . --status` shows whether it is running; `--stop` stops it.

## Getting the user's feedback

- After asking the user to review something, call `wait_for_feedback`: it returns as soon as
  they press **Send to agent** (default timeout 600s). Otherwise call `get_feedback`.
- Each bundle has an optional overall note and, per screenshot: the image, the note, the
  timecode (`00:12.350 (frame 741)` = seconds into the animation and the frame at its fps), and
  the **artboard and animation name**. Fix that animation, at that frame, unless the note says otherwise.
- Reading marks a bundle as read; the player then shows the user "✓ The agent read it".
  Pass `include_read: true` to see older bundles.
- Without the MCP tools, read the newest `feedback.md` under `.rive-preview/feedback/*/`
  (for a bare `.riv`: `.rive-preview/<file>.riv/feedback/*/`); it lists notes and image paths.
- After fixing, `seek_player` to the frame you changed and ask the user to check it.

## Limits

- The player drives one animation directly, bypassing the state machine: inputs, listeners and
  data-bound logic do not run. Use `rive .` to test interactivity.
- Audio is synced only for `AudioEvent`s keyed on the animation timeline.
- For a bare `.riv`, fps is assumed to be 60 and there is no audio timing.
- Do not preview with `rive push` (it uploads to the user's Rive account).
